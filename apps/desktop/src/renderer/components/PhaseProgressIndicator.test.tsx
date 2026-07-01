// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhaseProgressIndicator } from './PhaseProgressIndicator';

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

describe('PhaseProgressIndicator', () => {
  beforeEach(() => {
    class MockIntersectionObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows planning progress when the task is no longer actively running', () => {
    render(
      <PhaseProgressIndicator
        phase="planning"
        subtasks={[]}
        phaseProgress={50}
        isRunning={false}
      />
    );

    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows a parallel badge when multiple coding subtasks are in progress', () => {
    render(
      <PhaseProgressIndicator
        phase="coding"
        subtasks={[
          { id: 'subtask-1', title: 'One', description: 'One', status: 'in_progress', files: [] },
          { id: 'subtask-2', title: 'Two', description: 'Two', status: 'in_progress', files: [] },
          { id: 'subtask-3', title: 'Three', description: 'Three', status: 'pending', files: [] },
        ]}
        isRunning={true}
      />
    );

    expect(screen.getByText('2 parallel')).toBeInTheDocument();
  });

  it('shows a parallel badge when coding subtasks are active but phase metadata is missing', () => {
    render(
      <PhaseProgressIndicator
        subtasks={[
          { id: 'subtask-1', title: 'One', description: 'One', status: 'in_progress', files: [] },
          { id: 'subtask-2', title: 'Two', description: 'Two', status: 'in_progress', files: [] },
          { id: 'subtask-3', title: 'Three', description: 'Three', status: 'pending', files: [] },
        ]}
        isRunning={true}
      />
    );

    expect(screen.getByText('2 parallel')).toBeInTheDocument();
  });

  it('shows 100% for completed terminal phase even when subtasks are not all completed', () => {
    render(
      <PhaseProgressIndicator
        phase="complete"
        subtasks={[
          { id: 'subtask-1', title: 'One', description: 'One', status: 'completed', files: [] },
          { id: 'subtask-2', title: 'Two', description: 'Two', status: 'pending', files: [] },
        ]}
        isRunning={false}
      />
    );

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.queryByText('50%')).not.toBeInTheDocument();
  });
});
