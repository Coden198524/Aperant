/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InsightsChatStatus,
  InsightsSession,
  InsightsStreamChunk,
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
});
