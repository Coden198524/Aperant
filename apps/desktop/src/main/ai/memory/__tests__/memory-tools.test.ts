import { describe, expect, it, vi } from 'vitest';
import { createRecordMemoryStub, createRecordMemoryTool } from '../tools/record-memory';
import { createSearchMemoryTool } from '../tools/search-memory';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory } from '../types';
import { estimateTokens } from '../retrieval/context-packer';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    type: 'gotcha',
    content: 'Always check token expiry before validating claims.',
    confidence: 0.9,
    tags: [],
    relatedFiles: ['src/auth/token.ts'],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

async function executeTool<TInput, TOutput>(
  aiTool: unknown,
  input: TInput,
): Promise<TOutput> {
  const executable = aiTool as { execute: (input: TInput) => Promise<TOutput> };
  return executable.execute(input);
}

describe('memory agent tools', () => {
  it('keeps search_memory output compact and deduplicated', async () => {
    const longContent = 'Use the auth refresh helper before API calls. '.repeat(30);
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({ id: 'a', content: longContent }),
        makeMemory({ id: 'b', content: longContent }),
        makeMemory({ id: 'c', type: 'decision', content: 'Auth tokens are stored in secure storage.' }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string },
      string
    >(tool, { query: 'auth token handling' });

    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      projectId: 'project-1',
      promptContextOnly: true,
      recordAccess: true,
    }));
    expect((result.match(/\[gotcha\]/g) ?? [])).toHaveLength(1);
    expect(result).toContain('2. [decision]');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('skips search_memory IPC for empty queries', async () => {
    const proxy = {
      searchMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string },
      string
    >(tool, { query: '   \n\t  ' });

    expect(result).toBe('No memory search run: provide a specific query.');
    expect(proxy.searchMemory).not.toHaveBeenCalled();
  });

  it('normalizes search_memory query and filter inputs before IPC', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; relatedFiles: string[]; types: Array<'gotcha' | 'decision'> },
      string
    >(tool, {
      query: '  auth   token\nrefresh  ',
      types: ['gotcha', 'gotcha', 'decision'],
      relatedFiles: [
        ' src\\auth\\token.ts ',
        'src/auth//token.ts',
        './SRC/auth/token.ts',
        '',
        'src/auth/session.ts',
      ],
    });

    expect(result).toBe('No relevant memories found for this query.');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'auth token refresh',
      types: ['gotcha', 'decision'],
      relatedFiles: ['src/auth/token.ts', 'src/auth/session.ts'],
      projectId: 'project-1',
      promptContextOnly: true,
      recordAccess: true,
    }));
  });

  it('bounds search_memory query and related file filters before IPC', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');
    const longQuery = `auth ${'query detail '.repeat(80)}SEARCH_QUERY_TAIL_OK`;
    const longFile = `src/${'deep/'.repeat(60)}token-refresh-service.ts`;

    await executeTool<
      { query: string; relatedFiles: string[]; limit: number },
      string
    >(tool, {
      query: longQuery,
      relatedFiles: [
        longFile,
        longFile,
        ...Array.from({ length: 12 }, (_, index) => `src/auth/file-${index}.ts`),
      ],
      limit: 8,
    });

    const filters = vi.mocked(proxy.searchMemory).mock.calls[0][0];
    expect(filters.query?.length).toBeLessThanOrEqual(360);
    expect(filters.query).toContain('SEARCH_QUERY_TAIL_OK');
    expect(filters.relatedFiles).toHaveLength(8);
    expect(filters.relatedFiles?.[0].length).toBeLessThanOrEqual(160);
    expect(filters.relatedFiles?.[0]).toContain('token-refresh-service.ts');
    expect(filters.relatedFiles?.[0]).not.toContain('omitted');
  });

  it('keeps bounded search_memory file filters as path suffixes', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');
    const fullPath = `C:/repo/src/${'deep/'.repeat(80)}auth/token-refresh-service.ts`;

    await executeTool<
      { query: string; relatedFiles: string[] },
      string
    >(tool, { query: 'auth file suffix', relatedFiles: [fullPath] });

    const filterPath = vi.mocked(proxy.searchMemory).mock.calls[0][0].relatedFiles?.[0] ?? '';
    expect(fullPath.toLowerCase().endsWith(filterPath.toLowerCase())).toBe(true);
    expect(filterPath).toContain('auth/token-refresh-service.ts');
    expect(filterPath).not.toContain('omitted');
  });

  it('deduplicates near-duplicate search_memory memories before output', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'retry-a',
          content: 'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
        }),
        makeMemory({
          id: 'retry-b',
          content: 'When editing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
        }),
        makeMemory({
          id: 'clock',
          type: 'decision',
          content: 'Mock the OAuth clock before testing refresh retry expiry.',
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth refresh retry', limit: 8 });

    expect((result.match(/auth refresh flow/g) ?? [])).toHaveLength(1);
    expect(result).toContain('2. [decision]');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('deduplicates search_memory memories by compact rendered content before output', async () => {
    const sharedHead = [
      'SHARED_RENDERED_HEAD use the auth retry helper before refreshing tokens.',
      'shared rendered head detail '.repeat(30),
    ].join(' ');
    const sharedTail = ' SHARED_RENDERED_TAIL verify expired-token retry before merging.';
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'rendered-a',
          content: `${sharedHead}${'alpha-only-middle-detail '.repeat(100)}${sharedTail}`,
        }),
        makeMemory({
          id: 'rendered-b',
          content: `${sharedHead}${'beta-only-middle-detail '.repeat(100)}${sharedTail}`,
        }),
        makeMemory({
          id: 'distinct',
          type: 'decision',
          content: 'Mock the OAuth clock before testing refresh retry expiry.',
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth refresh retry', limit: 8 });

    expect(result.match(/SHARED_RENDERED_HEAD/g)).toHaveLength(1);
    expect(result.match(/SHARED_RENDERED_TAIL/g)).toHaveLength(1);
    expect(result).toContain('2. [decision]');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('keeps the higher quality memory for duplicate search_memory rendered content', async () => {
    const duplicateContent = 'Use the shared auth refresh helper before calling protected APIs.';
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'duplicate-low',
          content: duplicateContent,
          confidence: 0.55,
          relatedFiles: ['src/auth/low-quality.ts'],
          accessCount: 0,
        }),
        makeMemory({
          id: 'duplicate-high',
          content: duplicateContent,
          confidence: 0.95,
          relatedFiles: ['src/auth/high-quality.ts'],
          userVerified: true,
          accessCount: 5,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth refresh helper', limit: 8 });

    expect((result.match(/\[gotcha\]/g) ?? [])).toHaveLength(1);
    expect(result).toContain('[high-quality.ts]');
    expect(result).not.toContain('[low-quality.ts]');
    expect(result).not.toContain('[confidence: 55%]');
  });

  it('keeps the higher quality memory for near-duplicate search_memory content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'near-low',
          content: 'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
          confidence: 0.55,
          relatedFiles: ['src/auth/near-low.ts'],
        }),
        makeMemory({
          id: 'near-high',
          content: 'When editing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
          confidence: 0.95,
          relatedFiles: ['src/auth/near-high.ts'],
          userVerified: true,
        }),
        makeMemory({
          id: 'clock',
          type: 'decision',
          content: 'Mock the OAuth clock before testing refresh retry expiry.',
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth refresh retry', limit: 8 });

    expect((result.match(/\[gotcha\]/g) ?? [])).toHaveLength(1);
    expect(result).toContain('[near-high.ts]');
    expect(result).not.toContain('[near-low.ts]');
    expect(result).not.toContain('[confidence: 55%]');
    expect(result).toContain('2. [decision]');
  });

  it('packs search_memory output by result budget instead of truncating the whole response', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue(
        Array.from({ length: 8 }, (_, index) => makeMemory({
          id: `long-${index}`,
          type: index % 2 === 0 ? 'gotcha' : 'decision',
          content: [
            `LONG_RESULT_${index}_HEAD`,
            'implementation detail '.repeat(80),
            `LONG_RESULT_${index}_TAIL`,
          ].join(' '),
        })),
      ),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'long auth memory results', limit: 8 });

    expect(result.length).toBeLessThanOrEqual(1800);
    expect(result).toContain('LONG_RESULT_0_HEAD');
    expect(result).toContain('LONG_RESULT_0_TAIL');
    expect(result).toContain('more memory result(s) omitted for output budget');
  });

  it('filters low-quality memories from search_memory output', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({ id: 'good', content: 'Trusted auth memory remains visible.' }),
        makeMemory({ id: 'low', content: 'Low confidence memory should be hidden.', confidence: 0.2 }),
        makeMemory({ id: 'review', content: 'Pending review memory should be hidden.', needsReview: true }),
        makeMemory({
          id: 'stale',
          content: 'Stale memory should be hidden.',
          staleAt: '2000-01-01T00:00:00.000Z',
        }),
        makeMemory({
          id: 'verified',
          content: 'Verified low confidence memory remains visible.',
          confidence: 0.2,
          needsReview: true,
          userVerified: true,
        }),
        makeMemory({
          id: 'pinned',
          content: 'Pinned stale memory remains visible.',
          confidence: 0.2,
          staleAt: '2000-01-01T00:00:00.000Z',
          pinned: true,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth memory quality', limit: 8 });

    expect(result).toContain('Trusted auth memory remains visible.');
    expect(result).toContain('Verified low confidence memory remains visible.');
    expect(result).toContain('Pinned stale memory remains visible.');
    expect(result).toContain('[confidence: 20%]');
    expect(result).not.toContain('(confidence: 90%)');
    expect(result).not.toContain('Low confidence memory should be hidden.');
    expect(result).not.toContain('Pending review memory should be hidden.');
    expect(result).not.toContain('Stale memory should be hidden.');
  });

  it('truncates search_memory query echoes and file reference chips while preserving query tails', async () => {
    const longQuery = `auth memory ${'extra query detail '.repeat(40)}QUERY_TAIL_SHOULD_BE_PRESERVED`;
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'many-files',
          content: 'Use the shared auth refresh helper before calling protected APIs.',
          relatedFiles: [
            'src/auth/refresh-token-service-with-a-very-long-name.ts',
            'src/auth/session-store-with-a-very-long-name.ts',
            'src/auth/route-guard-with-a-very-long-name.ts',
            'src/auth/legacy-token-migration.ts',
            'src/auth/oauth-callback.ts',
          ],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: longQuery, limit: 8 });

    expect(result).toContain('Memory search results for "auth memory');
    expect(result).toContain('+2 more');
    expect(result).toContain('QUERY_TAIL_SHOULD_BE_PRESERVED');
    expect(result).toContain('[middle omitted]');
    expect(result).not.toContain('refresh-token-service-with-a-very-long-name.ts');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('deduplicates search_memory file reference chips before counting omitted files', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'duplicate-file-refs',
          content: 'Use the shared auth refresh helper before calling protected APIs.',
          relatedFiles: [
            'src\\auth\\token.ts',
            'SRC/auth/token.ts',
            './src/auth/session.ts',
            'src/auth/guard.ts',
            'src/auth/guard.ts',
          ],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth file refs', limit: 3 });

    expect(result).toContain('[token.ts, session.ts, guard.ts]');
    expect(result).not.toContain('+2 more');
    expect(result).not.toContain('SRC/auth/token.ts');
  });

  it('formats search_memory prefetch patterns without exposing raw JSON', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'prefetch-json',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: [],
            frequentlyReadFiles: [
              'src/auth/session.ts',
              'src/auth/token.ts',
            ],
          }),
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['prefetch_pattern'] },
      string
    >(tool, { query: 'auth prefetch', limit: 3, types: ['prefetch_pattern'] });

    expect(result).toContain('[prefetch_pattern]');
    expect(result).toContain('Prefetch together: src/auth/session.ts, src/auth/token.ts');
    expect(result).not.toContain('frequentlyReadFiles');
    expect(result).not.toContain('{');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['prefetch_pattern'],
      promptContextOnly: false,
    }));
  });

  it('deduplicates search_memory prefetch patterns by rendered content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'prefetch-a',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: [],
            frequentlyReadFiles: ['src\\auth\\session.ts', './src/auth/token.ts/'],
          }),
          relatedFiles: [],
        }),
        makeMemory({
          id: 'prefetch-b',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: [],
            frequentlyReadFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
          }),
          relatedFiles: [],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['prefetch_pattern'] },
      string
    >(tool, { query: 'auth prefetch duplicate', limit: 3, types: ['prefetch_pattern'] });

    expect((result.match(/\[prefetch_pattern\]/g) ?? [])).toHaveLength(1);
    expect(result).toContain('Prefetch together: src/auth/session.ts, src/auth/token.ts');
    expect(result).not.toContain('frequentlyReadFiles');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['prefetch_pattern'],
      promptContextOnly: false,
    }));
  });

  it('allows explicit search_memory context cost lookups without prompt filtering', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'context-cost',
          type: 'context_cost',
          content: 'High token usage per step - focus the implementation search scope.',
          confidence: 0.95,
          relatedFiles: [],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['context_cost'] },
      string
    >(tool, { query: 'token cost', limit: 3, types: ['context_cost'] });

    expect(result).toContain('[context_cost]');
    expect(result).toContain('High token usage per step');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['context_cost'],
      promptContextOnly: false,
    }));
  });

  it('infers context_cost searches from token cost queries without requiring explicit types', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'context-cost',
          type: 'context_cost',
          content: 'Context token spike: prompt reached 24k tokens; narrow broad file rereads.',
          confidence: 0.95,
          relatedFiles: ['src/auth/session.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'token cost for this auth task', limit: 3 });

    expect(result).toContain('[context_cost]');
    expect(result).toContain('Context token spike');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['context_cost'],
      promptContextOnly: false,
    }));
  });

  it('does not infer context_cost for ordinary auth token searches', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'auth-token-gotcha',
          type: 'gotcha',
          content: 'Refresh the auth token before calling protected APIs.',
          confidence: 0.95,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth token refresh behavior', limit: 3 });

    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: undefined,
      promptContextOnly: true,
    }));
  });

  it('preserves useful tail details when compacting search_memory result content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'tail-detail',
          content: [
            'Use the shared auth refresh helper before calling protected APIs.',
            'implementation noise '.repeat(80),
            'Final verification: retry with expired token before merging.',
          ].join(' '),
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth retry verification', limit: 3 });

    expect(result).toContain('Use the shared auth refresh helper');
    expect(result).toContain('Final verification: retry with expired token before merging.');
    expect(result).toContain('[middle omitted]');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('bounds localized search_memory output by estimated tokens', async () => {
    const cjkText = '\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25';
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'localized-long',
          content: `Start ${cjkText.repeat(600)} FINAL_LOCALIZED_SEARCH_TAIL_OK`,
          relatedFiles: [],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: `${cjkText.repeat(80)} query tail`, limit: 3 });

    expect(result).toContain('Start');
    expect(result).toContain('FINAL_LOCALIZED_SEARCH_TAIL_OK');
    expect(result).toContain('[middle omitted]');
    expect(result.length).toBeLessThanOrEqual(1800);
    expect(estimateTokens(result)).toBeLessThanOrEqual(450);
  });

  it('does not echo full memory content after recording', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('12345678-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'This is a reusable implementation gotcha that should not be echoed back.',
      relatedFiles: ['src/auth/token.ts'],
    });

    expect(result).toBe('Memory recorded (id: 12345678).');
    expect(result).not.toContain('reusable implementation gotcha');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'This is a reusable implementation gotcha that should not be echoed back.',
      projectId: 'project-1',
      limit: 4,
      promptContextOnly: true,
    }));
    expect(proxy.recordMemory).toHaveBeenCalledOnce();
  });

  it('normalizes record_memory content and metadata before duplicate search and persistence', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('abcdef12-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[]; relatedModules: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: '  Use   shared auth helper\nbefore retrying token refresh.  ',
      relatedFiles: [
        ' src\\auth\\token.ts ',
        'src/auth//token.ts',
        './SRC/auth/token.ts',
        '',
        'src/auth/session.ts',
      ],
      relatedModules: [' auth ', 'auth', 'AUTH', 'token refresh', ''],
    });

    expect(result).toBe('Memory recorded (id: abcdef12).');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Use shared auth helper before retrying token refresh.',
    }));
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Use shared auth helper before retrying token refresh.',
      relatedFiles: ['src/auth/token.ts', 'src/auth/session.ts'],
      relatedModules: ['auth', 'token refresh'],
    }));
  });

  it('bounds record_memory metadata before persistence', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('feedface-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');
    const longFile = `src/${'deep/'.repeat(80)}token-refresh-service.ts`;
    const longModule = `auth ${'nested module '.repeat(30)}tail`;

    await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[]; relatedModules: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Use shared auth helper before retrying token refresh.',
      relatedFiles: [
        longFile,
        longFile,
        ...Array.from({ length: 16 }, (_, index) => `src/auth/file-${index}.ts`),
      ],
      relatedModules: [
        longModule,
        longModule,
        ...Array.from({ length: 16 }, (_, index) => `auth-module-${index}`),
      ],
    });

    const entry = vi.mocked(proxy.recordMemory).mock.calls[0][0];
    expect(entry.relatedFiles).toHaveLength(12);
    expect(entry.relatedFiles?.[0].length).toBeLessThanOrEqual(160);
    expect(entry.relatedFiles?.[0]).toContain('token-refresh-service.ts');
    expect(entry.relatedFiles?.[0]).not.toContain('omitted');
    expect(entry.relatedModules).toHaveLength(12);
    expect(entry.relatedModules?.[0].length).toBeLessThanOrEqual(96);
    expect(entry.relatedModules?.[0]).toContain('tail');
  });

  it('compacts record_memory duplicate search queries without truncating persisted content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('feedface-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');
    const longContent = [
      'Use auth retry guard before refreshing protected API tokens.',
      'middle duplicate search detail '.repeat(10),
      'Verify expired-token retry before merging.',
    ].join(' ');

    await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: longContent,
    });

    const duplicateQuery = vi.mocked(proxy.searchMemory).mock.calls[0][0].query ?? '';
    expect(duplicateQuery.length).toBeLessThanOrEqual(260);
    expect(estimateTokens(duplicateQuery)).toBeLessThanOrEqual(80);
    expect(duplicateQuery).toContain('Use auth retry guard');
    expect(duplicateQuery).toContain('Verify expired-token retry');
    expect(duplicateQuery).toContain('omitted');
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: longContent.replace(/\s+/g, ' ').trim(),
    }));
  });

  it('skips recording near-duplicate memories that already exist', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'existing-memory-1234',
          content: 'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
        }),
      ]),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: 'When editing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
    });

    expect(result).toBe('Memory skipped: similar memory already exists (id: existing).');
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it('skips generic session metric memories before persistence', async () => {
    const proxy = {
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'module_insight'; content: string },
      string
    >(tool, {
      type: 'module_insight',
      content: 'Efficient token usage - concise and focused implementation',
    });

    expect(result).toBe(
      'Memory skipped: record only reusable project-specific gotchas, decisions, recurring errors, file couplings, or failed approaches.',
    );
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it('skips low-confidence memories before persistence', async () => {
    const proxy = {
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; confidence: number },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Possibly use a different helper for this branch, but this is not verified.',
      confidence: 0.2,
    });

    expect(result).toBe(
      'Memory skipped: record only reusable project-specific gotchas, decisions, recurring errors, file couplings, or failed approaches.',
    );
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it('keeps unavailable memory stub responses compact', async () => {
    const tool = createRecordMemoryStub();

    const result = await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: 'This content should not be echoed when persistence is unavailable.',
    });

    expect(result).toBe('Memory noted locally, but memory persistence is unavailable in this session.');
  });
});
