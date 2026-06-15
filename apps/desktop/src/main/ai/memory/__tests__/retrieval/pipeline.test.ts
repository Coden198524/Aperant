/**
 * pipeline.test.ts — Integration test of the full retrieval pipeline with mocked services
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@libsql/client';
import { getInMemoryClient } from '../../db';
import {
  compactRetrievalQuery,
  MAX_RETRIEVAL_QUERY_CHARS,
  MAX_RETRIEVAL_QUERY_TOKENS,
  normalizeMemoryFetchIds,
  RetrievalPipeline,
} from '../../retrieval/pipeline';
import { Reranker } from '../../retrieval/reranker';
import { estimateTokens } from '../../retrieval/context-packer';
import type { EmbeddingService } from '../../embedding-service';

// ============================================================
// HELPERS
// ============================================================

async function seedMemory(
  client: Client,
  id: string,
  content: string,
  projectId: string,
  type: string = 'gotcha',
  relatedFiles: string[] = [],
): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO memories (
      id, type, content, confidence, tags, related_files, related_modules,
      created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
    ) VALUES (?, ?, ?, 0.9, '[]', ?, '[]', ?, ?, 0, 'global', 'agent_explicit', ?, 0)`,
    args: [id, type, content, JSON.stringify(relatedFiles), now, now, projectId],
  });

  await client.execute({
    sql: `INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES (?, ?, '[]', '[]')`,
    args: [id, content],
  });
}

function makeMockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Array(256).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    embedMemory: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    embedChunk: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    initialize: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn().mockReturnValue('none'),
  } as unknown as EmbeddingService;
}

function makeCapturingReranker() {
  const rerank = vi.fn(async (
    _query: string,
    candidates: Array<{ memoryId: string; content: string }>,
    topK: number,
  ) =>
    candidates.slice(0, topK).map((candidate, index) => ({
      memoryId: candidate.memoryId,
      score: 1 - index / Math.max(candidates.length, 1),
    })),
  );
  return {
    reranker: { rerank } as unknown as Reranker,
    rerank,
  };
}

// ============================================================
// TESTS
// ============================================================

let client: Client;

beforeEach(async () => {
  client = await getInMemoryClient();
});

afterEach(() => {
  client.close();
  vi.restoreAllMocks();
});

describe('RetrievalPipeline', () => {
  it('compacts long retrieval queries while preserving head and tail constraints', () => {
    const query = `AUTH_QUERY_HEAD ${'verbose task detail '.repeat(120)} AUTH_QUERY_TAIL`;

    const compact = compactRetrievalQuery(query);

    expect(compact.length).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_CHARS);
    expect(compact).toContain('AUTH_QUERY_HEAD');
    expect(compact).toContain('AUTH_QUERY_TAIL');
    expect(compact).toContain('query middle omitted for retrieval budget');
  });

  it('compacts localized retrieval queries by estimated token budget', () => {
    const query = [
      '检索开头',
      '这是一段会显著增加 token 的中文检索查询。'.repeat(120),
      '检索尾部',
    ].join(' ');

    const compact = compactRetrievalQuery(query);

    expect(compact.length).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_CHARS);
    expect(estimateTokens(compact)).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_TOKENS);
    expect(compact).toContain('检索开头');
    expect(compact).toContain('检索尾部');
    expect(compact).toContain('query middle omitted for retrieval budget');
  });

  it('normalizes full-record fetch ids before building SQL', () => {
    expect(
      normalizeMemoryFetchIds(
        [' mem-a ', '', 'mem-b', 'mem-a', '   ', 'mem-c', 'mem-d'],
        3.9,
      ),
    ).toEqual(['mem-a', 'mem-b', 'mem-c']);
    expect(normalizeMemoryFetchIds(['mem-a'], 0)).toEqual([]);
    expect(normalizeMemoryFetchIds(['mem-a'], Number.NaN)).toEqual([]);
  });

  it('returns empty result for empty database', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('authentication', {
      phase: 'implement',
      projectId: 'test-project',
    });

    expect(result.memories).toEqual([]);
    expect(result.formattedContext).toBe('');
  });

  it('returns empty result without embedding blank queries', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('   \n\t   ', {
      phase: 'implement',
      projectId: 'test-project',
    });

    expect(result).toEqual({ memories: [], formattedContext: '' });
    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('returns empty result without embedding when maxResults is not positive', async () => {
    await seedMemory(client, 'mem-001', 'JWT token expiry must be checked in middleware', 'proj-a');
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const zeroResult = await pipeline.search('JWT token', {
      phase: 'implement',
      projectId: 'proj-a',
      maxResults: 0,
    });
    const invalidResult = await pipeline.search('JWT token', {
      phase: 'implement',
      projectId: 'proj-a',
      maxResults: Number.NaN,
    });

    expect(zeroResult).toEqual({ memories: [], formattedContext: '' });
    expect(invalidResult).toEqual({ memories: [], formattedContext: '' });
    expect(embeddingService.embed).not.toHaveBeenCalled();
  });

  it('returns memories matching a query via BM25', async () => {
    await seedMemory(client, 'mem-001', 'JWT token expiry must be checked in middleware', 'proj-a');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('JWT token', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].id).toBe('mem-001');
    expect(result.formattedContext).toContain('JWT token expiry');
  });

  it('deduplicates and bounds related files before reranking candidates', async () => {
    await seedMemory(
      client,
      'mem-rerank-files',
      'JWT reranker file context should stay compact',
      'proj-a',
      'gotcha',
      [
        ' ./src\\auth\\session.ts ',
        'SRC/auth/session.ts',
        ...Array.from({ length: 8 }, (_, index) => `src/auth/file-${index}.ts`),
      ],
    );
    const embeddingService = makeMockEmbeddingService();
    const { reranker, rerank } = makeCapturingReranker();
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('JWT reranker compact', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const candidates = rerank.mock.calls[0][1];
    const content = candidates[0].content;

    expect(content).toContain('[gotcha] src/auth/session.ts');
    expect(content).not.toContain('SRC/auth/session.ts');
    expect(content).not.toContain('\\');
    expect(content).toContain('src/auth/file-4.ts');
    expect(content).not.toContain('src/auth/file-5.ts');
    expect(content).toContain('JWT reranker file context should stay compact');
  });

  it('strips low-value memory lines before sending candidates to the reranker', async () => {
    const content = [
      'Keep OAuth refresh retry guard inside the session manager.',
      'npm run typecheck passed.',
      'No issues found',
    ].join('\n');
    await seedMemory(client, 'mem-low-value-rerank', content, 'proj-a', 'work_unit_outcome');

    const embeddingService = makeMockEmbeddingService();
    const { reranker, rerank } = makeCapturingReranker();
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('OAuth refresh retry guard', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const candidates = rerank.mock.calls[0][1];
    const candidate = candidates.find((item) => item.memoryId === 'mem-low-value-rerank');

    expect(result.memories[0].content).toBe(content);
    expect(candidate?.content).toContain('Keep OAuth refresh retry guard inside the session manager.');
    expect(candidate?.content).not.toContain('npm run typecheck passed.');
    expect(candidate?.content).not.toContain('No issues found');
  });

  it('skips low-value-only memories before reranking', async () => {
    const content = [
      'All tests passed.',
      'No issues found.',
      'Duration: 1234ms',
    ].join('\n');
    await seedMemory(client, 'mem-status-only', content, 'proj-a', 'work_unit_outcome');

    const embeddingService = makeMockEmbeddingService();
    const { reranker, rerank } = makeCapturingReranker();
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('No issues found', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    expect(result).toEqual({ memories: [], formattedContext: '' });
    expect(rerank).not.toHaveBeenCalled();
  });

  it('formats prefetch pattern JSON compactly before reranking', async () => {
    const content = JSON.stringify({
      alwaysReadFiles: ['src\\auth\\session.ts', 'src/auth/session.ts'],
      frequentlyReadFiles: [
        'src/auth/session.ts',
        'src/auth/token.ts',
        'src/auth/guard.ts',
        'src/auth/callback.ts',
        'src/auth/routes.ts',
        'src/auth/legacy.ts',
      ],
    });
    await seedMemory(client, 'mem-prefetch-rerank', content, 'proj-a', 'prefetch_pattern');

    const embeddingService = makeMockEmbeddingService();
    const { reranker, rerank } = makeCapturingReranker();
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('session token', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const candidates = rerank.mock.calls[0][1];
    const candidate = candidates.find((item) => item.memoryId === 'mem-prefetch-rerank');

    expect(candidate?.content).toContain('[prefetch_pattern]');
    expect(candidate?.content).toContain('Always prefetch: src/auth/session.ts');
    expect(candidate?.content).toContain('Prefetch together: src/auth/{token.ts, guard.ts, callback.ts, routes.ts} (+1 more)');
    expect(candidate?.content).not.toContain('alwaysReadFiles');
    expect(candidate?.content).not.toContain('frequentlyReadFiles');
    expect((candidate?.content.match(/src\/auth\/session\.ts/g) ?? [])).toHaveLength(1);
  });

  it('preserves context_cost token signals before sending candidates to the reranker', async () => {
    const content = [
      'High token usage per step: 24k tokens.',
      'Context token spike came from repeatedly sending full memory search results.',
    ].join('\n');
    await seedMemory(client, 'mem-context-cost-rerank', content, 'proj-a', 'context_cost');

    const embeddingService = makeMockEmbeddingService();
    const { reranker, rerank } = makeCapturingReranker();
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('high token usage', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const candidates = rerank.mock.calls[0][1];
    const candidate = candidates.find((item) => item.memoryId === 'mem-context-cost-rerank');

    expect(result.memories[0].content).toBe(content);
    expect(candidate?.content).toContain('[context_cost]');
    expect(candidate?.content).toContain('High token usage per step: 24k tokens.');
    expect(candidate?.content).toContain('Context token spike');
  });

  it('normalizes legacy rows fetched by query retrieval before packing context', async () => {
    const longContent = `pipeline token head ${'verbose implementation detail '.repeat(180)} pipeline token tail`;
    const longCitation = `pipeline citation head ${'reference detail '.repeat(120)} pipeline citation tail`;
    const longContext = `pipeline context head ${'neighbor detail '.repeat(90)} pipeline context tail`;
    await seedMemory(client, 'legacy-long', longContent, 'proj-a');
    await client.execute({
      sql: `UPDATE memories SET citation_text = ?, context_prefix = ? WHERE id = ?`,
      args: [longCitation, longContext, 'legacy-long'],
    });

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('pipeline token head', {
      phase: 'implement',
      projectId: 'proj-a',
    });
    const memory = result.memories[0];

    expect(memory.id).toBe('legacy-long');
    expect(memory.content.length).toBeLessThanOrEqual(2_000);
    expect(estimateTokens(memory.content)).toBeLessThanOrEqual(500);
    expect(memory.content).toContain('pipeline token head');
    expect(memory.content).toContain('pipeline token tail');
    expect(memory.content).toContain('[memory middle omitted before storage]');
    expect(memory.citationText?.length).toBeLessThanOrEqual(1_000);
    expect(estimateTokens(memory.citationText ?? '')).toBeLessThanOrEqual(250);
    expect(memory.citationText).toContain('pipeline citation head');
    expect(memory.citationText).toContain('pipeline citation tail');
    expect(memory.contextPrefix?.length).toBeLessThanOrEqual(600);
    expect(estimateTokens(memory.contextPrefix ?? '')).toBeLessThanOrEqual(150);
    expect(memory.contextPrefix).toContain('pipeline context head');
    expect(memory.contextPrefix).toContain('pipeline context tail');
    expect(result.formattedContext.length).toBeLessThan(longContent.length);
  });

  it('normalizes localized legacy rows by estimated token budget before packing context', async () => {
    const longContent = [
      '旧行记忆开头',
      '这是一段会显著增加 token 的中文旧行内容。'.repeat(180),
      '旧行记忆尾部',
    ].join(' ');
    const longCitation = [
      '旧行引用开头',
      '本地化引用细节。'.repeat(120),
      '旧行引用尾部',
    ].join(' ');
    const longContext = [
      '旧行前缀开头',
      '本地化上下文前缀。'.repeat(80),
      '旧行前缀尾部',
    ].join(' ');
    await seedMemory(client, 'legacy-localized', longContent, 'proj-a');
    await client.execute({
      sql: `UPDATE memories SET citation_text = ?, context_prefix = ? WHERE id = ?`,
      args: [longCitation, longContext, 'legacy-localized'],
    });

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('旧行记忆开头', {
      phase: 'implement',
      projectId: 'proj-a',
    });
    const memory = result.memories[0];

    expect(memory.id).toBe('legacy-localized');
    expect(memory.content.length).toBeLessThanOrEqual(2_000);
    expect(estimateTokens(memory.content)).toBeLessThanOrEqual(500);
    expect(memory.content).toContain('旧行记忆开头');
    expect(memory.content).toContain('旧行记忆尾部');
    expect(memory.content).toContain('[memory middle omitted before storage]');
    expect(memory.citationText).toContain('旧行引用开头');
    expect(memory.citationText).toContain('旧行引用尾部');
    expect(estimateTokens(memory.citationText ?? '')).toBeLessThanOrEqual(250);
    expect(memory.contextPrefix).toContain('旧行前缀开头');
    expect(memory.contextPrefix).toContain('旧行前缀尾部');
    expect(estimateTokens(memory.contextPrefix ?? '')).toBeLessThanOrEqual(150);
    expect(result.formattedContext).toContain('旧行记忆开头');
  });

  it('scopes results to correct project', async () => {
    await seedMemory(client, 'proj-a-mem', 'gotcha for project a', 'proj-a');
    await seedMemory(client, 'proj-b-mem', 'gotcha for project b', 'proj-b');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('gotcha', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain('proj-a-mem');
    expect(ids).not.toContain('proj-b-mem');
  });

  it('includes formatted context with phase-appropriate structure', async () => {
    await seedMemory(client, 'mem-001', 'critical gotcha about Electron path resolution', 'proj-a', 'gotcha');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('electron path', {
      phase: 'implement',
      projectId: 'proj-a',
    });

    if (result.memories.length > 0) {
      expect(result.formattedContext).toContain('Relevant Context from Memory');
      expect(result.formattedContext).toContain('Gotcha');
    }
  });

  it('respects maxResults config', async () => {
    // Seed 5 memories
    for (let i = 0; i < 5; i++) {
      await seedMemory(client, `mem-${i}`, `authentication gotcha number ${i}`, 'proj-a');
    }

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const result = await pipeline.search('authentication', {
      phase: 'implement',
      projectId: 'proj-a',
      maxResults: 2,
    });

    expect(result.memories.length).toBeLessThanOrEqual(2);
  });

  it('scales candidate limits down for small maxResults requests', async () => {
    for (let i = 0; i < 8; i++) {
      await seedMemory(client, `mem-${i}`, `authentication gotcha number ${i}`, 'proj-a');
    }
    const executeSpy = vi.spyOn(client, 'execute');
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('authentication', {
      phase: 'implement',
      projectId: 'proj-a',
      maxResults: 2,
      recentFiles: ['src/auth.ts'],
    });

    const statements = executeSpy.mock.calls.flatMap(([statement]) => {
      if (typeof statement === 'object' && statement !== null && 'sql' in statement) {
        return [statement as { sql: string; args: unknown[] }];
      }
      return [];
    });
    const bm25Call = statements.find((statement) => statement.sql.includes('memories_fts MATCH'));
    const denseCall = statements.find((statement) => statement.sql.includes('vector_distance_cos'));
    const graphCall = statements.find((statement) => statement.sql.includes('json_each(m.related_files)'));
    const fetchCall = statements.find((statement) => statement.sql.includes('SELECT * FROM memories WHERE id IN'));

    expect(bm25Call?.args.at(-1)).toBe(8);
    expect(denseCall?.args.at(-1)).toBe(12);
    expect(graphCall?.args.at(-1)).toBe(6);
    expect(fetchCall?.args.length).toBeLessThanOrEqual(8);
  });

  it('handles graph search gracefully when no recentFiles provided', async () => {
    await seedMemory(client, 'mem-001', 'some memory content', 'proj-a');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    // No recentFiles — graph search should return empty gracefully
    await expect(
      pipeline.search('content', {
        phase: 'explore',
        projectId: 'proj-a',
        // recentFiles: undefined
      }),
    ).resolves.not.toThrow();
  });

  it('calls embedding service for dense search', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    await pipeline.search('semantic query about architecture', {
      phase: 'explore',
      projectId: 'proj-a',
    });

    expect(embeddingService.embed).toHaveBeenCalled();
  });

  it('uses compact retrieval queries for dense search input', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);
    const query = `AUTH_QUERY_HEAD ${'verbose task detail '.repeat(120)} AUTH_QUERY_TAIL`;

    await pipeline.search(query, {
      phase: 'explore',
      projectId: 'proj-a',
    });

    const embeddedQuery = vi.mocked(embeddingService.embed).mock.calls[0][0] as string;
    expect(embeddedQuery.length).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_CHARS);
    expect(embeddedQuery).toContain('AUTH_QUERY_HEAD');
    expect(embeddedQuery).toContain('AUTH_QUERY_TAIL');
    expect(embeddedQuery).toContain('query middle omitted for retrieval budget');
    expect(embeddedQuery).not.toBe(query);
  });

  it('uses token-aware localized retrieval queries for dense search input', async () => {
    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);
    const query = [
      '向量检索开头',
      '这是一段会显著增加 token 的中文 dense 查询。'.repeat(120),
      '向量检索尾部',
    ].join(' ');

    await pipeline.search(query, {
      phase: 'explore',
      projectId: 'proj-a',
    });

    const embeddedQuery = vi.mocked(embeddingService.embed).mock.calls[0][0] as string;
    expect(embeddedQuery.length).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_CHARS);
    expect(estimateTokens(embeddedQuery)).toBeLessThanOrEqual(MAX_RETRIEVAL_QUERY_TOKENS);
    expect(embeddedQuery).toContain('向量检索开头');
    expect(embeddedQuery).toContain('向量检索尾部');
    expect(embeddedQuery).toContain('query middle omitted for retrieval budget');
    expect(embeddedQuery).not.toBe(query);
  });

  it('works with different phases', async () => {
    await seedMemory(client, 'mem-001', 'workflow recipe for feature development', 'proj-a', 'workflow_recipe');

    const embeddingService = makeMockEmbeddingService();
    const reranker = new Reranker('none');
    const pipeline = new RetrievalPipeline(client, embeddingService, reranker);

    const phases = ['define', 'implement', 'validate', 'refine', 'explore', 'reflect'] as const;
    for (const phase of phases) {
      await expect(
        pipeline.search('workflow', { phase, projectId: 'proj-a' }),
      ).resolves.not.toThrow();
    }
  });
});
