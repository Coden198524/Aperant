// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskLogs } from '../../../shared/types';
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

function createConcurrentWorkPackageTask(): Task {
  return {
    ...createTask(),
    status: 'in_progress',
    metadata: {
      runtimeConcurrency: {
        mode: 'concurrent',
        workers: 2,
        unit: 'work_item',
        conflictPolicy: 'lock-and-queue',
      },
    },
    subtasks: [
      {
        id: 'wp-1',
        title: 'Build board package',
        description: 'Render the board and core interactions',
        status: 'in_progress',
        files: [],
        workPackage: true,
      } as Task['subtasks'][number] & { workPackage: boolean },
      {
        id: 'wp-2',
        title: 'Build scoring package',
        description: 'Render score and level UI',
        status: 'pending',
        files: [],
        workPackage: true,
      } as Task['subtasks'][number] & { workPackage: boolean },
    ],
  };
}

function createFanOutWorkPackageTask(): Task {
  return {
    ...createTask(),
    subtasks: [
      {
        id: 'wp-1',
        title: 'Create shared contract',
        description: 'Create shared contract',
        status: 'completed',
        files: [],
        workPackage: true,
      },
      {
        id: 'wp-2',
        title: 'Build desktop adapter',
        description: 'Build desktop adapter',
        status: 'pending',
        files: [],
        dependsOn: ['wp-1'],
        workPackage: true,
      },
      {
        id: 'wp-3',
        title: 'Build CLI adapter',
        description: 'Build CLI adapter',
        status: 'pending',
        files: [],
        dependsOn: ['wp-1'],
        workPackage: true,
      },
      {
        id: 'wp-4',
        title: 'Build VS Code adapter',
        description: 'Build VS Code adapter',
        status: 'pending',
        files: [],
        dependsOn: ['wp-1'],
        workPackage: true,
      },
      {
        id: 'wp-5',
        title: 'Verify shared runtime',
        description: 'Verify shared runtime',
        status: 'pending',
        files: [],
        dependsOn: ['wp-2', 'wp-3', 'wp-4'],
        workPackage: true,
      },
    ],
  };
}

function createSkipLevelWorkPackageTask(): Task {
  return {
    ...createTask(),
    subtasks: [
      {
        id: 'wp-1',
        title: 'Create shared base',
        description: 'Create shared base',
        status: 'completed',
        files: [],
        workPackage: true,
      },
      {
        id: 'wp-2',
        title: 'Build intermediate layer',
        description: 'Build intermediate layer',
        status: 'pending',
        files: [],
        dependsOn: ['wp-1'],
        workPackage: true,
      },
      {
        id: 'wp-3',
        title: 'Build final layer',
        description: 'Build final layer',
        status: 'pending',
        files: [],
        dependsOn: ['wp-1', 'wp-2'],
        workPackage: true,
      },
    ],
  };
}

function createTimedFanOutWorkPackageTask(): Task {
  const task = createFanOutWorkPackageTask();
  const timings: Record<string, { startedAt: string; completedAt: string }> = {
    'wp-1': {
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:02.000Z',
    },
    'wp-2': {
      startedAt: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
    },
    'wp-3': {
      startedAt: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:06.000Z',
    },
    'wp-4': {
      startedAt: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:07.000Z',
    },
    'wp-5': {
      startedAt: '2026-01-01T00:00:07.000Z',
      completedAt: '2026-01-01T00:00:10.000Z',
    },
  };

  return {
    ...task,
    subtasks: task.subtasks.map(subtask => ({
      ...subtask,
      ...timings[subtask.id],
    })),
  };
}

function createTimedSerialWorkPackageTask(): Task {
  return {
    ...createTask(),
    subtasks: [
      {
        id: 'wp-1',
        title: 'Prepare contract',
        description: 'Prepare contract',
        status: 'completed',
        files: [],
        workPackage: true,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'wp-2',
        title: 'Implement contract',
        description: 'Implement contract',
        status: 'completed',
        files: [],
        dependsOn: ['wp-1'],
        workPackage: true,
        startedAt: '2026-01-01T00:00:01.000Z',
        completedAt: '2026-01-01T00:00:03.000Z',
      },
    ],
  };
}

function createPausedTimedWorkPackageTask(): Task {
  return {
    ...createTask(),
    subtasks: [
      {
        id: 'wp-1',
        title: 'Build paused package',
        description: 'Build paused package',
        status: 'completed',
        files: [],
        workPackage: true,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:10:00.000Z',
        durationMs: 60_000,
      },
      {
        id: 'wp-2',
        title: 'Build active package',
        description: 'Build active package',
        status: 'completed',
        files: [],
        workPackage: true,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:10:00.000Z',
        durationMs: 120_000,
      },
    ],
  };
}

function createTimedFanOutWorkPackageLogs(): TaskLogs {
  const logs = createConcurrentWorkPackageLogs();
  logs.phases.coding.entries = [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Start wp-1.',
      subtask_id: 'wp-1',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'success',
      phase: 'coding',
      content: 'Done wp-1.',
      subtask_id: 'wp-1',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Start wp-2.',
      subtask_id: 'wp-2',
    },
    {
      timestamp: '2026-01-01T00:00:05.000Z',
      type: 'success',
      phase: 'coding',
      content: 'Done wp-2.',
      subtask_id: 'wp-2',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Start wp-3.',
      subtask_id: 'wp-3',
    },
    {
      timestamp: '2026-01-01T00:00:06.000Z',
      type: 'success',
      phase: 'coding',
      content: 'Done wp-3.',
      subtask_id: 'wp-3',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Start wp-4.',
      subtask_id: 'wp-4',
    },
    {
      timestamp: '2026-01-01T00:00:07.000Z',
      type: 'success',
      phase: 'coding',
      content: 'Done wp-4.',
      subtask_id: 'wp-4',
    },
    {
      timestamp: '2026-01-01T00:00:07.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Start wp-5.',
      subtask_id: 'wp-5',
    },
    {
      timestamp: '2026-01-01T00:00:10.000Z',
      type: 'success',
      phase: 'coding',
      content: 'Done wp-5.',
      subtask_id: 'wp-5',
    },
  ];
  return logs;
}

function createConcurrentWorkPackageLogs(): TaskLogs {
  return {
    spec_id: 'spec-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:03.000Z',
    phases: {
      planning: {
        phase: 'planning',
        status: 'completed',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        entries: [],
      },
      coding: {
        phase: 'coding',
        status: 'active',
        started_at: '2026-01-01T00:00:01.000Z',
        completed_at: null,
        entries: [
          {
            timestamp: '2026-01-01T00:00:01.500Z',
            type: 'text',
            phase: 'coding',
            content: 'Global coordinator output.',
          },
          {
            timestamp: '2026-01-01T00:00:02.000Z',
            type: 'text',
            phase: 'coding',
            content: 'Board package model output.',
            subtask_id: 'wp-1',
          },
          {
            timestamp: '2026-01-01T00:00:02.500Z',
            type: 'text',
            phase: 'coding',
            content: 'Scoring package model output.',
            subtask_id: 'wp-2',
          },
        ],
      },
      validation: {
        phase: 'validation',
        status: 'pending',
        started_at: null,
        completed_at: null,
        entries: [],
      },
    },
  };
}

function getExecutionGraphEdgePaths(container: HTMLElement): SVGPathElement[] {
  return Array.from(container.querySelectorAll('svg path'))
    .filter(path => (path.getAttribute('d') ?? '').startsWith('M ')) as SVGPathElement[];
}

function getExecutionGraphEdgePath(container: HTMLElement, from: string, to: string): string {
  return container
    .querySelector<SVGPathElement>(`svg path[data-edge-from="${from}"][data-edge-to="${to}"]`)
    ?.getAttribute('d') ?? '';
}

describe('TaskSubtasks', () => {
  beforeEach(() => {
    window.localStorage.removeItem('task-subtasks-layout-preferences');
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

  it('shows only model output next to the subtask list', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createTask()} />
      </TooltipProvider>
    );

    const runtimePanel = screen.getByTestId('task-runtime-logs');
    expect(runtimePanel).toBeInTheDocument();
    expect(runtimePanel).toHaveTextContent('Model output');
    expect(runtimePanel).not.toHaveTextContent('Runtime');
    expect(screen.queryByText(/Starting QA validation loop/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Running qa_reviewer session/)).not.toBeInTheDocument();
  });

  it('renders the execution graph beside the subtask list', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskSubtasks task={createFanOutWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(screen.getByTestId('subtask-execution-graph')).toBeInTheDocument();
    expect(screen.getByText('Execution graph')).toBeInTheDocument();
    expect(screen.getByText('Sequential 5 rounds')).toBeInTheDocument();
    expect(screen.getByText('Parallel 3 rounds')).toBeInTheDocument();
    expect(screen.getByText('Saves 2 rounds')).toBeInTheDocument();
    expect(screen.getByText('Max parallel 3')).toBeInTheDocument();
    expect(screen.getByText('wp-5')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: /Resize subtasks pane/i })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: /Resize execution graph pane/i })).toBeInTheDocument();

    const edgePaths = getExecutionGraphEdgePaths(container).map(path => path.getAttribute('d') ?? '');
    expect(edgePaths.length).toBeGreaterThan(0);
    expect(edgePaths.every(path => path.includes(' H ') && !path.includes(' C '))).toBe(true);
  });

  it('routes skip-level execution graph edges around intermediate nodes', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskSubtasks task={createSkipLevelWorkPackageTask()} />
      </TooltipProvider>
    );

    const skipEdgePath = getExecutionGraphEdgePath(container, 'wp-1', 'wp-3');

    expect(skipEdgePath).toContain(' H ');
    expect(skipEdgePath).toContain(' V ');
    expect((skipEdgePath.match(/ V /g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(skipEdgePath).not.toBe('M 136 37 H 306');
  });

  it('keeps execution graph edges gray until a connected node is selected', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskSubtasks task={createFanOutWorkPackageTask()} />
      </TooltipProvider>
    );

    const initialEdges = getExecutionGraphEdgePaths(container);
    expect(initialEdges.length).toBeGreaterThan(0);
    expect(initialEdges.every(path => path.getAttribute('class')?.includes('stroke-border'))).toBe(true);
    expect(initialEdges.every(path => path.getAttribute('marker-end') === 'url(#subtask-graph-arrow-default)')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Show model output for wp-1/i }));

    const selectedEdges = getExecutionGraphEdgePaths(container);
    expect(selectedEdges.some(path => !(path.getAttribute('class') ?? '').includes('stroke-border'))).toBe(true);
    expect(selectedEdges.some(path => path.getAttribute('class')?.includes('stroke-border'))).toBe(true);
    expect(selectedEdges.some(path => path.getAttribute('marker-end') !== 'url(#subtask-graph-arrow-default)')).toBe(true);
    expect(selectedEdges.some(path => path.getAttribute('marker-end') === 'url(#subtask-graph-arrow-default)')).toBe(true);
  });

  it('uses recorded work package timings for execution graph totals', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createTimedFanOutWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(screen.getByText('Sequential 17s')).toBeInTheDocument();
    expect(screen.getByText('Parallel 10s')).toBeInTheDocument();
    expect(screen.getByText('Saves 7s')).toBeInTheDocument();
    expect(screen.getByText('Max parallel 3')).toBeInTheDocument();
  });

  it('shows zero saved duration when recorded timings have no parallel savings', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createTimedSerialWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(screen.getByText('Sequential 3s')).toBeInTheDocument();
    expect(screen.getByText('Parallel 3s')).toBeInTheDocument();
    expect(screen.getByText('Saves 0s')).toBeInTheDocument();
  });

  it('excludes paused wall-clock time from recorded duration statistics', () => {
    render(
      <TooltipProvider>
        <TaskSubtasks task={createPausedTimedWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(screen.getByText('Sequential 3m')).toBeInTheDocument();
    expect(screen.getByText('Parallel 2m')).toBeInTheDocument();
    expect(screen.getByText('Saves 1m')).toBeInTheDocument();
  });

  it('falls back to scoped task logs when recorded work package timings are absent', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({
      success: true,
      data: createTimedFanOutWorkPackageLogs(),
    })) as typeof window.electronAPI.getTaskLogs;

    render(
      <TooltipProvider>
        <TaskSubtasks task={createFanOutWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(await screen.findByText('Sequential 17s')).toBeInTheDocument();
    expect(screen.getByText('Parallel 10s')).toBeInTheDocument();
    expect(screen.getByText('Saves 7s')).toBeInTheDocument();
  });

  it('does not infer graph durations from non-terminal work package logs', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({
      success: true,
      data: createConcurrentWorkPackageLogs(),
    })) as typeof window.electronAPI.getTaskLogs;

    render(
      <TooltipProvider>
        <TaskSubtasks task={createConcurrentWorkPackageTask()} />
      </TooltipProvider>
    );

    expect(await screen.findByText('Sequential 2 rounds')).toBeInTheDocument();
    expect(screen.getByText('Parallel 1 rounds')).toBeInTheDocument();
    expect(screen.queryByText('Sequential 1s')).not.toBeInTheDocument();
  });

  it('shows selected work package model output in the shared model log panel', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({
      success: true,
      data: createConcurrentWorkPackageLogs(),
    })) as typeof window.electronAPI.getTaskLogs;

    render(
      <TooltipProvider>
        <TaskSubtasks task={createConcurrentWorkPackageTask()} />
      </TooltipProvider>
    );

    await waitFor(() => {
      expect(window.electronAPI.getTaskLogs).toHaveBeenCalled();
    });
    expect(screen.getByText('No model output yet')).toBeInTheDocument();
    expect(screen.queryByText('Global coordinator output.')).not.toBeInTheDocument();
    expect(screen.queryByText('Board package model output.')).not.toBeInTheDocument();
    expect(screen.queryByText('Scoring package model output.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Build board package'));
    expect(screen.queryByText('Board package model output.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show model output for wp-1/i }));
    expect(await screen.findByText('Board package model output.')).toBeInTheDocument();
    expect(screen.getByText('Model output · Build board package')).toBeInTheDocument();
    expect(screen.queryByText('Global coordinator output.')).not.toBeInTheDocument();
    expect(screen.queryByText('Scoring package model output.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('execution-graph-canvas'));

    expect(screen.queryByText('Board package model output.')).not.toBeInTheDocument();
    expect(screen.getByText('No model output yet')).toBeInTheDocument();
  });
});
