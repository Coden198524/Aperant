import { afterEach, describe, expect, it, vi } from 'vitest';

import { Reranker } from '../../retrieval/reranker';

const originalCohereApiKey = process.env.COHERE_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCohereApiKey === undefined) {
    delete process.env.COHERE_API_KEY;
  } else {
    process.env.COHERE_API_KEY = originalCohereApiKey;
  }
});

describe('Reranker prompt compaction', () => {
  it('bounds Ollama reranker prompts while preserving document tail context', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: [1, 2, 3] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('ollama');

    await reranker.rerank(
      `auth query ${'extra query '.repeat(80)}QUERY_TAIL_SHOULD_BE_PRESERVED`,
      [
        {
          memoryId: 'a',
          content: `DOC_A_HEAD ${'middle detail '.repeat(220)}DOC_A_TAIL_SHOULD_BE_PRESERVED`,
        },
        {
          memoryId: 'b',
          content: `DOC_B_HEAD ${'middle detail '.repeat(220)}DOC_B_TAIL_SHOULD_BE_PRESERVED`,
        },
      ],
      1,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, { body?: unknown }];
    const firstBody = JSON.parse(String(firstCall[1]?.body)) as { prompt: string };
    expect(firstBody.prompt.length).toBeLessThanOrEqual(1700);
    expect(firstBody.prompt).toContain('DOC_A_HEAD');
    expect(firstBody.prompt).toContain('DOC_A_TAIL_SHOULD_BE_PRESERVED');
    expect(firstBody.prompt).toContain('[middle omitted]');
    expect(firstBody.prompt).toContain('QUERY_TAIL_SHOULD_BE_PRESERVED');
  });

  it('bounds Cohere reranker query and documents before sending them', async () => {
    process.env.COHERE_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.91 }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('cohere');

    await reranker.rerank(
      `settings save ${'query noise '.repeat(80)}QUERY_TAIL_SHOULD_BE_PRESERVED`,
      [
        {
          memoryId: 'a',
          content: `COHERE_DOC_HEAD ${'body detail '.repeat(250)}COHERE_DOC_TAIL_SHOULD_BE_PRESERVED`,
        },
        {
          memoryId: 'b',
          content: 'Short fallback document.',
        },
      ],
      1,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, { body?: unknown }];
    const body = JSON.parse(String(firstCall[1]?.body)) as {
      query: string;
      documents: string[];
    };
    expect(body.query.length).toBeLessThanOrEqual(300);
    expect(body.query).toContain('QUERY_TAIL_SHOULD_BE_PRESERVED');
    expect(body.query).toContain('[middle omitted]');
    expect(body.documents[0].length).toBeLessThanOrEqual(1200);
    expect(body.documents[0]).toContain('COHERE_DOC_HEAD');
    expect(body.documents[0]).toContain('COHERE_DOC_TAIL_SHOULD_BE_PRESERVED');
    expect(body.documents[0]).toContain('[middle omitted]');
  });
});
