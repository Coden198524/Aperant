import { describe, expect, it, vi } from 'vitest';
import { createRecordMemoryStub, createRecordMemoryTool } from '../tools/record-memory';
import { createSearchMemoryTool } from '../tools/search-memory';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory } from '../types';
import { estimateTokens } from '../retrieval/context-packer';

const MEMORY_SKIPPED_LOW_VALUE_RESULT =
  'Memory skipped: only reusable project-specific lessons.';

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
  it('describes search_memory machine memory affordances', () => {
    const proxy = {
      searchMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1') as { description?: string };

    expect(tool.description).toContain('file prefetch/file access patterns');
    expect(tool.description).toContain('token/context cost lessons');
    expect(tool.description).toContain('which files to inspect first');
  });

  it('describes record_memory low-value write constraints', () => {
    const proxy = {
      searchMemory: vi.fn(),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1') as { description?: string };

    expect(tool.description).toContain('non-obvious, reusable gotchas');
    expect(tool.description).toContain('generic completion status');
    expect(tool.description).toContain('memory/search tool responses');
  });

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

  it('returns compact unavailable text when search_memory IPC fails', async () => {
    const proxy = {
      searchMemory: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth retry memory', limit: 3 });

    expect(result).toBe('Memory search unavailable; inspect focused files next.');
    expect(result).not.toContain('database unavailable');
    expect(result).not.toContain('auth retry memory');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'auth retry memory',
      projectId: 'project-1',
      recordAccess: true,
    }));
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

  it('strips low-value outcome lines from search_memory results', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'outcome-noise',
          type: 'work_unit_outcome',
          content: [
            'Work unit s1 finished with outcome: success.',
            'Summary: Auth module narrowed memory lookup before editing.',
            'npm run typecheck passed.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          confidence: 0.95,
          relatedFiles: ['src/auth/session.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['work_unit_outcome'] },
      string
    >(tool, { query: 'auth outcome', limit: 3, types: ['work_unit_outcome'] });

    expect(result).toContain('[work_unit_outcome]');
    expect(result).toContain('Auth module narrowed memory lookup before editing');
    expect(result).toContain('[session.ts]');
    expect(result).not.toContain('Work unit s1 finished');
    expect(result).not.toContain('npm run typecheck passed');
    expect(result).not.toContain('No issues found');
    expect(result).not.toContain('Completed at:');
  });

  it('omits search_memory outcome results that only contain low-value lines', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'empty-outcome',
          type: 'work_unit_outcome',
          content: [
            'Work unit s1 finished with outcome: success.',
            'npm run typecheck passed.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          confidence: 0.95,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['work_unit_outcome'] },
      string
    >(tool, { query: 'auth outcome', limit: 3, types: ['work_unit_outcome'] });

    expect(result).toBe('No relevant memories found for this query.');
  });

  it('strips low-value status lines from non-outcome search_memory results', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'gotcha-noise',
          type: 'gotcha',
          content: [
            'npm run typecheck passed.',
            'Mock the OAuth clock before testing refresh retries.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['gotcha'] },
      string
    >(tool, { query: 'auth gotcha', limit: 3, types: ['gotcha'] });

    expect(result).toContain('[gotcha]');
    expect(result).toContain('Mock the OAuth clock before testing refresh retries');
    expect(result).not.toContain('npm run typecheck passed');
    expect(result).not.toContain('No issues found');
    expect(result).not.toContain('Completed at:');
  });

  it('omits non-outcome search_memory results that only contain low-value lines', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'gotcha-status-only',
          type: 'gotcha',
          content: [
            'npm run typecheck passed.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          confidence: 0.95,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['gotcha'] },
      string
    >(tool, { query: 'auth gotcha', limit: 3, types: ['gotcha'] });

    expect(result).toBe('No relevant memories found for this query.');
  });

  it('returns a focused no-result hint for machine memory searches', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'token cost and files to read for auth module', limit: 3 });

    expect(result).toBe(
      'No relevant token-cost/file-prefetch memories found; inspect focused files next.',
    );
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['context_cost', 'prefetch_pattern'],
      promptContextOnly: false,
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

  it('disambiguates duplicate search_memory file reference chip names', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'duplicate-file-names',
          content: 'Check the index module boundaries before changing exports.',
          relatedFiles: [
            'src/auth/index.ts',
            'src/billing/index.ts',
            'src/auth/session.ts',
          ],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'index file refs', limit: 3 });

    expect(result).toContain('[auth/index.ts, billing/index.ts, session.ts]');
    expect(result).not.toContain('[index.ts, index.ts');
  });

  it('does not repeat file reference chips already mentioned in search_memory content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'mentioned-file-ref',
          content: 'Before editing src/auth/session.ts, refresh auth-token.ts cache helpers.',
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'auth file refs', limit: 3 });

    expect(result).toContain('Before editing src/auth/session.ts');
    expect(result).toContain('auth-token.ts');
    expect(result).toContain('[token.ts]');
    expect(result).not.toContain('[session.ts, token.ts]');
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
    expect(result).toContain('Prefetch together: src/auth/{session.ts, token.ts}');
    expect(result).not.toContain('[session.ts, token.ts]');
    expect(result).not.toContain('frequentlyReadFiles');
    expect(result).not.toContain('"frequentlyReadFiles"');
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
    expect(result).toContain('Prefetch together: src/auth/{session.ts, token.ts}');
    expect(result).not.toContain('frequentlyReadFiles');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['prefetch_pattern'],
      promptContextOnly: false,
    }));
  });

  it('infers prefetch_pattern searches from file access queries without explicit types', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'prefetch-json',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: ['src/auth/session.ts'],
            frequentlyReadFiles: ['src/auth/token.ts'],
          }),
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'file access patterns for auth module', limit: 3 });

    expect(result).toContain('[prefetch_pattern]');
    expect(result).toContain('Always prefetch: src/auth/session.ts');
    expect(result).toContain('Prefetch together: src/auth/token.ts');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['prefetch_pattern'],
      promptContextOnly: false,
    }));
  });

  it('infers prefetch_pattern searches from localized file access queries', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'localized-prefetch-json',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: ['src/auth/session.ts'],
            frequentlyReadFiles: ['src/auth/token.ts'],
          }),
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: '处理认证时该先看哪些文件', limit: 3 });

    expect(result).toContain('[prefetch_pattern]');
    expect(result).toContain('Always prefetch: src/auth/session.ts');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['prefetch_pattern'],
      promptContextOnly: false,
    }));
  });

  it('does not infer prefetch_pattern for ordinary file gotcha searches', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'file-gotcha',
          type: 'gotcha',
          content: 'Validate file upload size before writing to disk.',
          confidence: 0.95,
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'file upload gotchas', limit: 3 });

    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: undefined,
      promptContextOnly: true,
    }));
  });

  it('infers multiple machine memory types from combined cost and file access queries', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'context-cost',
          type: 'context_cost',
          content: 'Context token spike: prompt reached 24k tokens; narrow broad file rereads.',
          confidence: 0.95,
          relatedFiles: ['src/auth/session.ts'],
        }),
        makeMemory({
          id: 'prefetch-json',
          type: 'prefetch_pattern',
          content: JSON.stringify({
            alwaysReadFiles: ['src/auth/session.ts'],
            frequentlyReadFiles: ['src/auth/token.ts'],
          }),
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number },
      string
    >(tool, { query: 'token cost and files to read for auth module', limit: 3 });

    expect(result).toContain('[context_cost]');
    expect(result).toContain('Context token spike');
    expect(result).toContain('[prefetch_pattern]');
    expect(result).toContain('Always prefetch: src/auth/session.ts');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['context_cost', 'prefetch_pattern'],
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
    expect(result).toContain('Related files: src/auth/session.ts.');
    expect(result).not.toContain('[session.ts]');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      types: ['context_cost'],
      promptContextOnly: false,
    }));
  });

  it('formats context_cost related files as compact full paths', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'context-cost-files',
          type: 'context_cost',
          content: 'Context token spike: prompt reached 32k tokens; avoid broad auth rereads.',
          confidence: 0.95,
          relatedFiles: [
            'src\\auth\\session.ts',
            './src/auth/token.ts',
            'src/auth/token.ts',
            'src/auth/refresh-flow.ts',
            'src/auth/retry-policy.ts',
            'src/auth/telemetry.ts',
          ],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['context_cost'] },
      string
    >(tool, { query: 'token cost auth files', limit: 3, types: ['context_cost'] });

    expect(result).toContain('[context_cost]');
    expect(result).toContain(
      'Related files: src/auth/{session.ts, token.ts, refresh-flow.ts, retry-policy.ts} (+1 more).',
    );
    expect(result).not.toContain('[session.ts');
  });

  it('does not repeat context_cost related files already present in content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'context-cost-mentioned-file',
          type: 'context_cost',
          content: 'Context token spike near session.ts and auth-token.ts; inspect narrowly next time.',
          confidence: 0.95,
          relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts', 'src/auth/retry-policy.ts'],
        }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string; limit: number; types: ['context_cost'] },
      string
    >(tool, { query: 'token cost auth files', limit: 3, types: ['context_cost'] });

    expect(result).toContain('Context token spike near session.ts and auth-token.ts');
    expect(result).toContain('Related files: src/auth/{token.ts, retry-policy.ts}.');
    expect(result).not.toContain('Related files: src/auth/session.ts');
  });

  it('infers context_cost searches from localized token cost queries', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'localized-context-cost',
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
    >(tool, { query: '怎么减少 token 消耗并避免上下文窗口过大', limit: 3 });

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

  it('does not infer context_cost for localized auth token searches', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'localized-auth-token-gotcha',
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
    >(tool, { query: '认证 token 刷新行为', limit: 3 });

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

  it('records useful memory when duplicate search fails', async () => {
    const proxy = {
      searchMemory: vi.fn().mockRejectedValue(new Error('memory search unavailable')),
      recordMemory: vi.fn().mockResolvedValue('aabbccdd-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Retry memory persistence after transient search IPC failures.',
      relatedFiles: ['src/main/ai/memory/tools/record-memory.ts'],
    });

    expect(result).toBe('Memory recorded (id: aabbccdd).');
    expect(proxy.searchMemory).toHaveBeenCalledOnce();
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Retry memory persistence after transient search IPC failures.',
    }));
  });

  it('returns compact failure text when record_memory persistence throws', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Use a compact tool response when memory persistence fails.',
    });

    expect(result).toBe('Memory noted locally, but could not be persisted.');
    expect(result).not.toContain('database unavailable');
    expect(result).not.toContain('Use a compact tool response');
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

  it('omits record_memory modules already represented by related files', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('ab12cd34-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[]; relatedModules: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Use shared auth helper before retrying token refresh.',
      relatedFiles: ['src/auth/token.ts', 'src/auth/session-store.ts'],
      relatedModules: [
        'src/auth/token.ts',
        'token.ts',
        'token',
        'session-store',
        'auth',
        'token refresh',
      ],
    });

    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      relatedFiles: ['src/auth/token.ts', 'src/auth/session-store.ts'],
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

  it('strips low-value status lines before recording useful memory content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('feedface-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: [
        'npm run typecheck passed.',
        'Mock the OAuth clock before testing refresh retries.',
        'No issues found.',
        'Completed at: 2026-06-15T00:00:00.000Z',
      ].join('\n'),
    });

    expect(result).toBe('Memory recorded (id: feedface).');
    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Mock the OAuth clock before testing refresh retries.',
    }));
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Mock the OAuth clock before testing refresh retries.',
    }));
  });

  it('skips record_memory writes that are only low-value lines after cleanup', async () => {
    const proxy = {
      searchMemory: vi.fn(),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'module_insight'; content: string },
      string
    >(tool, {
      type: 'module_insight',
      content: [
        'Memory search results for "auth": 1. [gotcha] Already shown.',
        'npm run typecheck passed.',
        'No issues found.',
        'Completed at: 2026-06-15T00:00:00.000Z',
      ].join('\n'),
    });

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
    expect(proxy.searchMemory).not.toHaveBeenCalled();
    expect(proxy.recordMemory).not.toHaveBeenCalled();
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

  it('detects duplicate memories after stripping low-value lines from existing content', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({
          id: 'existing-noisy-memory',
          content: [
            'npm run typecheck passed.',
            'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
            'No issues found.',
          ].join('\n'),
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

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it('skips localized generic completion memories before persistence', async () => {
    const proxy = {
      searchMemory: vi.fn(),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'module_insight'; content: string },
      string
    >(tool, {
      type: 'module_insight',
      content: '任务完成，所有测试通过，token 使用较少。',
    });

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
    expect(proxy.searchMemory).not.toHaveBeenCalled();
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it.each([
    'Typecheck passed.',
    'npm run typecheck passed.',
  ])('skips generic verification status memories before persistence: %s', async (content) => {
    const proxy = {
      searchMemory: vi.fn(),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'module_insight'; content: string },
      string
    >(tool, { type: 'module_insight', content });

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
    expect(proxy.searchMemory).not.toHaveBeenCalled();
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it.each([
    'No relevant token-cost/file-prefetch memories found; continue with focused inspection instead of repeating this search.',
    'No relevant token-cost/file-prefetch memories found; inspect focused files next.',
    'Memory search unavailable; inspect focused files next.',
    'Memory search results for "auth": 1. [gotcha] Refresh token cache before notifying listeners.',
    'Memory system not available in this session.',
    'Memory noted locally, but could not be persisted.',
  ])('skips memory tool echo responses before persistence: %s', async (content) => {
    const proxy = {
      searchMemory: vi.fn(),
      recordMemory: vi.fn(),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'module_insight'; content: string },
      string
    >(tool, {
      type: 'module_insight',
      content,
    });

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
    expect(proxy.searchMemory).not.toHaveBeenCalled();
    expect(proxy.recordMemory).not.toHaveBeenCalled();
  });

  it('keeps localized reusable gotchas recordable', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('facefeed-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: '实现 auth refresh 时必须先更新 token cache，再通知 renderer 监听器。',
      relatedFiles: ['src/auth/token-cache.ts'],
    });

    expect(result).toBe('Memory recorded (id: facefeed).');
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: '实现 auth refresh 时必须先更新 token cache，再通知 renderer 监听器。',
      relatedFiles: ['src/auth/token-cache.ts'],
    }));
  });

  it('keeps actionable verification gotchas recordable', async () => {
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([]),
      recordMemory: vi.fn().mockResolvedValue('feedface-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'Typecheck fails unless worker memory IPC request unions include token usage events.',
      relatedFiles: ['src/main/ai/memory/types.ts'],
    });

    expect(result).toBe('Memory recorded (id: feedface).');
    expect(proxy.recordMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Typecheck fails unless worker memory IPC request unions include token usage events.',
      relatedFiles: ['src/main/ai/memory/types.ts'],
    }));
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

    expect(result).toBe(MEMORY_SKIPPED_LOW_VALUE_RESULT);
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
