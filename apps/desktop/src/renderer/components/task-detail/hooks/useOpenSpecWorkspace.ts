import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isOpenSpecArtifactRefreshRequiredError } from '../../../../shared/types';
import type {
  OpenSpecAction,
  OpenSpecActionRunSummary,
  OpenSpecArtifactContent,
  OpenSpecArtifactDiff,
  OpenSpecBoardSnapshot,
  OpenSpecChangeSummary,
  OpenSpecInteraction,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewSummary,
  OpenSpecRendererEvent,
  OpenSpecValidationSummary,
  Task,
} from '../../../../shared/types';

export interface OpenSpecConsoleLine {
  runId: string;
  sequence: number;
  text: string;
  truncated?: boolean;
}

const HYDRATED_LOG_SEQUENCE = -1;
const MAX_CONSOLE_CHUNKS = 2_000;
const STALE_CHANGE_SELECTION_ERROR =
  'The selected OpenSpec change no longer exists. Select an active change and try again.';

interface ActivityLogSegment {
  runId: string;
  content: string;
  truncated: boolean;
}

function limitConsoleLines(lines: OpenSpecConsoleLine[]): OpenSpecConsoleLine[] {
  if (lines.length <= MAX_CONSOLE_CHUNKS) return lines;
  const retained = lines.slice(-MAX_CONSOLE_CHUNKS);
  retained[0] = {
    ...retained[0],
    truncated: true,
  };
  return retained;
}

function groupConsoleLines(lines: OpenSpecConsoleLine[]) {
  const order: string[] = [];
  const groups = new Map<string, OpenSpecConsoleLine[]>();
  for (const line of lines) {
    const group = groups.get(line.runId);
    if (group) {
      group.push(line);
    } else {
      order.push(line.runId);
      groups.set(line.runId, [line]);
    }
  }
  return { groups, order };
}

const TERMINAL_RUN_STATES = new Set<OpenSpecActionRunSummary['state']>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

function completedTimestamp(run: OpenSpecActionRunSummary): number {
  const timestamp = Date.parse(run.completedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeHydratedRun(
  current: OpenSpecActionRunSummary,
  hydrated: OpenSpecActionRunSummary,
): OpenSpecActionRunSummary {
  const currentTerminal = TERMINAL_RUN_STATES.has(current.state);
  const hydratedTerminal = TERMINAL_RUN_STATES.has(hydrated.state);
  if (currentTerminal && !hydratedTerminal) {
    return { ...hydrated, ...current };
  }
  if (!currentTerminal && hydratedTerminal) {
    return { ...current, ...hydrated };
  }
  if (currentTerminal && hydratedTerminal) {
    return completedTimestamp(hydrated) > completedTimestamp(current)
      ? { ...current, ...hydrated }
      : { ...hydrated, ...current };
  }
  // A run-state event received while History was loading is newer than the
  // response that was already in flight, so retain its live state.
  return { ...hydrated, ...current };
}

export function mergeOpenSpecRunHistory(
  current: readonly OpenSpecActionRunSummary[],
  hydrated: readonly OpenSpecActionRunSummary[],
): OpenSpecActionRunSummary[] {
  const currentById = new Map(current.map((run) => [run.runId, run]));
  const hydratedIds = new Set(hydrated.map((run) => run.runId));
  return [
    ...hydrated.map((run) => {
      const live = currentById.get(run.runId);
      return live ? mergeHydratedRun(live, run) : run;
    }),
    ...current.filter((run) => !hydratedIds.has(run.runId)),
  ];
}

function representedLiveChunkCount(
  content: string,
  liveLines: OpenSpecConsoleLine[],
): number {
  let prefix = '';
  let represented = 0;
  for (const [index, line] of liveLines.entries()) {
    prefix += line.text;
    if (content.endsWith(prefix)) {
      represented = index + 1;
    }
  }
  return represented;
}

function mergeRunLog(
  current: OpenSpecConsoleLine[],
  segment: ActivityLogSegment,
): OpenSpecConsoleLine[] {
  const hydrated = current.find((line) => line.sequence === HYDRATED_LOG_SEQUENCE);
  const liveLines = current
    .filter((line) => line.sequence !== HYDRATED_LOG_SEQUENCE)
    .sort((left, right) => left.sequence - right.sequence);
  const previousContent = hydrated?.text ?? '';
  const nextContent = segment.content.length === 0 && previousContent.length > 0
    ? previousContent
    : previousContent.startsWith(segment.content) &&
        !segment.truncated &&
        !hydrated?.truncated
      ? previousContent
      : segment.content;
  const representedCount = representedLiveChunkCount(nextContent, liveLines);
  const truncated = Boolean(hydrated?.truncated || segment.truncated);
  const next: OpenSpecConsoleLine[] = [];
  if (nextContent || truncated) {
    next.push({
      runId: segment.runId,
      sequence: HYDRATED_LOG_SEQUENCE,
      text: nextContent,
      ...(truncated ? { truncated: true } : {}),
    });
  }
  next.push(...liveLines.slice(representedCount));
  return next;
}

export function mergeOpenSpecActivityLog(
  current: OpenSpecConsoleLine[],
  segments: ActivityLogSegment[],
  truncated: boolean,
  runOrder: string[] = [],
): OpenSpecConsoleLine[] {
  if (segments.length === 0) return current;
  const { groups, order } = groupConsoleLines(current);
  const hydratedRunIds: string[] = [];
  for (const [index, segment] of segments.entries()) {
    hydratedRunIds.push(segment.runId);
    groups.set(segment.runId, mergeRunLog(groups.get(segment.runId) ?? [], {
      ...segment,
      truncated: segment.truncated || (truncated && index === 0),
    }));
  }

  const nextOrder: string[] = [];
  const appendRunId = (runId: string) => {
    if (
      groups.has(runId) &&
      !nextOrder.includes(runId)
    ) {
      nextOrder.push(runId);
    }
  };
  runOrder.forEach(appendRunId);
  hydratedRunIds.forEach(appendRunId);
  order.forEach(appendRunId);

  return limitConsoleLines(nextOrder.flatMap((runId) => groups.get(runId) ?? []));
}

export function appendOpenSpecConsoleOutput(
  current: OpenSpecConsoleLine[],
  output: OpenSpecConsoleLine,
): OpenSpecConsoleLine[] {
  if (current.some((line) =>
    line.runId === output.runId &&
    line.sequence === output.sequence &&
    line.sequence !== HYDRATED_LOG_SEQUENCE
  )) {
    return current;
  }
  const { groups, order } = groupConsoleLines(current);
  const group = groups.get(output.runId) ?? [];
  groups.set(output.runId, [
    ...group.filter((line) => line.sequence === HYDRATED_LOG_SEQUENCE),
    ...group
      .filter((line) => line.sequence !== HYDRATED_LOG_SEQUENCE)
      .concat(output)
      .sort((left, right) => left.sequence - right.sequence),
  ]);
  if (!order.includes(output.runId)) order.push(output.runId);
  return limitConsoleLines(order.flatMap((runId) => groups.get(runId) ?? []));
}

interface ScopedSnapshot {
  scope: string;
  value: OpenSpecBoardSnapshot;
}

interface ScopedPlanningReviewSummary {
  scope: string;
  value: OpenSpecPlanningReviewSummary;
}

interface ScopedPlanningReviewLoadState {
  scope: string;
  runId: string;
  review: OpenSpecPlanningReview | null;
  loading: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function earlierPlanningReview(
  current: OpenSpecPlanningReviewSummary | null,
  candidate: OpenSpecPlanningReviewSummary | null,
): OpenSpecPlanningReviewSummary | null {
  if (!current) return candidate;
  if (!candidate) return current;
  if (current.runId === candidate.runId) {
    return candidate.completedAt >= current.completedAt ? candidate : current;
  }
  return candidate.createdAt < current.createdAt ? candidate : current;
}

export function useOpenSpecWorkspace(task: Task) {
  const taskScope = `${task.projectId ?? ''}::${task.id}`;
  const taskScopeRef = useRef(taskScope);
  const acknowledgedPlanningReviewIdsRef = useRef(
    new Map<string, Set<string>>(),
  );
  taskScopeRef.current = taskScope;
  const latestRevision = useRef({
    scope: taskScope,
    revision: 0,
  });
  const changesRequestVersion = useRef({
    scope: taskScope,
    version: 0,
  });
  const selectionRequestVersion = useRef({
    scope: taskScope,
    version: 0,
  });
  const artifactRecoveryAttempts = useRef({
    scope: taskScope,
    keys: new Set<string>(),
  });
  if (latestRevision.current.scope !== taskScope) {
    latestRevision.current = {
      scope: taskScope,
      revision: 0,
    };
  }
  if (changesRequestVersion.current.scope !== taskScope) {
    changesRequestVersion.current = {
      scope: taskScope,
      version: 0,
    };
  }
  if (selectionRequestVersion.current.scope !== taskScope) {
    selectionRequestVersion.current = {
      scope: taskScope,
      version: 0,
    };
  }
  if (artifactRecoveryAttempts.current.scope !== taskScope) {
    artifactRecoveryAttempts.current = {
      scope: taskScope,
      keys: new Set<string>(),
    };
  }

  const [scopedSnapshot, setScopedSnapshot] = useState<ScopedSnapshot | null>(null);
  const [changes, setChanges] = useState<OpenSpecChangeSummary[]>([]);
  const [changesLoadedScope, setChangesLoadedScope] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<OpenSpecArtifactContent | null>(null);
  const [artifactDiff, setArtifactDiff] = useState<OpenSpecArtifactDiff | null>(null);
  const [interaction, setInteraction] = useState<OpenSpecInteraction | null>(null);
  const [consoleLines, setConsoleLines] = useState<OpenSpecConsoleLine[]>([]);
  const [runHistory, setRunHistory] = useState<OpenSpecActionRunSummary[]>([]);
  const [scopedPlanningReviewSummary, setScopedPlanningReviewSummary] =
    useState<ScopedPlanningReviewSummary | null>(null);
  const [scopedPlanningReviewLoadState, setScopedPlanningReviewLoadState] =
    useState<ScopedPlanningReviewLoadState | null>(null);
  const [planningReviewReloadKey, setPlanningReviewReloadKey] = useState(0);
  const [validation, setValidation] = useState<OpenSpecValidationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [actionPending, setActionPending] = useState<OpenSpecAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snapshot = scopedSnapshot?.scope === taskScope ? scopedSnapshot.value : null;
  const planningReviewSummary =
    scopedPlanningReviewSummary?.scope === taskScope
      ? scopedPlanningReviewSummary.value
      : null;
  const planningReviewRunId = planningReviewSummary?.runId ?? null;
  const planningReviewRequestVersion = planningReviewSummary
    ? `${planningReviewSummary.runId}\0${planningReviewSummary.completedAt}\0${planningReviewReloadKey}`
    : null;
  const planningReviewLoadState =
    planningReviewSummary &&
      scopedPlanningReviewLoadState?.scope === taskScope &&
      scopedPlanningReviewLoadState.runId === planningReviewSummary.runId
      ? scopedPlanningReviewLoadState
      : null;
  const planningReview = planningReviewLoadState?.review ?? null;
  const planningReviewLoading = planningReviewLoadState?.loading ?? false;
  const planningReviewLoadError = planningReviewLoadState?.error ?? null;
  const isCurrentScope = useCallback(
    (expectedScope: string) => taskScopeRef.current === expectedScope,
    [],
  );

  useEffect(() => {
    if (!taskScope) return;
    setScopedSnapshot(null);
    setChanges([]);
    setChangesLoadedScope(null);
    setSelectedArtifactId(null);
    setSelectedRelativePath(null);
    setArtifactContent(null);
    setArtifactDiff(null);
    setInteraction(null);
    setConsoleLines([]);
    setRunHistory([]);
    setScopedPlanningReviewSummary(null);
    setScopedPlanningReviewLoadState(null);
    setPlanningReviewReloadKey(0);
    setValidation(null);
    setArtifactLoading(false);
    setActionPending(null);
    setError(null);
  }, [taskScope]);

  const applySnapshot = useCallback((
    next: OpenSpecBoardSnapshot,
    expectedScope: string,
  ) => {
    if (!isCurrentScope(expectedScope)) return false;
    if (
      latestRevision.current.scope === expectedScope &&
      next.revision < latestRevision.current.revision
    ) {
      return false;
    }
    latestRevision.current = {
      scope: expectedScope,
      revision: next.revision,
    };
    setScopedSnapshot({
      scope: expectedScope,
      value: next,
    });
    if (next.validation) setValidation(next.validation);
    setSelectedArtifactId((current) => {
      if (current && next.artifacts.some((artifact) => artifact.id === current)) {
        return current;
      }
      return next.artifacts.find((artifact) => artifact.existingOutputPaths.length > 0)?.id ??
        next.artifacts[0]?.id ??
        null;
    });
    return true;
  }, [isCurrentScope]);

  const refreshChanges = useCallback(async () => {
    const expectedScope = taskScope;
    const requestVersion = changesRequestVersion.current.version + 1;
    changesRequestVersion.current = {
      scope: expectedScope,
      version: requestVersion,
    };
    const next = await window.electronAPI.listOpenSpecChanges(task.id, task.projectId);
    if (
      isCurrentScope(expectedScope) &&
      changesRequestVersion.current.scope === expectedScope &&
      changesRequestVersion.current.version === requestVersion
    ) {
      setChanges(next);
      setChangesLoadedScope(expectedScope);
    }
    return next;
  }, [isCurrentScope, task.id, task.projectId, taskScope]);

  const refreshHistory = useCallback(async (restoreConsole = false) => {
    const expectedScope = taskScope;
    const history = await window.electronAPI.getOpenSpecHistory(task.id, task.projectId);
    if (!isCurrentScope(expectedScope)) return history;
    setRunHistory((current) => mergeOpenSpecRunHistory(current, history.runs));
    setScopedPlanningReviewSummary((current) => {
      const acknowledged =
        acknowledgedPlanningReviewIdsRef.current.get(expectedScope);
      const currentReview =
        current?.scope === expectedScope &&
          !acknowledged?.has(current.value.runId)
          ? current.value
          : null;
      const pendingReview =
        history.pendingPlanningReview &&
          !acknowledged?.has(history.pendingPlanningReview.runId)
          ? history.pendingPlanningReview
          : null;
      const next = earlierPlanningReview(
        currentReview,
        pendingReview,
      );
      return next ? { scope: expectedScope, value: next } : null;
    });
    setInteraction(history.waitingInteraction);
    if (restoreConsole) {
      const activityLog = history.activityLog;
      const segments = activityLog
        ? activityLog.segments
        : history.latestRunLog
          ? [history.latestRunLog]
          : [];
      if (segments.length > 0) {
        setConsoleLines((current) => mergeOpenSpecActivityLog(
          current,
          segments,
          activityLog?.truncated ?? false,
          history.runs.map((run) => run.runId),
        ));
      }
    }
    return history;
  }, [isCurrentScope, task.id, task.projectId, taskScope]);

  const refresh = useCallback(async () => {
    const expectedScope = taskScope;
    if (isCurrentScope(expectedScope)) {
      setError(null);
    }
    const [nextSnapshot] = await Promise.all([
      window.electronAPI.getOpenSpecSnapshot(task.id, task.projectId),
      refreshChanges(),
    ]);
    applySnapshot(nextSnapshot, expectedScope);
    return nextSnapshot;
  }, [
    applySnapshot,
    isCurrentScope,
    refreshChanges,
    task.id,
    task.projectId,
    taskScope,
  ]);

  useEffect(() => {
    const expectedScope = taskScope;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      refresh(),
      refreshHistory(true),
    ])
      .catch((reason) => {
        if (!cancelled && isCurrentScope(expectedScope)) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (!cancelled && isCurrentScope(expectedScope)) {
          setLoading(false);
        }
      });

    const unsubscribe = window.electronAPI.onOpenSpecEvent(
      task.id,
      (event: OpenSpecRendererEvent) => {
        if (cancelled || !isCurrentScope(expectedScope)) return;
        switch (event.type) {
          case 'snapshot':
            applySnapshot(event.snapshot, expectedScope);
            void refreshChanges().catch(() => undefined);
            break;
          case 'run-state':
            setScopedSnapshot((current) => current?.scope === expectedScope
              ? {
                ...current,
                value: {
                  ...current.value,
                  activeRun: event.run,
                },
              }
              : current);
            setRunHistory((current) => {
              const index = current.findIndex((run) => run.runId === event.run.runId);
              if (index === -1) return [...current, event.run];
              const next = [...current];
              next[index] = event.run;
              return next;
            });
            if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.run.state)) {
              setActionPending(null);
            }
            break;
          case 'planning-review':
            setScopedPlanningReviewSummary((current) => {
              if (
                acknowledgedPlanningReviewIdsRef.current
                  .get(expectedScope)
                  ?.has(event.review.runId)
              ) {
                return current;
              }
              const next = earlierPlanningReview(
                current?.scope === expectedScope ? current.value : null,
                event.review,
              );
              return next ? { scope: expectedScope, value: next } : null;
            });
            break;
          case 'output':
            setConsoleLines((current) =>
              appendOpenSpecConsoleOutput(current, {
                runId: event.runId,
                sequence: event.sequence,
                text: event.text,
              }));
            break;
          case 'interaction-required':
            setInteraction(event.interaction);
            break;
          case 'validation':
            setValidation(event.validation);
            break;
          case 'error':
            setError(event.message);
            break;
        }
      },
      task.projectId,
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    applySnapshot,
    isCurrentScope,
    refresh,
    refreshChanges,
    refreshHistory,
    task.id,
    task.projectId,
    taskScope,
  ]);

  useEffect(() => {
    const runId = planningReviewRunId;
    if (!runId || !planningReviewRequestVersion) {
      setScopedPlanningReviewLoadState((current) =>
        current?.scope === taskScope ? null : current);
      return;
    }
    const expectedScope = taskScope;
    let cancelled = false;
    setScopedPlanningReviewLoadState({
      scope: expectedScope,
      runId,
      review: null,
      loading: true,
      error: null,
    });
    void window.electronAPI.getOpenSpecPlanningReview({
      taskId: task.id,
      projectId: task.projectId,
      runId,
    })
      .then((review) => {
        if (
          !cancelled &&
          isCurrentScope(expectedScope) &&
          review.runId === runId
        ) {
          setScopedPlanningReviewLoadState((current) =>
            current?.scope === expectedScope &&
              current.runId === runId
              ? { ...current, review, error: null }
              : current);
        }
      })
      .catch((reason) => {
        if (!cancelled && isCurrentScope(expectedScope)) {
          setScopedPlanningReviewLoadState((current) =>
            current?.scope === expectedScope &&
              current.runId === runId
              ? { ...current, error: errorMessage(reason) }
              : current);
        }
      })
      .finally(() => {
        if (!cancelled && isCurrentScope(expectedScope)) {
          setScopedPlanningReviewLoadState((current) =>
            current?.scope === expectedScope &&
              current.runId === runId
              ? { ...current, loading: false }
              : current);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    isCurrentScope,
    planningReviewRequestVersion,
    planningReviewRunId,
    task.id,
    task.projectId,
    taskScope,
  ]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh().catch(() => undefined);
      }
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    const timer = window.setInterval(refreshIfVisible, 60_000);
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const changesLoaded = changesLoadedScope === taskScope;
  const selectedChangeExists = Boolean(
    snapshot?.changeName &&
    changes.some((change) =>
      !change.archived && change.name === snapshot.changeName
    ),
  );
  const selectedChangeStale = Boolean(
    snapshot?.initialized &&
    snapshot.changeName &&
    !snapshot.archived &&
    changesLoaded &&
    !selectedChangeExists,
  );
  const selectedChangeReady = Boolean(
    snapshot &&
    (
      !snapshot.initialized ||
      !snapshot.changeName ||
      snapshot.archived ||
      (changesLoaded && selectedChangeExists)
    ),
  );
  const selectedArtifact = useMemo(
    () => selectedChangeReady
      ? snapshot?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null
      : null,
    [selectedArtifactId, selectedChangeReady, snapshot],
  );
  const artifactRevision = snapshot?.revision ?? 0;

  useEffect(() => {
    if (!selectedArtifact) {
      setSelectedRelativePath(null);
      setArtifactContent(null);
      setArtifactDiff(null);
      return;
    }
    setSelectedRelativePath((current) =>
      current && selectedArtifact.existingOutputPaths.includes(current)
        ? current
        : selectedArtifact.existingOutputPaths[0] ?? null,
    );
  }, [selectedArtifact]);

  useEffect(() => {
    if (
      !selectedArtifact ||
      !selectedRelativePath ||
      !snapshot?.changeName ||
      !selectedArtifact.existingOutputPaths.includes(selectedRelativePath)
    ) {
      setArtifactContent(null);
      setArtifactDiff(null);
      setArtifactLoading(false);
      return;
    }
    const expectedScope = taskScope;
    let cancelled = false;
    const revisionAtRequest = artifactRevision;
    setArtifactLoading(true);
    setError(null);
    const input = {
      taskId: task.id,
      projectId: task.projectId,
      expectedChangeName: snapshot.changeName,
      artifactId: selectedArtifact.id,
      relativePath: selectedRelativePath,
    };
    const recoveryKey = [
      expectedScope,
      snapshot.changeName,
      revisionAtRequest,
      selectedArtifact.id,
      selectedRelativePath,
    ].join('\0');
    void Promise.all([
      window.electronAPI.readOpenSpecArtifact(input),
      window.electronAPI.getOpenSpecArtifactDiff(input),
    ])
      .then(([content, diff]) => {
        if (
          cancelled ||
          !isCurrentScope(expectedScope) ||
          latestRevision.current.scope !== expectedScope ||
          revisionAtRequest !== latestRevision.current.revision
        ) {
          return;
        }
        artifactRecoveryAttempts.current.keys.delete(recoveryKey);
        setArtifactContent(content);
        setArtifactDiff(diff);
      })
      .catch((reason) => {
        if (
          cancelled ||
          !isCurrentScope(expectedScope) ||
          latestRevision.current.scope !== expectedScope ||
          revisionAtRequest !== latestRevision.current.revision
        ) {
          return;
        }
        const message = errorMessage(reason);
        if (isOpenSpecArtifactRefreshRequiredError(reason)) {
          setArtifactContent(null);
          setArtifactDiff(null);
          setArtifactLoading(false);
          if (!artifactRecoveryAttempts.current.keys.has(recoveryKey)) {
            artifactRecoveryAttempts.current.keys.add(recoveryKey);
            void refresh().catch(() => undefined);
          }
          return;
        }
        setError(message);
      })
      .finally(() => {
        if (!cancelled && isCurrentScope(expectedScope)) {
          setArtifactLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    artifactRevision,
    isCurrentScope,
    refresh,
    selectedArtifact,
    selectedRelativePath,
    snapshot?.changeName,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const runAction = useCallback(async (
    action: OpenSpecAction,
    options: {
      arguments?: string;
      changeName?: string;
      selectedChanges?: string[];
      confirmed?: boolean;
    } = {},
  ) => {
    const expectedScope = taskScope;
    if (
      !selectedChangeReady &&
      snapshot?.changeName &&
      !snapshot.archived &&
      action !== 'new' &&
      action !== 'propose' &&
      action !== 'onboard'
    ) {
      const reason = new Error(STALE_CHANGE_SELECTION_ERROR);
      if (isCurrentScope(expectedScope)) {
        setError(reason.message);
      }
      throw reason;
    }
    if (isCurrentScope(expectedScope)) {
      setActionPending(action);
      setError(null);
      setInteraction(null);
    }
    try {
      return await window.electronAPI.runOpenSpecAction({
        taskId: task.id,
        projectId: task.projectId,
        action,
        changeName: options.changeName ?? (
          action === 'new' || action === 'propose' || action === 'onboard'
            ? undefined
            : snapshot?.archived
              ? undefined
              : snapshot?.changeName ?? undefined
        ),
        arguments: options.arguments,
        selectedChanges: options.selectedChanges,
        confirmed: options.confirmed,
      });
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setActionPending(null);
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [
    isCurrentScope,
    selectedChangeReady,
    snapshot?.archived,
    snapshot?.changeName,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const cancelAction = useCallback(async () => {
    const runId = snapshot?.activeRun?.runId;
    if (!runId) return;
    const expectedScope = taskScope;
    if (isCurrentScope(expectedScope)) {
      setError(null);
    }
    try {
      await window.electronAPI.cancelOpenSpecAction(task.id, runId, task.projectId);
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [
    isCurrentScope,
    snapshot?.activeRun?.runId,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const resumeAction = useCallback(async (confirmed = false) => {
    const activeRun = snapshot?.activeRun;
    if (!activeRun || activeRun.state !== 'interrupted') return null;
    const expectedScope = taskScope;
    if (selectedChangeStale) {
      const reason = new Error(STALE_CHANGE_SELECTION_ERROR);
      if (isCurrentScope(expectedScope)) {
        setError(reason.message);
      }
      throw reason;
    }
    if (isCurrentScope(expectedScope)) {
      setActionPending(activeRun.action);
      setError(null);
      setInteraction(null);
    }
    try {
      return await window.electronAPI.resumeOpenSpecAction({
        taskId: task.id,
        projectId: task.projectId,
        runId: activeRun.runId,
        ...(confirmed ? { confirmed: true } : {}),
      });
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setActionPending(null);
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [
    isCurrentScope,
    selectedChangeStale,
    snapshot?.activeRun,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const loadRunLog = useCallback(async (runId: string) => {
    const expectedScope = taskScope;
    if (isCurrentScope(expectedScope)) {
      setError(null);
    }
    try {
      const log = await window.electronAPI.readOpenSpecRunLog(
        task.id,
        runId,
        task.projectId,
      );
      if (isCurrentScope(expectedScope)) {
        setConsoleLines((current) => mergeOpenSpecActivityLog(
          current,
          [log],
          false,
          runHistory.map((run) => run.runId),
        ));
      }
      return log;
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [isCurrentScope, runHistory, task.id, task.projectId, taskScope]);

  const answerInteraction = useCallback(async (answer: string) => {
    if (!interaction) return;
    const expectedScope = taskScope;
    if (isCurrentScope(expectedScope)) {
      setError(null);
    }
    try {
      await window.electronAPI.answerOpenSpecInteraction({
        taskId: task.id,
        projectId: task.projectId,
        runId: interaction.runId,
        interactionId: interaction.interactionId,
        answer,
      });
      if (isCurrentScope(expectedScope)) {
        setInteraction(null);
      }
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [interaction, isCurrentScope, task.id, task.projectId, taskScope]);

  const runValidation = useCallback(async () => {
    const expectedScope = taskScope;
    if (
      !selectedChangeReady &&
      snapshot?.changeName &&
      !snapshot.archived
    ) {
      const reason = new Error(STALE_CHANGE_SELECTION_ERROR);
      if (isCurrentScope(expectedScope)) {
        setError(reason.message);
      }
      throw reason;
    }
    if (isCurrentScope(expectedScope)) {
      setError(null);
    }
    try {
      const result = await window.electronAPI.validateOpenSpec({
        taskId: task.id,
        projectId: task.projectId,
        changeName: snapshot?.changeName ?? undefined,
        strict: true,
      });
      if (isCurrentScope(expectedScope)) {
        setValidation(result);
      }
      return result;
    } catch (reason) {
      if (isCurrentScope(expectedScope)) {
        setError(errorMessage(reason));
      }
      throw reason;
    }
  }, [
    isCurrentScope,
    selectedChangeReady,
    snapshot?.archived,
    snapshot?.changeName,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const selectChange = useCallback(async (changeName: string) => {
    const expectedScope = taskScope;
    if (
      changesLoaded &&
      !changes.some((change) => !change.archived && change.name === changeName)
    ) {
      const reason = new Error(
        `OpenSpec change "${changeName}" is no longer active. Refresh the change list and try again.`,
      );
      if (isCurrentScope(expectedScope)) {
        setError(reason.message);
      }
      throw reason;
    }
    const requestVersion = selectionRequestVersion.current.version + 1;
    selectionRequestVersion.current = {
      scope: expectedScope,
      version: requestVersion,
    };
    const isLatestSelection = () =>
      isCurrentScope(expectedScope) &&
      selectionRequestVersion.current.scope === expectedScope &&
      selectionRequestVersion.current.version === requestVersion;
    if (isCurrentScope(expectedScope)) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await window.electronAPI.selectOpenSpecChange(
        task.id,
        changeName,
        task.projectId,
      );
      if (isLatestSelection() && applySnapshot(next, expectedScope)) {
        setArtifactContent(null);
        setArtifactDiff(null);
      }
      return next;
    } catch (reason) {
      if (isLatestSelection()) {
        setError(errorMessage(reason));
        void refreshChanges().catch(() => undefined);
      }
      throw reason;
    } finally {
      if (isLatestSelection()) {
        setLoading(false);
      }
    }
  }, [
    applySnapshot,
    changes,
    changesLoaded,
    isCurrentScope,
    refreshChanges,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const acknowledgePlanningReview = useCallback(async () => {
    if (!planningReviewSummary) return null;
    const expectedScope = taskScope;
    const acknowledgedRunId = planningReviewSummary.runId;
    if (isCurrentScope(expectedScope)) setError(null);
    try {
      const next = await window.electronAPI.acknowledgeOpenSpecPlanningReview({
        taskId: task.id,
        projectId: task.projectId,
        runId: acknowledgedRunId,
      });
      if (isCurrentScope(expectedScope)) {
        const acknowledged =
          acknowledgedPlanningReviewIdsRef.current.get(expectedScope) ??
          new Set<string>();
        acknowledged.add(acknowledgedRunId);
        acknowledgedPlanningReviewIdsRef.current.set(
          expectedScope,
          acknowledged,
        );
        setScopedPlanningReviewSummary((current) => {
          if (
            current?.scope !== expectedScope ||
            current.value.runId !== acknowledgedRunId
          ) {
            return current;
          }
          return next && !acknowledged.has(next.runId)
            ? { scope: expectedScope, value: next }
            : null;
        });
        setScopedPlanningReviewLoadState((current) =>
          current?.scope === expectedScope &&
            current.runId === acknowledgedRunId
            ? null
            : current);
      }
      return next;
    } catch (reason) {
      if (isCurrentScope(expectedScope)) setError(errorMessage(reason));
      throw reason;
    }
  }, [
    isCurrentScope,
    planningReviewSummary,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const retryPlanningReview = useCallback(async () => {
    if (!planningReviewSummary) return null;
    const expectedScope = taskScope;
    const retriedRunId = planningReviewSummary.runId;
    if (isCurrentScope(expectedScope)) setError(null);
    try {
      const review = await window.electronAPI.retryOpenSpecPlanningReview({
        taskId: task.id,
        projectId: task.projectId,
        runId: retriedRunId,
      });
      if (isCurrentScope(expectedScope)) {
        setScopedPlanningReviewLoadState((current) =>
          current?.scope === expectedScope &&
            current.runId === retriedRunId
            ? {
                ...current,
                review,
                loading: false,
                error: null,
              }
            : current);
        setScopedPlanningReviewSummary((current) =>
          current?.scope === expectedScope &&
            current.value.runId === retriedRunId
            ? {
                scope: expectedScope,
                value: {
                  runId: review.runId,
                  state: review.state,
                  createdAt: review.createdAt,
                  completedAt: review.completedAt,
                  changeCount: review.changes.length,
                  ...(review.error ? { error: review.error } : {}),
                },
              }
            : current);
      }
      return review;
    } catch (reason) {
      if (isCurrentScope(expectedScope)) setError(errorMessage(reason));
      throw reason;
    }
  }, [
    isCurrentScope,
    planningReviewSummary,
    task.id,
    task.projectId,
    taskScope,
  ]);

  const reloadPlanningReview = useCallback(() => {
    setPlanningReviewReloadKey((current) => current + 1);
  }, []);

  return {
    snapshot,
    changes,
    changesLoaded,
    selectedChangeStale,
    selectedChangeReady,
    selectedArtifact,
    selectedArtifactId,
    selectedRelativePath,
    artifactContent,
    artifactDiff,
    interaction,
    consoleLines,
    runHistory,
    planningReviewSummary,
    planningReview,
    planningReviewLoading,
    planningReviewLoadError,
    validation,
    loading,
    artifactLoading,
    actionPending,
    error,
    setError,
    setSelectedArtifactId,
    setSelectedRelativePath,
    refresh,
    refreshHistory,
    runAction,
    cancelAction,
    resumeAction,
    loadRunLog,
    answerInteraction,
    runValidation,
    selectChange,
    acknowledgePlanningReview,
    retryPlanningReview,
    reloadPlanningReview,
  };
}
