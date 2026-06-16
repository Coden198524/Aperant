// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskLogStreamChunk, TaskLogs } from '../../../shared/types';
import { TaskRuntimeLogs } from './TaskRuntimeLogs';

let storeTasks: Task[] = [];
const unsubscribeTaskLogsChanged = vi.fn();
let taskLogsChangedCallback: ((specId: string, logs: TaskLogs) => void) | null = null;
let taskLogsStreamCallback: ((specId: string, chunk: TaskLogStreamChunk) => void) | null = null;

function createTaskLogs(): TaskLogs {
  return {
    spec_id: 'spec-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:01.000Z',
    phases: {
      planning: {
        phase: 'planning',
        status: 'completed',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        entries: [
          {
            timestamp: '2026-01-01T00:00:00.500Z',
            type: 'text',
            phase: 'planning',
            content: 'The model is planning the implementation.',
          },
        ],
      },
      coding: {
        phase: 'coding',
        status: 'pending',
        started_at: null,
        completed_at: null,
        entries: [],
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

function createMarkdownTaskLogs(): TaskLogs {
  const logs = createTaskLogs();
  logs.phases.planning.entries = [
    {
      timestamp: '2026-01-01T00:00:00.500Z',
      type: 'text',
      phase: 'planning',
      content: [
        '## Implementation',
        '',
        '- Add streaming output',
        '- Render **Markdown** cleanly',
        '',
        '```ts',
        'const enabled = true;',
        '```',
      ].join('\n'),
    },
  ];
  return logs;
}

function createToolTaskLogs(): TaskLogs {
  const logs = createTaskLogs();
  logs.phases.planning.entries = [
    {
      timestamp: '2026-01-01T00:00:00.500Z',
      type: 'text',
      phase: 'planning',
      content: 'I need to inspect the file.',
    },
    {
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'tool_start',
      phase: 'planning',
      content: '[Read] src/app.ts',
      tool_name: 'Read',
      tool_input: 'src/app.ts',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'tool_end',
      phase: 'planning',
      content: '[Read] Done',
      tool_name: 'Read',
      detail: 'export function app() {}',
    },
  ];
  return logs;
}

function createConcurrentWorkPackageLogs(): TaskLogs {
  const logs = createTaskLogs();
  logs.phases.planning.entries = [];
  logs.phases.coding.status = 'completed';
  logs.phases.coding.started_at = '2026-01-01T00:00:01.000Z';
  logs.phases.coding.completed_at = '2026-01-01T00:00:04.000Z';
  logs.phases.coding.entries = [
    {
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'text',
      phase: 'coding',
      content: 'Global coding output.',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'text',
      phase: 'coding',
      content: 'Work package one output.',
      subtask_id: 'wp-1',
    },
    {
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'text',
      phase: 'coding',
      content: 'Work package two output.',
      subtask_id: 'wp-2',
    },
  ];
  return logs;
}

function createActiveEmptyTaskLogs(): TaskLogs {
  const logs = createTaskLogs();
  logs.phases.planning.status = 'active';
  logs.phases.planning.completed_at = null;
  logs.phases.planning.entries = [];
  return logs;
}

function createCodexToolRouterJsonErrorLog(): string {
  return [
    '6',
    '2026-06-14T03:32:26.118278Z ERROR codex_core::tools::router: error=Exit code: 1',
    'Wall time: 0.4 seconds',
    'Output:',
    "ConvertFrom-Json : Invalid object passed in, ':' or '}' expected. (178): {",
    '',
    '  "task_id": "003-task",',
    '  "purpose": "broken JSON,',
    '}',
  ].join('\n');
}

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

vi.mock('../../stores/task-store', () => ({
  useTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: storeTasks }),
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    specId: 'spec-1',
    projectId: 'project-1',
    title: 'Runtime task',
    description: 'Runtime task description',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createConcurrentWorkPackageTask(): Task {
  return createTask({
    status: 'human_review',
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
        title: 'Work package one',
        description: 'First package',
        status: 'completed',
        files: [],
        workPackage: true,
      } as Task['subtasks'][number] & { workPackage: boolean },
      {
        id: 'wp-2',
        title: 'Work package two',
        description: 'Second package',
        status: 'completed',
        files: [],
        workPackage: true,
      } as Task['subtasks'][number] & { workPackage: boolean },
    ],
  });
}

describe('TaskRuntimeLogs', () => {
  beforeEach(() => {
    storeTasks = [];
    taskLogsChangedCallback = null;
    taskLogsStreamCallback = null;
    unsubscribeTaskLogsChanged.mockClear();
    window.electronAPI = {
      ...window.electronAPI,
      getTaskLogs: vi.fn(async () => ({ success: true, data: createTaskLogs() })),
      watchTaskLogs: vi.fn(async () => ({ success: true })),
      unwatchTaskLogs: vi.fn(async () => ({ success: true })),
      onTaskLogsChanged: vi.fn((callback) => {
        taskLogsChangedCallback = callback;
        return unsubscribeTaskLogsChanged;
      }),
      onTaskLogsStream: vi.fn((callback) => {
        taskLogsStreamCallback = callback;
        return vi.fn();
      }),
    } as typeof window.electronAPI;
  });

  it('shows model output by default and hides the runtime view', async () => {
    render(<TaskRuntimeLogs task={createTask()} />);

    await waitFor(() => {
      expect(screen.getByText('The model is planning the implementation.')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /runtime/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-output-scroll')).not.toBeInTheDocument();
  });

  it('keeps concurrent work package output out of the global model log scope', () => {
    render(
      <TaskRuntimeLogs
        task={createConcurrentWorkPackageTask()}
        modelLogs={createConcurrentWorkPackageLogs()}
        scope={{ type: 'global' }}
      />
    );

    expect(screen.getByText('Global coding output.')).toBeInTheDocument();
    expect(screen.queryByText('Work package one output.')).not.toBeInTheDocument();
    expect(screen.queryByText('Work package two output.')).not.toBeInTheDocument();
  });

  it('shows only the selected concurrent work package model log scope', () => {
    render(
      <TaskRuntimeLogs
        task={createConcurrentWorkPackageTask()}
        modelLogs={createConcurrentWorkPackageLogs()}
        scope={{ type: 'work-item', workItemId: 'wp-1' }}
        compact
      />
    );

    expect(screen.getByText('Work package one output.')).toBeInTheDocument();
    expect(screen.queryByText('Global coding output.')).not.toBeInTheDocument();
    expect(screen.queryByText('Work package two output.')).not.toBeInTheDocument();
  });

  it('omits phase badges from model output entries', async () => {
    render(<TaskRuntimeLogs task={createTask()} />);

    await waitFor(() => {
      expect(screen.getByText('The model is planning the implementation.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
  });

  it('does not duplicate model output when live stream is followed by persisted logs', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({
      success: true,
      data: createActiveEmptyTaskLogs(),
    })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    await waitFor(() => {
      expect(taskLogsStreamCallback).toBeTruthy();
      expect(taskLogsChangedCallback).toBeTruthy();
    });

    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      source: 'sdk',
      phase: 'planning',
      timestamp: '2026-01-01T00:00:00.500Z',
      content: '正在生成计划。',
      session: 1,
    });

    const persistedLogs = createTaskLogs();
    persistedLogs.phases.planning.status = 'active';
    persistedLogs.phases.planning.entries = [
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'text',
        phase: 'planning',
        content: '正在生成计划。',
      },
    ];
    taskLogsChangedCallback?.('spec-1', persistedLogs);

    await waitFor(() => {
      expect(screen.getAllByText('正在生成计划。')).toHaveLength(1);
    });
  });

  it('renders model output as markdown', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: createMarkdownTaskLogs() })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    expect(await screen.findByRole('heading', { name: 'Implementation' })).toBeInTheDocument();
    expect(screen.getByText('Add streaming output')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('const enabled = true;')).toBeInTheDocument();
  });

  it('shows an explicit activity state before model text arrives', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask({ executionProgress: { phase: 'planning', phaseProgress: 10, overallProgress: 5 } })} />);
    expect(await screen.findByText('Thinking...')).toBeInTheDocument();
    expect(screen.getByText('The model is preparing its next response.')).toBeInTheDocument();

    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'planning',
      timestamp: '2026-01-01T00:00:02.000Z',
      content: 'First model token.',
      source: 'sdk',
    });

    await waitFor(() => {
      expect(screen.getByText('First model token.')).toBeInTheDocument();
    });
  });

  it('does not keep showing working state after the task has ended', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({
      success: true,
      data: createActiveEmptyTaskLogs(),
    })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask({ status: 'human_review' })} />);
    expect(await screen.findByText('No model output yet')).toBeInTheDocument();
    expect(screen.queryByText('Working...')).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows tool calls in a compact model output row', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: createToolTaskLogs() })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    await waitFor(() => {
      expect(screen.getByText('I need to inspect the file.')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Read')).toHaveLength(1);
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getAllByText('tool')).toHaveLength(1);
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.queryByText('export function app() {}')).not.toBeInTheDocument();
  });

  it('hides repeated PowerShell command wrappers in compact tool rows', async () => {
    const fullCommand = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Get-Content -LiteralPath 'E:\Work\Lumen1\assets\scenes\cornell_box.json'"`;
    const displayCommand = String.raw`Get-Content -LiteralPath 'E:\Work\Lumen1\assets\scenes\cornell_box.json'`;
    const logs = createTaskLogs();
    logs.phases.planning.entries = [
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'tool_start',
        phase: 'planning',
        content: `[Command] ${fullCommand}`,
        tool_name: 'Command',
        tool_input: fullCommand,
      },
      {
        timestamp: '2026-01-01T00:00:02.000Z',
        type: 'tool_end',
        phase: 'planning',
        content: '[Command] Done',
        tool_name: 'Command',
        tool_success: true,
      },
    ];
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: logs })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);

    expect(await screen.findByText(displayCommand)).toHaveAttribute('title', fullCommand);
    expect(screen.queryByText(/WindowsPowerShell/)).not.toBeInTheDocument();
  });

  it('merges streamed model tokens without waiting for a full log refresh', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:02.000Z',
      content: 'Streaming ',
      source: 'sdk',
      session: 1,
    });
    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:02.010Z',
      content: 'model output ',
      source: 'sdk',
      session: 1,
    });
    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:02.020Z',
      content: 'arrived.',
      source: 'sdk',
      session: 1,
    });

    await waitFor(() => {
      expect(screen.getByText('Streaming model output arrived.')).toBeInTheDocument();
    });
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('keeps historical full logs when a shorter live stream is already visible', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:05.000Z',
      content: 'Live tail that is not flushed yet.',
      source: 'sdk',
      session: 1,
    });

    await waitFor(() => {
      expect(screen.getByText('Live tail that is not flushed yet.')).toBeInTheDocument();
    });

    const historicalLogs = createTaskLogs();
    historicalLogs.updated_at = '2026-01-01T00:00:01.000Z';
    historicalLogs.phases.planning.entries = [
      {
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'text',
        phase: 'planning',
        content: 'Historical planning output.',
      },
    ];
    taskLogsChangedCallback?.('spec-1', historicalLogs);

    await waitFor(() => {
      expect(screen.getByText('Historical planning output.')).toBeInTheDocument();
    });
    expect(screen.getByText('Live tail that is not flushed yet.')).toBeInTheDocument();
  });

  it('shows the current streamed provider and model in the model output title', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    taskLogsStreamCallback?.('spec-1', {
      type: 'text',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:02.000Z',
      content: 'Streaming from current model.',
      source: 'sdk',
      model: {
        provider: 'openai',
        modelId: 'gpt-5.5',
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/OpenAI · GPT-5.5/)).toBeInTheDocument();
    });
  });

  it('collapses raw Codex JSON event logs by default', async () => {
    const logs = createTaskLogs();
    logs.phases.planning.entries = [
      {
        timestamp: '2026-01-01T00:00:00.500Z',
        type: 'text',
        phase: 'planning',
        content: '。{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"git status --short","aggregated_output":" M package.json"}}',
      },
    ];
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: logs })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);

    expect(await screen.findByText('Internal Codex event log collapsed.')).toBeInTheDocument();
    expect(screen.queryByText(/aggregated_output/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand log detail'));

    expect(await screen.findByText(/aggregated_output/)).toBeInTheDocument();
  });

  it('collapses Codex tool router JSON parse errors by default', async () => {
    const logs = createTaskLogs();
    logs.phases.planning.entries = [
      {
        timestamp: '2026-01-01T00:00:00.500Z',
        type: 'text',
        phase: 'planning',
        content: createCodexToolRouterJsonErrorLog(),
      },
    ];
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: logs })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);

    expect(await screen.findByText('PowerShell JSON parse failure log collapsed.')).toBeInTheDocument();
    expect(screen.queryByText(/ConvertFrom-Json/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand log detail'));

    expect(await screen.findByText(/ConvertFrom-Json/)).toBeInTheDocument();
  });

  it('falls back to task metadata model info before stream chunks arrive', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask({
      metadata: {
        phaseModels: { spec: 'sonnet', planning: 'gpt-5.5', coding: 'gpt-5.4', qa: 'sonnet' },
        phaseProviders: { planning: 'openai', coding: 'openai' },
      },
      executionProgress: { phase: 'coding', phaseProgress: 20, overallProgress: 40 },
    })} />);
    expect(await screen.findByText(/OpenAI · GPT-5.4/)).toBeInTheDocument();
  });

  it('shows streamed tool calls in a compact model output row', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    taskLogsStreamCallback?.('spec-1', {
      type: 'tool_start',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:03.000Z',
      content: '[Bash] npm test',
      tool_call_id: 'call-1',
      tool: {
        name: 'Bash',
        input: 'npm test',
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();

    taskLogsStreamCallback?.('spec-1', {
      type: 'tool_end',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:04.000Z',
      content: '[Bash] Done',
      tool_call_id: 'call-1',
      tool: {
        name: 'Bash',
        success: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText('done')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Bash')).toHaveLength(1);
    expect(screen.getAllByText('tool')).toHaveLength(1);
  });

  it('keeps streamed failed tool calls in one row with an error status', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    taskLogsStreamCallback?.('spec-1', {
      type: 'tool_start',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:03.000Z',
      content: '[Bash] npm test',
      tool_call_id: 'call-1',
      tool: {
        name: 'Bash',
        input: 'npm test',
      },
    });

    expect(await screen.findByText('running')).toBeInTheDocument();

    taskLogsStreamCallback?.('spec-1', {
      type: 'tool_end',
      phase: 'coding',
      timestamp: '2026-01-01T00:00:04.000Z',
      content: '[Bash] Failed',
      tool_call_id: 'call-1',
      tool: {
        name: 'Bash',
        success: false,
      },
    });

    await waitFor(() => {
      expect(screen.getByText('error')).toBeInTheDocument();
    });
    expect(screen.queryByText('done')).not.toBeInTheDocument();
    expect(screen.getAllByText('Bash')).toHaveLength(1);
    expect(screen.getAllByText('tool')).toHaveLength(1);
  });
});
