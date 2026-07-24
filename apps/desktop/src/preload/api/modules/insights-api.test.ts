import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../shared/constants';

const mocks = vi.hoisted(() => ({
  getPathForFile: vi.fn(),
  invokeIpc: vi.fn(),
}));

vi.mock('electron', () => ({
  webUtils: { getPathForFile: mocks.getPathForFile },
}));

vi.mock('./ipc-utils', () => ({
  createIpcListener: vi.fn(),
  invokeIpc: mocks.invokeIpc,
}));

import { createInsightsAPI } from './insights-api';

describe('Insights preload API document boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects document IPC payloads onto id, path, and token only', async () => {
    const api = createInsightsAPI();
    const documents = Array.from({ length: 25 }, (_, index) => ({
      id: `document-${index}`,
      path: `E:\\Logs\\document-${index}.log`,
      authorizationToken: `token-${index}`,
      filename: `document-${index}.log`,
      size: 9_000_000_000,
      content: 'must not cross IPC',
      data: 'data:application/octet-stream;base64,AAAA',
      extra: { nested: true },
    }));

    mocks.invokeIpc.mockResolvedValue({ success: false, error: 'test acknowledgement' });
    await api.sendInsightsMessage(
      'project-1',
      'Analyze these files',
      undefined,
      undefined,
      documents,
      'client-message-1',
    );

    const sentDocuments = mocks.invokeIpc.mock.calls[0][5];
    expect(sentDocuments).toHaveLength(20);
    expect(sentDocuments[0]).toEqual({
      id: 'document-0',
      path: 'E:\\Logs\\document-0.log',
      authorizationToken: 'token-0',
    });
    expect(sentDocuments[0]).not.toHaveProperty('filename');
    expect(sentDocuments[0]).not.toHaveProperty('size');
    expect(sentDocuments[0]).not.toHaveProperty('content');
    expect(sentDocuments[0]).not.toHaveProperty('data');
    expect(sentDocuments[0]).not.toHaveProperty('extra');
    expect(mocks.invokeIpc.mock.calls[0][0]).toBe(IPC_CHANNELS.INSIGHTS_SEND_MESSAGE);
    expect(mocks.invokeIpc.mock.calls[0][6]).toBe('client-message-1');
  });

  it('resolves a genuine selected File in preload before requesting a capability', async () => {
    const file = { native: true } as unknown as File;
    mocks.getPathForFile.mockReturnValue('E:\\Logs\\selected.log');
    mocks.invokeIpc.mockResolvedValue({
      success: true,
      data: {
        filename: 'selected.log',
        path: 'E:\\Logs\\selected.log',
        size: 12,
        authorizationToken: 'opaque-token',
      },
    });

    const result = await createInsightsAPI().authorizeInsightsDocument('project-1', file);

    expect(result.success).toBe(true);
    expect(mocks.getPathForFile).toHaveBeenCalledWith(file);
    expect(mocks.invokeIpc).toHaveBeenCalledWith(
      IPC_CHANNELS.INSIGHTS_AUTHORIZE_DOCUMENT,
      'project-1',
      'E:\\Logs\\selected.log',
    );
  });

  it('does not invoke main when webUtils rejects a forged File object', async () => {
    mocks.getPathForFile.mockImplementation(() => {
      throw new TypeError('not a native File');
    });

    const result = await createInsightsAPI().authorizeInsightsDocument(
      'project-1',
      {} as File,
    );

    expect(result).toEqual({
      success: false,
      error: 'Could not resolve the selected local file.',
    });
    expect(mocks.invokeIpc).not.toHaveBeenCalled();
  });

  it('forwards the task suggestion identity used for session persistence', async () => {
    const request = {
      sessionId: 'session-1',
      messageId: 'message-1',
      taskIndex: 0,
      suggestionId: 'suggestion-1',
      title: 'Create a task',
      description: 'Persist its state in the conversation.',
    };
    mocks.invokeIpc.mockResolvedValue({ success: false, error: 'test result' });

    await createInsightsAPI().createTaskFromInsights('project-1', request);

    expect(mocks.invokeIpc).toHaveBeenCalledWith(
      IPC_CHANNELS.INSIGHTS_CREATE_TASK,
      'project-1',
      request,
    );
  });
});
