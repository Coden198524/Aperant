/**
 * MemoryServiceImpl Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@libsql/client';
import type { Memory, MemoryRecordEntry, MemorySearchFilters } from '../types';
import type { EmbeddingService } from '../embedding-service';
import type { RetrievalPipeline } from '../retrieval/pipeline';
import { MemoryServiceImpl } from '../memory-service';

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
      });

      const batchArgs = mockBatch.mock.calls[0][0];
      const memoriesArgs = batchArgs[0].args;
      const ftsArgs = batchArgs[1].args;
      const storedRelatedFiles = JSON.parse(memoriesArgs[5] as string) as string[];
      const embeddingText = mockEmbed.mock.calls[0][0] as string;

      expect(storedRelatedFiles).toEqual(['src/auth/token.ts', 'src/auth/session.ts']);
      expect(ftsArgs[3]).toBe('src/auth/token.ts src/auth/session.ts');
      expect(embeddingText).toContain('Files: src/auth/token.ts, src/auth/session.ts');
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
          'auth',
          'auth',
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
      expect(storedContent).toContain('MEMORY_HEAD');
      expect(storedContent).toContain('MEMORY_TAIL');
      expect(storedContent).toContain('memory middle omitted before storage');
      expect(ftsArgs[1]).toBe(storedContent);
      expect(embeddingText).toContain(storedContent);
      expect(embeddingText).not.toContain('verbose implementation detail\n'.repeat(120));

      expect(storedTags).toHaveLength(20);
      expect(new Set(storedTags).size).toBe(storedTags.length);
      expect(storedTags.every((tag) => tag.length <= 64)).toBe(true);
      expect(storedRelatedFiles).toHaveLength(24);
      expect(storedRelatedFiles.every((file) => file.length <= 220)).toBe(true);
      expect(storedRelatedModules).toHaveLength(16);
      expect(storedRelatedModules.every((module) => module.length <= 96)).toBe(true);
      expect(storedCitation.length).toBeLessThanOrEqual(1000);
      expect(storedCitation).toContain('CITATION_HEAD');
      expect(storedCitation).toContain('CITATION_TAIL');
      expect(storedContextPrefix.length).toBeLessThanOrEqual(600);
      expect(storedContextPrefix).toContain('PREFIX_HEAD');
      expect(storedContextPrefix).toContain('PREFIX_TAIL');
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
      mockRetrievalSearch.mockResolvedValueOnce({
        memories: [trusted, lowConfidence, pendingReview, stale, verified],
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

    it('filters by type in direct SQL', async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });

      await service.search({ types: ['decision', 'gotcha'] });

      const sql = mockExecute.mock.calls[0][0].sql as string;
      expect(sql).toContain('type IN (?, ?)');
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
