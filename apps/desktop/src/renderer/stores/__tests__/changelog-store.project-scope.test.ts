/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createTask(id: string, projectId: string): Task {
  return {
    id,
    specId: id,
    projectId,
    title: id,
    description: id,
    status: 'done',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('changelog-store project scoping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('passes only current project tasks when loading changelog data', async () => {
    const getChangelogDoneTasks = vi.fn(async () => ({ success: true, data: [] }));
    const readExistingChangelog = vi.fn(async () => ({ success: true, data: null }));

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getChangelogDoneTasks,
        readExistingChangelog,
      },
      configurable: true,
    });

    const { useTaskStore } = await import('../task-store');
    const { loadChangelogData } = await import('../changelog-store');
    const taskA = createTask('task-a', 'project-a');
    const taskB = createTask('task-b', 'project-b');

    useTaskStore.setState({ tasks: [taskA, taskB] });

    await loadChangelogData('project-a');

    expect(getChangelogDoneTasks).toHaveBeenCalledWith('project-a', [taskA]);
  });

  it('ignores stale changelog data responses after switching projects', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getChangelogDoneTasks: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
        readExistingChangelog: vi.fn(async (projectId: string) => ({
          success: true,
          data: { content: projectId, lastVersion: '1.0.0' },
        })),
      },
      configurable: true,
    });

    const { useTaskStore } = await import('../task-store');
    const { loadChangelogData, useChangelogStore } = await import('../changelog-store');

    useTaskStore.setState({
      tasks: [createTask('task-a', 'project-a'), createTask('task-b', 'project-b')],
    });

    const loadA = loadChangelogData('project-a');
    const loadB = loadChangelogData('project-b');

    projectB.resolve({ success: true, data: [{ id: 'done-b' }] });
    await loadB;

    projectA.resolve({ success: true, data: [{ id: 'done-a' }] });
    await loadA;

    const state = useChangelogStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.doneTasks).toEqual([{ id: 'done-b' }]);
    expect(state.existingChangelog?.content).toBe('project-b');
  });
});
