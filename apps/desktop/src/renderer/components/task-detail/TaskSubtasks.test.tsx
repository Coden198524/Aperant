// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';
import { TooltipProvider } from '../ui/tooltip';
import { TaskSubtasks } from './TaskSubtasks';

vi.mock('../../stores/task-store', () => ({
  deleteSubtask: vi.fn(),
  useTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: [] }),
}));

function createTask(): Task {
  return {
    id: 'task-1',
    specId: 'spec-1',
    projectId: 'project-1',
    title: 'Review task',
    description: 'Task description',
    status: 'human_review',
    subtasks: [
      {
        id: 'subtask-1',
        title: 'Render summary',
        description: 'Render subtask completion summary',
        completionSummary: [
          'Added the summary panel and task detail view layout.',
          'Verified with TaskSubtasks.test.tsx.',
          'Reviewer should confirm long summaries remain readable.',
        ].join(' '),
        status: 'completed',
        files: [],
      },
    ],
    logs: [
      'Starting QA validation loop',
      'Running qa_reviewer session (session=1)',
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('TaskSubtasks', () => {
  beforeEach(() => {
    window.electronAPI = {
      ...window.electronAPI,
      getTaskLogs: vi.fn(async () => ({ success: true, data: null })),
      watchTaskLogs: vi.fn(async () => ({ success: true })),
      unwatchTaskLogs: vi.fn(async () => ({ success: true })),
      onTaskLogsChanged: vi.fn(() => vi.fn()),
      onTaskLogsStream: vi.fn(() => vi.fn()),
    } as typeof window.electronAPI;
  });

  it('shows completion summary when a subtask is expanded', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createTask()} />
      </TooltipProvider>
    );

    expect(screen.queryByText(/Added the summary panel/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Render summary'));

    expect(screen.getByText('Completion summary')).toBeInTheDocument();
    expect(screen.getByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Review notes')).toBeInTheDocument();
    expect(screen.getByText(/Added the summary panel/)).toBeInTheDocument();
    expect(screen.getByText(/Verified with TaskSubtasks.test.tsx/)).toBeInTheDocument();
  });

  it('shows markdown table supplemental text around completion summaries', () => {
    const task = createTask();
    task.subtasks[0].completionSummary = [
      'Context before table should remain visible.',
      '',
      '| Item | Detail |',
      '| --- | --- |',
      '| What changed | Added structured summary rendering. |',
      '| Verification | Ran TaskSubtasks.test.tsx. |',
      '',
      'Context after table should also remain visible.',
    ].join('\n');

    render(
      <TooltipProvider>
        <TaskSubtasks task={task} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByText('Render summary'));

    expect(screen.getByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText(/Context before table should remain visible/)).toBeInTheDocument();
    expect(screen.getByText(/Context after table should also remain visible/)).toBeInTheDocument();
  });

  it('renders escaped Chinese markdown summary tables instead of raw source', () => {
    const task = createTask();
    task.subtasks[0].completionSummary = [
      '\\|项目\\|内容\\|',
      '\\|完成内容\\|添加了子任务总结表格渲染。\\|',
      '\\|验证结果\\|运行 TaskSubtasks.test.tsx。\\|',
      '\\|审核要点\\|确认表格不再显示源码。\\|',
    ].join('\n');

    render(
      <TooltipProvider>
        <TaskSubtasks task={task} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByText('Render summary'));

    expect(screen.getByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Review notes')).toBeInTheDocument();
    expect(screen.getByText('添加了子任务总结表格渲染。')).toBeInTheDocument();
    expect(screen.queryByText(/\\\|项目\\\|内容\\\|/)).not.toBeInTheDocument();
  });

  it('shows runtime logs next to the subtask list', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createTask()} />
      </TooltipProvider>
    );

    const runtimePanel = screen.getByTestId('task-runtime-logs');
    expect(runtimePanel).toBeInTheDocument();
    expect(within(runtimePanel).getAllByText('Runtime').length).toBeGreaterThan(0);
    expect(screen.getByText(/Starting QA validation loop/)).toBeInTheDocument();
    expect(screen.getByText(/Running qa_reviewer session/)).toBeInTheDocument();
  });
});
