// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskLogs as TaskLogsData } from '../../../shared/types';
import { TaskLogs } from './TaskLogs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown> | string) => {
      if (typeof params === 'string') {
        return params;
      }
      if (typeof params?.defaultValue === 'string') {
        return params.defaultValue
          .replace('{{count}}', String(params.count ?? ''))
          .replace('{{model}}', String(params.model ?? ''))
          .replace('{{thinking}}', String(params.thinking ?? ''));
      }
      return key;
    },
  }),
}));

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { settings: { logOrder: 'chronological' | 'reverse-chronological' } }) => unknown) =>
    selector({ settings: { logOrder: 'chronological' } }),
}));

function createTask(): Task {
  return {
    id: 'task-1',
    specId: '001-test-task',
    projectId: 'project-1',
    title: 'QA task',
    description: 'Verify runtime logs are visible',
    status: 'ai_review',
    subtasks: [],
    logs: [
      'Starting QA validation loop',
      'Running qa_reviewer session (session=1)',
    ],
    executionProgress: {
      phase: 'qa_review',
      phaseProgress: 40,
      overallProgress: 80,
      message: 'Running AI review',
    },
    createdAt: new Date('2026-04-14T00:00:00Z'),
    updatedAt: new Date('2026-04-14T00:00:00Z'),
  };
}

function createPhaseLogs(): TaskLogsData {
  return {
    spec_id: '001-test-task',
    created_at: '2026-04-14T00:00:00Z',
    updated_at: '2026-04-14T00:10:00Z',
    phases: {
      planning: {
        phase: 'planning',
        status: 'completed',
        started_at: '2026-04-14T00:00:00Z',
        completed_at: '2026-04-14T00:01:00Z',
        entries: [],
      },
      coding: {
        phase: 'coding',
        status: 'completed',
        started_at: '2026-04-14T00:01:00Z',
        completed_at: '2026-04-14T00:05:00Z',
        entries: [],
      },
      validation: {
        phase: 'validation',
        status: 'active',
        started_at: '2026-04-14T00:05:00Z',
        completed_at: null,
        entries: [],
      },
    },
  };
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

describe('TaskLogs', () => {
  it('does not show runtime logs in the logs tab', () => {
    render(
      <TaskLogs
        task={createTask()}
        phaseLogs={createPhaseLogs()}
        isLoadingLogs={false}
        expandedPhases={new Set(['validation'])}
        isStuck={false}
        logsEndRef={{ current: null }}
        logsContainerRef={{ current: null }}
        onLogsScroll={() => {}}
        onTogglePhase={() => {}}
      />,
    );

    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Starting QA validation loop')).not.toBeInTheDocument();
    expect(screen.queryByText('Running qa_reviewer session (session=1)')).not.toBeInTheDocument();
  });

  it('collapses raw Codex JSON event logs in the logs tab', () => {
    const phaseLogs = createPhaseLogs();
    phaseLogs.phases.planning.entries = [
      {
        timestamp: '2026-04-14T00:00:01Z',
        type: 'text',
        phase: 'planning',
        content: '。{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"git status --short","aggregated_output":" M package.json"}}',
      },
    ];

    render(
      <TaskLogs
        task={createTask()}
        phaseLogs={phaseLogs}
        isLoadingLogs={false}
        expandedPhases={new Set(['planning'])}
        isStuck={false}
        logsEndRef={{ current: null }}
        logsContainerRef={{ current: null }}
        onLogsScroll={() => {}}
        onTogglePhase={() => {}}
      />,
    );

    expect(screen.getByText('Internal Codex event log collapsed.')).toBeInTheDocument();
    expect(screen.queryByText(/aggregated_output/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('More'));

    expect(screen.getByText(/aggregated_output/)).toBeInTheDocument();
  });

  it('collapses Codex tool router JSON parse errors in the logs tab', () => {
    const phaseLogs = createPhaseLogs();
    phaseLogs.phases.planning.entries = [
      {
        timestamp: '2026-04-14T00:00:01Z',
        type: 'text',
        phase: 'planning',
        content: createCodexToolRouterJsonErrorLog(),
      },
    ];

    render(
      <TaskLogs
        task={createTask()}
        phaseLogs={phaseLogs}
        isLoadingLogs={false}
        expandedPhases={new Set(['planning'])}
        isStuck={false}
        logsEndRef={{ current: null }}
        logsContainerRef={{ current: null }}
        onLogsScroll={() => {}}
        onTogglePhase={() => {}}
      />,
    );

    expect(screen.getByText('PowerShell JSON parse failure log collapsed.')).toBeInTheDocument();
    expect(screen.queryByText(/ConvertFrom-Json/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('More'));

    expect(screen.getByText(/ConvertFrom-Json/)).toBeInTheDocument();
  });
});
