/**
 * Concurrent Work Executor
 * ========================
 *
 * Executes implementation plan work items with a shared concurrency flow.
 * OpenSpec work packages and Standard subtasks are both treated as work items.
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
  detectFileConflicts,
  groupConflictingWorkItems,
} from './conflict-detector';
import {
  writeAuthPauseFile,
  writeRateLimitPauseFile,
  waitForAuthResume,
  waitForRateLimitResume,
} from './pause-handler';
import { iterateSubtasks } from './subtask-iterator';
import type { SubtaskIteratorConfig } from './subtask-iterator';
import {
  loadImplementationPlanFromFiles,
  updateImplementationPlanInFiles,
} from '../schema/plan-shards';

const MAX_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const FALLBACK_FAILURE_THRESHOLD = 3;

export interface ConcurrentWorkExecutorConfig {
  specDir: string;
  projectDir: string;
  sourceSpecDir?: string;
  maxRetries: number;
  workers: number;
  abortSignal?: AbortSignal;
  onGroupStart?: (items: WorkItemInfo[], groupNum: number, totalGroups: number, mode: 'concurrent' | 'serial') => void;
  onWorkItemStart?: (item: WorkItemInfo, attempt: number) => number | void;
  runWorkItemSession: (item: WorkItemInfo, attempt: number, sessionNumber?: number) => Promise<SessionResult>;
  onWorkItemSessionComplete?: (item: WorkItemInfo, result: SessionResult) => void;
  onGroupComplete?: (items: WorkItemInfo[], result: WorkItemResult) => void;
  onLog?: (message: string) => void;
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
  updated_at?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  pattern_files?: string[];
  depends_on?: unknown;
  verification?: unknown;
  work_package?: boolean;
  upstream_task_ids?: unknown;
  upstream_source?: unknown;
}

type PlanWrite<T> = () => Promise<T>;

export async function executeConcurrentWorkItems(
  config: ConcurrentWorkExecutorConfig,
): Promise<WorkExecutorResult> {
  const log = (message: string) => config.onLog?.(message);
  const planWriter = createPlanWriter();
  const workers = Math.max(1, Math.floor(config.workers || 1));
  let totalCompleted = 0;
  let totalFailed = 0;
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

    await planWriter(() => resetRoundInProgressWorkItems(config, log));

    const pendingItems = getPendingWorkItems(plan);
    if (pendingItems.length === 0) {
      log('[ConcurrentWorkExecutor] No more pending work items');
      break;
    }

    const statusById = getWorkItemStatusMap(plan);
    const dependencyAnalysis = analyzeAutocodeWorkDependencies(pendingItems, { statusById });
    const runnableItems = dependencyAnalysis.runnable;
    if (runnableItems.length === 0) {
      const blockedSummary = describeAutocodeWorkDependencyBlockers(dependencyAnalysis.blocked, statusById);
      await planWriter(() => markDependencyBlockedWorkItems(config, dependencyAnalysis.blocked, statusById));
      log(`[ConcurrentWorkExecutor] No runnable work items because dependencies are unresolved: ${blockedSummary}`);
      return {
        success: false,
        totalCompleted,
        totalFailed: pendingItems.length,
        error: `No runnable work items because dependencies are unresolved: ${blockedSummary}`,
      };
    }

    const { independent, sequential } = detectFileConflicts(runnableItems);
    const independentItems = independent.flat();
    const conflictGroups = groupConflictingWorkItems(sequential);
    log(
      `[ConcurrentWorkExecutor] Conflict analysis: ${independentItems.length} independent, ${sequential.length} conflict-locked`,
    );

    const groups: Array<{ mode: 'concurrent' | 'serial'; items: WorkItemInfo[] }> = [
      ...(independentItems.length > 0 ? [{ mode: 'concurrent' as const, items: independentItems }] : []),
      ...conflictGroups.map((items) => ({ mode: 'serial' as const, items })),
    ];
    log(`[ConcurrentWorkExecutor] Prepared ${groups.length} work group(s), workers=${workers}`);

    let roundCompleted = 0;
    let roundFailed = 0;
    let consecutiveFailures = 0;

    for (let i = 0; i < groups.length; i++) {
      if (config.abortSignal?.aborted) {
        return { success: false, totalCompleted: totalCompleted + roundCompleted, cancelled: true };
      }

      const group = groups[i];
      config.onGroupStart?.(group.items, i + 1, groups.length, group.mode);

      const result = group.mode === 'serial'
        ? await executeSerialGroup(group.items, config, planWriter)
        : await executeConcurrentGroup(group.items, workers, config, planWriter);

      config.onGroupComplete?.(group.items, result);

      if (config.abortSignal?.aborted || result.sessionResult.outcome === 'cancelled') {
        return {
          success: false,
          totalCompleted: totalCompleted + roundCompleted + result.completed.length,
          cancelled: true,
        };
      }

      roundCompleted += result.completed.length;
      roundFailed += result.failed.length;

      if (result.failed.length > 0) {
        consecutiveFailures++;
        log(
          `[ConcurrentWorkExecutor] Work group ${i + 1} had ${result.failed.length} failure(s) (consecutive: ${consecutiveFailures})`,
        );
        if (consecutiveFailures >= FALLBACK_FAILURE_THRESHOLD) {
          log('[ConcurrentWorkExecutor] Failure threshold reached, switching to serial iterator');
          return fallbackToSerial(config);
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
      log('[ConcurrentWorkExecutor] Stopping due to failures');
      break;
    }
  }

  const success = totalFailed === 0;
  log(
    `[ConcurrentWorkExecutor] All rounds completed: ${totalCompleted} total completed, ${totalFailed} total failed`,
  );

  return { success, totalCompleted, totalFailed };
}

async function executeConcurrentGroup(
  items: WorkItemInfo[],
  workers: number,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
): Promise<WorkItemResult> {
  let cancelled = false;
  const results = await runWithConcurrency(
    items,
    workers,
    async (item) => {
      await planWriter(() => markWorkItemsInProgress(config, [item.id]));
      const result = await executeWorkItemIsolated(item, config, planWriter);
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
    await planWriter(() => markWorkItemsInProgress(config, [item.id]));
    results.push(await executeWorkItemIsolated(item, config, planWriter));
  }
  return summarizeWorkItemResults(results);
}

async function executeWorkItemIsolated(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
): Promise<WorkItemResult> {
  try {
    return await executeWorkItemWithRetries(item, config, planWriter);
  } catch (error) {
    const sessionResult = createErrorSessionResult(error, Date.now());
    config.onLog?.(
      `[ConcurrentWorkExecutor] Work item ${item.id} failed outside session: ${sessionResult.error?.message ?? sessionResult.outcome}`,
    );

    try {
      await planWriter(() => updateWorkItemStatuses(config, [
        { id: item.id, summary: summarizeFailureResult(sessionResult) },
      ], 'failed'));
    } catch (statusError) {
      config.onLog?.(
        `[ConcurrentWorkExecutor] Failed to persist failure for ${item.id}: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
    }

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

    const sessionResult = await executeWorkItemSession(
      item,
      config,
      attemptNumber,
      typeof sessionNumber === 'number' ? sessionNumber : undefined,
    );
    config.onWorkItemSessionComplete?.(item, sessionResult);
    lastResult = sessionResult;

    if (sessionResult.outcome === 'cancelled') {
      return {
        completed: [],
        failed: [item.id],
        blocked: [],
        sessionResult,
      };
    }

    if (sessionResult.outcome === 'completed') {
      await planWriter(() => updateWorkItemStatuses(config, [
        { id: item.id, summary: summarizeSessionResult(sessionResult) },
      ], 'completed'));
      return {
        completed: [item.id],
        failed: [],
        blocked: [],
        sessionResult,
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

    if (attempt < config.maxRetries) {
      log(`[ConcurrentWorkExecutor] Retrying ${item.id} after outcome ${sessionResult.outcome}`);
    }
  }

  await planWriter(() => updateWorkItemStatuses(config, [
    { id: item.id, summary: summarizeFailureResult(lastResult) },
  ], 'failed'));

  return {
    completed: [],
    failed: [item.id],
    blocked: [],
    sessionResult: lastResult,
  };
}

async function fallbackToSerial(
  config: ConcurrentWorkExecutorConfig,
): Promise<WorkExecutorResult> {
  const log = (message: string) => config.onLog?.(message);
  log('[ConcurrentWorkExecutor] Falling back to serial mode');

  const serialConfig: SubtaskIteratorConfig = {
    specDir: config.specDir,
    projectDir: config.projectDir,
    sourceSpecDir: config.sourceSpecDir,
    maxRetries: config.maxRetries,
    autoContinueDelayMs: 500,
    abortSignal: config.abortSignal,
    runSubtaskSession: async (subtask, attempt) => config.runWorkItemSession({
      id: subtask.id,
      phaseId: subtask.phaseName,
      description: subtask.description,
      filesToCreate: subtask.filesToCreate,
      filesToModify: subtask.filesToModify,
      patternFiles: subtask.patternFiles,
      dependsOn: subtask.dependsOn,
      verification: subtask.verification,
      workPackage: subtask.workPackage,
      upstreamTaskIds: subtask.upstreamTaskIds,
      upstreamSource: subtask.upstreamSource,
      status: 'in_progress',
    }, attempt),
  };

  const result = await iterateSubtasks(serialConfig);

  return {
    success: result.completedSubtasks === result.totalSubtasks,
    totalCompleted: result.completedSubtasks,
    totalFailed: result.totalSubtasks - result.completedSubtasks,
    cancelled: result.cancelled,
  };
}

async function executeWorkItemSession(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  attempt: number,
  sessionNumber?: number,
): Promise<SessionResult> {
  const log = (message: string) => config.onLog?.(message);

  while (true) {
    const sessionResult = await runWorkItemSessionSafely(config, item, attempt, sessionNumber);

    if (sessionResult.outcome === 'rate_limited') {
      log(`[ConcurrentWorkExecutor] Work item ${item.id} rate limited, waiting for reset...`);
      const errorMessage = sessionResult.error?.message ?? 'Rate limit exceeded';
      writeRateLimitPauseFile(config.specDir, errorMessage, null);

      await waitForRateLimitResume(
        config.specDir,
        MAX_RATE_LIMIT_WAIT_MS,
        config.sourceSpecDir,
        config.abortSignal,
      );

      if (config.abortSignal?.aborted) {
        return { outcome: 'cancelled' } as SessionResult;
      }
      continue;
    }

    if (sessionResult.outcome === 'auth_failure') {
      log(`[ConcurrentWorkExecutor] Work item ${item.id} auth failure, waiting for re-auth...`);
      const errorMessage = sessionResult.error?.message ?? 'Authentication failed';
      writeAuthPauseFile(config.specDir, errorMessage);

      await waitForAuthResume(config.specDir, config.sourceSpecDir, config.abortSignal);

      if (config.abortSignal?.aborted) {
        return { outcome: 'cancelled' } as SessionResult;
      }
      continue;
    }

    return sessionResult;
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

async function resetRoundInProgressWorkItems(
  config: ConcurrentWorkExecutorConfig,
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
    await syncWorkItemPlanToSource(config);
    log?.('[ConcurrentWorkExecutor] Reset stale in_progress work items to pending before scheduling');
  }
}

async function markWorkItemsInProgress(
  config: ConcurrentWorkExecutorConfig,
  workItemIds: string[],
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
          subtask.updated_at = now;
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await syncWorkItemPlanToSource(config);
  }
}

async function syncWorkItemPlanToSource(config: ConcurrentWorkExecutorConfig): Promise<void> {
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
        }
        subtask.updated_at = now;
        const summary = summaries.get(subtask.id);
        if (summary && !subtask.completion_summary) {
          subtask.completion_summary = summary;
          if (!subtask.notes) {
            subtask.notes = summary;
          }
          updated = true;
        } else if (summary && status !== 'completed' && !subtask.notes) {
          subtask.notes = summary;
          updated = true;
        }
      }
    }
    return updated ? plan : false;
  });
  if (updated) {
    await syncWorkItemPlanToSource(config);
  }
}

async function markDependencyBlockedWorkItems(
  config: ConcurrentWorkExecutorConfig,
  blockedItems: Array<AutocodeWorkDependencyBlockedItem<WorkItemInfo>>,
  statusById: ReadonlyMap<string, string>,
): Promise<void> {
  await updateWorkItemStatuses(
    config,
    blockedItems.map((blocked) => ({
      id: blocked.item.id,
      summary: describeAutocodeWorkDependencyBlocker(blocked, statusById),
    })),
    'blocked',
  );
}

function getPendingWorkItems(plan: ImplementationPlan): WorkItemInfo[] {
  const items: WorkItemInfo[] = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (subtask.status === 'pending' || subtask.status === 'in_progress') {
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
          workPackage: subtask.work_package === true,
          upstreamTaskIds: Array.isArray(subtask.upstream_task_ids)
            ? subtask.upstream_task_ids.filter((value): value is string => typeof value === 'string')
            : [],
          upstreamSource: typeof subtask.upstream_source === 'string' ? subtask.upstream_source : undefined,
          status: subtask.status as 'pending' | 'in_progress',
        });
      }
    }
  }

  return items;
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
  const completed = results.flatMap((result) => result.completed);
  const failed = results.flatMap((result) => result.failed);
  const blocked = results.flatMap((result) => result.blocked);
  const sessionResult = results.find((result) => result.sessionResult.outcome !== 'completed')?.sessionResult
    ?? results[0]?.sessionResult
    ?? ({ outcome: 'completed' } as SessionResult);

  return { completed, failed, blocked, sessionResult };
}

function summarizeSessionResult(result: SessionResult): string | undefined {
  const content = [...(result.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())?.content;
  if (!content) {
    return undefined;
  }

  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#*_>\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return undefined;
  }

  const maxLength = 3000;
  const compacted = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;

  return formatCompletionSummaryTable(compacted, result);
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

function formatCompletionSummaryTable(summary: string, result: SessionResult): string {
  const verification = [
    `Session outcome: ${result.outcome}`,
    `Steps: ${result.stepsExecuted ?? 0}`,
    `Tools: ${result.toolCallCount ?? 0}`,
  ].join('. ');

  return [
    '| Item | Details |',
    '| --- | --- |',
    `| What changed | ${escapeMarkdownTableCell(summary)} |`,
    `| Verification | ${escapeMarkdownTableCell(verification)} |`,
    '| Review notes | Review changed files, runtime output, and git diff before approval. |',
  ].join('\n');
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
