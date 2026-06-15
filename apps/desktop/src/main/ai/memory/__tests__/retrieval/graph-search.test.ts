/**
 * graph-search.test.ts - Boundary behavior for graph retrieval.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { searchGraph } from '../../retrieval/graph-search';

function makeMockClient() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    client: { execute } as unknown as Client,
    execute,
  };
}

describe('searchGraph', () => {
  it('returns empty result without querying when limit is not positive', async () => {
    const { client, execute } = makeMockClient();

    await expect(searchGraph(client, ['src/auth.ts'], 'proj-a', 0)).resolves.toEqual([]);
    await expect(searchGraph(client, ['src/auth.ts'], 'proj-a', Number.NaN)).resolves.toEqual([]);

    expect(execute).not.toHaveBeenCalled();
  });

  it('returns empty result without querying when recent files normalize away', async () => {
    const { client, execute } = makeMockClient();

    const results = await searchGraph(client, ['  ', '\n\t'], 'proj-a', 3);

    expect(results).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes and deduplicates recent files before querying', async () => {
    const { client, execute } = makeMockClient();

    await searchGraph(client, ['src\\auth.ts', './SRC/auth.ts/', 'src/auth.ts', 'src//session.ts/'], 'proj-a', 2.9);

    const firstStatement = execute.mock.calls[0][0] as { args: unknown[] };
    expect(firstStatement.args).toEqual([
      'proj-a',
      'src/auth.ts',
      'src/auth.ts/',
      './src/auth.ts',
      './src/auth.ts/',
      'src/session.ts',
      'src/session.ts/',
      './src/session.ts',
      './src/session.ts/',
      2,
    ]);
  });

  it('caps normalized recent files before building graph queries', async () => {
    const { client, execute } = makeMockClient();
    const recentFiles = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);

    await searchGraph(client, recentFiles, 'proj-a', 15);

    const firstStatement = execute.mock.calls[0][0] as { args: unknown[] };
    const filesInQuery = firstStatement.args.slice(1, -1);
    const canonicalFilesInQuery = filesInQuery.filter((value) =>
      typeof value === 'string' && !value.startsWith('./') && !value.endsWith('/'),
    );
    expect(canonicalFilesInQuery).toHaveLength(32);
    expect(canonicalFilesInQuery[0]).toBe('src/file-0.ts');
    expect(canonicalFilesInQuery.at(-1)).toBe('src/file-31.ts');
    expect(filesInQuery).toContain('./src/file-0.ts');
    expect(filesInQuery).toContain('src/file-31.ts/');
  });

  it('scales internal neighbor and memory query limits down', async () => {
    const execute = vi.fn(async (statement: { sql: string }) => {
      if (statement.sql.includes('observer_co_access_edges')) {
        return { rows: [{ neighbor: './src\\session.ts/', weight: 0.9 }] };
      }
      if (statement.sql.includes('graph_closure')) {
        return { rows: [{ descendant_id: 'node-1' }] };
      }
      return { rows: [] };
    });
    const client = { execute } as unknown as Client;

    await searchGraph(client, ['src/auth.ts'], 'proj-a', 2.9);

    const statements = execute.mock.calls.map(([statement]) => statement as { sql: string; args: unknown[] });
    const coAccessCall = statements.find((statement) => statement.sql.includes('observer_co_access_edges'));
    const coAccessMemoryCall = statements.find((statement) => statement.args.includes('src/session.ts'));
    const closureCall = statements.find((statement) => statement.sql.includes('graph_closure'));
    const closureMemoryCall = statements.find((statement) => statement.sql.includes('target_node_id = ?'));

    expect(coAccessCall?.args.at(-1)).toBe(2);
    expect(coAccessMemoryCall?.args).toEqual([
      'proj-a',
      'src/session.ts',
      'src/session.ts/',
      './src/session.ts',
      './src/session.ts/',
      2,
    ]);
    expect(coAccessMemoryCall?.args.at(-1)).toBe(2);
    expect(coAccessMemoryCall?.sql).not.toContain('related_files LIKE');
    expect(coAccessMemoryCall?.sql).toContain('json_each(m.related_files)');
    expect(closureCall?.args.at(-1)).toBe(2);
    expect(closureMemoryCall?.args.at(-1)).toBe(2);
  });

  it('filters invalid graph rows before returning candidates', async () => {
    let relatedFileLookupCount = 0;
    const execute = vi.fn(async (statement: { sql: string }) => {
      if (statement.sql.includes('json_each(m.related_files)')) {
        relatedFileLookupCount += 1;
        return relatedFileLookupCount === 1
          ? { rows: [{ id: ' file-memory ' }, { id: '' }, { id: 42 }] }
          : { rows: [{ id: ' co-memory ' }, { id: '' }] };
      }
      if (statement.sql.includes('observer_co_access_edges')) {
        return {
          rows: [
            { neighbor: 'src/session.ts', weight: 0.9 },
            { neighbor: 'src/bad.ts', weight: Number.NaN },
            { neighbor: '', weight: 0.8 },
          ],
        };
      }
      if (statement.sql.includes('graph_closure')) {
        return { rows: [{ descendant_id: ' node-1 ' }, { descendant_id: '' }] };
      }
      if (statement.sql.includes('target_node_id = ?')) {
        return { rows: [{ id: ' closure-memory ' }, { id: 7 }] };
      }
      return { rows: [] };
    });
    const client = { execute } as unknown as Client;

    const results = await searchGraph(client, ['src/auth.ts'], 'proj-a', 10);

    expect(results).toEqual([
      { memoryId: 'file-memory', graphScore: 0.8, reason: 'file_scoped' },
      { memoryId: 'co-memory', graphScore: 0.63, reason: 'co_access' },
      { memoryId: 'closure-memory', graphScore: 0.6, reason: 'closure_neighbor' },
    ]);
  });

  it('uses exact JSON file matching for co-access memories', async () => {
    const execute = vi.fn(async (statement: { sql: string; args: unknown[] }) => {
      if (statement.sql.includes('related_files LIKE')) {
        throw new Error('substring related_files matching should not be used');
      }
      if (statement.sql.includes('observer_co_access_edges')) {
        return { rows: [{ neighbor: 'src/auth.ts', weight: 0.9 }] };
      }
      if (statement.sql.includes('json_each(m.related_files)') && statement.args.includes('src/auth.ts')) {
        return { rows: [{ id: 'exact-co-access-memory' }] };
      }
      return { rows: [] };
    });
    const client = { execute } as unknown as Client;

    const results = await searchGraph(client, ['src/session.ts'], 'proj-a', 5);

    expect(results).toContainEqual({
      memoryId: 'exact-co-access-memory',
      graphScore: 0.63,
      reason: 'co_access',
    });
  });
});
