/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../shared/types';

const mockGetWorktreeStatus = vi.fn();
const mockGetWorktreeDiff = vi.fn();

vi.mock('../../../stores/project-store', () => ({
  useProjectStore: (selector: (state: {
    activeProjectId: string | null;
    selectedProjectId: string | null;
    projects: Array<{ id: string; path: string }>;
  }) => unknown) => selector({
    activeProjectId: null,
    selectedProjectId: null,
    projects: [],
  }),
}));

vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { settings: { logOrder: 'chronological' | 'reverse-chronological' } }) => unknown) =>
    selector({ settings: { logOrder: 'chronological' } }),
}));

vi.mock('../../../stores/task-store', () => ({
  checkTaskRunning: vi.fn().mockResolvedValue(false),
  isIncompleteHumanReview: vi.fn(() => false),
  getTaskProgress: vi.fn(() => ({ completed: 0, total: 0, percentage: 0 })),
  useTaskStore: {
    getState: () => ({
      updateTask: vi.fn(),
    }),
  },
  loadTasks: vi.fn(),
  hasRecentActivity: vi.fn(() => false),
}));

import { useTaskDetail } from './useTaskDetail';

describe('useTaskDetail', () => {
  const task: Task = {
    id: 'task-1',
    specId: '001-test-task',
    projectId: 'project-1',
    title: 'Test task',
    description: 'Test description',
    status: 'human_review',
    reviewReason: 'errors',
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-04-10T00:00:00.000Z'),
    updatedAt: new Date('2026-04-10T00:00:00.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockGetWorktreeStatus.mockResolvedValue({
      success: true,
      data: {
        exists: true,
        worktreePath: 'E:/repo/.autocode/worktrees/tasks/001-test-task',
        branch: 'autocode/001-test-task',
        baseBranch: 'develop',
        commitCount: 1,
        filesChanged: 2,
        additions: 10,
        deletions: 3,
      },
    });

    mockGetWorktreeDiff.mockResolvedValue({
      success: true,
      data: {
        files: [
          {
            path: 'src/test.ts',
            status: 'modified',
            additions: 10,
            deletions: 3,
          },
        ],
        summary: '1 files changed, 10 insertions(+), 3 deletions(-)',
      },
    });

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getWorktreeStatus: mockGetWorktreeStatus,
        getWorktreeDiff: mockGetWorktreeDiff,
      },
      writable: true,
      configurable: true,
    });
  });

  it('loads worktree status on mount without eagerly loading diff', async () => {
    renderHook(() => useTaskDetail({ task }));

    await waitFor(() => {
      expect(mockGetWorktreeStatus).toHaveBeenCalledTimes(1);
    });

    expect(mockGetWorktreeDiff).not.toHaveBeenCalled();
  });

  it('loads diff only after the diff dialog is opened', async () => {
    const { result } = renderHook(() => useTaskDetail({ task }));

    await waitFor(() => {
      expect(mockGetWorktreeStatus).toHaveBeenCalledTimes(1);
    });
    expect(mockGetWorktreeDiff).not.toHaveBeenCalled();

    act(() => {
      result.current.setShowDiffDialog(true);
    });

    await waitFor(() => {
      expect(mockGetWorktreeDiff).toHaveBeenCalledTimes(1);
    });
  });
});
