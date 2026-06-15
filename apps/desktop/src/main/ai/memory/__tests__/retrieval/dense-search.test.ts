/**
 * dense-search.test.ts - Boundary behavior for dense retrieval.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import type { EmbeddingService } from '../../embedding-service';
import { searchDense } from '../../retrieval/dense-search';

function makeMockClient() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    client: { execute } as unknown as Client,
    execute,
  };
}

function makeMockEmbeddingService() {
  const embed = vi.fn().mockResolvedValue(new Array(256).fill(0.1));
  return {
    embeddingService: { embed } as unknown as EmbeddingService,
    embed,
  };
}

function serializeEmbedding(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

describe('searchDense', () => {
  it('returns empty result without embedding blank queries', async () => {
    const { client, execute } = makeMockClient();
    const { embeddingService, embed } = makeMockEmbeddingService();

    const results = await searchDense(client, '   \n\t   ', embeddingService, 'proj-a');

    expect(results).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns empty result without embedding nonpositive limits', async () => {
    const { client, execute } = makeMockClient();
    const { embeddingService, embed } = makeMockEmbeddingService();

    await expect(searchDense(client, 'JWT token', embeddingService, 'proj-a', 256, 0)).resolves.toEqual([]);
    await expect(searchDense(client, 'JWT token', embeddingService, 'proj-a', 256, Number.NaN)).resolves.toEqual([]);

    expect(embed).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes query whitespace and floors fractional limits', async () => {
    const { client, execute } = makeMockClient();
    const { embeddingService, embed } = makeMockEmbeddingService();

    await searchDense(client, '  JWT \n token  ', embeddingService, 'proj-a', 256, 2.9);

    expect(embed).toHaveBeenCalledWith('JWT token', 256);
    const statement = execute.mock.calls[0][0] as { args: unknown[] };
    expect(statement.args.at(-1)).toBe(2);
  });

  it('filters invalid native result rows before returning candidates', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { memory_id: ' good-memory ', distance: 0.2 },
        { memory_id: '', distance: 0.1 },
        { memory_id: 42, distance: 0.3 },
        { memory_id: 'bad-distance', distance: Number.NaN },
      ],
    });
    const client = { execute } as unknown as Client;
    const { embeddingService } = makeMockEmbeddingService();

    const results = await searchDense(client, 'JWT token', embeddingService, 'proj-a');

    expect(results).toEqual([{ memoryId: 'good-memory', distance: 0.2 }]);
  });

  it('skips corrupt fallback embeddings instead of failing dense search', async () => {
    const validEmbedding = new Array(256).fill(0.1);
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('native vector unavailable'))
      .mockResolvedValueOnce({
        rows: [
          { memory_id: 'bad-buffer', embedding: Buffer.from([1, 2, 3]) },
          { memory_id: 'bad-value', embedding: serializeEmbedding([Number.NaN, 0.1]) },
          { memory_id: 'good-buffer', embedding: serializeEmbedding(validEmbedding) },
        ],
      });
    const client = { execute } as unknown as Client;
    const { embeddingService } = makeMockEmbeddingService();

    const results = await searchDense(client, 'JWT token', embeddingService, 'proj-a', 256, 5);

    expect(results).toHaveLength(1);
    expect(results[0].memoryId).toBe('good-buffer');
    expect(results[0].distance).toBeCloseTo(0);
  });
});
