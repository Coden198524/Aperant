/**
 * MemoryServiceImpl Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@libsql/client';
import type { Memory, MemoryRecordEntry, MemorySearchFilters } from '../types';
import type { EmbeddingService } from '../embedding-service';
import type { RetrievalPipeline } from '../retrieval/pipeline';
import { MemoryServiceImpl } from '../memory-service';
import { estimateTokens } from '../retrieval/context-packer';

// ============================================================
// MOCKS
// ============================================================

const mockExecute = vi.fn();
const mockBatch = vi.fn();

const mockDb = {
  execute: mockExecute,
  batch: mockBatch,
} as unknown as Client;

const mockEmbed = vi.fn().mockResolvedValue(new Array(1024).fill(0.1));
const mockEmbedBatch = vi.fn().mockResolvedValue([new Array(1024).fill(0.1)]);
const mockGetProvider = vi.fn().mockReturnValue('none');

const mockEmbeddingService = {
  embed: mockEmbed,
  embedBatch: mockEmbedBatch,
  getProvider: mockGetProvider,
  initialize: vi.fn().mockResolvedValue(undefined),
} as unknown as EmbeddingService;

const mockRetrievalSearch = vi.fn();
const mockRetrievalPipeline = {
  search: mockRetrievalSearch,
} as unknown as RetrievalPipeline;

// ============================================================
// FIXTURES
// ============================================================

function makeMemoryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'mem-001',
    type: 'gotcha',
    content: 'Test memory content',
    confidence: 0.9,
    tags: '["typescript","testing"]',
    related_files: '["src/foo.ts"]',
    related_modules: '["module-a"]',
    created_at: '2024-01-01T00:00:00.000Z',
    last_accessed_at: '2024-01-01T00:00:00.000Z',
    access_count: 0,
    scope: 'global',
    source: 'agent_explicit',
    session_id: 'session-001',
    commit_sha: null,
    provenance_session_ids: '[]',
    target_node_id: null,
    impacted_node_ids: '[]',
    relations: '[]',
    decay_half_life_days: null,
    needs_review: 0,
    user_verified: 0,
    citation_text: null,
    pinned: 0,
    deprecated: 0,
    deprecated_at: null,
    stale_at: null,
    project_id: 'proj-001',
    trust_level_scope: 'personal',
    chunk_type: null,
    chunk_start_line: null,
    chunk_end_line: null,
    context_prefix: null,
    embedding_model_id: 'onnx-d1024',
    work_unit_ref: null,
    methodology: null,
    ...overrides,
  };
}

function makeMemoryResult(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-001',
    type: 'gotcha',
    content: 'Test memory content',
    confidence: 0.9,
    tags: ['typescript', 'testing'],
    relatedFiles: ['src/foo.ts'],
    relatedModules: ['module-a'],
    createdAt: '2024-01-01T00:00:00.000Z',
    lastAccessedAt: '2024-01-01T00:00:00.000Z',
    accessCount: 0,
    scope: 'global',
    source: 'agent_explicit',
    sessionId: 'session-001',
    provenanceSessionIds: [],
    projectId: 'proj-001',
    relations: [],
    needsReview: false,
    userVerified: false,
    pinned: false,
    deprecated: false,
    ...overrides,
  };
}

function getAccessBatchMemoryIds(): string[] {
  const statements = mockBatch.mock.calls.at(-1)?.[0] as
    | Array<{ sql: string; args: unknown[] }>
    | undefined;
  expect(statements).toBeDefined();
  return (statements ?? []).map((statement) => {
    expect(statement.sql).toContain('access_count = access_count + 1');
    expect(statement.sql).toContain('last_accessed_at');
    return statement.args[1] as string;
  });
}

// ============================================================
// TESTS
// ============================================================

describe('MemoryServiceImpl', () => {
  let service: MemoryServiceImpl;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MemoryServiceImpl(mockDb, mockEmbeddingService, mockRetrievalPipeline);
    // Default batch mock: resolve successfully
    mockBatch.mockResolvedValue([]);
  });

  // ----------------------------------------------------------
  // store()
  // ----------------------------------------------------------

  describe('store()', () => {
    it('stores a memory entry and returns a UUID', async () => {
      const entry: MemoryRecordEntry = {
        type: 'gotcha',
        content: 'Remember to use bun instead of npm',
        projectId: 'proj-001',
        tags: ['tooling'],
        relatedFiles: ['package.json'],
      };

      const id = await service.store(entry);

      expect(typeof id).toBe('string');
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(mockEmbed).toHaveBeenCalledOnce();
    });

    it('calls db.batch with three statements (memories, fts, embeddings)', async () => {
      const entry: MemoryRecordEntry = {
        type: 'decision',
        content: 'Use libSQL for memory storage',
        projectId: 'proj-002',
      };

      await service.store(entry);

      const batchArgs = mockBatch.mock.calls[0][0];
      expect(batchArgs).toHaveLength(3);

      // Check that the first SQL is the memories insert
      expect(batchArgs[0].sql).toContain('INSERT INTO memories');
      // Check that the second SQL is the FTS insert
      expect(batchArgs[1].sql).toContain('INSERT INTO memories_fts');
      // Check that the third SQL is the embeddings insert
      expect(batchArgs[2].sql).toContain('INSERT INTO memory_embeddings');
    });

    it('uses default values for optional fields', async () => {
      const entry: MemoryRecordEntry = {
        type: 'pattern',
        content: 'Always check for null',
        projectId: 'proj-001',
      };

      await service.store(entry);

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;

      // confidence defaults to 0.8
      expect(memoriesArgs).toContain(0.8);
      // scope defaults to 'global'
      expect(memoriesArgs).toContain('global');
      // source defaults to 'agent_explicit'
      expect(memoriesArgs).toContain('agent_explicit');
    });

    it('normalizes confidence before storage', async () => {
      await service.store({
        type: 'gotcha',
        content: 'Clamp overconfident memory writes',
        projectId: 'proj-001',
        confidence: 1.5,
      });

      let batchArgs = mockBatch.mock.calls[0][0];
      let memoriesArgs = batchArgs[0].args;
      expect(memoriesArgs[3]).toBe(1);

      vi.clearAllMocks();
      mockBatch.mockResolvedValue([]);
      mockEmbed.mockResolvedValue(new Array(1024).fill(0.1));

      await service.store({
        type: 'gotcha',
        content: 'Default invalid confidence memory writes',
        projectId: 'proj-001',
        confidence: Number.NaN,
      });

      batchArgs = mockBatch.mock.calls[0][0];
      memoriesArgs = batchArgs[0].args;
      expect(memoriesArgs[3]).toBe(0.8);
    });

    it('serializes tags and relatedFiles as JSON', async () => {
      const entry: MemoryRecordEntry = {
        type: 'gotcha',
        content: 'Some content',
        projectId: 'proj-001',
        tags: ['tag1', 'tag2'],
        relatedFiles: ['a.ts', 'b.ts'],
      };

      await service.store(entry);

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      expect(memoriesArgs).toContain(JSON.stringify(['tag1', 'tag2']));
      expect(memoriesArgs).toContain(JSON.stringify(['a.ts', 'b.ts']));
    });

    it('normalizes relatedFiles before storage, FTS indexing, and embedding', async () => {
      await service.store({
        type: 'gotcha',
        content: 'Normalize related file paths once at the storage boundary',
        projectId: 'proj-001',
        relatedFiles: [
          ' src\\auth\\token.ts ',
          './src/auth//token.ts',
          'src/auth/session.ts/',
          '',
        ],
        relatedModules: [' auth ', 'AUTH', 'billing'],
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const storedRelatedFiles = JSON.parse(memoriesArgs[5] as string) as string[];
      const storedRelatedModules = JSON.parse(memoriesArgs[6] as string) as string[];
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(storedRelatedFiles).toEqual(['src/auth/token.ts', 'src/auth/session.ts']);
      expect(storedRelatedModules).toEqual(['auth', 'billing']);
      expect(ftsArgs[3]).toBe('src/auth/token.ts src/auth/session.ts');
      expect(embeddingText).toContain('Files: src/auth/{token.ts, session.ts}');
      expect(embeddingText).toContain('Module: auth');
    });

    it('strips low-value lines from FTS and embedding text while preserving stored content', async () => {
      const content = [
        'Keep OAuth refresh retry guard inside the session manager.',
        'npm run typecheck passed.',
        'No issues found',
      ].join('\n');

      await service.store({
        type: 'work_unit_outcome',
        content,
        projectId: 'proj-001',
        relatedFiles: ['src/auth/session.ts'],
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(memoriesArgs[2]).toBe(content);
      expect(ftsArgs[1]).toBe('Keep OAuth refresh retry guard inside the session manager.');
      expect(embeddingText).toContain('Keep OAuth refresh retry guard inside the session manager.');
      expect(embeddingText).not.toContain('npm run typecheck passed.');
      expect(embeddingText).not.toContain('No issues found');
    });

    it('preserves context_cost token signals in FTS and embedding text', async () => {
      const content = [
        'High token usage per step: 24k tokens.',
        'Efficient token usage - concise and focused implementation.',
        'npm run typecheck passed.',
        'No issues found.',
        'Context token spike came from repeatedly sending full memory search results.',
      ].join('\n');

      await service.store({
        type: 'context_cost',
        content,
        projectId: 'proj-001',
        relatedFiles: ['src/main/ai/memory/tools/search-memory.ts'],
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(memoriesArgs[2]).toBe(content);
      expect(ftsArgs[1]).toBe([
        'High token usage per step: 24k tokens.',
        'Context token spike came from repeatedly sending full memory search results.',
      ].join('\n'));
      expect(embeddingText).toContain('High token usage per step: 24k tokens.');
      expect(embeddingText).toContain('Context token spike');
      expect(embeddingText).not.toContain('Efficient token usage');
      expect(embeddingText).not.toContain('npm run typecheck passed.');
      expect(embeddingText).not.toContain('No issues found');
    });

    it('rejects context_cost memories with no token-cost signal after filtering', async () => {
      await expect(
        service.store({
          type: 'context_cost',
          content: [
            'Efficient token usage - concise and focused implementation.',
            'npm run typecheck passed.',
            'No issues found.',
          ].join('\n'),
          projectId: 'proj-001',
        }),
      ).rejects.toThrow('Context-cost memory has no token-cost signal after filtering.');

      expect(mockBatch).not.toHaveBeenCalled();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('compacts oversized memory content and metadata before storage and embedding', async () => {
      const longContent = `MEMORY_HEAD\n${'verbose implementation detail\n'.repeat(120)}MEMORY_TAIL`;
      const longCitation = `CITATION_HEAD ${'citation detail '.repeat(120)} CITATION_TAIL`;
      const longContextPrefix = `PREFIX_HEAD ${'context detail '.repeat(80)} PREFIX_TAIL`;

      await service.store({
        type: 'gotcha',
        content: longContent,
        projectId: 'proj-001',
        tags: [
          'Auth',
          ' auth ',
          'AUTH',
          ...Array.from({ length: 30 }, (_, index) => `tag-${index}-${'x'.repeat(80)}`),
        ],
        relatedFiles: Array.from(
          { length: 30 },
          (_, index) => `src/very/deep/path/${index}/${'file-name-segment-'.repeat(20)}tail-${index}.ts`,
        ),
        relatedModules: Array.from(
          { length: 20 },
          (_, index) => `module-${index}-${'nested-'.repeat(20)}tail`,
        ),
        citationText: longCitation,
        contextPrefix: longContextPrefix,
        methodology: `METHODOLOGY_HEAD ${'storage methodology detail '.repeat(30)} METHODOLOGY_TAIL`,
        workUnitRef: {
          methodology: `WORK_UNIT_METHOD_HEAD ${'work unit methodology detail '.repeat(30)} WU_TAIL`,
          hierarchy: [
            'Spec 001',
            ' spec 001 ',
            ...Array.from(
              { length: 12 },
              (_, index) => `Task ${index} ${'hierarchy detail '.repeat(20)}tail-${index}`,
            ),
          ],
          label: `WORK_UNIT_LABEL_HEAD ${'work unit label detail '.repeat(60)} WORK_UNIT_LABEL_TAIL`,
        },
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const storedContent = memoriesArgs[2] as string;
      const storedTags = JSON.parse(memoriesArgs[4] as string) as string[];
      const storedRelatedFiles = JSON.parse(memoriesArgs[5] as string) as string[];
      const storedRelatedModules = JSON.parse(memoriesArgs[6] as string) as string[];
      const storedWorkUnitRef = JSON.parse(memoriesArgs[11] as string) as {
        methodology: string;
        hierarchy: string[];
        label: string;
      };
      const storedMethodology = memoriesArgs[12] as string;
      const storedCitation = memoriesArgs[19] as string;
      const storedContextPrefix = memoriesArgs[23] as string;
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(storedContent.length).toBeLessThanOrEqual(2000);
      expect(estimateTokens(storedContent)).toBeLessThanOrEqual(500);
      expect(storedContent).toContain('MEMORY_HEAD');
      expect(storedContent).toContain('MEMORY_TAIL');
      expect(storedContent).toContain('119 repeated line(s) omitted for prompt budget');
      expect((storedContent.match(/verbose implementation detail/g) ?? [])).toHaveLength(1);
      expect(ftsArgs[1]).toBe(storedContent);
      expect(embeddingText).toContain(storedContent);
      expect(embeddingText).not.toContain('verbose implementation detail\n'.repeat(120));

      expect(storedTags).toHaveLength(20);
      expect(new Set(storedTags).size).toBe(storedTags.length);
      expect(storedTags[0]).toBe('Auth');
      expect(storedTags).not.toContain('auth');
      expect(storedTags).not.toContain('AUTH');
      expect(storedTags.every((tag) => tag.length <= 64)).toBe(true);
      expect(storedTags.every((tag) => estimateTokens(tag) <= 24)).toBe(true);
      expect(storedRelatedFiles).toHaveLength(24);
      expect(storedRelatedFiles.every((file) => file.length <= 220)).toBe(true);
      expect(storedRelatedFiles.every((file) => estimateTokens(file) <= 56)).toBe(true);
      expect(storedRelatedFiles[0]).toContain('tail-0.ts');
      expect(storedRelatedFiles[0]).not.toContain('omitted');
      expect(storedRelatedModules).toHaveLength(16);
      expect(storedRelatedModules.every((module) => module.length <= 96)).toBe(true);
      expect(storedRelatedModules.every((module) => estimateTokens(module) <= 32)).toBe(true);
      expect(storedCitation.length).toBeLessThanOrEqual(1000);
      expect(estimateTokens(storedCitation)).toBeLessThanOrEqual(250);
      expect(storedCitation).toContain('CITATION_HEAD');
      expect(storedCitation).toContain('CITATION_TAIL');
      expect(storedContextPrefix.length).toBeLessThanOrEqual(600);
      expect(estimateTokens(storedContextPrefix)).toBeLessThanOrEqual(150);
      expect(storedContextPrefix).toContain('PREFIX_HEAD');
      expect(storedContextPrefix).toContain('PREFIX_TAIL');
      expect(storedMethodology.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(storedMethodology)).toBeLessThanOrEqual(24);
      expect(storedMethodology).toContain('METHODOLOGY_HEAD');
      expect(storedMethodology).toContain('METHODOLOGY_TAIL');
      expect(storedWorkUnitRef.methodology.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(storedWorkUnitRef.methodology)).toBeLessThanOrEqual(24);
      expect(storedWorkUnitRef.methodology).toContain('WORK_UNIT_METHOD_HEAD');
      expect(storedWorkUnitRef.methodology).toContain('WU_TAIL');
      expect(storedWorkUnitRef.hierarchy).toHaveLength(8);
      expect(storedWorkUnitRef.hierarchy[0]).toBe('Spec 001');
      expect(storedWorkUnitRef.hierarchy).not.toContain('spec 001');
      expect(storedWorkUnitRef.hierarchy.every((item) => item.length <= 120)).toBe(true);
      expect(storedWorkUnitRef.hierarchy.every((item) => estimateTokens(item) <= 32)).toBe(true);
      expect(storedWorkUnitRef.label.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(storedWorkUnitRef.label)).toBeLessThanOrEqual(75);
      expect(storedWorkUnitRef.label).toContain('WORK_UNIT_LABEL_HEAD');
      expect(storedWorkUnitRef.label).toContain('WORK_UNIT_LABEL_TAIL');
    });

    it('folds repeated memory storage text before inserting and embedding', async () => {
      const repeatedContent = 'REPEATED_STORAGE_LOG: worker retried the same file read with no new signal.';
      const repeatedCitation = 'REPEATED_STORAGE_CITATION: reranker returned the same score without new evidence.';
      const repeatedPrefix = 'REPEATED_STORAGE_PREFIX: context prefix repeated the same module breadcrumb.';

      await service.store({
        type: 'gotcha',
        content: [
          'Storage head: keep the useful memory lesson visible.',
          ...Array.from({ length: 120 }, () => repeatedContent),
          'Storage tail: inspect settings write permissions before broad searches.',
        ].join('\n'),
        projectId: 'proj-001',
        citationText: [
          'Citation head.',
          ...Array.from({ length: 48 }, () => repeatedCitation),
          'Citation tail.',
        ].join('\n'),
        contextPrefix: [
          'Prefix head.',
          ...Array.from({ length: 48 }, () => repeatedPrefix),
          'Prefix tail.',
        ].join('\n'),
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const storedContent = memoriesArgs[2] as string;
      const storedCitation = memoriesArgs[19] as string;
      const storedContextPrefix = memoriesArgs[23] as string;
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(storedContent).toContain('Storage head: keep the useful memory lesson visible.');
      expect(storedContent).toContain('Storage tail: inspect settings write permissions before broad searches.');
      expect(storedContent).toContain('119 repeated line(s) omitted for prompt budget');
      expect((storedContent.match(/REPEATED_STORAGE_LOG/g) ?? [])).toHaveLength(1);
      expect(storedContent).not.toContain('memory middle omitted before storage');
      expect(storedCitation).toContain('47 repeated line(s) omitted for prompt budget');
      expect((storedCitation.match(/REPEATED_STORAGE_CITATION/g) ?? [])).toHaveLength(1);
      expect(storedContextPrefix).toContain('47 repeated line(s) omitted for prompt budget');
      expect((storedContextPrefix.match(/REPEATED_STORAGE_PREFIX/g) ?? [])).toHaveLength(1);
      expect(ftsArgs[1]).toBe(storedContent);
      expect(embeddingText).toContain(storedContent);
    });

    it('compacts localized memory content and metadata before storage and embedding', async () => {
      await service.store({
        type: 'gotcha',
        content: [
          '记忆开头',
          '这是一段会显著增加 token 的中文记忆内容。'.repeat(180),
          '记忆尾部',
        ].join(' '),
        projectId: 'proj-001',
        tags: [
          `标签开头${'本地化标签'.repeat(20)}标签尾部`,
        ],
        relatedFiles: [
          `src/${'深层目录/'.repeat(100)}localized-storage-tail.ts`,
        ],
        relatedModules: [
          `模块开头${'本地化模块上下文'.repeat(40)}模块尾部`,
        ],
        citationText: [
          '引用开头',
          '本地化引用细节。'.repeat(120),
          '引用尾部',
        ].join(' '),
        contextPrefix: [
          '前缀开头',
          '本地化上下文前缀。'.repeat(80),
          '前缀尾部',
        ].join(' '),
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const storedContent = memoriesArgs[2] as string;
      const storedTags = JSON.parse(memoriesArgs[4] as string) as string[];
      const storedRelatedFiles = JSON.parse(memoriesArgs[5] as string) as string[];
      const storedRelatedModules = JSON.parse(memoriesArgs[6] as string) as string[];
      const storedCitation = memoriesArgs[19] as string;
      const storedContextPrefix = memoriesArgs[23] as string;
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(storedContent.length).toBeLessThanOrEqual(2000);
      expect(estimateTokens(storedContent)).toBeLessThanOrEqual(500);
      expect(storedContent).toContain('记忆开头');
      expect(storedContent).toContain('记忆尾部');
      expect(storedContent).toContain('memory middle omitted before storage');
      expect(ftsArgs[1]).toBe(storedContent);
      expect(embeddingText).toContain(storedContent);
      expect(storedTags[0]).toContain('标签开头');
      expect(storedTags[0]).toContain('标签尾部');
      expect(estimateTokens(storedTags[0])).toBeLessThanOrEqual(24);
      expect(storedRelatedFiles[0]).toContain('localized-storage-tail.ts');
      expect(storedRelatedFiles[0]).not.toContain('omitted');
      expect(estimateTokens(storedRelatedFiles[0])).toBeLessThanOrEqual(56);
      expect(storedRelatedModules[0]).toContain('模块开头');
      expect(storedRelatedModules[0]).toContain('模块尾部');
      expect(estimateTokens(storedRelatedModules[0])).toBeLessThanOrEqual(32);
      expect(storedCitation).toContain('引用开头');
      expect(storedCitation).toContain('引用尾部');
      expect(estimateTokens(storedCitation)).toBeLessThanOrEqual(250);
      expect(storedContextPrefix).toContain('前缀开头');
      expect(storedContextPrefix).toContain('前缀尾部');
      expect(estimateTokens(storedContextPrefix)).toBeLessThanOrEqual(150);
    });

    it('reuses an exact active duplicate without embedding or inserting again', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ id: 'existing-memory-id' }] })
        .mockResolvedValueOnce({ rows: [] });

      const id = await service.store({
        type: 'gotcha',
        content: 'Avoid duplicate embeddings for the same memory',
        projectId: 'proj-001',
      });

      expect(id).toBe('existing-memory-id');
      expect(mockEmbed).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute.mock.calls[1][0].sql).toContain('access_count = access_count + 1');
    });

    it('deduplicates context_cost memories by cleaned index content', async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [{ id: 'existing-context-cost' }] })
        .mockResolvedValueOnce({ rows: [] });

      const id = await service.store({
        type: 'context_cost',
        content: [
          'High token usage per step: 24k tokens.',
          'npm run typecheck passed.',
          'No issues found.',
        ].join('\n'),
        projectId: 'proj-001',
      });

      const duplicateLookup = mockExecute.mock.calls[0][0];

      expect(id).toBe('existing-context-cost');
      expect(duplicateLookup.sql).toContain('LEFT JOIN memories_fts');
      expect(duplicateLookup.args).toEqual([
        'proj-001',
        'context_cost',
        [
          'High token usage per step: 24k tokens.',
          'npm run typecheck passed.',
          'No issues found.',
        ].join('\n'),
        'High token usage per step: 24k tokens.',
      ]);
      expect(mockEmbed).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
      expect(mockExecute.mock.calls[1][0].sql).toContain('access_count = access_count + 1');
    });

    it('throws if db.batch fails', async () => {
      mockBatch.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.store({ type: 'gotcha', content: 'x', projectId: 'p' }),
      ).rejects.toThrow('DB error');
    });
  });

  // ----------------------------------------------------------
  // search() — query-based (pipeline delegation)
  // ----------------------------------------------------------

  describe('search() with query', () => {
    it('delegates to retrievalPipeline.search() when query is provided', async () => {
      const mockMemory = makeMemoryResult();
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [mockMemory],
        formattedContext: '',
      });

      const filters: MemorySearchFilters = {
        query: 'typescript testing gotcha',
        projectId: 'proj-001',
      };

      const results = await service.search(filters);

      expect(mockRetrievalSearch).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-001');
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it('passes phase and projectId to the pipeline', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({ memories: [], formattedContext: '' });

      await service.search({
        query: 'search term',
        projectId: 'proj-test',
        phase: 'implement',
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('search term', {
        phase: 'implement',
        projectId: 'proj-test',
        maxResults: 8,
      });
    });

    it('normalizes query text and structural filters before pipeline search', async () => {
      const matching = makeMemoryResult({
        id: 'matching',
        type: 'gotcha',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });
      const wrongModule = makeMemoryResult({
        id: 'wrong-module',
        type: 'gotcha',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['billing'],
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [wrongModule, matching],
        formattedContext: '',
      });

      const results = await service.search({
        query: '  auth\n\tmemory   gotcha  ',
        projectId: 'proj-001',
        types: ['gotcha', 'gotcha'],
        relatedFiles: [' ./src/auth//token.ts ', 'src\\auth\\token.ts'],
        relatedModules: [' auth ', 'auth'],
        limit: 2,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('auth memory gotcha', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 10,
      });
      expect(results.map((memory) => memory.id)).toEqual(['matching']);
    });

    it('records access for final query-search results only when requested', async () => {
      const wrongModule = makeMemoryResult({
        id: 'wrong-module',
        relatedModules: ['billing'],
      });
      const matching = makeMemoryResult({
        id: 'matching',
        relatedModules: ['auth'],
      });
      const slicedOut = makeMemoryResult({
        id: 'sliced-out',
        relatedModules: ['auth'],
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [wrongModule, matching, slicedOut],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        relatedModules: ['auth'],
        limit: 1,
        recordAccess: true,
      });

      expect(results.map((memory) => memory.id)).toEqual(['matching']);
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(getAccessBatchMemoryIds()).toEqual(['matching']);
    });

    it('compacts long query searches at the service boundary before pipeline retrieval', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [],
        formattedContext: '',
      });
      const longQuery = `AUTH_QUERY_HEAD ${'verbose query detail '.repeat(120)} AUTH_QUERY_TAIL`;

      await service.search({
        query: longQuery,
        projectId: 'proj-001',
      });

      const query = mockRetrievalSearch.mock.calls[0][0] as string;
      expect(query.length).toBeLessThanOrEqual(800);
      expect(estimateTokens(query)).toBeLessThanOrEqual(200);
      expect(query).toContain('AUTH_QUERY_HEAD');
      expect(query).toContain('AUTH_QUERY_TAIL');
      expect(query).toContain('memory query middle omitted for retrieval budget');
      expect(query).not.toContain('before storage');
    });

    it('folds repeated query lines at the service boundary before pipeline retrieval', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [],
        formattedContext: '',
      });
      const repeatedLine = 'AUTH_QUERY_REPEAT: same stack frame produced no new memory signal.';
      const repeatedQuery = [
        'AUTH_QUERY_HEAD',
        ...Array.from({ length: 120 }, () => repeatedLine),
        'AUTH_QUERY_TAIL',
      ].join('\n');

      await service.search({
        query: repeatedQuery,
        projectId: 'proj-001',
      });

      const query = mockRetrievalSearch.mock.calls[0][0] as string;
      expect(query.length).toBeLessThan(repeatedQuery.length / 4);
      expect(query).toContain('AUTH_QUERY_HEAD');
      expect(query).toContain('AUTH_QUERY_TAIL');
      expect(query).toContain('119 repeated line(s) omitted for prompt budget');
      expect((query.match(/AUTH_QUERY_REPEAT/g) ?? [])).toHaveLength(1);
    });

    it('compacts localized query searches by token budget before pipeline retrieval', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [],
        formattedContext: '',
      });
      const longQuery = [
        '服务查询开头',
        '这是一段会显著增加 token 的中文服务层查询。'.repeat(120),
        '服务查询尾部',
      ].join(' ');

      await service.search({
        query: longQuery,
        projectId: 'proj-001',
      });

      const query = mockRetrievalSearch.mock.calls[0][0] as string;
      expect(query.length).toBeLessThanOrEqual(800);
      expect(estimateTokens(query)).toBeLessThanOrEqual(200);
      expect(query).toContain('服务查询开头');
      expect(query).toContain('服务查询尾部');
      expect(query).toContain('memory query middle omitted for retrieval budget');
    });

    it('does not run a broad search for blank query text', async () => {
      const results = await service.search({
        query: ' \n\t ',
        projectId: 'proj-001',
      });

      expect(results).toEqual([]);
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('does not run query search when normalized limit is zero', async () => {
      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        limit: Number.NaN,
      });

      expect(results).toEqual([]);
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rounds fractional query limits down before candidate expansion and final slicing', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [
          makeMemoryResult({ id: 'first' }),
          makeMemoryResult({ id: 'second' }),
          makeMemoryResult({ id: 'third' }),
        ],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        limit: 2.9,
        promptContextOnly: true,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('auth memory', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 10,
      });
      expect(results.map((memory) => memory.id)).toEqual(['first', 'second']);
    });

    it('caps oversized query limits before retrieval and final slicing', async () => {
      const memories = Array.from({ length: 60 }, (_, index) =>
        makeMemoryResult({ id: `memory-${index}` }),
      );
      mockRetrievalSearch.mockResolvedValueOnce({
        memories,
        formattedContext: '',
      });

      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        limit: 10_000,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('auth memory', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 50,
      });
      expect(results).toHaveLength(50);
    });


    it('applies minConfidence post-filter', async () => {
      const highConf = makeMemoryResult({ id: 'high', confidence: 0.95 });
      const lowConf = makeMemoryResult({ id: 'low', confidence: 0.5 });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [highConf, lowConf],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'test',
        projectId: 'proj-001',
        minConfidence: 0.8,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('high');
    });

    it('ignores non-finite minConfidence for query search', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [
          makeMemoryResult({ id: 'low', confidence: 0.2 }),
          makeMemoryResult({ id: 'high', confidence: 0.9 }),
        ],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'test',
        projectId: 'proj-001',
        minConfidence: Number.NaN,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('test', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 8,
      });
      expect(results.map((memory) => memory.id)).toEqual(['low', 'high']);
    });

    it('clamps query minConfidence above one before filtering', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [
          makeMemoryResult({ id: 'almost', confidence: 0.99 }),
          makeMemoryResult({ id: 'perfect', confidence: 1 }),
        ],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'test',
        projectId: 'proj-001',
        minConfidence: 1.5,
      });

      expect(results.map((memory) => memory.id)).toEqual(['perfect']);
    });

    it('applies excludeDeprecated post-filter', async () => {
      const active = makeMemoryResult({ id: 'active', deprecated: false });
      const deprecated = makeMemoryResult({ id: 'deprecated', deprecated: true });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [active, deprecated],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'test',
        projectId: 'proj-001',
        excludeDeprecated: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('active');
    });

    it('filters query results to prompt-eligible memories when requested', async () => {
      const trusted = makeMemoryResult({ id: 'trusted', content: 'Trusted memory should remain.' });
      const lowConfidence = makeMemoryResult({
        id: 'low-confidence',
        content: 'Low confidence memory should be omitted.',
        confidence: 0.2,
      });
      const pendingReview = makeMemoryResult({
        id: 'pending-review',
        content: 'Pending review memory should be omitted.',
        needsReview: true,
      });
      const stale = makeMemoryResult({
        id: 'stale',
        content: 'Stale memory should be omitted.',
        staleAt: '2000-01-01T00:00:00.000Z',
      });
      const verified = makeMemoryResult({
        id: 'verified',
        content: 'Verified memory should remain.',
        confidence: 0.2,
        needsReview: true,
        userVerified: true,
      });
      const prefetch = makeMemoryResult({
        id: 'prefetch',
        type: 'prefetch_pattern',
        content: JSON.stringify({
          alwaysReadFiles: ['src/auth/session.ts'],
          frequentlyReadFiles: ['src/auth/token.ts'],
        }),
      });
      const contextCost = makeMemoryResult({
        id: 'context-cost',
        type: 'context_cost',
        content: 'High token usage per step should be omitted from prompt context.',
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [trusted, lowConfidence, pendingReview, stale, verified, prefetch, contextCost],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        promptContextOnly: true,
      });

      expect(results.map((memory) => memory.id)).toEqual(['trusted', 'verified']);
    });

    it('fetches extra query candidates for prompt-context searches before applying the final limit', async () => {
      const lowConfidence = makeMemoryResult({
        id: 'low-confidence',
        content: 'Low confidence memory should be skipped before limiting.',
        confidence: 0.2,
      });
      const pendingReview = makeMemoryResult({
        id: 'pending-review',
        content: 'Pending review memory should be skipped before limiting.',
        needsReview: true,
      });
      const trusted = makeMemoryResult({ id: 'trusted', content: 'Trusted memory should remain.' });
      const verified = makeMemoryResult({
        id: 'verified',
        content: 'Verified memory should remain.',
        confidence: 0.2,
        needsReview: true,
        userVerified: true,
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [lowConfidence, pendingReview, trusted, verified],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'auth memory',
        projectId: 'proj-001',
        limit: 2,
        promptContextOnly: true,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('auth memory', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 10,
      });
      expect(results.map((memory) => memory.id)).toEqual(['trusted', 'verified']);
    });

    it('applies custom filter callback', async () => {
      const mem1 = makeMemoryResult({ id: 'mem1', type: 'gotcha' });
      const mem2 = makeMemoryResult({ id: 'mem2', type: 'decision' });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [mem1, mem2],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'test',
        projectId: 'proj-001',
        filter: (m) => m.type === 'gotcha',
      });

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('gotcha');
    });

    it('applies structural filters after query-based retrieval', async () => {
      const matching = makeMemoryResult({
        id: 'matching',
        type: 'gotcha',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });
      const wrongType = makeMemoryResult({
        id: 'wrong-type',
        type: 'decision',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });
      const wrongFile = makeMemoryResult({
        id: 'wrong-file',
        type: 'gotcha',
        relatedFiles: ['src/billing.ts'],
        relatedModules: ['billing'],
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [matching, wrongType, wrongFile],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'token gotcha',
        projectId: 'proj-001',
        types: ['gotcha'],
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });

      expect(results.map((memory) => memory.id)).toEqual(['matching']);
    });

    it('matches query related-file filters across absolute and relative path variants', async () => {
      const matching = makeMemoryResult({
        id: 'matching',
        type: 'gotcha',
        relatedFiles: ['src/auth/token.ts'],
      });
      const wrongFile = makeMemoryResult({
        id: 'wrong-file',
        type: 'gotcha',
        relatedFiles: ['src/auth/session.ts'],
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [wrongFile, matching],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'token gotcha',
        projectId: 'proj-001',
        relatedFiles: ['E:\\Work\\Project\\src\\auth\\token.ts'],
      });

      expect(results.map((memory) => memory.id)).toEqual(['matching']);
    });

    it('fetches extra query candidates before applying structural filters and final limit', async () => {
      const wrongType = makeMemoryResult({
        id: 'wrong-type',
        type: 'decision',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });
      const wrongModule = makeMemoryResult({
        id: 'wrong-module',
        type: 'gotcha',
        relatedFiles: ['src/billing.ts'],
        relatedModules: ['billing'],
      });
      const matchingOne = makeMemoryResult({
        id: 'matching-one',
        type: 'gotcha',
        relatedFiles: ['src/auth/token.ts'],
        relatedModules: ['auth'],
      });
      const matchingTwo = makeMemoryResult({
        id: 'matching-two',
        type: 'gotcha',
        relatedFiles: ['src/auth/session.ts'],
        relatedModules: ['auth'],
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [wrongType, wrongModule, matchingOne, matchingTwo],
        formattedContext: '',
      });

      const results = await service.search({
        query: 'token gotcha',
        projectId: 'proj-001',
        types: ['gotcha'],
        relatedModules: ['auth'],
        limit: 2,
      });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('token gotcha', {
        phase: 'explore',
        projectId: 'proj-001',
        maxResults: 10,
      });
      expect(results.map((memory) => memory.id)).toEqual(['matching-one', 'matching-two']);
    });
  });

  // ----------------------------------------------------------
  // search() — filter-only (direct SQL)
  // ----------------------------------------------------------

  describe('search() with filters only (no query)', () => {
    it('performs direct SQL query when no query string is given', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [makeMemoryRow()] });

      const filters: MemorySearchFilters = {
        projectId: 'proj-001',
        scope: 'global',
        types: ['gotcha'],
      };

      const results = await service.search(filters);

      expect(mockRetrievalSearch).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
    });

    it('normalizes legacy row metadata before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            tags: '[" auth ","AUTH","auth","","typescript"," TYPESCRIPT "]',
            related_files: '[" ./src/auth//token.ts ","src\\\\auth\\\\token.ts","src/auth/session.ts/",""]',
            related_modules: '[" auth ","AUTH","","billing"]',
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].tags).toEqual(['auth', 'typescript']);
      expect(results[0].relatedFiles).toEqual(['src/auth/token.ts', 'src/auth/session.ts']);
      expect(results[0].relatedModules).toEqual(['auth', 'billing']);
    });

    it('tolerates legacy row metadata that is not a string array', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'bad-metadata',
            tags: '"auth"',
            related_files: '{"path":"src/auth/token.ts"}',
            related_modules: '[123," auth ",null,"billing"]',
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].id).toBe('bad-metadata');
      expect(results[0].tags).toEqual([]);
      expect(results[0].relatedFiles).toEqual([]);
      expect(results[0].relatedModules).toEqual(['auth', 'billing']);
    });

    it('compacts legacy row text payloads before returning memories', async () => {
      const longContent = `content-start ${'x'.repeat(4_000)} content-end`;
      const longCitation = `citation-start ${'y'.repeat(2_000)} citation-end`;
      const longContext = `context-start ${'z'.repeat(1_200)} context-end`;

      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            content: `  ${longContent}  `,
            citation_text: `  ${longCitation}  `,
            context_prefix: `  ${longContext}  `,
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });
      const memory = results[0];

      expect(memory.content.length).toBeLessThanOrEqual(2_000);
      expect(memory.content).toContain('content-start');
      expect(memory.content).toContain('content-end');
      expect(memory.content).toContain('[memory middle omitted before storage]');
      expect(memory.citationText?.length).toBeLessThanOrEqual(1_000);
      expect(memory.citationText).toContain('citation-start');
      expect(memory.citationText).toContain('citation-end');
      expect(memory.contextPrefix?.length).toBeLessThanOrEqual(600);
      expect(memory.contextPrefix).toContain('context-start');
      expect(memory.contextPrefix).toContain('context-end');
    });

    it('normalizes legacy row confidence before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: 'string-confidence', confidence: '0.25' }),
          makeMemoryRow({ id: 'bad-confidence', confidence: 'not-a-number' }),
          makeMemoryRow({ id: 'high-confidence', confidence: 1.5 }),
          makeMemoryRow({ id: 'negative-confidence', confidence: -0.2 }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results.map((memory) => [memory.id, memory.confidence])).toEqual([
        ['string-confidence', 0.25],
        ['bad-confidence', 0.8],
        ['high-confidence', 1],
        ['negative-confidence', 0],
      ]);
    });

    it('normalizes legacy row boolean flags before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'boolean-flags',
            needs_review: Number.NaN,
            user_verified: '1',
            pinned: 'true',
            deprecated: '0',
          }),
          makeMemoryRow({
            id: 'invalid-boolean-flags',
            needs_review: 'yes',
            user_verified: Number.NaN,
            pinned: 0,
            deprecated: 1,
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(
        results.map((memory) => [
          memory.id,
          memory.needsReview,
          memory.userVerified,
          memory.pinned,
          memory.deprecated,
        ]),
      ).toEqual([
        ['boolean-flags', false, true, true, false],
        ['invalid-boolean-flags', false, false, false, true],
      ]);
    });

    it('normalizes legacy row timestamps before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            created_at: 'not-a-date',
            last_accessed_at: ' 2024-02-03T04:05:06Z ',
            deprecated_at: 'also-not-a-date',
            stale_at: '2024-03-04T05:06:07Z',
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].createdAt).toBe('1970-01-01T00:00:00.000Z');
      expect(results[0].lastAccessedAt).toBe('2024-02-03T04:05:06.000Z');
      expect(results[0].deprecatedAt).toBeUndefined();
      expect(results[0].staleAt).toBe('2024-03-04T05:06:07.000Z');
    });

    it('normalizes legacy provenance and relation arrays before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            provenance_session_ids: '[" session-a ","session-a",42,"session-b"]',
            impacted_node_ids: '[" node-a ","node-a",null,"node-b"]',
            relations: JSON.stringify([
              {
                relationType: 'validates',
                targetFilePath: ' ./src/auth//token.ts ',
                confidence: 1.5,
                autoExtracted: true,
              },
              {
                relationType: 'derived_from',
                targetMemoryId: ' parent-memory ',
                confidence: 'bad',
                autoExtracted: false,
              },
              { relationType: 'unknown', targetMemoryId: 'ignored' },
              { relationType: 'conflicts_with', confidence: 0.9 },
              'not-a-relation',
            ]),
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].provenanceSessionIds).toEqual(['session-a', 'session-b']);
      expect(results[0].impactedNodeIds).toEqual(['node-a', 'node-b']);
      expect(results[0].relations).toEqual([
        {
          relationType: 'validates',
          targetFilePath: 'src/auth/token.ts',
          confidence: 1,
          autoExtracted: true,
        },
        {
          relationType: 'derived_from',
          targetMemoryId: 'parent-memory',
          confidence: 0.8,
          autoExtracted: false,
        },
      ]);
    });

    it('deduplicates and caps legacy row relations before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            relations: JSON.stringify([
              {
                relationType: 'validates',
                targetFilePath: ' ./src/auth//token.ts ',
                confidence: 0.4,
                autoExtracted: true,
              },
              {
                relationType: 'validates',
                targetFilePath: 'SRC\\auth\\token.ts',
                confidence: 0.98,
                autoExtracted: false,
              },
              ...Array.from({ length: 20 }, (_, index) => ({
                relationType: 'required_with',
                targetFilePath: `src/relation/${index}/${'deep-segment/'.repeat(30)}tail-${index}.ts`,
                confidence: 0.8,
                autoExtracted: true,
              })),
            ]),
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });
      const relations = results[0].relations ?? [];

      expect(relations).toHaveLength(16);
      expect(relations[0]).toEqual({
        relationType: 'validates',
        targetFilePath: 'src/auth/token.ts',
        confidence: 0.98,
        autoExtracted: false,
      });
      expect(relations.every((relation) => (relation.targetFilePath?.length ?? 0) <= 220)).toBe(true);
      expect(relations.every((relation) => estimateTokens(relation.targetFilePath ?? '') <= 56)).toBe(true);
      expect(relations.some((relation) => relation.targetFilePath?.includes('tail-14.ts'))).toBe(true);
      expect(relations.some((relation) => relation.targetFilePath?.includes('tail-15.ts'))).toBe(false);
    });

    it('normalizes legacy work-unit and chunk fields before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'valid-structured-fields',
            work_unit_ref: JSON.stringify({
              methodology: ' native ',
              hierarchy: [' root ', 42, 'task', 'task'],
              label: ' implement memory ',
            }),
            methodology: ' native ',
            decay_half_life_days: '14.5',
            chunk_type: 'function',
            chunk_start_line: '10.9',
            chunk_end_line: '20.1',
          }),
          makeMemoryRow({
            id: 'invalid-structured-fields',
            work_unit_ref: '"not-a-ref"',
            methodology: '   ',
            decay_half_life_days: -1,
            chunk_type: 'unknown',
            chunk_start_line: 'NaN',
            chunk_end_line: -4,
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].workUnitRef).toEqual({
        methodology: 'native',
        hierarchy: ['root', 'task'],
        label: 'implement memory',
      });
      expect(results[0].methodology).toBe('native');
      expect(results[0].decayHalfLifeDays).toBe(14.5);
      expect(results[0].chunkType).toBe('function');
      expect(results[0].chunkStartLine).toBe(10);
      expect(results[0].chunkEndLine).toBe(20);

      expect(results[1].workUnitRef).toBeUndefined();
      expect(results[1].methodology).toBeUndefined();
      expect(results[1].decayHalfLifeDays).toBeUndefined();
      expect(results[1].chunkType).toBeUndefined();
      expect(results[1].chunkStartLine).toBeUndefined();
      expect(results[1].chunkEndLine).toBeUndefined();
    });

    it('compacts legacy work-unit metadata before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'verbose-work-unit',
            work_unit_ref: JSON.stringify({
              methodology: `WORK_UNIT_METHOD_HEAD ${'legacy methodology detail '.repeat(30)} WU_TAIL`,
              hierarchy: [
                'Spec 001',
                ' spec 001 ',
                ...Array.from(
                  { length: 12 },
                  (_, index) => `Task ${index} ${'legacy hierarchy detail '.repeat(20)}tail-${index}`,
                ),
              ],
              label: `WORK_UNIT_LABEL_HEAD ${'legacy work unit label detail '.repeat(60)} WORK_UNIT_LABEL_TAIL`,
            }),
            methodology: `METHODOLOGY_HEAD ${'legacy top methodology detail '.repeat(30)} METHODOLOGY_TAIL`,
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });
      const memory = results[0];

      expect(memory.methodology?.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(memory.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(memory.methodology).toContain('METHODOLOGY_HEAD');
      expect(memory.methodology).toContain('METHODOLOGY_TAIL');
      expect(memory.workUnitRef?.methodology.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(memory.workUnitRef?.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(memory.workUnitRef?.methodology).toContain('WORK_UNIT_METHOD_HEAD');
      expect(memory.workUnitRef?.methodology).toContain('WU_TAIL');
      expect(memory.workUnitRef?.hierarchy).toHaveLength(8);
      expect(memory.workUnitRef?.hierarchy[0]).toBe('Spec 001');
      expect(memory.workUnitRef?.hierarchy).not.toContain('spec 001');
      expect(memory.workUnitRef?.hierarchy.every((item) => item.length <= 120)).toBe(true);
      expect(memory.workUnitRef?.hierarchy.every((item) => estimateTokens(item) <= 32)).toBe(true);
      expect(memory.workUnitRef?.label.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(memory.workUnitRef?.label ?? '')).toBeLessThanOrEqual(75);
      expect(memory.workUnitRef?.label).toContain('WORK_UNIT_LABEL_HEAD');
      expect(memory.workUnitRef?.label).toContain('WORK_UNIT_LABEL_TAIL');
    });

    it('normalizes legacy enum fields before returning memories', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'invalid-enums',
            type: 'obsolete_type',
            source: 'old_source',
            scope: 'workspace',
          }),
        ],
      });

      const results = await service.search({ projectId: 'proj-001' });

      expect(results[0].id).toBe('invalid-enums');
      expect(results[0].type).toBe('gotcha');
      expect(results[0].source).toBe('agent_explicit');
      expect(results[0].scope).toBe('global');
    });

    it('filters by type in direct SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ types: ['decision', 'gotcha'] });

      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('type IN (?, ?)');
    });

    it('deduplicates direct-search type and source filters before SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({
        types: ['gotcha', 'gotcha', 'decision'],
        sources: ['agent_explicit', 'agent_explicit'],
      });

      const call = mockExecute.mock.calls[0][0];
      const sql = call.sql as string;
      const args = call.args as unknown[];
      expect(sql).toContain('type IN (?, ?)');
      expect(sql).toContain('source IN (?)');
      expect(args).toEqual(['gotcha', 'decision', 'agent_explicit', 50]);
    });

    it('does not run direct search when normalized limit is zero', async () => {
      const results = await service.search({
        projectId: 'proj-001',
        limit: -1,
      });

      expect(results).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
    });

    it('rounds fractional direct-search limits down before SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({
        projectId: 'proj-001',
        limit: 2.9,
      });

      const args = mockExecute.mock.calls[0][0].args as unknown[];
      expect(args[args.length - 1]).toBe(2);
    });

    it('caps oversized direct-search limits before SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({
        projectId: 'proj-001',
        limit: 10_000,
      });

      const args = mockExecute.mock.calls[0][0].args as unknown[];
      expect(args[args.length - 1]).toBe(50);
    });


    it('omits non-finite direct-search minConfidence from SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({
        projectId: 'proj-001',
        minConfidence: Number.NaN,
      });

      const call = mockExecute.mock.calls[0][0];
      const sql = call.sql as string;
      const args = call.args as unknown[];
      expect(sql).not.toContain('confidence >= ?');
      expect(args).toEqual(['proj-001', 50]);
    });

    it('clamps direct-search minConfidence above one before SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({
        projectId: 'proj-001',
        minConfidence: 1.5,
      });

      const call = mockExecute.mock.calls[0][0];
      const sql = call.sql as string;
      const args = call.args as unknown[];
      expect(sql).toContain('confidence >= ?');
      expect(args).toEqual(['proj-001', 1, 50]);
    });

    it('filters by scope in direct SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ scope: 'module' });

      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('scope = ?');
    });

    it('filters by projectId in direct SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ projectId: 'proj-abc' });

      const args = mockExecute.mock.calls[0][0].args as string[];
      expect(args).toContain('proj-abc');
    });

    it('sorts by recency when sort=recency', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ sort: 'recency' });

      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('created_at DESC');
    });

    it('sorts by confidence when sort=confidence', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ sort: 'confidence' });

      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('confidence DESC');
    });

    it('filters direct-search results to prompt-eligible memories when requested', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: 'trusted', content: 'Trusted memory should remain.' }),
          makeMemoryRow({
            id: 'low-confidence',
            content: 'Low confidence memory should be omitted.',
            confidence: 0.2,
          }),
          makeMemoryRow({
            id: 'pending-review',
            content: 'Pending review memory should be omitted.',
            needs_review: 1,
          }),
          makeMemoryRow({
            id: 'stale',
            content: 'Stale memory should be omitted.',
            stale_at: '2000-01-01T00:00:00.000Z',
          }),
          makeMemoryRow({
            id: 'verified',
            content: 'Verified memory should remain.',
            confidence: 0.2,
            needs_review: 1,
            user_verified: 1,
          }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        promptContextOnly: true,
      });

      expect(results.map((memory) => memory.id)).toEqual(['trusted', 'verified']);
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it('fetches extra direct-search candidates for prompt-context searches before applying the final limit', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'low-confidence',
            content: 'Low confidence memory should be skipped before limiting.',
            confidence: 0.2,
          }),
          makeMemoryRow({
            id: 'pending-review',
            content: 'Pending review memory should be skipped before limiting.',
            needs_review: 1,
          }),
          makeMemoryRow({ id: 'trusted', content: 'Trusted memory should remain.' }),
          makeMemoryRow({
            id: 'verified',
            content: 'Verified memory should remain.',
            confidence: 0.2,
            needs_review: 1,
            user_verified: 1,
          }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        limit: 2,
        promptContextOnly: true,
      });

      const directSearchArgs = mockExecute.mock.calls[0][0].args as unknown[];
      expect(directSearchArgs[directSearchArgs.length - 1]).toBe(10);
      expect(results.map((memory) => memory.id)).toEqual(['trusted', 'verified']);
    });

    it('records access for final direct-search results only when requested', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'low-confidence',
            content: 'Low confidence memory should not be counted.',
            confidence: 0.2,
          }),
          makeMemoryRow({ id: 'trusted-one', content: 'Trusted memory should be counted.' }),
          makeMemoryRow({ id: 'trusted-two', content: 'Second trusted memory should be sliced out.' }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        limit: 1,
        promptContextOnly: true,
        recordAccess: true,
      });

      expect(results.map((memory) => memory.id)).toEqual(['trusted-one']);
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(getAccessBatchMemoryIds()).toEqual(['trusted-one']);
    });

    it('fetches extra direct-search candidates before applying related-file filters and final limit', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: 'wrong-file-1', related_files: '["src/other-a.ts"]' }),
          makeMemoryRow({ id: 'wrong-file-2', related_files: '["src/other-b.ts"]' }),
          makeMemoryRow({ id: 'matching-one', related_files: '["src/auth/token.ts"]' }),
          makeMemoryRow({ id: 'matching-two', related_files: '["src/auth/token.ts"]' }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        relatedFiles: ['src/auth/token.ts'],
        limit: 2,
      });

      const directSearchArgs = mockExecute.mock.calls[0][0].args as unknown[];
      expect(directSearchArgs[directSearchArgs.length - 1]).toBe(10);
      expect(results.map((memory) => memory.id)).toEqual(['matching-one', 'matching-two']);
    });

    it('matches direct related-file filters across absolute and relative path variants', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: 'matching', related_files: '["E:\\\\Work\\\\Project\\\\src\\\\auth\\\\token.ts"]' }),
          makeMemoryRow({ id: 'wrong-file', related_files: '["src/auth/session.ts"]' }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        relatedFiles: ['./src/auth/token.ts'],
      });

      expect(results.map((memory) => memory.id)).toEqual(['matching']);
    });

    it('keeps long direct related-file filters as suffixes for path matching', async () => {
      const longPath = `E:/Work/Project/src/${'deep/'.repeat(80)}auth/token-refresh-service.ts`;
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: 'matching', related_files: JSON.stringify([longPath]) }),
          makeMemoryRow({ id: 'wrong-file', related_files: '["src/auth/session.ts"]' }),
        ],
      });

      const results = await service.search({
        projectId: 'proj-001',
        relatedFiles: [longPath],
      });

      expect(results.map((memory) => memory.id)).toEqual(['matching']);
      expect(results[0].relatedFiles[0].length).toBeLessThanOrEqual(220);
      expect(longPath.toLowerCase().endsWith(results[0].relatedFiles[0].toLowerCase())).toBe(true);
      expect(results[0].relatedFiles[0]).not.toContain('omitted');
    });

    it('returns empty array if db fails', async () => {
      mockExecute.mockRejectedValueOnce(new Error('DB down'));

      const results = await service.search({ projectId: 'proj-001' });

      expect(results).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // searchByPattern()
  // ----------------------------------------------------------

  describe('searchByPattern()', () => {
    it('returns null without BM25 for blank patterns', async () => {
      const result = await service.searchByPattern(' \n\t ');

      expect(result).toBeNull();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('returns null when no BM25 results', async () => {
      // searchBM25 calls db.execute
      mockExecute.mockResolvedValueOnce({ rows: [] });

      const result = await service.searchByPattern('some pattern');

      expect(result).toBeNull();
    });

    it('returns a memory when BM25 finds a match', async () => {
      // First execute: BM25 result
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 'mem-001', bm25_score: -1.5 }],
      });
      // Second execute: fetch full memory
      mockExecute.mockResolvedValueOnce({ rows: [makeMemoryRow()] });

      const result = await service.searchByPattern('typescript testing');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('mem-001');
      const bm25Args = mockExecute.mock.calls[0][0].args as unknown[];
      expect(bm25Args[bm25Args.length - 1]).toBe(6);
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(getAccessBatchMemoryIds()).toEqual(['mem-001']);
    });

    it('can skip access recording for BM25 pattern matches used as candidates', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 'mem-001', bm25_score: -1.5 }],
      });
      mockExecute.mockResolvedValueOnce({ rows: [makeMemoryRow()] });

      const result = await service.searchByPattern('typescript testing', { recordAccess: false });

      expect(result?.id).toBe('mem-001');
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it('passes projectId to BM25 pattern search when provided', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 'mem-001', bm25_score: -1.5 }],
      });
      mockExecute.mockResolvedValueOnce({ rows: [makeMemoryRow()] });

      await service.searchByPattern('typescript testing', { projectId: 'project-patterns' });

      const bm25Args = mockExecute.mock.calls[0][0].args as unknown[];
      expect(bm25Args).toEqual(['typescript testing', 'project-patterns', 6]);
    });

    it('normalizes pattern whitespace before BM25 search', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.searchByPattern('  typescript\n\ttesting  ');

      const bm25Args = mockExecute.mock.calls[0][0].args as unknown[];
      expect(bm25Args[0]).toBe('typescript testing');
    });

    it('returns null if the fetched memory is deprecated', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 'mem-001', bm25_score: -1.5 }],
      });
      // Memory fetch returns empty (deprecated = 0 condition excludes it)
      mockExecute.mockResolvedValueOnce({ rows: [] });

      const result = await service.searchByPattern('test');

      expect(result).toBeNull();
    });

    it('returns null for memories that are not eligible for prompt context', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [{ id: 'mem-001', bm25_score: -1.5 }],
      });
      mockExecute.mockResolvedValueOnce({
        rows: [makeMemoryRow({
          confidence: 0.2,
          content: 'Low confidence pattern should not be injected.',
        })],
      });

      const result = await service.searchByPattern('low confidence pattern');

      expect(result).toBeNull();
    });

    it('falls through to the next BM25 candidate when the top match is not prompt-eligible', async () => {
      mockExecute.mockResolvedValueOnce({
        rows: [
          { id: 'low-confidence', bm25_score: -2.0 },
          { id: 'trusted', bm25_score: -1.7 },
        ],
      });
      mockExecute.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({
            id: 'trusted',
            content: 'Trusted pattern should be injected.',
            confidence: 0.9,
          }),
          makeMemoryRow({
            id: 'low-confidence',
            content: 'Low confidence pattern should not be injected.',
            confidence: 0.2,
          }),
        ],
      });

      const result = await service.searchByPattern('auth pattern');

      expect(result?.id).toBe('trusted');
      expect(result?.content).toBe('Trusted pattern should be injected.');
      const fetchArgs = mockExecute.mock.calls[1][0].args as unknown[];
      expect(fetchArgs).toEqual(['low-confidence', 'trusted']);
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(getAccessBatchMemoryIds()).toEqual(['trusted']);
    });
  });

  // ----------------------------------------------------------
  // insertUserTaught()
  // ----------------------------------------------------------

  describe('insertUserTaught()', () => {
    it('stores a preference memory with correct defaults', async () => {
      const id = await service.insertUserTaught(
        'Always use bun over npm',
        'proj-001',
        ['tooling'],
      );

      expect(typeof id).toBe('string');
      expect(mockBatch).toHaveBeenCalledOnce();

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args as unknown[];
      // type = 'preference'
      expect(memoriesArgs).toContain('preference');
      // source = 'user_taught'
      expect(memoriesArgs).toContain('user_taught');
      // confidence = 1.0
      expect(memoriesArgs).toContain(1.0);
      // scope = 'global'
      expect(memoriesArgs).toContain('global');
    });
  });

  // ----------------------------------------------------------
  // searchWorkflowRecipe()
  // ----------------------------------------------------------

  describe('searchWorkflowRecipe()', () => {
    it('returns empty array without retrieval for blank task descriptions', async () => {
      const results = await service.searchWorkflowRecipe(' \n\t ');

      expect(results).toEqual([]);
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
    });

    it('returns empty array without retrieval when limit is zero', async () => {
      const results = await service.searchWorkflowRecipe('deploy task', { limit: 0 });

      expect(results).toEqual([]);
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
    });

    it('returns empty array without retrieval for non-finite workflow recipe limits', async () => {
      const results = await service.searchWorkflowRecipe('deploy task', { limit: Number.NaN });

      expect(results).toEqual([]);
      expect(mockRetrievalSearch).not.toHaveBeenCalled();
    });

    it('returns workflow_recipe memories', async () => {
      const recipe = makeMemoryResult({ id: 'recipe-001', type: 'workflow_recipe' });
      const other = makeMemoryResult({ id: 'other-001', type: 'gotcha' });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [recipe, other],
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('deploy to production');

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('workflow_recipe');
    });

    it('can skip access recording for workflow recipes used as candidates', async () => {
      const recipe = makeMemoryResult({ id: 'recipe-001', type: 'workflow_recipe' });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [recipe],
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('deploy to production', { recordAccess: false });

      expect(results.map((memory) => memory.id)).toEqual(['recipe-001']);
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it('respects limit option', async () => {
      const recipes = Array.from({ length: 10 }, (_, i) =>
        makeMemoryResult({ id: `recipe-${i}`, type: 'workflow_recipe' }),
      );
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: recipes,
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('task', { limit: 3 });

      expect(results).toHaveLength(3);
    });

    it('rounds fractional workflow recipe limits down before retrieval and slicing', async () => {
      const recipes = Array.from({ length: 3 }, (_, i) =>
        makeMemoryResult({ id: `recipe-${i}`, type: 'workflow_recipe' }),
      );
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: recipes,
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('task', { limit: 2.9 });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('task', {
        phase: 'implement',
        projectId: '',
        maxResults: 10,
      });
      expect(results.map((memory) => memory.id)).toEqual(['recipe-0', 'recipe-1']);
    });

    it('caps oversized workflow recipe limits before retrieval and slicing', async () => {
      const recipes = Array.from({ length: 25 }, (_, i) =>
        makeMemoryResult({ id: `recipe-${i}`, type: 'workflow_recipe' }),
      );
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: recipes,
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('task', { limit: 10_000 });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('task', {
        phase: 'implement',
        projectId: '',
        maxResults: 50,
      });
      expect(results).toHaveLength(20);
    });


    it('normalizes task description before workflow recipe retrieval', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [],
        formattedContext: '',
      });

      await service.searchWorkflowRecipe('  deploy\n\tto   production  ', { limit: 2 });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('deploy to production', {
        phase: 'implement',
        projectId: '',
        maxResults: 10,
      });
    });

    it('passes projectId to workflow recipe retrieval', async () => {
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [],
        formattedContext: '',
      });

      await service.searchWorkflowRecipe('task', { limit: 2, projectId: 'proj-recipes' });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('task', {
        phase: 'implement',
        projectId: 'proj-recipes',
        maxResults: 10,
      });
    });

    it('fetches extra workflow candidates before applying type and prompt-context filters', async () => {
      const nonRecipe = makeMemoryResult({ id: 'not-recipe', type: 'gotcha' });
      const lowConfidenceRecipe = makeMemoryResult({
        id: 'recipe-low',
        type: 'workflow_recipe',
        content: 'Low confidence recipe should not be used.',
        confidence: 0.2,
      });
      const trustedRecipe = makeMemoryResult({
        id: 'recipe-trusted',
        type: 'workflow_recipe',
        content: 'Trusted recipe should be used.',
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [nonRecipe, lowConfidenceRecipe, trustedRecipe],
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('task', { limit: 1, projectId: 'proj-recipes' });

      expect(mockRetrievalSearch).toHaveBeenCalledWith('task', {
        phase: 'implement',
        projectId: 'proj-recipes',
        maxResults: 9,
      });
      expect(results.map((memory) => memory.id)).toEqual(['recipe-trusted']);
    });

    it('filters workflow recipes that are not eligible for prompt context', async () => {
      const good = makeMemoryResult({
        id: 'recipe-good',
        type: 'workflow_recipe',
        content: 'Trusted recipe should remain.',
      });
      const lowConfidence = makeMemoryResult({
        id: 'recipe-low',
        type: 'workflow_recipe',
        content: 'Low confidence recipe should not be used.',
        confidence: 0.2,
      });
      const pendingReview = makeMemoryResult({
        id: 'recipe-review',
        type: 'workflow_recipe',
        content: 'Pending review recipe should not be used.',
        needsReview: true,
      });
      const stale = makeMemoryResult({
        id: 'recipe-stale',
        type: 'workflow_recipe',
        content: 'Stale recipe should not be used.',
        staleAt: '2000-01-01T00:00:00.000Z',
      });
      const verified = makeMemoryResult({
        id: 'recipe-verified',
        type: 'workflow_recipe',
        content: 'Verified recipe should remain.',
        confidence: 0.2,
        needsReview: true,
        userVerified: true,
      });
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [good, lowConfidence, pendingReview, stale, verified],
        formattedContext: '',
      });

      const results = await service.searchWorkflowRecipe('task', { limit: 5 });

      expect(results.map((memory) => memory.id)).toEqual(['recipe-good', 'recipe-verified']);
      expect(mockBatch).toHaveBeenCalledOnce();
      expect(getAccessBatchMemoryIds()).toEqual(['recipe-good', 'recipe-verified']);
    });

    it('returns empty array on pipeline failure', async () => {
      mockRetrievalSearch.mockRejectedValueOnce(new Error('Pipeline error'));

      const results = await service.searchWorkflowRecipe('task');

      expect(results).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // updateAccessCount()
  // ----------------------------------------------------------

  describe('updateAccessCount()', () => {
    it('executes an UPDATE query to increment access_count', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.updateAccessCount('mem-001');

      expect(mockExecute).toHaveBeenCalledOnce();
      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('access_count = access_count + 1');
      expect(sql).toContain('last_accessed_at');
    });

    it('does not throw on DB failure', async () => {
      mockExecute.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.updateAccessCount('mem-001')).resolves.toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // deprecateMemory()
  // ----------------------------------------------------------

  describe('deprecateMemory()', () => {
    it('sets deprecated=1 and deprecated_at', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.deprecateMemory('mem-001');

      expect(mockExecute).toHaveBeenCalledOnce();
      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('deprecated = 1');
      expect(sql).toContain('deprecated_at');
    });

    it('does not throw on DB failure', async () => {
      mockExecute.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.deprecateMemory('mem-001')).resolves.toBeUndefined();
    });
  });
});
