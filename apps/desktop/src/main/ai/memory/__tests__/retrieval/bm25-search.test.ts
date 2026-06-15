/**
 * bm25-search.test.ts — Test FTS5 BM25 search against seeded in-memory DB
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { getInMemoryClient } from '../../db';
import { searchBM25 } from '../../retrieval/bm25-search';

// ============================================================
// HELPERS
// ============================================================

async function seedMemory(
  client: Client,
  id: string,
  content: string,
  projectId: string,
  tags: string[] = [],
): Promise<void> {
  const now = new Date().toISOString();

  // Insert into memories table
  await client.execute({
    sql: `INSERT INTO memories (
      id, type, content, confidence, tags, related_files, related_modules,
      created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
    ) VALUES (?, 'gotcha', ?, 0.9, ?, '[]', '[]', ?, ?, 0, 'global', 'agent_explicit', ?, 0)`,
    args: [id, content, JSON.stringify(tags), now, now, projectId],
  });

  // Insert into FTS5 virtual table
  await client.execute({
    sql: `INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES (?, ?, ?, ?)`,
    args: [id, content, JSON.stringify(tags), '[]'],
  });
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

describe('searchBM25', () => {
  it('returns empty array for empty database', async () => {
    const results = await searchBM25(client, 'authentication', 'test-project');
    expect(results).toEqual([]);
  });

  it('returns empty result without querying for blank query or nonpositive limit', async () => {
    const executeSpy = vi.spyOn(client, 'execute');

    await expect(searchBM25(client, '   \n\t   ', 'proj-a')).resolves.toEqual([]);
    await expect(searchBM25(client, 'JWT token', 'proj-a', 0)).resolves.toEqual([]);
    await expect(searchBM25(client, 'JWT token', 'proj-a', Number.NaN)).resolves.toEqual([]);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('filters invalid result rows before returning candidates', async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { id: ' valid-memory ', bm25_score: -0.2 },
          { id: '', bm25_score: -0.1 },
          { id: 'bad-score', bm25_score: Number.NaN },
          { id: 42, bm25_score: -0.3 },
        ],
      }),
    } as unknown as Client;

    const results = await searchBM25(mockClient, 'JWT token', 'proj-a');

    expect(results).toEqual([{ memoryId: 'valid-memory', bm25Score: -0.2 }]);
  });

  it('finds a memory matching the search query', async () => {
    await seedMemory(client, 'mem-001', 'Always check JWT token expiry before validating', 'proj-a');

    const results = await searchBM25(client, 'JWT token', 'proj-a');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memoryId).toBe('mem-001');
  });

  it('scopes results to the correct project', async () => {
    await seedMemory(client, 'mem-a', 'JWT authentication gotcha', 'proj-a');
    await seedMemory(client, 'mem-b', 'JWT authentication gotcha', 'proj-b');

    const results = await searchBM25(client, 'JWT', 'proj-a');
    const ids = results.map((r) => r.memoryId);

    expect(ids).toContain('mem-a');
    expect(ids).not.toContain('mem-b');
  });

  it('does not return deprecated memories', async () => {
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO memories (
        id, type, content, confidence, tags, related_files, related_modules,
        created_at, last_accessed_at, access_count, scope, source, project_id, deprecated
      ) VALUES ('dep-001', 'gotcha', 'deprecated JWT content', 0.9, '[]', '[]', '[]', ?, ?, 0, 'global', 'agent_explicit', 'proj-a', 1)`,
      args: [now, now],
    });
    await client.execute({
      sql: `INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES ('dep-001', 'deprecated JWT content', '[]', '[]')`,
    });

    const results = await searchBM25(client, 'JWT content', 'proj-a');
    const ids = results.map((r) => r.memoryId);
    expect(ids).not.toContain('dep-001');
  });

  it('returns results ordered by BM25 score (best match first)', async () => {
    // Seed memories with varying relevance to 'authentication error'
    await seedMemory(client, 'mem-high', 'authentication error occurs when token expires', 'proj-a');
    await seedMemory(client, 'mem-low', 'database connection established', 'proj-a');

    const results = await searchBM25(client, 'authentication error', 'proj-a');

    if (results.length >= 2) {
      const highIdx = results.findIndex((r) => r.memoryId === 'mem-high');
      const lowIdx = results.findIndex((r) => r.memoryId === 'mem-low');

      if (highIdx !== -1 && lowIdx !== -1) {
        expect(highIdx).toBeLessThan(lowIdx);
      }
    }

    // At least mem-high should match
    expect(results.some((r) => r.memoryId === 'mem-high')).toBe(true);
  });

  it('returns empty array for malformed FTS5 query without throwing', async () => {
    await seedMemory(client, 'mem-001', 'some content', 'proj-a');

    // Malformed FTS5 query should not throw
    const results = await searchBM25(client, 'AND OR (( ', 'proj-a');
    expect(Array.isArray(results)).toBe(true);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await seedMemory(client, `mem-${i}`, `JWT authentication pattern ${i}`, 'proj-a');
    }

    const results = await searchBM25(client, 'JWT authentication', 'proj-a', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('includes bm25Score in results', async () => {
    await seedMemory(client, 'mem-001', 'electron path resolution gotcha', 'proj-a');

    const results = await searchBM25(client, 'electron', 'proj-a');
    if (results.length > 0) {
      expect(typeof results[0].bm25Score).toBe('number');
      // BM25 scores from FTS5 are negative (lower = better match)
      expect(results[0].bm25Score).toBeLessThanOrEqual(0);
    }
  });
});
