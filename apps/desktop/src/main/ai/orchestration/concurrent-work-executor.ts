/**
 * Concurrent Work Executor
 * ========================
 *
 * Executes implementation plan work items with a shared concurrency flow.
 * Standard work packages and subtasks are both treated as work items.
 */

import type {
  WorkExecutorResult,
  WorkItemInfo,
  WorkItemResult,
} from './work-executor-types';
import type { SessionResult } from '../session/types';
import {
  analyzeAutocodeWorkDependencies,
  buildAutocodeWorkDependencyStatusMap,
  describeAutocodeWorkDependencyBlocker,
  describeAutocodeWorkDependencyBlockers,
  normalizeAutocodeWorkDependencyIds,
  type AutocodeWorkDependencyBlockedItem,
} from '@autocode/core';
import {
  createAutocodeAdaptiveConcurrency,
  partitionAutocodeHighRiskUnscopedWorkItems,
  shouldSerializeAutocodeHighRiskUnscopedWorkItem,
  summarizeAutocodeWorkItemResults,
} from '@autocode/core/runtime/work-executor-strategy';
import {
  detectFileConflicts,
  groupConflictingWorkItems,
} from './conflict-detector';
import {
  collectFilesChangedSinceBaseline,
  collectGitChangedFileSnapshot,
  loadGeneratedFilesForCritique,
  type ChangedFileSnapshot,
} from './changed-files';
import { summarizeSessionCompletion } from './completion-summary';
import type { CritiqueResult } from './self-critique';
import type { IncrementalValidationResult } from './incremental-validation';
import {
  writeAuthPauseFile,
  writeRateLimitPauseFile,
  waitForAuthResume,
  waitForRateLimitResume,
} from './pause-handler';
import {
  loadImplementationPlanFromFiles,
  updateImplementationPlanInFiles,
} from '../schema/plan-shards';

const MAX_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const FALLBACK_FAILURE_THRESHOLD = 3;
const HIGH_RISK_UNSCOPED_WORK_PATTERN = /\b(refactor|restructure|architecture|migration|global|cross-cutting|shared|config|schema|security|auth|permission|database|persistence|routing|build|pipeline|concurrent|parallel|framework)\b|重构|架构|迁移|全局|共享|配置|模式|安全|认证|权限|数据库|持久化|路由|构建|管线|并发/iu;

export interface ConcurrentWorkExecutorConfig {
  specDir: string;
  projectDir: string;
  sourceSpecDir?: string;
  maxRetries: number;
  workers: number;
  abortSignal?: AbortSignal;
  onGroupStart?: (items: WorkItemInfo[], groupNum: number, totalGroups: number, mode: 'concurrent' | 'serial') => void;
  onWorkItemStart?: (item: WorkItemInfo, attempt: number) => number | undefined;
  runWorkItemSession: (item: WorkItemInfo, attempt: number, sessionNumber?: number) => Promise<SessionResult>;
  onWorkItemSessionComplete?: (item: WorkItemInfo, result: SessionResult) => void;
  onWorkItemQualityFailure?: (item: WorkItemInfo, result: SessionResult, attempt: number, issues: string[]) => void;
  onGroupComplete?: (items: WorkItemInfo[], result: WorkItemResult) => void;
  onLog?: (message: string) => void;
  qualityConfig?: import('./quality-integration').QualityConfig;
}

interface ImplementationPlan {
  feature?: string;
  workflow_type?: string;
  executionPhase?: string;
  updated_at?: string;
  phases: PlanPhase[];
}

interface PlanPhase {
  id?: string;
  phase?: number;
  name: string;
  subtasks: PlanSubtask[];
}

interface PlanSubtask {
  id: string;
  title: string;
  description: string;
  status: string;
  notes?: string;
  completion_summary?: string;
  completed_at?: string;
  started_at?: string;
  duration_ms?: number;
  updated_at?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  pattern_files?: string[];
  depends_on?: unknown;
  verification?: unknown;
  work_package?: boolean;
  upstream_task_ids?: unknown;
  upstream_source?: unknown;
  ai_coding_quality?: WorkItemQualityMetrics;
}

type PlanWrite<T> = () => Promise<T>;

interface WorkItemQualityMetrics {
  outcome: string;
  attempt: number;
  changed_files: string[];
  files_changed: number;
  steps_executed: number;
  tool_call_count: number;
  duration_ms: number;
  recorded_at: string;
  self_critique?: {
    status: 'passed' | 'failed' | 'skipped';
    score?: number;
    files_reviewed: number;
    improvements: string[];
  };
  incremental_validation?: {
    status: 'passed' | 'failed' | 'skipped';
    duration_ms?: number;
    checks_run?: number;
    failures: string[];
  };
}

interface ExecutionRuntime {
  sourceSync: SourceSyncCoordinator;
  pauseCoordinator: PauseCoordinator;
}

interface SourceSyncCoordinator {
  request(): Promise<void>;
  flush(): Promise<void>;
}

interface PauseCoordinator {
  waitForRateLimit(errorMessage: string): Promise<void>;
  waitForAuth(errorMessage: string): Promise<void>;
  consumePressure(): 'rate_limited' | 'auth_failure' | null;
}

interface WorkItemQualityResult {
  passed: boolean;
  issues: string[];
  changedFiles: string[];
  selfCritique: CritiqueResult | null;
  incrementalValidation: IncrementalValidationResult | null;
}

export async function executeConcurrentWorkItems(
  config: ConcurrentWorkExecutorConfig,
): Promise<WorkExecutorResult> {
  const log = (message: string) => config.onLog?.(message);
  const planWriter = createPlanWriter();
  const sourceSync = createSourceSyncCoordinator(config);
  const runtime: ExecutionRuntime = {
    sourceSync,
    pauseCoordinator: createPauseCoordinator(config),
  };
  const adaptiveConcurrency = createAdaptiveConcurrency(Math.max(1, Math.floor(config.workers || 1)), log);
  const terminalFailedWorkItemIds = new Set<string>();
  let totalCompleted = 0;
  let totalFailed = 0;
  let totalBlocked = 0;
  let roundNumber = 0;

  while (true) {
    roundNumber++;
    log(`[ConcurrentWorkExecutor] Round ${roundNumber}`);

    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return {
        success: false,
        totalCompleted,
        error: 'Failed to load implementation plan',
      };
    }

    if (hasInProgressWorkItems(plan)) {
      await planWriter(() => resetRoundInProgressWorkItems(config, runtime, log));
      await sourceSync.flush();
    }

    const pendingItems = getPendingWorkItems(plan)
      .filter((item) => !terminalFailedWorkItemIds.has(item.id));
    if (pendingItems.length === 0) {
      const terminalIncompleteItems = getTerminalIncompleteWorkItems(plan);
      const unreportedTerminalIncompleteItems = terminalIncompleteItems
        .filter((item) => !terminalFailedWorkItemIds.has(item.id));
      if (unreportedTerminalIncompleteItems.length > 0) {
        const terminalSummary = summarizeTerminalIncompleteWorkItems(terminalIncompleteItems);
        log(`[ConcurrentWorkExecutor] No runnable work items remain; terminal incomplete work items: ${terminalSummary}`);
        return {
          success: false,
          totalCompleted,
          totalFailed: totalFailed + unreportedTerminalIncompleteItems.length,
          totalBlocked: totalBlocked + unreportedTerminalIncompleteItems.filter((item) => item.status === 'blocked').length,
          error: `No runnable work items remain; terminal incomplete work items: ${terminalSummary}. Reset failed or blocked work items before retrying.`,
        };
      }
      log('[ConcurrentWorkExecutor] No more pending work items');
      break;
    }

    const statusById = getWorkItemStatusMap(plan);
    const dependencyAnalysis = analyzeAutocodeWorkDependencies(pendingItems, { statusById });
    const runnableItems = dependencyAnalysis.runnable;
    if (runnableItems.length === 0) {
      const blockedSummary = describeAutocodeWorkDependencyBlockers(dependencyAnalysis.blocked, statusById);
      const newlyBlocked = dependencyAnalysis.blocked.length;
      await planWriter(() => markDependencyBlockedWorkItems(config, dependencyAnalysis.blocked, statusById, runtime));
      await sourceSync.flush();
      await learnFromBlockedWorkItems(config, dependencyAnalysis.blocked, statusById);
      totalBlocked += newlyBlocked;
      log(`[ConcurrentWorkExecutor] No runnable work items because dependencies are unresolved: ${blockedSummary}`);
      return {
        success: false,
        totalCompleted,
        totalFailed: totalFailed + newlyBlocked,
        totalBlocked,
        error: `No runnable work items because dependencies are unresolved: ${blockedSummary}`,
      };
    }

    const { scopedItems, highRiskUnscopedItems } = partitionHighRiskUnscopedWorkItems(runnableItems);
    const groups: Array<{ mode: 'concurrent' | 'serial'; items: WorkItemInfo[] }> = [];
    const { independent, sequential } = detectFileConflicts(scopedItems);
    const independentItems = independent.flat();
    const conflictGroups = groupConflictingWorkItems(sequential);
    log(
      `[ConcurrentWorkExecutor] Conflict analysis: ${independentItems.length} independent, ${sequential.length} conflict-locked, ${highRiskUnscopedItems.length} metadata-limited`,
    );
    groups.push(
      ...(independentItems.length > 0 ? [{ mode: 'concurrent' as const, items: independentItems }] : []),
      ...conflictGroups.map((items) => ({ mode: 'serial' as const, items })),
      ...highRiskUnscopedItems.map((item) => ({ mode: 'serial' as const, items: [item] })),
    );
    log(`[ConcurrentWorkExecutor] Prepared ${groups.length} work group(s), workers=${adaptiveConcurrency.current()}`);

    let roundCompleted = 0;
    let roundFailed = 0;
    let consecutiveFailures = 0;
    let forceSerialForRound = false;

    for (let i = 0; i < groups.length; i++) {
      if (config.abortSignal?.aborted) {
        await sourceSync.flush();
        return {
          success: false,
          totalCompleted: totalCompleted + roundCompleted,
          totalFailed,
          totalBlocked,
          cancelled: true,
        };
      }

      const group = groups[i];
      const groupMode = forceSerialForRound ? 'serial' : group.mode;
      config.onGroupStart?.(group.items, i + 1, groups.length, groupMode);

      const result = groupMode === 'serial'
        ? await executeSerialGroup(group.items, config, planWriter, runtime)
        : await executeConcurrentGroup(group.items, adaptiveConcurrency.current(), config, planWriter, runtime);
      await sourceSync.flush();

      config.onGroupComplete?.(group.items, result);

      if (config.abortSignal?.aborted || result.sessionResult.outcome === 'cancelled') {
        await planWriter(() => resetCancelledInProgressWorkItems(config, result.failed, runtime));
        await sourceSync.flush();
        return {
          success: false,
          totalCompleted: totalCompleted + roundCompleted + result.completed.length,
          totalFailed: totalFailed + roundFailed,
          totalBlocked,
          cancelled: true,
        };
      }

      roundCompleted += result.completed.length;
      roundFailed += result.failed.length;
      for (const failedId of result.failed) {
        terminalFailedWorkItemIds.add(failedId);
      }
      adaptiveConcurrency.recordGroupResult(result, groupMode, runtime.pauseCoordinator.consumePressure());

      if (result.failed.length > 0) {
        consecutiveFailures++;
        log(
          `[ConcurrentWorkExecutor] Work group ${i + 1} had ${result.failed.length} failure(s) (consecutive: ${consecutiveFailures})`,
        );
        if (consecutiveFailures >= FALLBACK_FAILURE_THRESHOLD) {
          forceSerialForRound = true;
          consecutiveFailures = 0;
          log('[ConcurrentWorkExecutor] Failure threshold reached, running remaining round groups serially');
        }
      } else {
        consecutiveFailures = 0;
      }
    }

    totalCompleted += roundCompleted;
    totalFailed += roundFailed;

    log(
      `[ConcurrentWorkExecutor] Round ${roundNumber} completed: ${roundCompleted} completed, ${roundFailed} failed`,
    );

    if (roundFailed > 0) {
      log('[ConcurrentWorkExecutor] Continuing with unrelated runnable work after isolating failed item(s)');
    }
  }

  const success = totalFailed === 0;
  log(
    `[ConcurrentWorkExecutor] All rounds completed: ${totalCompleted} total completed, ${totalFailed} total failed`,
  );

  await sourceSync.flush();
  return { success, totalCompleted, totalFailed, totalBlocked };
}

async function executeConcurrentGroup(
  items: WorkItemInfo[],
  workers: number,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<WorkItemResult> {
  let cancelled = false;
  const prestartedIds = new Set(items.slice(0, Math.max(1, workers)).map((item) => item.id));
  await planWriter(() => markWorkItemsInProgress(config, [...prestartedIds], runtime));
  await runtime.sourceSync.flush();

  const results = await runWithConcurrency(
    items,
    workers,
    async (item) => {
      if (!prestartedIds.has(item.id)) {
        await planWriter(() => markWorkItemsInProgress(config, [item.id], runtime));
      }
      const result = await executeWorkItemIsolated(item, config, planWriter, runtime);
      if (result.sessionResult.outcome === 'cancelled') {
        cancelled = true;
      }
      return result;
    },
    () => !config.abortSignal?.aborted && !cancelled,
  );

  return summarizeWorkItemResults(results);
}

async function executeSerialGroup(
  items: WorkItemInfo[],
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<WorkItemResult> {
  const results: WorkItemResult[] = [];
  for (const item of items) {
    if (config.abortSignal?.aborted) {
      return {
        completed: [],
        failed: items.map((candidate) => candidate.id),
        blocked: [],
        sessionResult: { outcome: 'cancelled' } as SessionResult,
      };
    }
    await planWriter(() => markWorkItemsInProgress(config, [item.id], runtime));
    await runtime.sourceSync.flush();
    results.push(await executeWorkItemIsolated(item, config, planWriter, runtime));
  }
  return summarizeWorkItemResults(results);
}

async function executeWorkItemIsolated(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<WorkItemResult> {
  try {
    return await executeWorkItemWithRetries(item, config, planWriter, runtime);
  } catch (error) {
    const sessionResult = createErrorSessionResult(error, Date.now());
    config.onLog?.(
      `[ConcurrentWorkExecutor] Work item ${item.id} failed outside session: ${sessionResult.error?.message ?? sessionResult.outcome}`,
    );

    await learnFromTerminalWorkItem(config, item, sessionResult, 'stuck');
    await tryPersistFailedWorkItemStatus(config, item, sessionResult, planWriter, runtime);

    return {
      completed: [],
      failed: [item.id],
      blocked: [],
      sessionResult,
    };
  }
}

async function executeWorkItemWithRetries(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<WorkItemResult> {
  const log = (message: string) => config.onLog?.(message);
  let lastResult: SessionResult = { outcome: 'error' } as SessionResult;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (config.abortSignal?.aborted) {
      return {
        completed: [],
        failed: [item.id],
        blocked: [],
        sessionResult: { outcome: 'cancelled' } as SessionResult,
      };
    }

    const attemptNumber = attempt + 1;
    const sessionNumber = config.onWorkItemStart?.(item, attemptNumber);
    log(`[ConcurrentWorkExecutor] Working on ${item.id} (attempt ${attemptNumber})`);
    const changedFileBaseline = await collectChangedFileBaseline(config.projectDir);

    const sessionResult = await executeWorkItemSession(
      item,
      config,
      attemptNumber,
      typeof sessionNumber === 'number' ? sessionNumber : undefined,
      runtime,
    );
    config.onWorkItemSessionComplete?.(item, sessionResult);
    try {
      await planWriter(() => recordWorkItemSessionDuration(config, item.id, sessionResult, runtime));
    } catch (error) {
      log(
        `[ConcurrentWorkExecutor] Failed to record active duration for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const qualityResult = await evaluateCompletedWorkItemQuality(
      config,
      item,
      sessionResult,
      attemptNumber,
      changedFileBaseline,
    );
    await recordWorkItemQualityMetricsSafely(
      config,
      item.id,
      buildWorkItemQualityMetrics(
        sessionResult,
        attemptNumber,
        qualityResult.changedFiles,
        qualityResult.selfCritique,
        qualityResult.incrementalValidation,
      ),
      planWriter,
      runtime,
    );

    const effectiveSessionResult = qualityResult.passed
      ? sessionResult
      : createQualityFailureSessionResult(qualityResult.issues, sessionResult);
    if (!qualityResult.passed) {
      config.onWorkItemQualityFailure?.(item, effectiveSessionResult, attemptNumber, qualityResult.issues);
    }
    lastResult = effectiveSessionResult;

    if (effectiveSessionResult.outcome === 'cancelled') {
      return {
        completed: [],
        failed: [item.id],
        blocked: [],
        sessionResult: effectiveSessionResult,
      };
    }

    if (effectiveSessionResult.outcome === 'completed') {
      await planWriter(() => updateWorkItemStatuses(config, [
        { id: item.id, summary: summarizeSessionCompletion(effectiveSessionResult) },
      ], 'completed', runtime));
      await learnFromCompletedWorkItem(config, item, effectiveSessionResult);
      return {
        completed: [item.id],
        failed: [],
        blocked: [],
        sessionResult: effectiveSessionResult,
      };
    }

    if (config.abortSignal?.aborted) {
      return {
        completed: [],
        failed: [item.id],
        blocked: [],
        sessionResult: { outcome: 'cancelled' } as SessionResult,
      };
    }

    if (isNonRetryableSessionResult(effectiveSessionResult)) {
      log(`[ConcurrentWorkExecutor] Not retrying ${item.id}: ${effectiveSessionResult.error?.message ?? effectiveSessionResult.outcome}`);
      break;
    }

    if (attempt < config.maxRetries) {
      log(`[ConcurrentWorkExecutor] Retrying ${item.id} after outcome ${effectiveSessionResult.outcome}`);
      try {
        await planWriter(() => markWorkItemsInProgress(config, [item.id], runtime));
        await runtime.sourceSync.flush();
      } catch (error) {
        log(
          `[ConcurrentWorkExecutor] Failed to mark ${item.id} in_progress before retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  await learnFromTerminalWorkItem(config, item, lastResult, 'stuck');
  await tryPersistFailedWorkItemStatus(config, item, lastResult, planWriter, runtime);

  return {
    completed: [],
    failed: [item.id],
    blocked: [],
    sessionResult: lastResult,
  };
}

async function tryPersistFailedWorkItemStatus(
  config: ConcurrentWorkExecutorConfig,
  item: WorkItemInfo,
  result: SessionResult,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<void> {
  try {
    await planWriter(() => updateWorkItemStatuses(config, [
      { id: item.id, summary: summarizeFailureResult(result) },
    ], 'failed', runtime));
  } catch (statusError) {
    config.onLog?.(
      `[ConcurrentWorkExecutor] Failed to persist failure for ${item.id}: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
    );
  }
}

async function learnFromCompletedWorkItem(
  config: ConcurrentWorkExecutorConfig,
  item: WorkItemInfo,
  result: SessionResult,
): Promise<void> {
  await learnFromTerminalWorkItem(config, item, result, 'completed');
}

async function learnFromTerminalWorkItem(
  config: ConcurrentWorkExecutorConfig,
  item: WorkItemInfo,
  result: SessionResult,
  status: 'completed' | 'blocked' | 'stuck',
): Promise<void> {
  if (!config.qualityConfig?.enableActiveMemoryLearning) {
    return;
  }

  try {
    const { learnFromSession } = await import('./quality-integration');
    await learnFromSession(
      {
        id: item.id,
        description: item.description,
        phaseName: item.phaseName ?? item.phaseId,
        filesToCreate: item.filesToCreate,
        filesToModify: item.filesToModify,
        patternFiles: item.patternFiles,
        verification: item.verification,
        dependsOn: item.dependsOn,
        hasFileMetadata: item.hasFileMetadata,
        hasDependencyMetadata: item.hasDependencyMetadata,
        hasVerificationMetadata: item.hasVerificationMetadata,
        workPackage: item.workPackage,
        upstreamTaskIds: item.upstreamTaskIds,
        upstreamSource: item.upstreamSource,
        status,
      },
      result,
      config.qualityConfig,
      config.projectDir,
      config.specDir,
    );
  } catch (error) {
    config.onLog?.(`[ConcurrentWorkExecutor] Failed to learn from ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function learnFromBlockedWorkItems(
  config: ConcurrentWorkExecutorConfig,
  blockedItems: Array<AutocodeWorkDependencyBlockedItem<WorkItemInfo>>,
  statusById: ReadonlyMap<string, string>,
): Promise<void> {
  if (!config.qualityConfig?.enableActiveMemoryLearning) {
    return;
  }

  for (const blocked of blockedItems) {
    const reason = describeAutocodeWorkDependencyBlocker(blocked, statusById);
    await learnFromTerminalWorkItem(
      config,
      blocked.item,
      createBlockedSessionResult(reason),
      'blocked',
    );
  }
}

async function executeWorkItemSession(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  attempt: number,
  sessionNumber?: number,
  runtime?: ExecutionRuntime,
): Promise<SessionResult> {
  const log = (message: string) => config.onLog?.(message);
  let accumulatedDurationMs = 0;

  while (true) {
    const sessionResult = await runWorkItemSessionSafely(config, item, attempt, sessionNumber);

    if (sessionResult.outcome === 'rate_limited') {
      accumulatedDurationMs += getSessionDurationMs(sessionResult);
      log(`[ConcurrentWorkExecutor] Work item ${item.id} rate limited, waiting for reset...`);
      const errorMessage = sessionResult.error?.message ?? 'Rate limit exceeded';
      await (runtime?.pauseCoordinator.waitForRateLimit(errorMessage) ?? waitForRateLimitResumeDirect(config, errorMessage));

      if (config.abortSignal?.aborted) {
        return createCancelledSessionResult(accumulatedDurationMs);
      }
      continue;
    }

    if (sessionResult.outcome === 'auth_failure') {
      accumulatedDurationMs += getSessionDurationMs(sessionResult);
      log(`[ConcurrentWorkExecutor] Work item ${item.id} auth failure, waiting for re-auth...`);
      const errorMessage = sessionResult.error?.message ?? 'Authentication failed';
      await (runtime?.pauseCoordinator.waitForAuth(errorMessage) ?? waitForAuthResumeDirect(config, errorMessage));

      if (config.abortSignal?.aborted) {
        return createCancelledSessionResult(accumulatedDurationMs);
      }
      continue;
    }

    if (accumulatedDurationMs <= 0) {
      return sessionResult;
    }

    return {
      ...sessionResult,
      durationMs: accumulatedDurationMs + getSessionDurationMs(sessionResult),
    };
  }
}

async function runWorkItemSessionSafely(
  config: ConcurrentWorkExecutorConfig,
  item: WorkItemInfo,
  attempt: number,
  sessionNumber?: number,
): Promise<SessionResult> {
  const startedAt = Date.now();
  try {
    return await config.runWorkItemSession(item, attempt, sessionNumber);
  } catch (error) {
    return createErrorSessionResult(error, startedAt);
  }
}

function createErrorSessionResult(error: unknown, startedAt: number): SessionResult {
  const message = error instanceof Error ? error.message : String(error);
  const outcome = classifyThrownSessionOutcome(message);
  return {
    outcome,
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    durationMs: Date.now() - startedAt,
    toolCallCount: 0,
    error: {
      code: outcome,
      message,
      retryable: outcome !== 'auth_failure',
      cause: error,
    },
  };
}

function createBlockedSessionResult(reason: string): SessionResult {
  return {
    outcome: 'error',
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [{ role: 'assistant', content: reason }],
    durationMs: 0,
    toolCallCount: 0,
    error: {
      code: 'dependency_blocked',
      message: reason,
      retryable: false,
    },
  };
}

function createCancelledSessionResult(durationMs = 0): SessionResult {
  return {
    outcome: 'cancelled',
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    durationMs,
    toolCallCount: 0,
  };
}

function isNonRetryableSessionResult(result: SessionResult): boolean {
  return result.error?.retryable === false;
}

async function collectChangedFileBaseline(projectDir: string): Promise<ChangedFileSnapshot> {
  try {
    return await collectGitChangedFileSnapshot(projectDir);
  } catch {
    return { files: new Set() };
  }
}

async function evaluateCompletedWorkItemQuality(
  config: ConcurrentWorkExecutorConfig,
  item: WorkItemInfo,
  result: SessionResult,
  attempt: number,
  baseline: ChangedFileSnapshot,
): Promise<WorkItemQualityResult> {
  const changedFiles = await collectWorkItemChangedFiles(config.projectDir, baseline, item);
  if (result.outcome !== 'completed') {
    return {
      passed: true,
      issues: [],
      changedFiles,
      selfCritique: null,
      incrementalValidation: null,
    };
  }

  const issues: string[] = [];
  let selfCritique: CritiqueResult | null = null;
  let incrementalValidation: IncrementalValidationResult | null = null;

  if (config.qualityConfig?.enableSelfCritique === true) {
    try {
      const generatedFiles = await loadGeneratedFilesForCritique(config.projectDir, changedFiles);
      if (generatedFiles.length > 0) {
        const { runSelfCritique, formatCritiqueSummary } = await import('./self-critique');
        selfCritique = await runSelfCritique({
          generatedFiles,
          subtask: item,
          projectDir: config.projectDir,
          specDir: config.specDir,
        });
        config.onLog?.(formatCritiqueSummary(selfCritique));
        if (!selfCritique.passed) {
          issues.push(`Self-critique failed: ${selfCritique.improvements.slice(0, 3).join('; ') || 'quality score below threshold'}`);
        }
      }
    } catch (error) {
      config.onLog?.(
        `[ConcurrentWorkExecutor] Self-critique failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (config.qualityConfig?.enableIncrementalValidation === true) {
    try {
      const { validateSubtaskQuality } = await import('./quality-integration');
      const validationResult = await validateSubtaskQuality(
        item,
        result,
        config.qualityConfig,
        config.projectDir,
        config.specDir,
        changedFiles,
      );
      incrementalValidation = validationResult.incrementalValidation ?? null;
      if (!validationResult.passed) {
        issues.push(...validationResult.issues);
      }
    } catch (error) {
      config.onLog?.(
        `[ConcurrentWorkExecutor] Incremental validation failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (issues.length > 0) {
    config.onLog?.(
      `[ConcurrentWorkExecutor] Quality gate requested retry for ${item.id} attempt ${attempt}: ${issues.join('; ')}`,
    );
  }

  return {
    passed: issues.length === 0,
    issues,
    changedFiles,
    selfCritique,
    incrementalValidation,
  };
}

async function collectWorkItemChangedFiles(
  projectDir: string,
  baseline: ChangedFileSnapshot,
  item: WorkItemInfo,
): Promise<string[]> {
  try {
    return await collectFilesChangedSinceBaseline(projectDir, baseline, [
      ...(item.filesToCreate ?? []),
      ...(item.filesToModify ?? []),
    ]);
  } catch {
    return [
      ...(item.filesToCreate ?? []),
      ...(item.filesToModify ?? []),
    ];
  }
}

function createQualityFailureSessionResult(issues: string[], previous: SessionResult): SessionResult {
  const message = issues.join('; ') || 'Quality validation failed';
  return {
    ...previous,
    outcome: 'error',
    error: {
      code: 'quality_validation_failed',
      message,
      retryable: true,
      cause: previous.error?.cause,
    },
    messages: [
      ...(previous.messages ?? []),
      { role: 'assistant', content: `Quality validation failed: ${message}` },
    ],
  };
}

function buildWorkItemQualityMetrics(
  result: SessionResult,
  attempt: number,
  changedFiles: string[],
  selfCritique: CritiqueResult | null,
  incrementalValidation: IncrementalValidationResult | null,
): WorkItemQualityMetrics {
  return {
    outcome: result.outcome,
    attempt,
    changed_files: changedFiles,
    files_changed: changedFiles.length,
    steps_executed: result.stepsExecuted ?? 0,
    tool_call_count: result.toolCallCount ?? 0,
    duration_ms: getSessionDurationMs(result),
    recorded_at: new Date().toISOString(),
    self_critique: selfCritique
      ? {
          status: selfCritique.passed ? 'passed' : 'failed',
          score: selfCritique.score,
          files_reviewed: selfCritique.checks.length > 0 ? changedFiles.length : 0,
          improvements: selfCritique.improvements.slice(0, 10),
        }
      : {
          status: 'skipped',
          files_reviewed: 0,
          improvements: [],
        },
    incremental_validation: incrementalValidation
      ? {
          status: incrementalValidation.passed ? 'passed' : 'failed',
          duration_ms: incrementalValidation.durationMs,
          checks_run: incrementalValidation.checks.length,
          failures: incrementalValidation.failures
            .slice(0, 10)
            .map((failure) => `${failure.type}: ${failure.message}`),
        }
      : {
          status: 'skipped',
          failures: [],
        },
  };
}

async function recordWorkItemQualityMetricsSafely(
  config: ConcurrentWorkExecutorConfig,
  workItemId: string,
  metrics: WorkItemQualityMetrics,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
  runtime: ExecutionRuntime,
): Promise<void> {
  if (!config.qualityConfig) {
    return;
  }

  try {
    await planWriter(() => recordWorkItemQualityMetrics(config, workItemId, metrics, runtime));
  } catch (error) {
    config.onLog?.(
      `[ConcurrentWorkExecutor] Failed to record quality metrics for ${workItemId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function recordWorkItemQualityMetrics(
  config: ConcurrentWorkExecutorConfig,
  workItemId: string,
  metrics: WorkItemQualityMetrics,
  runtime: ExecutionRuntime,
): Promise<void> {
  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (subtask.id !== workItemId) {
          continue;
        }
        subtask.ai_coding_quality = metrics;
        subtask.updated_at = metrics.recorded_at;
        updated = true;
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
  }
}

async function recordWorkItemSessionDuration(
  config: ConcurrentWorkExecutorConfig,
  workItemId: string,
  result: SessionResult,
  runtime: ExecutionRuntime,
): Promise<void> {
  const durationMs = getSessionDurationMs(result);
  if (durationMs <= 0) {
    return;
  }

  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (subtask.id !== workItemId) {
          continue;
        }
        subtask.duration_ms = getExistingDurationMs(subtask) + durationMs;
        subtask.updated_at = new Date().toISOString();
        updated = true;
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
  }
}

function getSessionDurationMs(result: SessionResult): number {
  return typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) && result.durationMs > 0
    ? Math.round(result.durationMs)
    : 0;
}

function getExistingDurationMs(subtask: PlanSubtask): number {
  const value = subtask.duration_ms;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function classifyThrownSessionOutcome(message: string): SessionResult['outcome'] {
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return 'auth_failure';
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'rate_limited';
  }
  return 'error';
}

async function loadImplementationPlan(specDir: string): Promise<ImplementationPlan | null> {
  return loadImplementationPlanFromFiles(specDir) as Promise<ImplementationPlan | null>;
}

function createPlanWriter(): <T>(write: PlanWrite<T>) => Promise<T> {
  let queue = Promise.resolve();
  return async <T>(write: PlanWrite<T>): Promise<T> => {
    const next = queue.then(write, write);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
}

function createSourceSyncCoordinator(config: ConcurrentWorkExecutorConfig): SourceSyncCoordinator {
  let dirty = false;
  let flushing: Promise<void> | null = null;

  return {
    async request() {
      if (!config.sourceSpecDir || config.sourceSpecDir === config.specDir) {
        return;
      }
      dirty = true;
    },
    async flush() {
      if (!dirty || flushing) {
        await flushing;
        return;
      }

      dirty = false;
      flushing = syncWorkItemPlanToSourceNow(config).finally(() => {
        flushing = null;
      });
      await flushing;
    },
  };
}

function createPauseCoordinator(config: ConcurrentWorkExecutorConfig): PauseCoordinator {
  let rateLimitWait: Promise<void> | null = null;
  let authWait: Promise<void> | null = null;
  let pressure: 'rate_limited' | 'auth_failure' | null = null;

  return {
    async waitForRateLimit(errorMessage: string) {
      pressure = 'rate_limited';
      if (!rateLimitWait) {
        rateLimitWait = waitForRateLimitResumeDirect(config, errorMessage).finally(() => {
          rateLimitWait = null;
        });
      }
      await rateLimitWait;
    },
    async waitForAuth(errorMessage: string) {
      pressure = 'auth_failure';
      if (!authWait) {
        authWait = waitForAuthResumeDirect(config, errorMessage).finally(() => {
          authWait = null;
        });
      }
      await authWait;
    },
    consumePressure() {
      const value = pressure;
      pressure = null;
      return value;
    },
  };
}

async function waitForRateLimitResumeDirect(
  config: ConcurrentWorkExecutorConfig,
  errorMessage: string,
): Promise<void> {
  writeRateLimitPauseFile(config.specDir, errorMessage, null);
  await waitForRateLimitResume(
    config.specDir,
    MAX_RATE_LIMIT_WAIT_MS,
    config.sourceSpecDir,
    config.abortSignal,
  );
}

async function waitForAuthResumeDirect(
  config: ConcurrentWorkExecutorConfig,
  errorMessage: string,
): Promise<void> {
  writeAuthPauseFile(config.specDir, errorMessage);
  await waitForAuthResume(config.specDir, config.sourceSpecDir, config.abortSignal);
}

function createAdaptiveConcurrency(maxWorkers: number, log: (message: string) => void) {
  return createAutocodeAdaptiveConcurrency<SessionResult>(maxWorkers, log);
}

function partitionHighRiskUnscopedWorkItems(workItems: WorkItemInfo[]): {
  scopedItems: WorkItemInfo[];
  highRiskUnscopedItems: WorkItemInfo[];
} {
  return partitionAutocodeHighRiskUnscopedWorkItems(workItems);
}

function shouldSerializeHighRiskUnscopedWorkItem(workItem: WorkItemInfo): boolean {
  return shouldSerializeAutocodeHighRiskUnscopedWorkItem(workItem);
}

async function resetRoundInProgressWorkItems(
  config: ConcurrentWorkExecutorConfig,
  runtime: ExecutionRuntime,
  log?: (message: string) => void,
): Promise<void> {
  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (subtask.status === 'in_progress') {
          subtask.status = 'pending';
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
    log?.('[ConcurrentWorkExecutor] Reset stale in_progress work items to pending before scheduling');
  }
}

async function markWorkItemsInProgress(
  config: ConcurrentWorkExecutorConfig,
  workItemIds: string[],
  runtime: ExecutionRuntime,
): Promise<void> {
  if (workItemIds.length === 0) {
    return;
  }

  const activeIds = new Set(workItemIds);
  const now = new Date().toISOString();
  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (activeIds.has(subtask.id) && subtask.status !== 'in_progress') {
          subtask.status = 'in_progress';
          subtask.started_at = subtask.started_at || now;
          subtask.completed_at = undefined;
          subtask.updated_at = now;
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
  }
}

async function resetCancelledInProgressWorkItems(
  config: ConcurrentWorkExecutorConfig,
  workItemIds: string[],
  runtime: ExecutionRuntime,
): Promise<void> {
  if (workItemIds.length === 0) {
    return;
  }

  const cancelledIds = new Set(workItemIds);
  const now = new Date().toISOString();
  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (cancelledIds.has(subtask.id) && subtask.status === 'in_progress') {
          subtask.status = 'pending';
          subtask.updated_at = now;
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
  }
}

async function syncWorkItemPlanToSourceNow(config: ConcurrentWorkExecutorConfig): Promise<void> {
  if (!config.sourceSpecDir || config.sourceSpecDir === config.specDir) {
    return;
  }

  try {
    const worktreePlan = await loadImplementationPlan(config.specDir);
    if (!worktreePlan?.phases) {
      return;
    }

    const now = new Date().toISOString();
    await updateImplementationPlanInFiles(config.sourceSpecDir, (mainPlan) => {
      mainPlan.phases = worktreePlan.phases as never;
      if (typeof worktreePlan.executionPhase === 'string') {
        mainPlan.executionPhase = worktreePlan.executionPhase;
      }
      mainPlan.updated_at = now;
      return mainPlan;
    });
  } catch (error) {
    config.onLog?.(
      `[ConcurrentWorkExecutor] Failed to sync work item state to source spec: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function updateWorkItemStatuses(
  config: ConcurrentWorkExecutorConfig,
  updates: Array<{ id: string; summary?: string }>,
  status: 'completed' | 'failed' | 'blocked',
  runtime: ExecutionRuntime,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const targetIds = new Set(updates.map((update) => update.id));
  const summaries = new Map(updates.map((update) => [update.id, update.summary]));
  const now = new Date().toISOString();
  let updated = false;
  await updateImplementationPlanInFiles(config.specDir, (plan) => {
    for (const phase of (plan as unknown as ImplementationPlan).phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (!targetIds.has(subtask.id)) {
          continue;
        }
        if (subtask.status !== status) {
          subtask.status = status;
          updated = true;
        }
        if (status === 'completed' && !subtask.completed_at) {
          subtask.completed_at = now;
          updated = true;
        } else if (status !== 'completed' && subtask.completed_at) {
          subtask.completed_at = undefined;
          updated = true;
        }
        subtask.updated_at = now;
        const summary = summaries.get(subtask.id);
        if (status === 'completed' && summary && !subtask.completion_summary) {
          subtask.completion_summary = summary;
          if (!subtask.notes) {
            subtask.notes = summary;
          }
          updated = true;
        } else if (summary && status !== 'completed') {
          subtask.notes = summary;
          updated = true;
        }
        if (status !== 'completed' && subtask.completion_summary) {
          subtask.completion_summary = undefined;
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await runtime.sourceSync.request();
  }
}

async function markDependencyBlockedWorkItems(
  config: ConcurrentWorkExecutorConfig,
  blockedItems: Array<AutocodeWorkDependencyBlockedItem<WorkItemInfo>>,
  statusById: ReadonlyMap<string, string>,
  runtime: ExecutionRuntime,
): Promise<void> {
  await updateWorkItemStatuses(
    config,
    blockedItems.map((blocked) => ({
      id: blocked.item.id,
      summary: describeAutocodeWorkDependencyBlocker(blocked, statusById),
    })),
    'blocked',
    runtime,
  );
}

function getPendingWorkItems(plan: ImplementationPlan): WorkItemInfo[] {
  const items: WorkItemInfo[] = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (isRetryableWorkItemStatus(subtask.status)) {
        items.push({
          id: subtask.id,
          phaseId: phase.id ?? phase.name,
          phaseName: phase.name,
          description: subtask.description,
          filesToCreate: subtask.files_to_create,
          filesToModify: subtask.files_to_modify,
          patternFiles: subtask.pattern_files,
          dependsOn: normalizeAutocodeWorkDependencyIds(subtask.depends_on),
          verification: stringifyVerification(subtask.verification),
          hasFileMetadata: hasDeclaredFileMetadata(subtask),
          hasDependencyMetadata: hasDeclaredField(subtask, 'depends_on'),
          hasVerificationMetadata: hasDeclaredField(subtask, 'verification'),
          workPackage: subtask.work_package === true,
          upstreamTaskIds: Array.isArray(subtask.upstream_task_ids)
            ? subtask.upstream_task_ids.filter((value): value is string => typeof value === 'string')
            : [],
          upstreamSource: typeof subtask.upstream_source === 'string' ? subtask.upstream_source : undefined,
          status: subtask.status as WorkItemInfo['status'],
        });
      }
    }
  }

  return items;
}

function isRetryableWorkItemStatus(status: string): boolean {
  return status === 'pending' ||
    status === 'in_progress' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'stuck';
}

function getTerminalIncompleteWorkItems(plan: ImplementationPlan): Array<{ id: string; status: string }> {
  const items: Array<{ id: string; status: string }> = [];
  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (subtask.status === 'failed' || subtask.status === 'blocked') {
        items.push({ id: subtask.id, status: subtask.status });
      }
    }
  }
  return items;
}

function summarizeTerminalIncompleteWorkItems(items: Array<{ id: string; status: string }>): string {
  const visible = items.slice(0, 12).map((item) => `${item.id} (${item.status})`);
  const remaining = items.length - visible.length;
  return remaining > 0
    ? `${visible.join(', ')}, and ${remaining} more`
    : visible.join(', ');
}

function hasInProgressWorkItems(plan: ImplementationPlan): boolean {
  return plan.phases.some((phase) =>
    phase.subtasks.some((subtask) => subtask.status === 'in_progress'),
  );
}

function hasDeclaredField(value: object, field: string): boolean {
  return Object.hasOwn(value, field);
}

function hasDeclaredFileMetadata(subtask: PlanSubtask): boolean {
  return hasDeclaredField(subtask, 'files_to_create') ||
    hasDeclaredField(subtask, 'files_to_modify') ||
    hasDeclaredField(subtask, 'pattern_files');
}

function getWorkItemStatusMap(plan: ImplementationPlan): Map<string, string> {
  return buildAutocodeWorkDependencyStatusMap(
    plan.phases.flatMap((phase) => phase.subtasks.map((subtask) => ({
      id: subtask.id,
      status: subtask.status,
      dependsOn: normalizeAutocodeWorkDependencyIds(subtask.depends_on),
    }))),
  );
}

async function runWithConcurrency<T>(
  items: WorkItemInfo[],
  concurrency: number,
  worker: (item: WorkItemInfo) => Promise<T>,
  shouldContinue: () => boolean = () => true,
): Promise<T[]> {
  const results: T[] = [];
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (!shouldContinue()) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      if (!shouldContinue()) {
        return;
      }
      results.push(await worker(items[currentIndex]));
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function summarizeWorkItemResults(results: WorkItemResult[]): WorkItemResult {
  return summarizeAutocodeWorkItemResults(results, { outcome: 'completed' } as SessionResult);
}

function summarizeFailureResult(result: SessionResult): string {
  const reason = result.error?.message
    ?? `Session ended with outcome: ${result.outcome}`;
  const verification = [
    `Session outcome: ${result.outcome}`,
    `Steps: ${result.stepsExecuted ?? 0}`,
    `Tools: ${result.toolCallCount ?? 0}`,
  ].join('. ');

  return [
    '| Item | Details |',
    '| --- | --- |',
    `| Failure | ${escapeMarkdownTableCell(reason)} |`,
    `| Verification | ${escapeMarkdownTableCell(verification)} |`,
    '| Review notes | Retry this work item after reviewing runtime output and git diff. |',
  ].join('\n');
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function stringifyVerification(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => stringifyVerification(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join('; ') : undefined;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = [record.type, record.run, record.command, record.scenario]
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return entries.length > 0 ? entries.join(': ') : undefined;
  }

  return String(value);
}
