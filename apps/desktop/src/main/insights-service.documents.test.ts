import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS } from '../shared/constants';
import type { InsightsSession } from '../shared/types';
import { InsightsService } from './insights-service';
import { InsightsDocumentCapabilityManager } from './insights/document-capabilities';

const temporaryDirectories: string[] = [];

function createProject(): string {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aperant-insights-service-'));
  temporaryDirectories.push(projectPath);
  return projectPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createSession(): InsightsSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'New Conversation',
    messages: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

async function flushDeferredExecution(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('InsightsService document references', () => {
  it('persists and forwards only a validated local path, never file content', async () => {
    const projectPath = createProject();
    const filePath = path.join(projectPath, 'retry-policy.md');
    fs.writeFileSync(filePath, '# Retry policy\nRetry at most three times.');
    const session = createSession();
    const savedSnapshots: InsightsSession[] = [];
    const execute = vi.fn(async (..._args: unknown[]) => ({
      fullResponse: 'The referenced file describes the retry policy.',
      suggestedTasks: undefined,
      toolsUsed: [],
    }));
    const service = new InsightsService();
    const internals = service as unknown as {
      sessionManager: {
        loadSession: () => InsightsSession;
        createNewSession: () => InsightsSession;
        saveSession: (projectPath: string, value: InsightsSession) => void;
      };
      storage: { generateTitle: (message: string) => string };
      executor: { cancelSession: () => boolean; execute: typeof execute };
    };
    internals.sessionManager = {
      loadSession: () => session,
      createNewSession: () => session,
      saveSession: (_path, value) => savedSnapshots.push(structuredClone(value)),
    };
    internals.storage = { generateTitle: (message) => message.slice(0, 50) };
    internals.executor = { cancelSession: () => false, execute };

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      '',
      undefined,
      undefined,
      [{
        id: 'document-1',
        path: filePath,
      }],
      undefined,
      'client-message-1',
    );

    expect(acknowledgement.success).toBe(true);
    expect(acknowledgement.data?.clientMessageId).toBe('client-message-1');
    expect(acknowledgement.data?.messageId).toBe('client-message-1');
    expect(execute).not.toHaveBeenCalled();
    const persistedReference = savedSnapshots[0].messages[0].documents?.[0];
    expect(persistedReference).toEqual({
      id: 'document-1',
      filename: 'retry-policy.md',
      path: fs.realpathSync(filePath),
      size: fs.statSync(filePath).size,
    });
    expect(persistedReference).not.toHaveProperty('content');
    expect(persistedReference).not.toHaveProperty('data');
    await flushDeferredExecution();
    const executorCall = execute.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown,
      unknown,
      unknown,
      Array<{ path: string }> | undefined,
    ];
    expect(executorCall[2]).toContain('retry-policy.md');
    expect(executorCall[6]?.[0].path).toBe(fs.realpathSync(filePath));
  });

  it('rejects the whole message when a referenced path is invalid or inaccessible', async () => {
    const projectPath = createProject();
    const session = createSession();
    const execute = vi.fn();
    const service = new InsightsService();
    const internals = service as unknown as {
      sessionManager: { loadSession: () => InsightsSession; createNewSession: () => InsightsSession };
      executor: { cancelSession: () => boolean; execute: typeof execute };
    };
    internals.sessionManager = { loadSession: () => session, createNewSession: () => session };
    internals.executor = { cancelSession: () => false, execute };
    const onError = vi.fn();
    service.on('error', onError);

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      'Analyze this file.',
      undefined,
      undefined,
      [{
        id: 'missing-file',
        path: path.join(projectPath, 'missing.log'),
      }],
    );

    expect(acknowledgement).toEqual({
      success: false,
      error: expect.stringContaining('invalid or inaccessible'),
    });
    expect(onError).toHaveBeenCalledWith(
      'project-1',
      expect.stringContaining('invalid or inaccessible'),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(session.messages).toEqual([]);
  });

  it('accepts an authorized external file without persisting or prompting with its token', async () => {
    const projectPath = createProject();
    const externalDirectory = createProject();
    const externalPath = path.join(externalDirectory, 'external-findings.md');
    fs.writeFileSync(externalPath, '# External findings\n');
    const capabilities = new InsightsDocumentCapabilityManager();
    const authorization = capabilities.issue('project-1', 77, externalPath);
    const session = createSession();
    const savedSnapshots: InsightsSession[] = [];
    const execute = vi.fn(async (..._args: unknown[]) => ({
      fullResponse: 'Reviewed.',
      suggestedTasks: undefined,
      toolsUsed: [],
    }));
    const service = new InsightsService(capabilities);
    const internals = service as unknown as {
      sessionManager: {
        loadSession: () => InsightsSession;
        createNewSession: () => InsightsSession;
        saveSession: (projectPath: string, value: InsightsSession) => void;
      };
      storage: { generateTitle: (message: string) => string };
      executor: { cancelSession: () => boolean; execute: typeof execute };
    };
    internals.sessionManager = {
      loadSession: () => session,
      createNewSession: () => session,
      saveSession: (_path, value) => savedSnapshots.push(structuredClone(value)),
    };
    internals.storage = { generateTitle: (message) => message.slice(0, 50) };
    internals.executor = { cancelSession: () => false, execute };

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      'Analyze the selected file.',
      undefined,
      undefined,
      [{
        id: 'external-1',
        path: authorization.path,
        authorizationToken: authorization.authorizationToken,
      }],
      77,
      'external-client-message',
    );

    expect(acknowledgement.success).toBe(true);
    expect(JSON.stringify(acknowledgement)).not.toContain(authorization.authorizationToken);
    expect(savedSnapshots[0].messages[0].documents?.[0]).toEqual({
      id: 'external-1',
      filename: 'external-findings.md',
      path: fs.realpathSync(externalPath),
      size: fs.statSync(externalPath).size,
    });
    expect(JSON.stringify(savedSnapshots)).not.toContain(authorization.authorizationToken);
    await flushDeferredExecution();
    expect(JSON.stringify(execute.mock.calls)).not.toContain(authorization.authorizationToken);
  });

  it('rejects the whole batch before file resolution when combined path text exceeds the budget', async () => {
    const projectPath = createProject();
    const session = createSession();
    const execute = vi.fn();
    const cancelSession = vi.fn();
    const service = new InsightsService();
    const internals = service as unknown as {
      sessionManager: { loadSession: () => InsightsSession; createNewSession: () => InsightsSession };
      executor: { cancelSession: typeof cancelSession; execute: typeof execute };
    };
    internals.sessionManager = { loadSession: () => session, createNewSession: () => session };
    internals.executor = { cancelSession, execute };
    service.on('error', vi.fn());
    const segmentLength = Math.floor(MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS / 3) + 1;
    const documents = Array.from({ length: 3 }, (_, index) => ({
      id: `oversized-${index}`,
      path: `E:\\${String(index).repeat(segmentLength)}`,
    }));

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      'Analyze these files.',
      undefined,
      undefined,
      documents,
    );

    expect(acknowledgement).toEqual({
      success: false,
      error: expect.stringContaining(`${MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS}-character`),
    });
    expect(cancelSession).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(session.messages).toEqual([]);
  });

  it('acknowledges a persisted user message before executor failure and keeps it in the session', async () => {
    const projectPath = createProject();
    const session = createSession();
    const execute = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const service = new InsightsService();
    const internals = service as unknown as {
      sessionManager: {
        loadSession: () => InsightsSession;
        createNewSession: () => InsightsSession;
        saveSession: () => void;
      };
      storage: { generateTitle: (message: string) => string };
      executor: { cancelSession: () => boolean; execute: typeof execute };
    };
    internals.sessionManager = {
      loadSession: () => session,
      createNewSession: () => session,
      saveSession: vi.fn(),
    };
    internals.storage = { generateTitle: (message) => message };
    internals.executor = { cancelSession: () => false, execute };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      'Keep this accepted message.',
      undefined,
      undefined,
      undefined,
      undefined,
      'accepted-before-failure',
    );
    expect(execute).not.toHaveBeenCalled();
    await flushDeferredExecution();

    expect(acknowledgement.success).toBe(true);
    expect(acknowledgement.data?.session.messages).toHaveLength(1);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].id).toBe('accepted-before-failure');
    expect(consoleError).toHaveBeenCalledWith(
      '[InsightsService] Error executing insights:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('uses a fresh persisted ID when a replayed client ID already exists', async () => {
    const projectPath = createProject();
    const session = createSession();
    session.messages.push({
      id: 'replayed-client-id',
      role: 'user',
      content: 'Earlier message',
      timestamp: new Date(),
    });
    const execute = vi.fn(async () => ({ fullResponse: '', suggestedTasks: undefined, toolsUsed: [] }));
    const service = new InsightsService();
    const internals = service as unknown as {
      sessionManager: {
        loadSession: () => InsightsSession;
        createNewSession: () => InsightsSession;
        saveSession: () => void;
      };
      executor: { cancelSession: () => boolean; execute: typeof execute };
    };
    internals.sessionManager = {
      loadSession: () => session,
      createNewSession: () => session,
      saveSession: vi.fn(),
    };
    internals.executor = { cancelSession: () => false, execute };

    const acknowledgement = await service.sendMessage(
      'project-1',
      projectPath,
      'New message',
      undefined,
      undefined,
      undefined,
      undefined,
      'replayed-client-id',
    );

    expect(acknowledgement.data?.clientMessageId).toBe('replayed-client-id');
    expect(acknowledgement.data?.messageId).not.toBe('replayed-client-id');
    expect(new Set(session.messages.map((item) => item.id)).size).toBe(session.messages.length);
    await flushDeferredExecution();
  });
});
