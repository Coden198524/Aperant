// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';
import { TaskGitChanges } from './TaskGitChanges';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (typeof params?.defaultValue === 'string') {
        return params.defaultValue.replace('{{count}}', String(params.count ?? ''));
      }
      return key;
    },
  }),
}));

vi.mock('../../hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function createTask(): Task {
  return {
    id: 'task-1',
    specId: 'spec-1',
    projectId: 'project-1',
    title: 'Git task',
    description: 'Task with git changes',
    status: 'human_review',
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('TaskGitChanges', () => {
  beforeEach(() => {
    window.electronAPI = {
      ...window.electronAPI,
      getWorktreeDiff: vi.fn(async () => ({
        success: true,
        data: {
          summary: '1 files changed, 1 insertions(+), 0 deletions(-)',
          files: [
            {
              path: 'src/app.ts',
              status: 'modified',
              additions: 1,
              deletions: 0,
              patch: [
                'diff --git a/src/app.ts b/src/app.ts',
                '@@ -1,1 +1,1 @@',
                '+new line',
              ].join('\n'),
            },
          ],
        },
      })),
      getWorktreeCommits: vi.fn(async () => ({ success: true, data: [] })),
      getWorktreeCommitFiles: vi.fn(async () => ({ success: true, data: [] })),
      getWorktreeCommitFileDiff: vi.fn(async () => ({ success: true, data: '' })),
    } as typeof window.electronAPI;
  });

  it('shows current worktree changes even when there are no commits', async () => {
    render(<TaskGitChanges task={createTask()} />);

    expect((await screen.findAllByText('src/app.ts')).length).toBeGreaterThan(0);
    expect(screen.getByText('+new line')).toBeInTheDocument();
    expect(window.electronAPI.getWorktreeCommitFiles).not.toHaveBeenCalled();
  });

  it('falls back to commit history when the worktree has no current changes', async () => {
    window.electronAPI.getWorktreeDiff = vi.fn(async () => ({
      success: true,
      data: {
        summary: 'No changes found',
        files: [],
      },
    })) as typeof window.electronAPI.getWorktreeDiff;
    window.electronAPI.getWorktreeCommits = vi.fn(async () => ({
      success: true,
      data: [
        {
          hash: 'abcdef123456',
          shortHash: 'abcdef1',
          message: 'Implement feature',
          author: 'Autocode',
          date: '2 minutes ago',
          timestamp: 1767225600,
          parents: ['parent1'],
          refs: [],
          isMerge: false,
        },
      ],
    })) as typeof window.electronAPI.getWorktreeCommits;
    window.electronAPI.getWorktreeCommitFiles = vi.fn(async () => ({
      success: true,
      data: [
        {
          path: 'src/feature.ts',
          status: 'A',
          additions: 1,
          deletions: 0,
        },
      ],
    })) as typeof window.electronAPI.getWorktreeCommitFiles;
    window.electronAPI.getWorktreeCommitFileDiff = vi.fn(async () => ({
      success: true,
      data: [
        'diff --git a/src/feature.ts b/src/feature.ts',
        '@@ -0,0 +1,1 @@',
        '+feature',
      ].join('\n'),
    })) as typeof window.electronAPI.getWorktreeCommitFileDiff;

    render(<TaskGitChanges task={createTask()} />);

    expect(await screen.findByText('Implement feature')).toBeInTheDocument();
    await waitFor(() => {
      expect(window.electronAPI.getWorktreeCommitFiles).toHaveBeenCalledWith('task-1', 'abcdef123456', 'project-1');
    });
    expect((await screen.findAllByText('src/feature.ts')).length).toBeGreaterThan(0);
    expect(await screen.findByText('+feature')).toBeInTheDocument();
  });
});
