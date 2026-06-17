/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('context-store project scoping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('ignores stale project context responses after switching projects', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getProjectContext: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { loadProjectContext, useContextStore } = await import('../context-store');

    const loadA = loadProjectContext('project-a');
    const loadB = loadProjectContext('project-b');

    projectB.resolve({
      success: true,
      data: {
        projectIndex: { projectId: 'project-b' },
        memoryStatus: { enabled: true },
        memoryState: { status: 'ready' },
        recentMemories: [{ id: 'memory-b' }],
      },
    });
    await loadB;

    projectA.resolve({
      success: true,
      data: {
        projectIndex: { projectId: 'project-a' },
        memoryStatus: { enabled: false },
        memoryState: { status: 'disabled' },
        recentMemories: [{ id: 'memory-a' }],
      },
    });
    await loadA;

    const state = useContextStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.projectIndex).toEqual({ projectId: 'project-b' });
    expect(state.recentMemories).toEqual([{ id: 'memory-b' }]);
    expect(state.indexLoading).toBe(false);
    expect(state.memoryLoading).toBe(false);
  });

  it('ignores stale memory search responses', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        searchMemories: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { searchMemories, useContextStore } = await import('../context-store');

    const searchA = searchMemories('project-a', 'old');
    const searchB = searchMemories('project-b', 'new');

    projectB.resolve({ success: true, data: [{ id: 'result-b' }] });
    await searchB;

    projectA.resolve({ success: true, data: [{ id: 'result-a' }] });
    await searchA;

    const state = useContextStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.searchQuery).toBe('new');
    expect(state.searchResults).toEqual([{ id: 'result-b' }]);
    expect(state.searchLoading).toBe(false);
  });
});
