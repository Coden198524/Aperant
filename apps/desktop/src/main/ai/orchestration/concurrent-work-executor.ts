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
  saveImplementationPlanToFiles,
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
  files_to_create?: string[];
  files_to_modify?: string[];
  pattern_files?: string[];
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

    await planWriter(() => resetRoundInProgressWorkItems(config.specDir, plan, log));

    const pendingItems = getPendingWorkItems(plan);
    if (pendingItems.length === 0) {
      log('[ConcurrentWorkExecutor] No more pending work items');
      break;
    }

    const { independent, sequential } = detectFileConflicts(pendingItems);
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
  await planWriter(() => markWorkItemsInProgress(config.specDir, items.map((item) => item.id)));

  const results = await runWithConcurrency(
    items,
    workers,
    async (item) => executeWorkItemWithRetries(item, config, planWriter),
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
    await planWriter(() => markWorkItemsInProgress(config.specDir, [item.id]));
    results.push(await executeWorkItemWithRetries(item, config, planWriter));
  }
  return summarizeWorkItemResults(results);
}

async function executeWorkItemWithRetries(
  item: WorkItemInfo,
  config: ConcurrentWorkExecutorConfig,
  planWriter: <T>(write: PlanWrite<T>) => Promise<T>,
): Promise<WorkItemResult> {
  const log = (message: string) => config.onLog?.(message);
  let lastResult: SessionResult = { outcome: 'error' } as SessionResult;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
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

    if (sessionResult.outcome === 'cancelled' || config.abortSignal?.aborted) {
      return {
        completed: [],
        failed: [item.id],
        blocked: [],
        sessionResult,
      };
    }

    if (sessionResult.outcome === 'completed') {
      await planWriter(() => updateWorkItemStatuses(config.specDir, [
        { id: item.id, summary: summarizeSessionResult(sessionResult) },
      ], 'completed'));
      return {
        completed: [item.id],
        failed: [],
        blocked: [],
        sessionResult,
      };
    }

    if (attempt < config.maxRetries) {
      log(`[ConcurrentWorkExecutor] Retrying ${item.id} after outcome ${sessionResult.outcome}`);
    }
  }

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
    const sessionResult = await config.runWorkItemSession(item, attempt, sessionNumber);

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
  specDir: string,
  plan: ImplementationPlan,
  log?: (message: string) => void,
): Promise<void> {
  let updated = false;

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (subtask.status === 'in_progress') {
        subtask.status = 'pending';
        updated = true;
      }
    }
  }

  if (!updated) {
    return;
  }

  await saveImplementationPlanToFiles(specDir, plan as never);
  log?.('[ConcurrentWorkExecutor] Reset stale in_progress work items to pending before scheduling');
}

async function markWorkItemsInProgress(
  specDir: string,
  workItemIds: string[],
): Promise<void> {
  if (workItemIds.length === 0) {
    return;
  }

  const activeIds = new Set(workItemIds);
  const plan = await loadImplementationPlan(specDir);
  if (!plan) return;

  let updated = false;
  for (const phase of plan.phases ?? []) {
    for (const subtask of phase.subtasks ?? []) {
      if (activeIds.has(subtask.id) && subtask.status !== 'in_progress') {
        subtask.status = 'in_progress';
        updated = true;
      }
    }
  }

  if (updated) {
    await saveImplementationPlanToFiles(specDir, plan as never);
  }
}

async function updateWorkItemStatuses(
  specDir: string,
  updates: Array<{ id: string; summary?: string }>,
  status: 'completed',
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const targetIds = new Set(updates.map((update) => update.id));
  const summaries = new Map(updates.map((update) => [update.id, update.summary]));
  const plan = await loadImplementationPlan(specDir);
  if (!plan) return;

  let updated = false;
  for (const phase of plan.phases ?? []) {
    for (const subtask of phase.subtasks ?? []) {
      if (!targetIds.has(subtask.id)) {
        continue;
      }
      if (subtask.status !== status) {
        subtask.status = status;
        updated = true;
      }
      const summary = summaries.get(subtask.id);
      if (summary && !subtask.completion_summary) {
        subtask.completion_summary = summary;
        if (!subtask.notes) {
          subtask.notes = summary;
        }
        updated = true;
      }
    }
  }

  if (updated) {
    await saveImplementationPlanToFiles(specDir, plan as never);
  }
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

async function runWithConcurrency<T>(
  items: WorkItemInfo[],
  concurrency: number,
  worker: (item: WorkItemInfo) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]);
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
