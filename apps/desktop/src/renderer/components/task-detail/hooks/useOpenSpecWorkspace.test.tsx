// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenSpecActionRunSummary,
  OpenSpecArtifactContent,
  OpenSpecArtifactDiff,
  OpenSpecBoardSnapshot,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewSummary,
  OpenSpecRendererEvent,
  Task,
} from '../../../../shared/types';
import {
  appendOpenSpecConsoleOutput,
  mergeOpenSpecRunHistory,
  useOpenSpecWorkspace,
} from './useOpenSpecWorkspace';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    specId: 'task-a',
    projectId: 'project-a',
    title: 'OpenSpec task',
    description: 'Implement a custom workflow.',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: 'project',
        schemaName: 'custom-board',
      },
    },
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
    ...overrides,
  };
}

function snapshot(
  revision = 2,
  overrides: Partial<OpenSpecBoardSnapshot> = {},
): OpenSpecBoardSnapshot {
  return {
    taskId: 'task-a',
    openSpecVersion: '1.6.0',
    rootKind: 'project',
    rootLabel: 'project-a',
    initialized: true,
    changeName: 'custom-change',
    schema: {
      name: 'custom-board',
      description: 'A two-artifact project Schema.',
    },
    artifacts: [
      {
        id: 'brief',
        description: 'Change brief',
        outputPath: 'brief.md',
        status: 'done',
        missingDeps: [],
        existingOutputPaths: ['brief.md'],
        dependencies: [],
        unlocks: ['checklist'],
        inProgress: false,
        blocksApply: false,
      },
      {
        id: 'checklist',
        description: 'Implementation checklist',
        outputPath: 'checklist.md',
        status: 'ready',
        missingDeps: [],
        existingOutputPaths: [],
        dependencies: ['brief'],
        unlocks: [],
        inProgress: false,
        blocksApply: true,
      },
    ],
    applyRequires: ['checklist'],
    activeRun: null,
    validation: null,
    nextSteps: ['Create checklist'],
    availableActions: ['explore', 'continue', 'update', 'verify', 'archive'],
    archived: false,
    revision,
    ...overrides,
  };
}

function run(
  runId: string,
  overrides: Partial<OpenSpecActionRunSummary> = {},
): OpenSpecActionRunSummary {
  return {
    runId,
    action: 'continue',
    state: 'succeeded',
    startedAt: '2026-07-28T00:00:00.000Z',
    completedAt: '2026-07-28T00:01:00.000Z',
    ...overrides,
  };
}

function planningReviewSummary(
  runId: string,
  overrides: Partial<OpenSpecPlanningReviewSummary> = {},
): OpenSpecPlanningReviewSummary {
  return {
    runId,
    state: 'ready',
    createdAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:00:05.000Z',
    changeCount: 1,
    ...overrides,
  };
}

function planningReview(
  runId: string,
  overrides: Partial<OpenSpecPlanningReview> = {},
): OpenSpecPlanningReview {
  return {
    runId,
    state: 'ready',
    createdAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:00:05.000Z',
    changes: [{
      relativePath: `${runId}.md`,
      kind: 'modified',
      patch: `+${runId}`,
    }],
    ...overrides,
  };
}

describe('mergeOpenSpecRunHistory', () => {
  it('does not let delayed hydration regress Apply or discard automatic Verify', () => {
    const merged = mergeOpenSpecRunHistory(
      [
        run('apply-run', {
          action: 'apply',
          state: 'succeeded',
          durationMs: 10_000,
        }),
        run('verify-run', {
          action: 'verify',
          state: 'running',
          startedAt: '2026-07-28T00:01:01.000Z',
          completedAt: undefined,
        }),
      ],
      [
        run('apply-run', {
          action: 'apply',
          state: 'running',
          completedAt: undefined,
        }),
      ],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        runId: 'apply-run',
        state: 'succeeded',
        durationMs: 10_000,
      }),
      expect.objectContaining({
        runId: 'verify-run',
        action: 'verify',
        state: 'running',
      }),
    ]);
  });

  it('allows authoritative terminal hydration to close a stale live run', () => {
    const merged = mergeOpenSpecRunHistory(
      [run('verify-run', {
        action: 'verify',
        state: 'running',
        completedAt: undefined,
      })],
      [run('verify-run', {
        action: 'verify',
        state: 'succeeded',
        durationMs: 5_000,
      })],
    );

    expect(merged[0]).toMatchObject({
      state: 'succeeded',
      durationMs: 5_000,
    });
  });
});

describe('useOpenSpecWorkspace', () => {
  let listener: ((event: OpenSpecRendererEvent) => void) | null;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    listener = null;
    api = {
      getOpenSpecSnapshot: vi.fn().mockResolvedValue(snapshot()),
      listOpenSpecChanges: vi.fn().mockResolvedValue([{
        name: 'custom-change',
        completedTasks: 0,
        totalTasks: 1,
        status: 'active',
      }]),
      getOpenSpecHistory: vi.fn().mockResolvedValue({
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        latestRunLog: null,
        pendingPlanningReview: null,
      }),
      readOpenSpecArtifact: vi.fn().mockResolvedValue({
        artifactId: 'brief',
        relativePath: 'brief.md',
        content: '# Brief\n',
        modifiedAt: '2026-07-28T00:00:00.000Z',
      }),
      getOpenSpecArtifactDiff: vi.fn().mockResolvedValue({
        artifactId: 'brief',
        relativePath: 'brief.md',
        patch: 'diff --git a/brief.md b/brief.md',
        base: 'git',
      }),
      onOpenSpecEvent: vi.fn((_taskId, callback) => {
        listener = callback;
        return vi.fn();
      }),
      runOpenSpecAction: vi.fn().mockResolvedValue({ runId: 'run-new' }),
      cancelOpenSpecAction: vi.fn().mockResolvedValue(undefined),
      resumeOpenSpecAction: vi.fn().mockResolvedValue({ runId: 'run-resumed' }),
      answerOpenSpecInteraction: vi.fn().mockResolvedValue(undefined),
      validateOpenSpec: vi.fn().mockResolvedValue({
        valid: true,
        checkedAt: '2026-07-28T00:00:00.000Z',
        issues: [],
      }),
      selectOpenSpecChange: vi.fn().mockResolvedValue(snapshot(3)),
      readOpenSpecRunLog: vi.fn().mockResolvedValue({
        runId: 'run-a',
        content: 'log',
        truncated: false,
      }),
      getOpenSpecPlanningReview: vi.fn().mockResolvedValue({
        runId: 'review-run',
        state: 'ready',
        createdAt: '2026-07-31T00:00:00.000Z',
        completedAt: '2026-07-31T00:00:05.000Z',
        changes: [],
      }),
      acknowledgeOpenSpecPlanningReview: vi.fn().mockResolvedValue(null),
      retryOpenSpecPlanningReview: vi.fn(),
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: api,
    });
  });

  it('renders a dynamic Schema snapshot and drops out-of-order revisions', async () => {
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.artifactContent?.content).toBe('# Brief\n'));

    expect(result.current.snapshot?.schema.name).toBe('custom-board');
    expect(result.current.snapshot?.artifacts.map((artifact) => artifact.id))
      .toEqual(['brief', 'checklist']);
    expect(result.current.selectedArtifact?.id).toBe('brief');
    expect(api.readOpenSpecArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'brief',
      relativePath: 'brief.md',
    }));

    act(() => {
      listener?.({
        type: 'snapshot',
        revision: 1,
        snapshot: snapshot(1, {
          schema: { name: 'stale-schema' },
          artifacts: [],
        }),
      });
    });
    expect(result.current.snapshot?.schema.name).toBe('custom-board');

    act(() => {
      listener?.({
        type: 'snapshot',
        revision: 3,
        snapshot: snapshot(3, {
          schema: { name: 'new-custom-schema' },
        }),
      });
    });
    await waitFor(() => expect(result.current.snapshot?.schema.name).toBe('new-custom-schema'));
    expect(api.getOpenSpecHistory).toHaveBeenCalledTimes(1);
  });

  it('restores an unreviewed planning change list from persisted History', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [],
        truncated: false,
      },
      latestRunLog: null,
      pendingPlanningReview: {
        runId: 'review-run',
        state: 'ready',
        createdAt: '2026-07-31T00:00:00.000Z',
        completedAt: '2026-07-31T00:00:05.000Z',
        changeCount: 1,
      },
    });
    api.getOpenSpecPlanningReview.mockResolvedValue({
      runId: 'review-run',
      state: 'ready',
      createdAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:05.000Z',
      changes: [{
        relativePath: 'adr/0001-offline.md',
        kind: 'created',
        patch: '--- a/adr/0001-offline.md\n+++ b/adr/0001-offline.md\n+# Offline',
      }],
    });
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-run'));

    expect(api.getOpenSpecPlanningReview).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'review-run',
    });
    expect(result.current.planningReview?.changes[0]?.relativePath)
      .toBe('adr/0001-offline.md');
  });

  it('loads a completed planning review from its event run ID', async () => {
    api.getOpenSpecPlanningReview.mockImplementation(
      (input: { runId: string }) => Promise.resolve(planningReview(input.runId)),
    );
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      listener?.({
        type: 'planning-review',
        review: planningReviewSummary('event-review-run'),
      });
    });

    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('event-review-run'));
    expect(api.getOpenSpecPlanningReview).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'event-review-run',
    });
  });

  it('acknowledges the current review and automatically loads the next pending review', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [],
        truncated: false,
      },
      latestRunLog: null,
      pendingPlanningReview: planningReviewSummary('review-run-1'),
    });
    api.getOpenSpecPlanningReview.mockImplementation(
      (input: { runId: string }) => Promise.resolve(planningReview(input.runId)),
    );
    api.acknowledgeOpenSpecPlanningReview.mockResolvedValue(
      planningReviewSummary('review-run-2', {
        createdAt: '2026-07-31T00:01:00.000Z',
        completedAt: '2026-07-31T00:01:05.000Z',
      }),
    );
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-run-1'));

    await act(async () => {
      await result.current.acknowledgePlanningReview();
    });

    expect(api.acknowledgeOpenSpecPlanningReview).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'review-run-1',
    });
    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-run-2'));
    expect(api.getOpenSpecPlanningReview).toHaveBeenLastCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'review-run-2',
    });
  });

  it('does not reopen an acknowledged review from a stale History response', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [],
      activeRun: null,
      waitingInteraction: null,
      latestRunLog: null,
      pendingPlanningReview: planningReviewSummary('review-run'),
    });
    api.getOpenSpecPlanningReview.mockResolvedValue(
      planningReview('review-run'),
    );
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-run'));

    const staleHistory = deferred<{
      runs: OpenSpecActionRunSummary[];
      activeRun: null;
      waitingInteraction: null;
      latestRunLog: null;
      pendingPlanningReview: OpenSpecPlanningReviewSummary;
    }>();
    api.getOpenSpecHistory.mockReturnValueOnce(staleHistory.promise);
    const pendingRefresh = result.current.refreshHistory();

    await act(async () => {
      await result.current.acknowledgePlanningReview();
    });
    expect(result.current.planningReviewSummary).toBeNull();

    await act(async () => {
      staleHistory.resolve({
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        latestRunLog: null,
        pendingPlanningReview: planningReviewSummary('review-run'),
      });
      await pendingRefresh;
    });

    expect(result.current.planningReviewSummary).toBeNull();
    expect(result.current.planningReview).toBeNull();
  });

  it('keeps a failed planning-review GET pending and reloads the same run', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [],
        truncated: false,
      },
      latestRunLog: null,
      pendingPlanningReview: planningReviewSummary('review-get-failure'),
    });
    api.getOpenSpecPlanningReview.mockRejectedValueOnce(
      new Error('review read failed'),
    );
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    await waitFor(() => expect(result.current.planningReviewLoadError)
      .toBe('review read failed'));
    expect(result.current.planningReviewSummary?.runId)
      .toBe('review-get-failure');
    expect(result.current.planningReview).toBeNull();
    expect(result.current.planningReviewLoading).toBe(false);

    api.getOpenSpecPlanningReview.mockResolvedValueOnce(
      planningReview('review-get-failure'),
    );
    act(() => result.current.reloadPlanningReview());

    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-get-failure'));
    expect(result.current.planningReviewSummary?.runId)
      .toBe('review-get-failure');
    expect(result.current.planningReviewLoadError).toBeNull();
  });

  it('keeps the review open when acknowledgement fails', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [],
        truncated: false,
      },
      latestRunLog: null,
      pendingPlanningReview: planningReviewSummary('review-ack-failure'),
    });
    api.getOpenSpecPlanningReview.mockResolvedValue(
      planningReview('review-ack-failure'),
    );
    api.acknowledgeOpenSpecPlanningReview.mockRejectedValueOnce(
      new Error('review acknowledgement failed'),
    );
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('review-ack-failure'));

    await act(async () => {
      await expect(result.current.acknowledgePlanningReview())
        .rejects.toThrow('review acknowledgement failed');
    });

    expect(result.current.planningReviewSummary?.runId)
      .toBe('review-ack-failure');
    expect(result.current.planningReview?.runId)
      .toBe('review-ack-failure');
    expect(result.current.error).toBe('review acknowledgement failed');
  });

  it('ignores an old planning-review GET after switching tasks', async () => {
    const taskAReview = deferred<OpenSpecPlanningReview>();
    const taskB = task({
      id: 'task-b',
      specId: 'task-b',
      projectId: 'project-b',
    });
    api.getOpenSpecSnapshot.mockImplementation((taskId: string) =>
      Promise.resolve(taskId === 'task-a'
        ? snapshot()
        : snapshot(1, {
            taskId: 'task-b',
            rootLabel: 'project-b',
            changeName: 'task-b-change',
          })));
    api.getOpenSpecHistory.mockImplementation((taskId: string) =>
      Promise.resolve({
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        activityLog: {
          segments: [],
          truncated: false,
        },
        latestRunLog: null,
        pendingPlanningReview: planningReviewSummary(
          taskId === 'task-a' ? 'task-a-review' : 'task-b-review',
        ),
      }));
    api.getOpenSpecPlanningReview.mockImplementation(
      (input: { taskId: string; runId: string }) =>
        input.taskId === 'task-a'
          ? taskAReview.promise
          : Promise.resolve(planningReview(input.runId)),
    );
    const { rerender, result } = renderHook(
      ({ currentTask }) => useOpenSpecWorkspace(currentTask),
      { initialProps: { currentTask: task() } },
    );
    await waitFor(() => expect(api.getOpenSpecPlanningReview)
      .toHaveBeenCalledWith({
        taskId: 'task-a',
        projectId: 'project-a',
        runId: 'task-a-review',
      }));

    rerender({ currentTask: taskB });

    await waitFor(() => expect(result.current.planningReview?.runId)
      .toBe('task-b-review'));
    expect(api.getOpenSpecPlanningReview).not.toHaveBeenCalledWith({
      taskId: 'task-b',
      projectId: 'project-b',
      runId: 'task-a-review',
    });

    await act(async () => {
      taskAReview.resolve(planningReview('task-a-review'));
      await taskAReview.promise;
    });
    expect(result.current.planningReview?.runId).toBe('task-b-review');
    expect(result.current.planningReviewSummary?.runId).toBe('task-b-review');
  });

  it('restores every Action stage in chronological order and marks aggregate truncation', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [
        run('run-planning'),
        run('run-implementation', {
          action: 'apply',
          startedAt: '2026-07-28T00:02:00.000Z',
        }),
      ],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [
          {
            runId: 'run-planning',
            content: 'planning output\n',
            truncated: false,
          },
          {
            runId: 'run-implementation',
            content: 'implementation output\n',
            truncated: false,
          },
        ],
        truncated: true,
      },
      latestRunLog: {
        runId: 'run-implementation',
        content: 'implementation output\n',
        truncated: false,
      },
    });

    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.consoleLines.map((line) => line.text)).toEqual([
      'planning output\n',
      'implementation output\n',
    ]);
    expect(result.current.consoleLines[0]?.truncated).toBe(true);
    expect(result.current.consoleLines[1]?.truncated).toBeUndefined();
  });

  it('falls back to the latest run log from older history payloads', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [run('run-legacy')],
      activeRun: null,
      waitingInteraction: null,
      latestRunLog: {
        runId: 'run-legacy',
        content: 'legacy output\n',
        truncated: false,
      },
    });

    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['legacy output\n']);
  });

  it('keeps accumulated output when a new Action starts, changes phase, or fails to start', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [run('run-planning')],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [{
          runId: 'run-planning',
          content: 'planning output\n',
          truncated: false,
        }],
        truncated: false,
      },
      latestRunLog: {
        runId: 'run-planning',
        content: 'planning output\n',
        truncated: false,
      },
    });
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.consoleLines[0]?.text)
      .toBe('planning output\n'));

    await act(async () => {
      await result.current.runAction('continue');
    });
    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['planning output\n']);

    act(() => {
      listener?.({
        type: 'snapshot',
        revision: 3,
        snapshot: snapshot(3, {
          nextSteps: ['Apply the implementation'],
        }),
      });
    });
    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['planning output\n']);

    api.runOpenSpecAction.mockRejectedValueOnce(new Error('start failed'));
    await act(async () => {
      await expect(result.current.runAction('apply')).rejects.toThrow('start failed');
    });
    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['planning output\n']);
  });

  it('keeps prior stages when the active run has no persisted output yet', async () => {
    const activeRun = run('run-active', {
      action: 'apply',
      state: 'running',
      completedAt: undefined,
      startedAt: '2026-07-28T00:02:00.000Z',
    });
    api.getOpenSpecSnapshot.mockResolvedValue(snapshot(3, { activeRun }));
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [run('run-planning'), activeRun],
      activeRun,
      waitingInteraction: null,
      activityLog: {
        segments: [
          {
            runId: 'run-planning',
            content: 'planning output\n',
            truncated: false,
          },
          {
            runId: 'run-active',
            content: '',
            truncated: false,
          },
        ],
        truncated: false,
      },
      latestRunLog: {
        runId: 'run-active',
        content: '',
        truncated: false,
      },
    });

    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['planning output\n']);
  });

  it('merges delayed history hydration with live output without duplicating chunks', async () => {
    const pendingHistory = deferred<Awaited<
      ReturnType<typeof window.electronAPI.getOpenSpecHistory>
    >>();
    api.getOpenSpecHistory.mockReturnValue(pendingHistory.promise);
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(listener).not.toBeNull());

    act(() => {
      listener?.({
        type: 'output',
        runId: 'run-active',
        sequence: 0,
        text: 'live output\n',
      });
    });
    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['live output\n']);

    await act(async () => {
      pendingHistory.resolve({
        runs: [run('run-active', {
          state: 'running',
          completedAt: undefined,
        })],
        activeRun: run('run-active', {
          state: 'running',
          completedAt: undefined,
        }),
        waitingInteraction: null,
        activityLog: {
          segments: [{
            runId: 'run-active',
            content: 'history output\nlive output\n',
            truncated: false,
          }],
          truncated: false,
        },
        latestRunLog: {
          runId: 'run-active',
          content: 'history output\nlive output\n',
          truncated: false,
        },
        pendingPlanningReview: null,
      });
      await pendingHistory.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['history output\nlive output\n']);
    expect(result.current.consoleLines.map((line) => line.text).join('')
      .match(/live output/g)).toHaveLength(1);
  });

  it('updates one requested run log without clearing other Action stages', async () => {
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [run('run-planning'), run('run-implementation', {
        action: 'apply',
        startedAt: '2026-07-28T00:02:00.000Z',
      })],
      activeRun: null,
      waitingInteraction: null,
      activityLog: {
        segments: [
          { runId: 'run-planning', content: 'planning\n', truncated: false },
          { runId: 'run-implementation', content: 'implementation\n', truncated: false },
        ],
        truncated: false,
      },
      latestRunLog: {
        runId: 'run-implementation',
        content: 'implementation\n',
        truncated: false,
      },
    });
    api.readOpenSpecRunLog.mockResolvedValue({
      runId: 'run-planning',
      content: 'planning updated\n',
      truncated: false,
    });
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.consoleLines).toHaveLength(2));

    await act(async () => {
      await result.current.loadRunLog('run-planning');
    });

    expect(result.current.consoleLines.map((line) => line.text)).toEqual([
      'planning updated\n',
      'implementation\n',
    ]);
  });

  it('keeps the newest 2,000 chunks and marks omitted output', () => {
    const initial = Array.from({ length: 2_000 }, (_, sequence) => ({
      runId: 'run-active',
      sequence,
      text: `${sequence}\n`,
    }));

    const next = appendOpenSpecConsoleOutput(initial, {
      runId: 'run-active',
      sequence: 2_000,
      text: '2000\n',
    });

    expect(next).toHaveLength(2_000);
    expect(next[0]).toMatchObject({
      sequence: 1,
      truncated: true,
    });
    expect(next.at(-1)?.sequence).toBe(2_000);
  });

  it('does not request a stale artifact path while switching board stages', async () => {
    const currentSnapshot = snapshot(4, {
      artifacts: [
        {
          id: 'specs',
          description: 'Delta specifications',
          outputPath: 'specs/**/*.md',
          status: 'done',
          missingDeps: [],
          existingOutputPaths: [
            'specs/browser/spec.md',
            'specs/gameplay/spec.md',
          ],
          dependencies: [],
          unlocks: ['design'],
          inProgress: false,
          blocksApply: false,
        },
        {
          id: 'design',
          description: 'Technical design',
          outputPath: 'design.md',
          status: 'done',
          missingDeps: [],
          existingOutputPaths: ['design.md'],
          dependencies: ['specs'],
          unlocks: [],
          inProgress: false,
          blocksApply: false,
        },
      ],
    });
    api.getOpenSpecSnapshot.mockResolvedValue(currentSnapshot);
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    await waitFor(() => expect(result.current.selectedRelativePath)
      .toBe('specs/browser/spec.md'));
    api.readOpenSpecArtifact.mockClear();
    api.getOpenSpecArtifactDiff.mockClear();

    act(() => {
      result.current.setSelectedArtifactId('design');
    });

    await waitFor(() => expect(api.readOpenSpecArtifact).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      expectedChangeName: 'custom-change',
      artifactId: 'design',
      relativePath: 'design.md',
    }));
    expect(api.readOpenSpecArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: 'design',
        relativePath: 'specs/browser/spec.md',
      }),
    );
    expect(api.getOpenSpecArtifactDiff).not.toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: 'design',
        relativePath: 'specs/browser/spec.md',
      }),
    );
  });

  it('does not read or run against a deleted change and recovers through an active selection', async () => {
    const changesResult = deferred<Awaited<
      ReturnType<typeof window.electronAPI.listOpenSpecChanges>
    >>();
    const staleChangeName = 'build-browser-match-3-game';
    const activeChangeName = 'build-browser-match-three-game';
    api.getOpenSpecSnapshot.mockResolvedValue(snapshot(4, {
      changeName: staleChangeName,
    }));
    api.listOpenSpecChanges.mockReturnValue(changesResult.promise);
    api.selectOpenSpecChange.mockResolvedValue(snapshot(5, {
      changeName: activeChangeName,
    }));

    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.selectedChangeReady).toBe(false);
    expect(api.readOpenSpecArtifact).not.toHaveBeenCalled();
    expect(api.getOpenSpecArtifactDiff).not.toHaveBeenCalled();

    await act(async () => {
      changesResult.resolve([{
        name: activeChangeName,
        completedTasks: 0,
        totalTasks: 4,
        status: 'active',
      }]);
      await changesResult.promise;
    });

    await waitFor(() => expect(result.current.snapshot?.changeName)
      .toBe(staleChangeName));
    await waitFor(() => expect(result.current.selectedChangeStale).toBe(true));
    act(() => {
      result.current.setSelectedArtifactId('brief');
    });
    expect(api.readOpenSpecArtifact).not.toHaveBeenCalled();
    expect(api.getOpenSpecArtifactDiff).not.toHaveBeenCalled();

    await act(async () => {
      await expect(result.current.runAction('update'))
        .rejects.toThrow('no longer exists');
      await expect(result.current.runValidation())
        .rejects.toThrow('no longer exists');
    });
    expect(api.runOpenSpecAction).not.toHaveBeenCalled();
    expect(api.validateOpenSpec).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.selectChange(activeChangeName);
    });

    await waitFor(() => expect(result.current.snapshot?.changeName)
      .toBe(activeChangeName));
    await waitFor(() => expect(api.readOpenSpecArtifact).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      expectedChangeName: activeChangeName,
      artifactId: 'brief',
      relativePath: 'brief.md',
    }));
    expect(api.selectOpenSpecChange).toHaveBeenCalledWith(
      'task-a',
      activeChangeName,
      'project-a',
    );
  });

  it('does not let an older change-list refresh invalidate a newer selection', async () => {
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const olderChanges = deferred<Awaited<
      ReturnType<typeof window.electronAPI.listOpenSpecChanges>
    >>();
    const newerChanges = deferred<Awaited<
      ReturnType<typeof window.electronAPI.listOpenSpecChanges>
    >>();
    api.listOpenSpecChanges
      .mockReset()
      .mockReturnValueOnce(olderChanges.promise)
      .mockReturnValueOnce(newerChanges.promise);

    let olderRefresh!: ReturnType<typeof result.current.refresh>;
    let newerRefresh!: ReturnType<typeof result.current.refresh>;
    act(() => {
      olderRefresh = result.current.refresh();
      newerRefresh = result.current.refresh();
    });

    await act(async () => {
      newerChanges.resolve([{
        name: 'custom-change',
        completedTasks: 1,
        totalTasks: 2,
        status: 'active',
      }]);
      await newerRefresh;
    });
    expect(result.current.selectedChangeStale).toBe(false);

    await act(async () => {
      olderChanges.resolve([{
        name: 'deleted-old-change',
        completedTasks: 0,
        totalTasks: 1,
        status: 'active',
      }]);
      await olderRefresh;
    });

    expect(result.current.changes.map((change) => change.name))
      .toEqual(['custom-change']);
    expect(result.current.selectedChangeStale).toBe(false);
  });

  it('does not combine a new task scope with the previous task artifact path', async () => {
    const taskAContent = deferred<OpenSpecArtifactContent>();
    const taskADiff = deferred<OpenSpecArtifactDiff>();
    const taskB = task({
      id: 'task-b',
      specId: 'task-b',
      projectId: 'project-b',
    });
    const taskBSnapshot = snapshot(1, {
      taskId: 'task-b',
      rootLabel: 'project-b',
      changeName: 'task-b-change',
      artifacts: [{
        id: 'design',
        description: 'Task B design',
        outputPath: 'design.md',
        status: 'done',
        missingDeps: [],
        existingOutputPaths: ['design.md'],
        dependencies: [],
        unlocks: [],
        inProgress: false,
        blocksApply: false,
      }],
    });
    api.getOpenSpecSnapshot.mockImplementation((taskId: string) =>
      Promise.resolve(taskId === 'task-b' ? taskBSnapshot : snapshot()));
    api.listOpenSpecChanges.mockImplementation((taskId: string) =>
      Promise.resolve([{
        name: taskId === 'task-b' ? 'task-b-change' : 'custom-change',
        completedTasks: 0,
        totalTasks: 1,
        status: 'active',
      }]));
    api.readOpenSpecArtifact.mockImplementation((input: {
      taskId: string;
      artifactId: string;
      relativePath: string;
    }) => input.taskId === 'task-a'
      ? taskAContent.promise
      : Promise.resolve({
        artifactId: input.artifactId,
        relativePath: input.relativePath,
        content: '# Task B design\n',
        modifiedAt: '2026-07-28T00:00:00.000Z',
      }));
    api.getOpenSpecArtifactDiff.mockImplementation((input: {
      taskId: string;
      artifactId: string;
      relativePath: string;
    }) => input.taskId === 'task-a'
      ? taskADiff.promise
      : Promise.resolve({
        artifactId: input.artifactId,
        relativePath: input.relativePath,
        patch: 'diff --git a/design.md b/design.md',
        base: 'git',
      }));

    const { rerender, result } = renderHook(
      ({ currentTask }) => useOpenSpecWorkspace(currentTask),
      { initialProps: { currentTask: task() } },
    );
    await waitFor(() => expect(api.readOpenSpecArtifact).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      expectedChangeName: 'custom-change',
      artifactId: 'brief',
      relativePath: 'brief.md',
    }));
    await waitFor(() => expect(result.current.artifactLoading).toBe(true));

    rerender({ currentTask: taskB });

    await waitFor(() => expect(api.readOpenSpecArtifact).toHaveBeenCalledWith({
      taskId: 'task-b',
      projectId: 'project-b',
      expectedChangeName: 'task-b-change',
      artifactId: 'design',
      relativePath: 'design.md',
    }));
    await waitFor(() => expect(result.current.artifactContent?.content)
      .toBe('# Task B design\n'));
    expect(api.readOpenSpecArtifact).not.toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-b',
        relativePath: 'brief.md',
      }),
    );
    expect(api.getOpenSpecArtifactDiff).not.toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-b',
        relativePath: 'brief.md',
      }),
    );

    await act(async () => {
      taskAContent.reject(new Error('stale task A artifact failure'));
      taskADiff.resolve({
        artifactId: 'brief',
        relativePath: 'brief.md',
        patch: '',
        base: 'git',
      });
      await Promise.resolve();
    });
    expect(result.current.snapshot?.taskId).toBe('task-b');
    expect(result.current.artifactContent?.content).toBe('# Task B design\n');
    expect(result.current.error).toBeNull();
  });

  it('ignores delayed snapshot, change, and history results from the previous task', async () => {
    const { rerender, result } = renderHook(
      ({ currentTask }) => useOpenSpecWorkspace(currentTask),
      { initialProps: { currentTask: task() } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const staleSnapshot = deferred<OpenSpecBoardSnapshot>();
    const staleChanges = deferred<Awaited<
      ReturnType<typeof window.electronAPI.listOpenSpecChanges>
    >>();
    const staleHistory = deferred<Awaited<
      ReturnType<typeof window.electronAPI.getOpenSpecHistory>
    >>();
    const taskB = task({
      id: 'task-b',
      specId: 'task-b',
      projectId: 'project-b',
    });
    const taskBSnapshot = snapshot(1, {
      taskId: 'task-b',
      rootLabel: 'project-b',
      changeName: 'task-b-change',
    });
    api.getOpenSpecSnapshot.mockImplementation((taskId: string) =>
      taskId === 'task-a' ? staleSnapshot.promise : Promise.resolve(taskBSnapshot));
    api.listOpenSpecChanges.mockImplementation((taskId: string) =>
      taskId === 'task-a'
        ? staleChanges.promise
        : Promise.resolve([{
          name: 'task-b-change',
          completedTasks: 1,
          totalTasks: 1,
          status: 'active',
        }]));
    api.getOpenSpecHistory.mockImplementation((taskId: string) =>
      taskId === 'task-a'
        ? staleHistory.promise
        : Promise.resolve({
          runs: [],
          activeRun: null,
          waitingInteraction: null,
          activityLog: {
            segments: [{
              runId: 'task-b-run',
              content: 'task B log',
              truncated: false,
            }],
            truncated: false,
          },
          latestRunLog: {
            runId: 'task-b-run',
            content: 'task B log',
            truncated: false,
          },
        }));

    let staleRefreshPromise!: ReturnType<typeof result.current.refresh>;
    let staleHistoryPromise!: ReturnType<typeof result.current.refreshHistory>;
    act(() => {
      staleRefreshPromise = result.current.refresh();
      staleHistoryPromise = result.current.refreshHistory(true);
    });
    rerender({ currentTask: taskB });

    await waitFor(() => expect(result.current.snapshot?.taskId).toBe('task-b'));
    await waitFor(() => expect(result.current.changes.map((change) => change.name))
      .toEqual(['task-b-change']));
    await waitFor(() => expect(result.current.consoleLines[0]?.text).toBe('task B log'));

    await act(async () => {
      staleSnapshot.resolve(snapshot(99, {
        schema: { name: 'stale-task-a-schema' },
      }));
      staleChanges.resolve([{
        name: 'stale-task-a-change',
        completedTasks: 0,
        totalTasks: 1,
        status: 'active',
      }]);
      staleHistory.resolve({
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        activityLog: {
          segments: [{
            runId: 'stale-task-a-run',
            content: 'stale task A log',
            truncated: false,
          }],
          truncated: false,
        },
        latestRunLog: {
          runId: 'stale-task-a-run',
          content: 'stale task A log',
          truncated: false,
        },
        pendingPlanningReview: null,
      });
      await Promise.all([staleRefreshPromise, staleHistoryPromise]);
    });

    expect(result.current.snapshot?.taskId).toBe('task-b');
    expect(result.current.snapshot?.schema.name).toBe('custom-board');
    expect(result.current.changes.map((change) => change.name)).toEqual(['task-b-change']);
    expect(result.current.consoleLines[0]?.text).toBe('task B log');
    expect(result.current.error).toBeNull();
  });

  it('refreshes once and suppresses a current stale-artifact IPC error', async () => {
    api.readOpenSpecArtifact.mockRejectedValue(new Error(
      '[OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED] ' +
      'Error invoking remote method openspec:readArtifact: ' +
      'Requested OpenSpec artifact is no longer available.',
    ));
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    await waitFor(() =>
      expect(api.getOpenSpecSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.artifactLoading).toBe(false));

    expect(result.current.artifactContent).toBeNull();
    expect(result.current.artifactDiff).toBeNull();
    expect(result.current.error).toBeNull();
    expect(api.readOpenSpecArtifact).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unmarked artifact policy error without retrying', async () => {
    api.readOpenSpecArtifact.mockRejectedValue(new Error(
      'Requested path is not one of the official artifact output paths.',
    ));
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    await waitFor(() => expect(result.current.error)
      .toBe('Requested path is not one of the official artifact output paths.'));

    expect(api.getOpenSpecSnapshot).toHaveBeenCalledTimes(1);
    expect(api.readOpenSpecArtifact).toHaveBeenCalledTimes(1);
  });

  it('ignores an artifact failure after an archived snapshot invalidates the request', async () => {
    const pendingContent = deferred<OpenSpecArtifactContent>();
    const pendingDiff = deferred<OpenSpecArtifactDiff>();
    api.readOpenSpecArtifact.mockReturnValue(pendingContent.promise);
    api.getOpenSpecArtifactDiff.mockReturnValue(pendingDiff.promise);
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));

    await waitFor(() => expect(result.current.artifactLoading).toBe(true));
    act(() => {
      listener?.({
        type: 'snapshot',
        revision: 3,
        snapshot: snapshot(3, {
          archived: true,
          artifacts: [],
          availableActions: ['new', 'propose', 'explore'],
        }),
      });
    });

    await waitFor(() => expect(result.current.selectedRelativePath).toBeNull());
    expect(result.current.artifactLoading).toBe(false);
    expect(result.current.artifactContent).toBeNull();
    expect(result.current.artifactDiff).toBeNull();

    await act(async () => {
      pendingContent.reject(new Error(
        '[OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED] ' +
        'Error invoking remote method openspec:readArtifact: ' +
        'Requested OpenSpec artifact is no longer available.',
      ));
      pendingDiff.resolve({
        artifactId: 'brief',
        relativePath: 'brief.md',
        patch: '',
        base: 'git',
      });
      await Promise.resolve();
    });
    expect(result.current.artifactContent).toBeNull();
    expect(result.current.error).toBeNull();
    expect(api.getOpenSpecSnapshot).toHaveBeenCalledTimes(1);
  });

  it('passes destructive confirmation through the typed Action API', async () => {
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.runAction('archive', {
        arguments: 'archive after review',
        confirmed: true,
      });
    });
    expect(api.runOpenSpecAction).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      action: 'archive',
      changeName: 'custom-change',
      arguments: 'archive after review',
      selectedChanges: undefined,
      confirmed: true,
    });
  });

  it('recovers an interrupted official Action with the original run ID', async () => {
    const interrupted = snapshot(5, {
      activeRun: {
        runId: 'run-interrupted',
        action: 'archive',
        state: 'interrupted',
        startedAt: '2026-07-28T00:00:00.000Z',
        recoverable: true,
      },
    });
    api.getOpenSpecSnapshot.mockResolvedValue(interrupted);
    api.getOpenSpecHistory.mockResolvedValue({
      runs: [interrupted.activeRun],
      activeRun: interrupted.activeRun,
      waitingInteraction: null,
      activityLog: {
        segments: [{
          runId: 'run-interrupted',
          content: 'output before interruption\n',
          truncated: false,
        }],
        truncated: false,
      },
      latestRunLog: {
        runId: 'run-interrupted',
        content: 'output before interruption\n',
        truncated: false,
      },
    });
    const { result } = renderHook(() => useOpenSpecWorkspace(task()));
    await waitFor(() => expect(result.current.snapshot?.activeRun?.state).toBe('interrupted'));
    await waitFor(() => expect(result.current.consoleLines[0]?.text)
      .toBe('output before interruption\n'));

    await act(async () => {
      await result.current.resumeAction(true);
    });
    expect(api.resumeOpenSpecAction).toHaveBeenCalledWith({
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'run-interrupted',
      confirmed: true,
    });
    expect(result.current.consoleLines.map((line) => line.text))
      .toEqual(['output before interruption\n']);
  });
});
