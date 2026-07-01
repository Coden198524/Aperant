// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';
import { TaskProgress } from './TaskProgress';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, params?: Record<string, unknown>) => {
      if (typeof params?.defaultValue === 'string') {
        return params.defaultValue
          .replace('{{subtask}}', String(params.subtask ?? ''))
          .replace('{{count}}', String(params.count ?? ''));
      }
      return _key;
    },
  }),
}));

function createTask(): Task {
  return {
    id: 'task-1',
    specId: 'spec-001',
    projectId: 'project-1',
    title: 'Batch task',
    description: 'Test task',
    status: 'in_progress',
    reviewReason: undefined,
    subtasks: [
      { id: 'subtask-1', title: 'First subtask', description: 'First subtask', status: 'pending', files: [] },
      { id: 'subtask-2', title: 'Second subtask', description: 'Second subtask', status: 'pending', files: [] },
      { id: 'subtask-3', title: 'Third subtask', description: 'Third subtask', status: 'pending', files: [] },
    ],
    logs: [],
    executionProgress: {
      phase: 'coding',
      phaseProgress: 30,
      overallProgress: 42,
      message: 'Working through implementation',
      currentSubtask: 'Third subtask',
    },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('TaskProgress', () => {
  it('renders execution message and current subtask during active execution', () => {
    render(
      <TaskProgress
        task={createTask()}
        isRunning={true}
        hasActiveExecution={true}
        executionPhase="coding"
        isStuck={false}
      />,
    );

    expect(screen.getAllByText('Working through implementation').length).toBeGreaterThan(0);
    expect(screen.getByText('Subtask: Third subtask')).toBeInTheDocument();
    expect(screen.getAllByText('42%').length).toBeGreaterThan(0);
  });

  it('renders a parallel summary when multiple coding subtasks are active', () => {
    const task = createTask();
    task.subtasks = task.subtasks.map((subtask, index) => ({
      ...subtask,
      status: index < 2 ? 'in_progress' : 'pending',
    }));

    render(
      <TaskProgress
        task={task}
        isRunning={true}
        hasActiveExecution={true}
        executionPhase="coding"
        isStuck={false}
      />,
    );

    expect(screen.getByText('Parallel: 2 subtasks active')).toBeInTheDocument();
  });

  it('renders completed human review as 100% even when stale execution progress is 95%', () => {
    const task = createTask();
    task.status = 'human_review';
    task.reviewReason = 'completed';
    task.executionProgress = {
      phase: 'qa_review',
      phaseProgress: 100,
      overallProgress: 95,
    };

    render(
      <TaskProgress
        task={task}
        isRunning={false}
        hasActiveExecution={false}
        executionPhase="complete"
        isStuck={false}
      />,
    );

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
