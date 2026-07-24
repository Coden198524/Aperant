/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InsightsChatStatus,
  InsightsPendingDocumentReference,
  InsightsSendMessageAcknowledgement,
  InsightsSession,
  InsightsStreamChunk,
  IPCResult,
} from '../../../shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createSession(projectId: string): InsightsSession {
  return {
    id: `session-${projectId}`,
    projectId,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('insights-store project scoping', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('ignores stream and status events for non-current projects', async () => {
    let streamHandler!: (projectId: string, chunk: InsightsStreamChunk) => void;
    let statusHandler!: (projectId: string, status: InsightsChatStatus) => void;
    let errorHandler!: (projectId: string, error: string) => void;
    let sessionUpdatedHandler!: (projectId: string, session: InsightsSession) => void;

    Object.defineProperty(window, 'electronAPI', {
      value: {
        onInsightsStreamChunk: vi.fn((handler) => {
          streamHandler = handler;
          return vi.fn();
        }),
        onInsightsStatus: vi.fn((handler) => {
          statusHandler = handler;
          return vi.fn();
        }),
        onInsightsError: vi.fn((handler) => {
          errorHandler = handler;
          return vi.fn();
        }),
        onInsightsSessionUpdated: vi.fn((handler) => {
          sessionUpdatedHandler = handler;
          return vi.fn();
        }),
        listInsightsSessions: vi.fn(async () => ({ success: true, data: [] })),
      },
      configurable: true,
    });

    const { setupInsightsListeners, useInsightsStore } = await import('../insights-store');

    useInsightsStore.getState().setCurrentProjectId('project-b');
    useInsightsStore.getState().setSession({ ...createSession('project-b'), title: 'current' });
    setupInsightsListeners();

    statusHandler('project-a', { phase: 'streaming', message: 'old' });
    streamHandler('project-a', { type: 'text', content: 'old' });
    errorHandler('project-a', 'old-error');
    sessionUpdatedHandler('project-a', { ...createSession('project-b'), projectId: 'project-a', title: 'old' });

    expect(useInsightsStore.getState().status.phase).toBe('idle');
    expect(useInsightsStore.getState().streamingContent).toBe('');
    expect(useInsightsStore.getState().session?.title).toBe('current');

    statusHandler('project-b', { phase: 'streaming', message: 'new' });
    streamHandler('project-b', { type: 'text', content: 'new' });
    sessionUpdatedHandler('project-b', { ...createSession('project-b'), title: 'updated' });

    expect(useInsightsStore.getState().status.phase).toBe('streaming');
    expect(useInsightsStore.getState().streamingContent).toBe('new');
    expect(useInsightsStore.getState().session?.projectId).toBe('project-b');
    expect(useInsightsStore.getState().session?.title).toBe('updated');
  });

  it('ignores stale session loads after switching projects', async () => {
    const projectA = deferred<any>();
    const projectB = deferred<any>();

    Object.defineProperty(window, 'electronAPI', {
      value: {
        getInsightsSession: vi.fn((projectId: string) =>
          projectId === 'project-a' ? projectA.promise : projectB.promise
        ),
        listInsightsSessions: vi.fn(async () => ({ success: true, data: [] })),
      },
      configurable: true,
    });

    const { loadInsightsSession, useInsightsStore } = await import('../insights-store');

    const loadA = loadInsightsSession('project-a');
    const loadB = loadInsightsSession('project-b');

    projectB.resolve({ success: true, data: createSession('project-b') });
    await loadB;

    projectA.resolve({ success: true, data: createSession('project-a') });
    await loadA;

    const state = useInsightsStore.getState();
    expect(state.currentProjectId).toBe('project-b');
    expect(state.session?.projectId).toBe('project-b');
  });

  it('sends and displays document path references without file contents', async () => {
    const sendInsightsMessage = vi.fn(async (
      projectId: string,
      message: string,
      _modelConfig: unknown,
      _images: unknown,
      _documents: unknown,
      clientMessageId: string,
    ) => ({
      success: true,
      data: {
        clientMessageId,
        messageId: clientMessageId,
        session: {
          ...createSession(projectId),
          messages: [{
            id: clientMessageId,
            role: 'user' as const,
            content: message,
            timestamp: new Date(),
            documents: [{
              id: 'document-1',
              filename: 'findings.md',
              size: 32,
              path: 'E:\\Project\\findings.md',
            }],
          }],
        },
      },
    }));
    Object.defineProperty(window, 'electronAPI', {
      value: { sendInsightsMessage },
      configurable: true,
    });

    const { sendMessage, useInsightsStore } = await import('../insights-store');
    const document: InsightsPendingDocumentReference = {
      id: 'document-1',
      filename: 'findings.md',
      size: 32,
      path: 'E:\\Project\\findings.md',
      authorizationToken: 'opaque-token',
    };
    useInsightsStore.getState().setCurrentProjectId('project-docs');
    useInsightsStore.getState().setSession(createSession('project-docs'));
    useInsightsStore.getState().setPendingDocuments([document]);

    const accepted = await sendMessage('project-docs', '', undefined, undefined, [document]);

    const state = useInsightsStore.getState();
    const acceptedDocument = state.session?.messages[0]?.documents?.[0];
    expect(acceptedDocument).toMatchObject({
      id: 'document-1',
      filename: 'findings.md',
      path: 'E:\\Project\\findings.md',
    });
    expect(acceptedDocument).not.toHaveProperty('content');
    expect(acceptedDocument).not.toHaveProperty('data');
    expect(acceptedDocument).not.toHaveProperty('authorizationToken');
    expect(accepted).toBe(true);
    expect(state.pendingDocuments).toEqual([]);
    expect(sendInsightsMessage).toHaveBeenCalledWith(
      'project-docs',
      '',
      undefined,
      undefined,
      [document],
      expect.stringMatching(/^msg-/),
    );
  });

  it('keeps the draft references and does not add a ghost message when main rejects them', async () => {
    const sendInsightsMessage = vi.fn(async () => ({
      success: false,
      error: 'One or more referenced file paths are invalid or inaccessible.',
    }));
    Object.defineProperty(window, 'electronAPI', {
      value: { sendInsightsMessage },
      configurable: true,
    });

    const { sendMessage, useInsightsStore } = await import('../insights-store');
    const document: InsightsPendingDocumentReference = {
      id: 'missing-document',
      filename: 'missing.log',
      path: 'E:\\Project\\missing.log',
    };
    useInsightsStore.getState().setCurrentProjectId('project-rejected');
    useInsightsStore.getState().setSession(createSession('project-rejected'));
    useInsightsStore.getState().setPendingMessage('Analyze this file');
    useInsightsStore.getState().setPendingDocuments([document]);

    const accepted = await sendMessage(
      'project-rejected',
      'Analyze this file',
      undefined,
      undefined,
      [document],
    );

    const state = useInsightsStore.getState();
    expect(accepted).toBe(false);
    expect(state.session?.messages).toEqual([]);
    expect(state.pendingMessage).toBe('Analyze this file');
    expect(state.pendingDocuments).toEqual([document]);
    expect(state.status).toEqual({
      phase: 'error',
      error: 'One or more referenced file paths are invalid or inaccessible.',
    });
  });

  it('adopts the authoritative main session when sending without a local session', async () => {
    const document: InsightsPendingDocumentReference = {
      id: 'first-document',
      filename: 'first.md',
      path: 'E:\\Project\\first.md',
    };
    const sendInsightsMessage = vi.fn(async (
      projectId: string,
      message: string,
      _modelConfig: unknown,
      _images: unknown,
      _documents: unknown,
      clientMessageId: string,
    ) => {
      const session = createSession(projectId);
      session.id = 'main-created-session';
      session.messages = [{
        id: clientMessageId,
        role: 'user',
        content: message,
        timestamp: new Date(),
        documents: [{ id: document.id, filename: document.filename, path: document.path }],
      }];
      return {
        success: true,
        data: { clientMessageId, messageId: clientMessageId, session },
      };
    });
    Object.defineProperty(window, 'electronAPI', {
      value: { sendInsightsMessage },
      configurable: true,
    });

    const { sendMessage, useInsightsStore } = await import('../insights-store');
    useInsightsStore.getState().setCurrentProjectId('project-new');
    useInsightsStore.getState().setSession(null);
    useInsightsStore.getState().setPendingMessage('First question');
    useInsightsStore.getState().setPendingDocuments([document]);

    const accepted = await sendMessage(
      'project-new',
      'First question',
      undefined,
      undefined,
      [document],
    );

    const state = useInsightsStore.getState();
    expect(accepted).toBe(true);
    expect(state.session?.id).toBe('main-created-session');
    expect(state.session?.messages).toHaveLength(1);
    expect(state.pendingMessage).toBe('');
    expect(state.pendingDocuments).toEqual([]);
  });

  it('does not apply a late acknowledgement after the chat scope changes', async () => {
    const acknowledgement = deferred<IPCResult<InsightsSendMessageAcknowledgement>>();
    Object.defineProperty(window, 'electronAPI', {
      value: { sendInsightsMessage: vi.fn(() => acknowledgement.promise) },
      configurable: true,
    });

    const { sendMessage, useInsightsStore } = await import('../insights-store');
    useInsightsStore.getState().setCurrentProjectId('project-a');
    useInsightsStore.getState().setSession(createSession('project-a'));
    const pendingSend = sendMessage('project-a', 'old question');

    useInsightsStore.getState().setCurrentProjectId('project-b');
    useInsightsStore.getState().setSession(createSession('project-b'));
    acknowledgement.resolve({
      success: true,
      data: {
        clientMessageId: 'ignored-by-stale-scope',
        messageId: 'message-a',
        session: createSession('project-a'),
      },
    });

    expect(await pendingSend).toBe(false);
    expect(useInsightsStore.getState().currentProjectId).toBe('project-b');
    expect(useInsightsStore.getState().session?.messages).toEqual([]);
  });

  it('does not apply a late acknowledgement to a newer no-session epoch', async () => {
    const acknowledgement = deferred<IPCResult<InsightsSendMessageAcknowledgement>>();
    const sendInsightsMessage = vi.fn((
      _projectId: string,
      _message: string,
      _modelConfig: unknown,
      _images: unknown,
      _documents: unknown,
      _clientMessageId: string,
    ) => acknowledgement.promise);
    Object.defineProperty(window, 'electronAPI', {
      value: { sendInsightsMessage },
      configurable: true,
    });

    const { sendMessage, useInsightsStore } = await import('../insights-store');
    useInsightsStore.getState().setCurrentProjectId('project-empty');
    useInsightsStore.getState().setSession(null);
    const pendingSend = sendMessage('project-empty', 'old empty-chat question');
    const clientMessageId = sendInsightsMessage.mock.calls[0][5];

    // A clear/new-empty-chat transition can leave both snapshots with null
    // session IDs. The internal scope generation must still distinguish them.
    useInsightsStore.getState().clearSession();
    const mainSession = createSession('project-empty');
    mainSession.id = 'old-main-session';
    mainSession.messages = [{
      id: clientMessageId,
      role: 'user',
      content: 'old empty-chat question',
      timestamp: new Date(),
    }];
    acknowledgement.resolve({
      success: true,
      data: {
        clientMessageId,
        messageId: clientMessageId,
        session: mainSession,
      },
    });

    expect(await pendingSend).toBe(false);
    expect(useInsightsStore.getState().session).toBeNull();
    expect(useInsightsStore.getState().pendingMessage).toBe('');
  });
});
