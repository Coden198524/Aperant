// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';
import { TaskMetadata } from './TaskMetadata';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, params?: Record<string, unknown> | string) => {
      if (typeof params === 'string') {
        return params;
      }
      if (typeof params?.defaultValue === 'string') {
        return params.defaultValue;
      }
      return _key;
    },
  }),
}));

vi.mock('../../stores/project-store', () => ({
  useProjectStore: (selector: (state: { projects: Array<{ id: string; path: string }> }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('../../stores/task-store', () => ({
  persistUpdateTask: vi.fn(),
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    specId: '001-token-task',
    projectId: 'project-1',
    title: 'Token task',
    description: 'Track token usage clearly.',
    status: 'human_review',
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-06-14T00:00:00.000Z'),
    updatedAt: new Date('2026-06-14T00:10:00.000Z'),
    ...overrides,
  };
}

describe('TaskMetadata token usage', () => {
  it('labels estimated usage and explains why cost is not configured', () => {
    render(
      <TaskMetadata
        task={createTask({
          tokenUsage: {
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            estimated: true,
          },
        })}
      />,
    );

    expect(screen.getByText('Estimated')).toBeInTheDocument();
    expect(screen.getByText(/Estimated usage/)).toBeInTheDocument();
    expect(screen.getAllByText(/Cost estimate/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not configured/)).toBeInTheDocument();
    expect(screen.getByText(/Cost estimates are not shown until a versioned provider pricing policy is configured/))
      .toBeInTheDocument();
  });

  it('labels provider-reported usage without implying a cost estimate', () => {
    render(
      <TaskMetadata
        task={createTask({
          tokenUsage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        })}
      />,
    );

    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText(/Provider-reported usage/)).toBeInTheDocument();
    expect(screen.getAllByText(/Cost estimate/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not configured/)).toBeInTheDocument();
  });
});
