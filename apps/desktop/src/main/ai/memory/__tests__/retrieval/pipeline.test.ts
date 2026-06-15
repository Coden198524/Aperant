/**
 * pipeline.test.ts — Integration test of the full retrieval pipeline with mocked services
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@libsql/client';
import { getInMemoryClient } from '../../db';
import {
  compactRetrievalQuery,
  MAX_RETRIEVAL_QUERY_CHARS,
  normalizeMemoryFetchIds,
  RetrievalPipeline,
} from '../../retrieval/pipeline';
import { Reranker } from '../../retrieval/reranker';
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
): Promise<void> {
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO memories (
      id, type, content, confidence, tags, related_files, related_modules,
      created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
    ) VALUES (?, ?, ?, 0.9, '[]', '[]', '[]', ?, ?, 0, 'global', 'agent_explicit', ?, 0)`,
    args: [id, type, content, now, now, projectId],
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
    expect(memory.content).toContain('pipeline token head');
    expect(memory.content).toContain('pipeline token tail');
    expect(memory.content).toContain('[memory middle omitted before storage]');
    expect(memory.citationText?.length).toBeLessThanOrEqual(1_000);
    expect(memory.citationText).toContain('pipeline citation head');
    expect(memory.citationText).toContain('pipeline citation tail');
    expect(memory.contextPrefix?.length).toBeLessThanOrEqual(600);
    expect(memory.contextPrefix).toContain('pipeline context head');
    expect(memory.contextPrefix).toContain('pipeline context tail');
    expect(result.formattedContext.length).toBeLessThan(longContent.length);
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
