import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InsightsSession, InsightsTaskCreationRequest } from '../shared/types';
import { InsightsService } from './insights-service';

const temporaryDirectories: string[] = [];

function createProject(): string {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aperant-insights-tasks-'));
  temporaryDirectories.push(projectPath);
  return projectPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function saveSession(service: InsightsService, projectPath: string, session: InsightsSession): void {
  const internals = service as unknown as {
    sessionManager: { saveSession: (path: string, value: InsightsSession) => void };
  };
  internals.sessionManager.saveSession(projectPath, session);
}

describe('InsightsService task suggestion persistence', () => {
  it('restores the created-task marker after switching away and back', async () => {
    const projectPath = createProject();
    const service = new InsightsService();
    const session = service.createNewSession('project-1', projectPath);
    session.messages.push({
      id: 'persisted-assistant-message',
      role: 'assistant',
      content: 'A task is recommended.',
      timestamp: new Date(),
      suggestedTasks: [{
        id: 'suggestion-1',
        title: 'Persist this status',
        description: 'Keep the created state in the conversation.',
      }],
    });
    saveSession(service, projectPath, session);

    const request: InsightsTaskCreationRequest = {
      sessionId: session.id,
      // The renderer may briefly hold a locally generated assistant-message ID.
      messageId: 'streamed-local-message',
      taskIndex: 0,
      suggestionId: 'suggestion-1',
      title: 'Untrusted renderer title',
      description: 'Untrusted renderer description',
    };
    expect(service.resolveTaskSuggestion('project-1', projectPath, request)).toMatchObject({
      title: 'Persist this status',
      description: 'Keep the created state in the conversation.',
    });

    const sessionUpdated = vi.fn();
    service.on('session-updated', sessionUpdated);
    const updated = service.markTaskSuggestionCreated(
      'project-1',
      projectPath,
      request,
      'task-123',
    );

    expect(updated?.messages[0].suggestedTasks?.[0].taskId).toBe('task-123');
    expect(sessionUpdated).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ id: session.id }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const otherSession = service.createNewSession('project-1', projectPath);
    expect(otherSession.id).not.toBe(session.id);

    const restored = service.switchSession('project-1', projectPath, session.id);
    expect(restored?.messages[0].suggestedTasks?.[0].taskId).toBe('task-123');
  });

  it('supports legacy suggestions that have no stable suggestion ID or task ID', () => {
    const projectPath = createProject();
    const service = new InsightsService();
    const session = service.createNewSession('project-legacy', projectPath);
    session.messages.push({
      id: 'legacy-message',
      role: 'assistant',
      content: 'Legacy recommendation.',
      timestamp: new Date(),
      suggestedTasks: [{
        title: 'Legacy task',
        description: 'Created before suggestion IDs were introduced.',
      }],
    });
    saveSession(service, projectPath, session);

    const request: InsightsTaskCreationRequest = {
      sessionId: session.id,
      messageId: 'legacy-message',
      taskIndex: 0,
      title: 'Legacy task',
      description: 'Created before suggestion IDs were introduced.',
    };

    expect(service.resolveTaskSuggestion('project-legacy', projectPath, request)?.taskId).toBeUndefined();
    expect(
      service.markTaskSuggestionCreated(
        'project-legacy',
        projectPath,
        request,
        'legacy-task-1',
      )?.messages[0].suggestedTasks?.[0].taskId,
    ).toBe('legacy-task-1');
    expect(
      service.markTaskSuggestionCreated(
        'project-legacy',
        projectPath,
        request,
        'different-task',
      ),
    ).toBeNull();
  });
});
