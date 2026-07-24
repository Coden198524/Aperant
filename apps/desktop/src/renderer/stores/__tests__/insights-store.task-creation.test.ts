/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightsSession, InsightsTaskCreationRequest, Task } from '../../../shared/types';

function createSession(): InsightsSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    messages: [{
      id: 'persisted-message',
      role: 'assistant',
      content: 'Recommendation',
      timestamp: new Date(),
      suggestedTasks: [{
        id: 'suggestion-1',
        title: 'Create a task',
        description: 'Persist the created status.',
      }],
    }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createTask(): Task {
  return {
    id: 'task-123',
    specId: '001-create-a-task',
    projectId: 'project-1',
    title: 'Create a task',
    description: 'Persist the created status.',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('insights task creation state', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('writes the returned task ID into the current suggestion immediately', async () => {
    const request: InsightsTaskCreationRequest = {
      sessionId: 'session-1',
      // Exercise stable suggestion matching instead of relying on the local message ID.
      messageId: 'streamed-local-message',
      taskIndex: 0,
      suggestionId: 'suggestion-1',
      title: 'Create a task',
      description: 'Persist the created status.',
    };
    const createTaskFromInsights = vi.fn(async () => ({
      success: true as const,
      data: createTask(),
    }));
    Object.defineProperty(window, 'electronAPI', {
      value: { createTaskFromInsights },
      configurable: true,
    });

    const { createTaskFromSuggestion, useInsightsStore } = await import('../insights-store');
    useInsightsStore.getState().setCurrentProjectId('project-1');
    useInsightsStore.getState().setSession(createSession());

    const created = await createTaskFromSuggestion('project-1', request);

    expect(created?.id).toBe('task-123');
    expect(createTaskFromInsights).toHaveBeenCalledWith('project-1', request);
    expect(
      useInsightsStore.getState().session?.messages[0].suggestedTasks?.[0].taskId,
    ).toBe('task-123');
  });
});
