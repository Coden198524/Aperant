// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../shared/types';
import { OpenSpecTaskDetailModal } from './OpenSpecTaskDetailModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./OpenSpecWorkspace', () => ({
  OpenSpecWorkspace: () => (
    <div data-testid="openspec-workspace">OpenSpec workspace</div>
  ),
}));

vi.mock('../WorktreeCleanupDialog', () => ({
  WorktreeCleanupDialog: ({
    open,
    worktreePath,
    variant,
    error,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    worktreePath?: string;
    variant?: string;
    error?: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }) => open ? (
    <div data-testid="worktree-cleanup-dialog" data-variant={variant}>
      <span>{worktreePath}</span>
      {error && <span role="alert">{error}</span>}
      <button type="button" onClick={() => onOpenChange(false)}>
        Cancel cleanup
      </button>
      <button type="button" onClick={onConfirm}>
        Confirm cleanup
      </button>
    </div>
  ) : null,
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'archived-spec',
    specId: 'archived-spec',
    projectId: 'project-a',
    title: 'Archived Spec',
    description: 'Archived OpenSpec task.',
    status: 'done',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      useWorktree: true,
      openSpec: {
        formatVersion: 1,
        rootKind: 'project',
        schemaName: 'spec-driven',
      },
    },
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('OpenSpecTaskDetailModal archived worktree cleanup', () => {
  const getWorktreeStatus = vi.fn();
  const discardWorktree = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getWorktreeStatus,
        discardWorktree,
      },
    });
  });

  it('prompts once per open details session and cancel keeps the completed task open', async () => {
    getWorktreeStatus.mockResolvedValue({
      success: true,
      data: {
        exists: true,
        worktreePath: 'C:\\project\\.autocode\\worktrees\\tasks\\archived-spec',
      },
    });
    const onOpenChange = vi.fn();
    const currentTask = task();
    const { rerender } = render(
      <OpenSpecTaskDetailModal
        open
        task={currentTask}
        onOpenChange={onOpenChange}
      />,
    );

    expect(await screen.findByTestId('worktree-cleanup-dialog'))
      .toHaveTextContent('archived-spec');
    expect(screen.getByTestId('worktree-cleanup-dialog'))
      .toHaveAttribute('data-variant', 'archived');
    expect(getWorktreeStatus).toHaveBeenCalledOnce();

    rerender(
      <OpenSpecTaskDetailModal
        open
        task={{ ...currentTask, updatedAt: new Date() }}
        onOpenChange={onOpenChange}
      />,
    );
    expect(getWorktreeStatus).toHaveBeenCalledOnce();

    fireEvent.click(within(
      screen.getByTestId('worktree-cleanup-dialog'),
    ).getByText('Cancel cleanup'));
    expect(screen.queryByTestId('worktree-cleanup-dialog'))
      .not.toBeInTheDocument();
    expect(screen.getByTestId('openspec-workspace')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(discardWorktree).not.toHaveBeenCalled();
  });

  it('discards without changing status and closes details after cleanup succeeds', async () => {
    getWorktreeStatus.mockResolvedValue({
      success: true,
      data: {
        exists: true,
        worktreePath: 'C:\\project\\.autocode\\worktrees\\tasks\\archived-spec',
      },
    });
    discardWorktree.mockResolvedValue({
      success: true,
      data: { discarded: true },
    });
    const onOpenChange = vi.fn();
    render(
      <OpenSpecTaskDetailModal
        open
        task={task()}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(within(
      await screen.findByTestId('worktree-cleanup-dialog'),
    ).getByText('Confirm cleanup'));

    await waitFor(() => expect(discardWorktree).toHaveBeenCalledWith(
      'archived-spec',
      true,
      'project-a',
    ));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not inspect tasks that are not completed worktree tasks', () => {
    render(
      <OpenSpecTaskDetailModal
        open
        task={task({
          status: 'human_review',
        })}
        onOpenChange={vi.fn()}
      />,
    );

    expect(getWorktreeStatus).not.toHaveBeenCalled();
  });
});
