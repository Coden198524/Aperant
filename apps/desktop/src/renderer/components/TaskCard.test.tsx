// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/types';
import { TaskCard } from './TaskCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (typeof params?.defaultValue === 'string') {
        return params.defaultValue
          .replace('{{index}}', String(params.index ?? ''))
          .replace('{{count}}', String(params.count ?? ''));
      }

      return key;
    },
  }),
}));

vi.mock('./PhaseProgressIndicator', () => ({
  PhaseProgressIndicator: () => <div data-testid="phase-progress-indicator" />,
}));

vi.mock('../hooks/use-toast', () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

vi.mock('../stores/task-store', () => ({
  stopTask: vi.fn(),
  checkTaskRunning: vi.fn().mockResolvedValue(true),
  recoverStuckTask: vi.fn().mockResolvedValue({ success: true }),
  isIncompleteHumanReview: vi.fn(() => false),
  archiveTasks: vi.fn().mockResolvedValue({ success: true }),
  hasRecentActivity: vi.fn(() => true),
  startTaskOrQueue: vi.fn().mockResolvedValue({ success: true, action: 'started' }),
  deleteTask: vi.fn().mockResolvedValue({ success: true }),
}));

function createTask(): Task {
  return {
    id: 'task-1',
    specId: 'spec-1',
    projectId: 'project-1',
    title: 'Batch task card',
    description: 'Render active batch subtasks on the card',
    status: 'in_progress',
    reviewReason: undefined,
    subtasks: [
      { id: 'subtask-1', title: 'Build batch badge', description: 'Build batch badge', status: 'pending', files: [] },
      { id: 'subtask-2', title: 'Leave pending for next batch', description: 'Leave pending for next batch', status: 'pending', files: [] },
      { id: 'subtask-3', title: 'Render subtask chips', description: 'Render subtask chips', status: 'pending', files: [] },
    ],
    logs: [],
    executionProgress: {
      phase: 'coding',
      phaseProgress: 45,
      overallProgress: 45,
      message: 'Working through implementation',
      currentSubtask: 'subtask-3',
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('TaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).electronAPI = {
      openExternal: vi.fn(),
      checkWorktreeChanges: vi.fn().mockResolvedValue({
        success: true,
        data: { hasChanges: false, changedFileCount: 0 },
      }),
    };
  });

  it('renders the phase progress indicator and active subtask summary', () => {
    render(
      <TaskCard
        task={createTask()}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId('phase-progress-indicator')).toBeInTheDocument();
    expect(screen.getByText('Executing #3')).toBeInTheDocument();
  });

  it('renders a parallel summary when multiple subtasks are in progress', () => {
    const task = createTask();
    task.subtasks = task.subtasks.map((subtask, index) => ({
      ...subtask,
      status: index < 2 ? 'in_progress' : 'pending',
    }));
    if (task.executionProgress) {
      task.executionProgress = {
        ...task.executionProgress,
        currentSubtask: undefined,
      };
    }

    render(
      <TaskCard
        task={task}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('2 subtasks running in parallel')).toBeInTheDocument();
  });

  it('renders parallel task info on the kanban card even when execution phase is missing', () => {
    const task = createTask();
    task.subtasks = task.subtasks.map((subtask, index) => ({
      ...subtask,
      status: index < 2 ? 'in_progress' : 'pending',
    }));
    task.executionProgress = undefined;

    render(
      <TaskCard
        task={task}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText('Parallel: 2')).toBeInTheDocument();
    expect(screen.getByText('2 subtasks running in parallel')).toBeInTheDocument();
  });
});
