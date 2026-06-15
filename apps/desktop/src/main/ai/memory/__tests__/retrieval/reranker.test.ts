import { afterEach, describe, expect, it, vi } from 'vitest';

import { Reranker } from '../../retrieval/reranker';
import { estimateTokens } from '../../retrieval/context-packer';

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
  it('filters invalid passthrough candidates and floors topK', async () => {
    const reranker = new Reranker('none');

    const results = await reranker.rerank(
      'auth query',
      [
        { memoryId: ' ', content: 'ignored blank id' },
        { memoryId: 'blank-content', content: '   ' },
        { memoryId: ' first ', content: 'First usable memory' },
        { memoryId: 'first', content: 'Duplicate should be skipped' },
        { memoryId: 'second', content: 'Second usable memory' },
      ],
      1.9,
    );

    expect(results).toEqual([{ memoryId: 'first', score: 1 }]);
  });

  it('returns empty result without remote calls for blank query or invalid topK', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('cohere');

    await expect(
      reranker.rerank('   \n\t  ', [{ memoryId: 'a', content: 'usable' }], 1),
    ).resolves.toEqual([]);
    await expect(
      reranker.rerank('auth query', [{ memoryId: 'a', content: 'usable' }], Number.NaN),
    ).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    expect(estimateTokens(firstBody.prompt)).toBeLessThanOrEqual(430);
    expect(firstBody.prompt).toContain('DOC_A_HEAD');
    expect(firstBody.prompt).toContain('DOC_A_TAIL_SHOULD_BE_PRESERVED');
    expect(firstBody.prompt).toContain('[middle omitted]');
    expect(firstBody.prompt).toContain('QUERY_TAIL_SHOULD_BE_PRESERVED');
  });

  it('caps remote reranker candidates before sending documents', async () => {
    process.env.COHERE_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ index: 19, relevance_score: 0.55 }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('cohere');
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      memoryId: `mem-${index}`,
      content: `candidate ${index}`,
    }));

    const results = await reranker.rerank('settings save', candidates, 5);

    expect(results).toEqual([{ memoryId: 'mem-19', score: 0.55 }]);
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, { body?: unknown }];
    const body = JSON.parse(String(firstCall[1]?.body)) as {
      documents: string[];
      top_n: number;
    };
    expect(body.documents).toHaveLength(20);
    expect(body.documents.at(-1)).toBe('candidate 19');
    expect(body.top_n).toBe(5);
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
    expect(estimateTokens(body.query)).toBeLessThanOrEqual(75);
    expect(body.query).toContain('QUERY_TAIL_SHOULD_BE_PRESERVED');
    expect(body.query).toContain('[middle omitted]');
    expect(body.documents[0].length).toBeLessThanOrEqual(1200);
    expect(estimateTokens(body.documents[0])).toBeLessThanOrEqual(300);
    expect(body.documents[0]).toContain('COHERE_DOC_HEAD');
    expect(body.documents[0]).toContain('COHERE_DOC_TAIL_SHOULD_BE_PRESERVED');
    expect(body.documents[0]).toContain('[middle omitted]');
  });

  it('keeps localized Cohere reranker query and documents within token budgets', async () => {
    process.env.COHERE_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.91 }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('cohere');

    await reranker.rerank(
      [
        '查询开头',
        '这是一段会显著增加 token 的中文 rerank 查询。'.repeat(80),
        '查询尾部',
      ].join(' '),
      [
        {
          memoryId: 'localized',
          content: [
            '文档开头',
            '这是一段会显著增加 token 的中文 rerank 文档。'.repeat(200),
            '文档尾部',
          ].join(' '),
        },
        {
          memoryId: 'short',
          content: '短文档',
        },
      ],
      1,
    );

    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, { body?: unknown }];
    const body = JSON.parse(String(firstCall[1]?.body)) as {
      query: string;
      documents: string[];
    };

    expect(body.query.length).toBeLessThanOrEqual(300);
    expect(estimateTokens(body.query)).toBeLessThanOrEqual(75);
    expect(body.query).toContain('查询开头');
    expect(body.query).toContain('查询尾部');
    expect(body.documents[0].length).toBeLessThanOrEqual(1200);
    expect(estimateTokens(body.documents[0])).toBeLessThanOrEqual(300);
    expect(body.documents[0]).toContain('文档开头');
    expect(body.documents[0]).toContain('文档尾部');
  });

  it('filters invalid Cohere result entries instead of discarding valid scores', async () => {
    process.env.COHERE_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          { index: 42, relevance_score: 0.99 },
          { index: 0, relevance_score: Number.NaN },
          { index: 1, relevance_score: 0.72 },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const reranker = new Reranker('cohere');

    const results = await reranker.rerank(
      'auth query',
      [
        { memoryId: 'a', content: 'first' },
        { memoryId: 'b', content: 'second' },
        { memoryId: 'c', content: 'third' },
      ],
      1,
    );

    expect(results).toEqual([{ memoryId: 'b', score: 0.72 }]);
  });
});
