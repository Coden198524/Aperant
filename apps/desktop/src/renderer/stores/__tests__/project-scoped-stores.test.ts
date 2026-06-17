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

describe('project-scoped stores', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('ignores stale release version responses', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getReleaseableVersions: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { loadReleaseableVersions, useReleaseStore } = await import('../release-store');

    const loadA = loadReleaseableVersions('project-a');
    const loadB = loadReleaseableVersions('project-b');

    projectB.resolve({ success: true, data: [{ version: '2.0.0', isReleased: false }] });
    await loadB;

    projectA.resolve({ success: true, data: [{ version: '1.0.0', isReleased: false }] });
    await loadA;

    const state = useReleaseStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.releaseableVersions).toEqual([{ version: '2.0.0', isReleased: false }]);
    expect(state.selectedVersion).toBe('2.0.0');
  });

  it('ignores stale GitHub issue responses', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getGitHubIssues: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { loadGitHubIssues, useIssuesStore } = await import('../github/issues-store');

    const loadA = loadGitHubIssues('project-a');
    const loadB = loadGitHubIssues('project-b');

    projectB.resolve({ success: true, data: { issues: [{ number: 2, state: 'open' }], hasMore: false } });
    await loadB;

    projectA.resolve({ success: true, data: { issues: [{ number: 1, state: 'open' }], hasMore: false } });
    await loadA;

    const state = useIssuesStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.issues).toEqual([{ number: 2, state: 'open' }]);
  });

  it('ignores stale GitLab issue responses', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getGitLabIssues: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { loadGitLabIssues, useGitLabStore } = await import('../gitlab-store');

    const loadA = loadGitLabIssues('project-a');
    const loadB = loadGitLabIssues('project-b');

    projectB.resolve({ success: true, data: [{ iid: 2, state: 'opened' }] });
    await loadB;

    projectA.resolve({ success: true, data: [{ iid: 1, state: 'opened' }] });
    await loadA;

    const state = useGitLabStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.issues).toEqual([{ iid: 2, state: 'opened' }]);
  });

  it('ignores stale Yunxiao issue responses', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getYunxiaoIssues: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
      },
      configurable: true,
    });

    const { loadYunxiaoIssues, useYunxiaoIssuesStore } = await import('../yunxiao-issues-store');

    const loadA = loadYunxiaoIssues('project-a');
    const loadB = loadYunxiaoIssues('project-b');

    projectB.resolve({ success: true, data: [{ workItemId: 'b' }] });
    await loadB;

    projectA.resolve({ success: true, data: [{ workItemId: 'a' }] });
    await loadA;

    const state = useYunxiaoIssuesStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.issues).toEqual([{ workItemId: 'b' }]);
  });
});
