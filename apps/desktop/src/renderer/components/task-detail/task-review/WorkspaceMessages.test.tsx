/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import type { Task } from '../../../../shared/types';

const mockPersistTaskStatus = vi.fn();
const mockStartTaskOrQueue = vi.fn();

vi.mock('../../../stores/task-store', () => ({
  persistTaskStatus: (...args: unknown[]) => mockPersistTaskStatus(...args),
  startTaskOrQueue: (...args: unknown[]) => mockStartTaskOrQueue(...args),
}));

import { NoWorkspaceMessage } from './WorkspaceMessages';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    specId: '001-test-task',
    projectId: 'project-1',
    title: 'Test task',
    description: 'Task description',
    status: 'human_review',
    reviewReason: 'completed',
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-04-10T00:00:00.000Z'),
    updatedAt: new Date('2026-04-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NoWorkspaceMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPersistTaskStatus.mockResolvedValue({ success: true });
    mockStartTaskOrQueue.mockResolvedValue({ success: true, action: 'started' });
  });

  it('shows retry execution for coding-error review tasks', async () => {
    render(
      <NoWorkspaceMessage
        task={createTask({ reviewReason: 'errors' })}
      />
    );

    const button = screen.getByRole('button', { name: /retry execution/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockStartTaskOrQueue).toHaveBeenCalledWith('task-1', 'project-1');
    });
    expect(mockPersistTaskStatus).not.toHaveBeenCalled();
  });

  it('shows mark as done for completed review tasks', async () => {
    render(
      <NoWorkspaceMessage
        task={createTask({ reviewReason: 'completed' })}
      />
    );

    const button = screen.getByRole('button', { name: /mark as done/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockPersistTaskStatus).toHaveBeenCalledWith('task-1', 'done', { projectId: 'project-1' });
    });
    expect(mockStartTaskOrQueue).not.toHaveBeenCalled();
  });
});
