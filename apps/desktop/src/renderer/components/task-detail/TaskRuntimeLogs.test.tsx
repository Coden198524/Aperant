// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskLogStreamChunk, TaskLogs } from '../../../shared/types';
import { TaskRuntimeLogs } from './TaskRuntimeLogs';

let storeTasks: Task[] = [];
const unsubscribeTaskLogsChanged = vi.fn();
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

function createActiveEmptyTaskLogs(): TaskLogs {
  const logs = createTaskLogs();
  logs.phases.planning.status = 'active';
  logs.phases.planning.completed_at = null;
  logs.phases.planning.entries = [];
  return logs;
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

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { settings: { logOrder: 'chronological' | 'reverse-chronological' } }) => unknown) =>
    selector({ settings: { logOrder: 'chronological' } }),
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

describe('TaskRuntimeLogs', () => {
  beforeEach(() => {
    storeTasks = [];
    taskLogsStreamCallback = null;
    unsubscribeTaskLogsChanged.mockClear();
    window.electronAPI = {
      ...window.electronAPI,
      getTaskLogs: vi.fn(async () => ({ success: true, data: createTaskLogs() })),
      watchTaskLogs: vi.fn(async () => ({ success: true })),
      unwatchTaskLogs: vi.fn(async () => ({ success: true })),
      onTaskLogsChanged: vi.fn(() => unsubscribeTaskLogsChanged),
      onTaskLogsStream: vi.fn((callback) => {
        taskLogsStreamCallback = callback;
        return vi.fn();
      }),
    } as typeof window.electronAPI;
  });

  it('uses live store logs when they are newer than the task prop snapshot', () => {
    const snapshot = createTask({ logs: ['initial snapshot log'] });
    storeTasks = [
      createTask({
        logs: ['initial snapshot log', 'live runtime update'],
      }),
    ];

    render(<TaskRuntimeLogs task={snapshot} />);

    expect(screen.getByText(/live runtime update/)).toBeInTheDocument();
  });

  it('renders runtime logs as markdown preview', () => {
    const snapshot = createTask({
      logs: [
        [
          '## Runtime Report',
          '',
          '- **Build** passed',
          '- `npm test` passed',
        ].join('\n'),
      ],
    });

    render(<TaskRuntimeLogs task={snapshot} />);

    expect(screen.getByRole('heading', { name: 'Runtime Report' })).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.queryByText(/## Runtime Report/)).not.toBeInTheDocument();
  });

  it('can switch to model output from phase text logs', async () => {
    render(<TaskRuntimeLogs task={createTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

    await waitFor(() => {
      expect(screen.getByText('The model is planning the implementation.')).toBeInTheDocument();
    });
  });

  it('renders model output as markdown', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: createMarkdownTaskLogs() })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

    expect(await screen.findByRole('heading', { name: 'Implementation' })).toBeInTheDocument();
    expect(screen.getByText('Add streaming output')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('const enabled = true;')).toBeInTheDocument();
  });

  it('shows an explicit activity state before model text arrives', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask({ executionProgress: { phase: 'planning', phaseProgress: 10, overallProgress: 5 } })} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

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
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

    expect(await screen.findByText('No model output yet')).toBeInTheDocument();
    expect(screen.queryByText('Working...')).not.toBeInTheDocument();
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows tool calls in a compact model output row', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: createToolTaskLogs() })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

    await waitFor(() => {
      expect(screen.getByText('I need to inspect the file.')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Read')).toHaveLength(1);
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getAllByText('tool')).toHaveLength(1);
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.queryByText('export function app() {}')).not.toBeInTheDocument();
  });

  it('merges streamed model tokens without waiting for a full log refresh', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

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

  it('shows the current streamed provider and model in the model output title', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

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

  it('falls back to task metadata model info before stream chunks arrive', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask({
      metadata: {
        phaseModels: { spec: 'sonnet', planning: 'gpt-5.5', coding: 'gpt-5.4', qa: 'sonnet' },
        phaseProviders: { planning: 'openai', coding: 'openai' },
      },
      executionProgress: { phase: 'coding', phaseProgress: 20, overallProgress: 40 },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

    expect(await screen.findByText(/OpenAI · GPT-5.4/)).toBeInTheDocument();
  });

  it('shows streamed tool calls in a compact model output row', async () => {
    window.electronAPI.getTaskLogs = vi.fn(async () => ({ success: true, data: null })) as typeof window.electronAPI.getTaskLogs;

    render(<TaskRuntimeLogs task={createTask()} />);
    fireEvent.click(screen.getByRole('button', { name: /model output/i }));

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
});
