import { describe, expect, it, vi } from 'vitest';
import { createRecordMemoryStub, createRecordMemoryTool } from '../tools/record-memory';
import { createSearchMemoryTool } from '../tools/search-memory';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory } from '../types';

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
    }));
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
        '',
        'src/auth/session.ts',
      ],
      relatedModules: [' auth ', 'auth', 'token refresh', ''],
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
