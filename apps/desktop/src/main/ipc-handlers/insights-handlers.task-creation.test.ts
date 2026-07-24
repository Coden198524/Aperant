import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants';
import type { InsightsSession } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  createAutocodeTask: vi.fn(),
  getProject: vi.fn(),
  invalidateTasksCache: vi.fn(),
  resolveTaskSuggestion: vi.fn(),
  markTaskSuggestionCreated: vi.fn(),
  serviceOn: vi.fn(),
}));

vi.mock('@autocode/core', () => ({
  AUTOCODE_PROJECT_DATA_DIR_NAME: '.autocode',
  createAutocodeTask: mocks.createAutocodeTask,
}));

vi.mock('../project-store', () => ({
  projectStore: {
    getProject: mocks.getProject,
    invalidateTasksCache: mocks.invalidateTasksCache,
  },
}));

vi.mock('../insights-service', () => ({
  insightsService: {
    on: mocks.serviceOn,
    resolveTaskSuggestion: mocks.resolveTaskSuggestion,
    markTaskSuggestionCreated: mocks.markTaskSuggestionCreated,
  },
}));

vi.mock('../insights/document-capabilities', () => ({
  insightsDocumentCapabilities: { issue: vi.fn() },
}));

vi.mock('./feature-settings-helper', () => ({
  getActiveProviderFeatureSettings: vi.fn(() => ({
    model: 'sonnet',
    thinkingLevel: 'medium',
  })),
}));

import { registerInsightsHandlers } from './insights-handlers';

const persistedSession: InsightsSession = {
  id: 'session-1',
  projectId: 'project-1',
  messages: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('insights task creation handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProject.mockReturnValue({
      id: 'project-1',
      path: 'E:\\Project',
      autoBuildPath: '.autocode',
    });
    mocks.resolveTaskSuggestion.mockReturnValue({
      id: 'suggestion-1',
      title: 'Persisted title',
      description: 'Persisted description',
      metadata: { category: 'feature' },
    });
    mocks.createAutocodeTask.mockReturnValue({
      id: '001-persisted-title',
      specId: '001-persisted-title',
      title: 'Persisted title',
      description: 'Persisted description',
      status: 'backlog',
      subtasks: [],
      metadata: { sourceType: 'insights', category: 'feature' },
      specsPath: 'E:\\Project\\.autocode\\specs\\001-persisted-title',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mocks.markTaskSuggestionCreated.mockReturnValue(persistedSession);
    registerInsightsHandlers(() => null);
  });

  it('creates from persisted suggestion data and writes the task ID back to its session', async () => {
    const request = {
      sessionId: 'session-1',
      messageId: 'message-1',
      taskIndex: 0,
      suggestionId: 'suggestion-1',
      title: 'Renderer title is not authoritative',
      description: 'Renderer description is not authoritative',
    };
    const result = await (
      ipcMain as unknown as {
        invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
      }
    ).invokeHandler(IPC_CHANNELS.INSIGHTS_CREATE_TASK, {}, 'project-1', request);

    expect(result).toMatchObject({
      success: true,
      data: { id: '001-persisted-title' },
    });
    expect(mocks.createAutocodeTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Persisted title',
      description: 'Persisted description',
      metadata: { sourceType: 'insights', category: 'feature' },
    }));
    expect(mocks.markTaskSuggestionCreated).toHaveBeenCalledWith(
      'project-1',
      'E:\\Project',
      request,
      '001-persisted-title',
    );
    expect(mocks.invalidateTasksCache).toHaveBeenCalledWith('project-1');
  });
});
