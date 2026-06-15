/**
 * graph-boost.test.ts - Boundary behavior for graph neighborhood boost.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { applyGraphNeighborhoodBoost } from '../../retrieval/graph-boost';
import type { RankedResult } from '../../retrieval/rrf-fusion';

function makeRanked(memoryId: string, score: number): RankedResult {
  return {
    memoryId,
    score,
    sources: new Set(['test']),
  };
}

describe('applyGraphNeighborhoodBoost', () => {
  it('returns normalized candidates without querying when topK leaves no anchors', async () => {
    const execute = vi.fn();
    const client = { execute } as unknown as Client;

    await expect(
      applyGraphNeighborhoodBoost(
        client,
        [makeRanked(' anchor ', 0.9), makeRanked('', 0.8), makeRanked('target', 0.1)],
        'proj-a',
        0,
      ),
    ).resolves.toEqual([makeRanked('anchor', 0.9), makeRanked('target', 0.1)]);
    await expect(
      applyGraphNeighborhoodBoost(client, [makeRanked('anchor', 0.9), makeRanked('target', 0.1)], 'proj-a', Number.NaN),
    ).resolves.toEqual([makeRanked('anchor', 0.9), makeRanked('target', 0.1)]);

    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes candidates and related files before graph boost queries', async () => {
    const execute = vi.fn(async (statement: { sql: string; args: unknown[] }) => {
      if (statement.sql.includes('SELECT id, related_files')) {
        return {
          rows: [
            { id: ' anchor ', related_files: JSON.stringify([' ./src//anchor.ts ', './SRC/anchor.ts/', 42]) },
            { id: 'target', related_files: JSON.stringify(['src\\Neighbor.ts/']) },
          ],
        };
      }
      if (statement.sql.includes('graph_closure')) {
        return { rows: [{ file_path: './SRC/neighbor.ts/' }] };
      }
      return { rows: [] };
    });
    const client = { execute } as unknown as Client;

    const results = await applyGraphNeighborhoodBoost(
      client,
      [
        makeRanked(' anchor ', 0.9),
        makeRanked('', 0.8),
        makeRanked('anchor', 0.7),
        makeRanked('bad-score', Number.NaN),
        makeRanked('target', 0.1),
      ],
      'proj-a',
      1.9,
    );

    const fetchCall = execute.mock.calls[0][0] as { args: unknown[] };
    const closureCall = execute.mock.calls[1][0] as { args: unknown[] };
    expect(fetchCall.args).toEqual(['anchor', 'target']);
    expect(closureCall.args).toEqual(['src/anchor.ts', 'proj-a']);
    expect(results.map((result) => [result.memoryId, result.score])).toEqual([
      ['anchor', 0.9],
      ['target', 0.4],
    ]);
  });

  it('caps related files per memory before querying graph closure', async () => {
    const topFiles = Array.from({ length: 70 }, (_, index) => `src/file-${index}.ts`);
    const execute = vi.fn(async (statement: { sql: string; args: unknown[] }) => {
      if (statement.sql.includes('SELECT id, related_files')) {
        return {
          rows: [
            { id: 'anchor', related_files: JSON.stringify(topFiles) },
            { id: 'target', related_files: JSON.stringify(['src/target.ts']) },
          ],
        };
      }
      return { rows: [] };
    });
    const client = { execute } as unknown as Client;

    await applyGraphNeighborhoodBoost(client, [makeRanked('anchor', 0.9), makeRanked('target', 0.1)], 'proj-a', 1);

    const closureCall = execute.mock.calls[1][0] as { args: unknown[] };
    const filesInQuery = closureCall.args.slice(0, -1);
    expect(filesInQuery).toHaveLength(24);
    expect(filesInQuery[0]).toBe('src/file-0.ts');
    expect(filesInQuery.at(-1)).toBe('src/file-23.ts');
  });
});
