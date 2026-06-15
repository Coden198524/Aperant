import { describe, expect, it, vi } from 'vitest';
import { buildPrefetchPlan } from '../../injection/prefetch-builder';
import type { Memory, MemoryService } from '../../types';

function makeMemory(content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'prefetch-1',
    type: 'prefetch_pattern',
    content,
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'observer_inferred',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

function makeMemoryService(memories: Memory[]): MemoryService {
  return {
    store: vi.fn().mockResolvedValue('id'),
    search: vi.fn().mockResolvedValue(memories),
    searchByPattern: vi.fn().mockResolvedValue(null),
    insertUserTaught: vi.fn().mockResolvedValue('id'),
    searchWorkflowRecipe: vi.fn().mockResolvedValue([]),
    updateAccessCount: vi.fn().mockResolvedValue(undefined),
    deprecateMemory: vi.fn().mockResolvedValue(undefined),
    verifyMemory: vi.fn().mockResolvedValue(undefined),
    pinMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildPrefetchPlan', () => {
  it('returns an empty plan without querying memory when modules normalize empty', async () => {
    const memoryService = makeMemoryService([]);

    const plan = await buildPrefetchPlan([' ', '\n\t'], memoryService, 'project-1');

    expect(memoryService.search).not.toHaveBeenCalled();
    expect(plan.alwaysReadFiles).toEqual([]);
    expect(plan.frequentlyReadFiles).toEqual([]);
    expect(plan.maxFiles).toBe(6);
  });

  it('normalizes and deduplicates module filters before searching', async () => {
    const memoryService = makeMemoryService([]);

    await buildPrefetchPlan([' auth ', 'AUTH', 'billing', 'billing'], memoryService, 'project-1');

    expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
      relatedModules: ['auth', 'billing'],
      promptContextOnly: false,
      excludeDeprecated: true,
      recordAccess: false,
    }));
  });

  it('keeps the default prefetch plan compact', async () => {
    const files = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: files,
        frequentlyReadFiles: files,
      })),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.totalTokenBudget).toBe(8192);
    expect(plan.maxFiles).toBe(6);
    expect(plan.alwaysReadFiles).toHaveLength(6);
    expect(plan.frequentlyReadFiles).toHaveLength(0);
    expect(plan.alwaysReadFiles.length + plan.frequentlyReadFiles.length).toBeLessThanOrEqual(plan.maxFiles);
  });

  it('samples long prefetch file lists from the head and tail', async () => {
    const files = Array.from({ length: 14 }, (_, index) => `src/prefetch-${index}.ts`);
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: files,
      })),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toContain('src/prefetch-0.ts');
    expect(plan.alwaysReadFiles).toContain('src/prefetch-13.ts');
    expect(plan.alwaysReadFiles).not.toContain('src/prefetch-7.ts');
    expect(plan.alwaysReadFiles).toHaveLength(6);
    expect(plan.alwaysReadFiles.length + plan.frequentlyReadFiles.length).toBeLessThanOrEqual(plan.maxFiles);
  });

  it('prioritizes files repeated across memories before one-off samples', async () => {
    const files = Array.from({ length: 15 }, (_, index) => `src/prefetch-${index}.ts`);
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          ...files,
          'src/prefetch-10.ts',
        ],
      }), { id: 'long-history' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          'src/prefetch-10.ts',
          'src/prefetch-11.ts',
        ],
      }), { id: 'repeat-signal' }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([
      'src/prefetch-10.ts',
      'src/prefetch-11.ts',
      'src/prefetch-0.ts',
      'src/prefetch-1.ts',
      'src/prefetch-2.ts',
      'src/prefetch-14.ts',
    ]);
    expect(plan.alwaysReadFiles).not.toContain('src/prefetch-13.ts');
    expect(plan.alwaysReadFiles.length + plan.frequentlyReadFiles.length).toBeLessThanOrEqual(plan.maxFiles);
  });

  it('orders repeated files first even when all candidates fit', async () => {
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          'src/auth/session.ts',
          'src/auth/token.ts',
          'src/auth/guard.ts',
        ],
      }), { id: 'baseline' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/auth/guard.ts'],
      }), { id: 'guard-repeat' }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([
      'src/auth/guard.ts',
      'src/auth/session.ts',
      'src/auth/token.ts',
    ]);
  });

  it('records access only for memories that contribute selected prefetch files', async () => {
    const files = Array.from({ length: 14 }, (_, index) => `src/prefetch-${index}.ts`);
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: files,
      }), { id: 'selected' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/prefetch-0.ts'],
      }), { id: 'duplicate-selected' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/prefetch-extra-0.ts'],
      }), { id: 'not-selected' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          'src/prefetch-extra-1.ts',
          'src/prefetch-extra-2.ts',
          'src/prefetch-extra-3.ts',
        ],
      }), { id: 'tail-selected' }),
      makeMemory('{bad json', { id: 'malformed' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/prefetch-low.ts'],
      }), { id: 'low-confidence', confidence: 0.2 }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([
      'src/prefetch-0.ts',
      'src/prefetch-1.ts',
      'src/prefetch-2.ts',
      'src/prefetch-3.ts',
      'src/prefetch-4.ts',
      'src/prefetch-extra-3.ts',
    ]);
    expect(memoryService.updateAccessCount).toHaveBeenCalledTimes(2);
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('selected');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('tail-selected');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('duplicate-selected');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('not-selected');
  });

  it('deduplicates equivalent prefetch paths before applying file budgets', async () => {
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          'src\\auth\\session.ts',
          'SRC/auth/session.ts',
          'src/auth/token.ts',
        ],
        frequentlyReadFiles: [
          'SRC/AUTH/SESSION.ts',
          'src/auth/guard.ts',
        ],
      }), { id: 'selected' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/auth/session.ts'],
        frequentlyReadFiles: ['SRC/auth/guard.ts'],
      }), { id: 'duplicate-path-source' }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([
      'src/auth/session.ts',
      'src/auth/token.ts',
    ]);
    expect(plan.frequentlyReadFiles).toEqual(['src/auth/guard.ts']);
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('selected');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('duplicate-path-source');
  });

  it('consumes observer-inferred co-access prefetch patterns', async () => {
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: [],
        frequentlyReadFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
      }), { id: 'observer-co-access' }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([]);
    expect(plan.frequentlyReadFiles).toEqual([
      'src/auth/session.ts',
      'src/auth/token.ts',
    ]);
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('observer-co-access');
  });

  it('filters low-quality memories and unsafe prefetch paths', async () => {
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: [
          'src/auth/session.ts',
          './src/auth/session.ts',
          'E:/Work/project/src/auth/absolute.ts',
          '../outside.ts',
          '.autocode/specs/001-task/context.md',
          'node_modules/pkg/index.js',
          'dist/bundle.js',
          '.next/server/app.js',
          '.turbo/cache/trace.json',
          '.cache/vite/auth.ts',
          'target/debug/auth.rs',
          'tmp/generated-auth.ts',
          'src/auth//refresh.ts',
          'src/assets/logo.png',
          'src/auth/generated.js.map',
          'src/data/auth.sqlite',
          'src/data/cache.db',
          'src/native/auth.wasm',
          'src/native/auth.dll',
          'package-lock.json',
          'src/auth/',
        ],
        frequentlyReadFiles: [
          'src/auth/session.ts',
          'src/auth/token.ts',
          'coverage/lcov.info',
          'https://example.com/remote.ts',
          'src/auth/guard.ts',
          'pnpm-lock.yaml',
          'src/videos/demo.mp4',
        ],
      })),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/auth/low-confidence.ts'],
      }), { id: 'low', confidence: 0.2 }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/auth/wrong-type.ts'],
      }), { id: 'wrong-type', type: 'gotcha' }),
      makeMemory(JSON.stringify({
        alwaysReadFiles: ['src/auth/stale.ts'],
      }), { id: 'stale', staleAt: '2000-01-01T00:00:00.000Z' }),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.alwaysReadFiles).toEqual([
      'src/auth/session.ts',
      'src/auth/refresh.ts',
    ]);
    expect(plan.frequentlyReadFiles).toEqual([
      'src/auth/token.ts',
      'src/auth/guard.ts',
    ]);
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('.autocode');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('node_modules');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('.next');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('.turbo');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('.cache');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('target/');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('tmp/');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('logo.png');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('generated.js.map');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('auth.sqlite');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('cache.db');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('auth.wasm');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('auth.dll');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('package-lock');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('pnpm-lock');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('demo.mp4');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('low-confidence');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('wrong-type');
    expect([...plan.alwaysReadFiles, ...plan.frequentlyReadFiles].join('\n')).not.toContain('stale');
  });
});
