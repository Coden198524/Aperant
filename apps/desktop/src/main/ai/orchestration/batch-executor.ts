/**
 * Batch Executor
 * ==============
 *
 * Executes multiple subtasks in batch sessions with progress tracking,
 * error recovery, and fallback to serial execution.
 */

import type {
  BatchExecutorResult,
  BatchResult,
  SubtaskInfo,
  ExecutionMode,
} from './batch-types';
import { DEFAULT_BATCH_CONFIG } from './batch-types';
import type { SessionResult } from '../session/types';
import {
  detectFileConflicts,
  groupConflictingSubtasks,
  calculateOptimalBatchSize,
  chunkSubtasks,
} from './conflict-detector';
import { createBatchProgressTracker } from './batch-progress-tracker';
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

// =============================================================================
// Constants
// =============================================================================

/** Default context window limit (tokens) */
const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Maximum rate limit wait time (ms) */
const MAX_RATE_LIMIT_WAIT_MS = 30 * 60 * 1000; // 30 minutes

// =============================================================================
// Types
// =============================================================================

/** Configuration for batch executor */
export interface BatchExecutorConfig {
  /** Spec directory */
  specDir: string;
  /** Project directory */
  projectDir: string;
  /** Source spec directory (worktree mode) */
  sourceSpecDir?: string;
  /** Maximum retries per batch */
  maxRetries: number;
  /** Batch size (number or 'auto') */
  batchSize: number | 'auto';
  /** Execution mode */
  executionMode: ExecutionMode;
  /** Legacy setting reused as a cap on subtasks per batch */
  maxConcurrentSubtasks?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /** Context window limit */
  contextLimit?: number;

  /** Callback: batch start */
  onBatchStart?: (batch: SubtaskInfo[], batchNum: number, totalBatches?: number) => void;
  /** Callback: run a single batch session */
  runBatchSession?: (batch: SubtaskInfo[], attempt: number) => Promise<SessionResult>;
  /** Callback: run a single subtask session */
  runSubtaskSession: (subtask: SubtaskInfo, attempt: number) => Promise<SessionResult>;
  /** Callback: batch session complete */
  onBatchSessionComplete?: (batch: SubtaskInfo[], result: SessionResult) => void;
  /** Callback: subtask session complete */
  onSubtaskSessionComplete?: (subtask: SubtaskInfo, result: SessionResult) => void;
  /** Callback: batch complete */
  onBatchComplete?: (batch: SubtaskInfo[], result: BatchResult) => void;
  /** Callback: log message */
  onLog?: (message: string) => void;
}

// =============================================================================
// Implementation Plan Types
// =============================================================================

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
  verification?: string;
}

// =============================================================================
// Main Executor
// =============================================================================

/**
 * Executes subtasks in batches.
 *
 * @param config - Batch executor configuration
 * @returns Batch executor result
 */
export async function executeBatches(
  config: BatchExecutorConfig
): Promise<BatchExecutorResult> {
  const log = (msg: string) => config.onLog?.(msg);

  let totalCompleted = 0;
  let totalFailed = 0;
  let roundNumber = 0;

  // Loop until no more pending subtasks
  while (true) {
    roundNumber++;
    log(`[BatchExecutor] Round ${roundNumber}`);

    // Load implementation plan
    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return {
        success: false,
        totalCompleted,
        error: 'Failed to load implementation plan',
      };
    }

    await resetRoundInProgressSubtasks(config.specDir, plan, log);

    // Get pending subtasks
    const pendingSubtasks = getPendingSubtasks(plan);
    if (pendingSubtasks.length === 0) {
      log('[BatchExecutor] No more pending subtasks');
      break;
    }

    log(`[BatchExecutor] Found ${pendingSubtasks.length} pending subtasks`);

    // Detect file conflicts
    const { independent, sequential } = detectFileConflicts(pendingSubtasks);
    log(
      `[BatchExecutor] Conflict analysis: ${independent.flat().length} independent, ${sequential.length} sequential`
    );

    // Calculate batch size
    const contextLimit = config.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const requestedBatchSize =
      config.batchSize === 'auto'
        ? calculateOptimalBatchSize(
            pendingSubtasks,
            contextLimit,
            DEFAULT_BATCH_CONFIG.contextManagement.maxBatchTokens,
            DEFAULT_BATCH_CONFIG.contextManagement.safetyMargin
          )
        : config.batchSize;
    // When using runBatchSession (batch processing), don't limit by maxConcurrentSubtasks
    // maxConcurrentSubtasks only applies to parallel execution mode
    const batchSize = Math.max(
      1,
      config.runBatchSession ? requestedBatchSize : Math.min(requestedBatchSize, config.maxConcurrentSubtasks ?? requestedBatchSize),
    );

    log(`[BatchExecutor] Batch size: ${batchSize}`);

    const independentBatches = independent.flatMap((group) => chunkSubtasks(group, batchSize));
    const conflictingBatches = groupConflictingSubtasks(sequential).flatMap((group) =>
      group.length > batchSize ? chunkSubtasks(group, batchSize) : [group],
    );
    const allBatches = [...independentBatches, ...conflictingBatches];

    log(
      `[BatchExecutor] Prepared ${allBatches.length} batch session(s): ${independentBatches.length} independent, ${conflictingBatches.length} conflict-aware`
    );

    // Execute all batches
    let roundCompleted = 0;
    let roundFailed = 0;
    let consecutiveFailures = 0;

    for (let i = 0; i < allBatches.length; i++) {
      const batch = allBatches[i];

      // Check cancellation
      if (config.abortSignal?.aborted) {
        return { success: false, totalCompleted: totalCompleted + roundCompleted, cancelled: true };
      }

      config.onBatchStart?.(batch, i + 1, allBatches.length);

      const result = await executeSingleBatch(batch, config, 0);

      config.onBatchComplete?.(batch, result);

      roundCompleted += result.completed.length;
      roundFailed += result.failed.length;

      if (result.failed.length > 0) {
        consecutiveFailures++;
        log(
          `[BatchExecutor] Batch ${i + 1} had ${result.failed.length} failures (consecutive: ${consecutiveFailures})`
        );

        // Check fallback condition
        if (
          DEFAULT_BATCH_CONFIG.fallback.enabled &&
          consecutiveFailures >= DEFAULT_BATCH_CONFIG.fallback.threshold
        ) {
          log('[BatchExecutor] Fallback threshold reached, switching to serial mode');
          return fallbackToSerial(pendingSubtasks, config);
        }
      } else {
        consecutiveFailures = 0;
      }
    }

    totalCompleted += roundCompleted;
    totalFailed += roundFailed;

    log(
      `[BatchExecutor] Round ${roundNumber} completed: ${roundCompleted} completed, ${roundFailed} failed`
    );

    // If there were failures, stop
    if (roundFailed > 0) {
      log(`[BatchExecutor] Stopping due to failures`);
      break;
    }
  }

  const success = totalFailed === 0;
  log(
    `[BatchExecutor] All rounds completed: ${totalCompleted} total completed, ${totalFailed} total failed`
  );

  return { success, totalCompleted, totalFailed };
}

/**
 * Executes a single batch of subtasks.
 *
 * @param batch - Subtasks to execute
 * @param config - Batch executor configuration
 * @param attempt - Attempt number
 * @returns Batch result
 */
async function executeSingleBatch(
  batch: SubtaskInfo[],
  config: BatchExecutorConfig,
  attempt: number
): Promise<BatchResult> {
  const log = (msg: string) => config.onLog?.(msg);
  const tracker = createBatchProgressTracker();
  let remainingBatch = [...batch];
  const completedIds = new Set<string>();
  const blockedIds = new Set<string>();

  // Retry loop
  for (let retryCount = 0; retryCount <= config.maxRetries; retryCount++) {
    const currentAttempt = attempt + retryCount;

    log(
      `[BatchExecutor] Executing batch session (${remainingBatch.length} subtasks, attempt ${currentAttempt + 1})`
    );

    await syncActiveBatchSubtasks(
      config.specDir,
      remainingBatch.map((subtask) => subtask.id),
    );

    const { sessionResult, cancelled } = await executeBatchAttempt(
      remainingBatch,
      config,
      currentAttempt,
      tracker,
    );

    if (cancelled || config.abortSignal?.aborted || sessionResult.outcome === 'cancelled') {
      return {
        completed: [],
        failed: remainingBatch.map((subtask) => subtask.id),
        blocked: [],
        sessionResult,
      };
    }

    const progress = await tracker.reconcile(
      config.specDir,
      remainingBatch.map((subtask) => subtask.id),
    );
    const completed = progress.completed.filter((id) => remainingBatch.some((subtask) => subtask.id === id));
    const blocked = progress.blocked.filter((id) => remainingBatch.some((subtask) => subtask.id === id));
    completed.forEach((id) => completedIds.add(id));
    blocked.forEach((id) => blockedIds.add(id));

    const failed = remainingBatch
      .map((subtask) => subtask.id)
      .filter((id) => !completed.includes(id) && !blocked.includes(id));

    log(
      `[BatchExecutor] Batch status: ${completed.length} completed, ${failed.length} failed, ${blocked.length} blocked`
    );

    if (failed.length === 0) {
      return {
        completed: Array.from(completedIds),
        failed: [],
        blocked: Array.from(blockedIds),
        sessionResult,
      };
    }

    if (retryCount === config.maxRetries) {
      return {
        completed: Array.from(completedIds),
        failed,
        blocked: Array.from(blockedIds),
        sessionResult,
      };
    }

    log(`[BatchExecutor] Retrying ${failed.length} failed subtasks in a new batch session...`);
    remainingBatch = remainingBatch.filter((subtask) => failed.includes(subtask.id));
    tracker.reset();
  }

  // Should not reach here
  return {
    completed: [],
    failed: remainingBatch.map((subtask) => subtask.id),
    blocked: [],
    sessionResult: { outcome: 'error' } as SessionResult,
  };
}

/**
 * Falls back to serial execution mode.
 *
 * @param subtasks - Remaining subtasks
 * @param config - Batch executor configuration
 * @returns Batch executor result
 */
async function fallbackToSerial(
  _subtasks: SubtaskInfo[],
  config: BatchExecutorConfig
): Promise<BatchExecutorResult> {
  const log = (msg: string) => config.onLog?.(msg);
  log('[BatchExecutor] Falling back to serial mode');

  // Create serial iterator config
  const serialConfig: SubtaskIteratorConfig = {
    specDir: config.specDir,
    projectDir: config.projectDir,
    sourceSpecDir: config.sourceSpecDir,
    maxRetries: config.maxRetries,
    autoContinueDelayMs: 500,
    abortSignal: config.abortSignal,

    runSubtaskSession: async (subtask, attempt) => {
      // Convert build-orchestrator SubtaskInfo to batch-types SubtaskInfo
      const batchSubtask: SubtaskInfo = {
        id: subtask.id,
        phaseId: subtask.phaseName,
        description: subtask.description,
        filesToCreate: subtask.filesToCreate,
        filesToModify: subtask.filesToModify,
        patternFiles: subtask.patternFiles,
        verification: subtask.verification,
        status: 'in_progress',
      };

      return config.runSubtaskSession(batchSubtask, attempt);
    },
  };

  const result = await iterateSubtasks(serialConfig);

  return {
    success: result.completedSubtasks === result.totalSubtasks,
    totalCompleted: result.completedSubtasks,
    totalFailed: result.totalSubtasks - result.completedSubtasks,
    cancelled: result.cancelled,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Loads implementation plan from spec directory.
 *
 * @param specDir - Spec directory
 * @returns Implementation plan or null
 */
async function loadImplementationPlan(specDir: string): Promise<ImplementationPlan | null> {
  return loadImplementationPlanFromFiles(specDir) as Promise<ImplementationPlan | null>;
}

async function resetRoundInProgressSubtasks(
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
  log?.('[BatchExecutor] Reset stale in_progress subtasks to pending before batching');
}

async function syncActiveBatchSubtasks(
  specDir: string,
  activeSubtaskIds: string[],
): Promise<void> {
  const activeIds = new Set(activeSubtaskIds);

  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) return;

    let updated = false;
    for (const phase of plan.phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (activeIds.has(subtask.id)) {
          if (subtask.status !== 'in_progress') {
            subtask.status = 'in_progress';
            updated = true;
          }
          continue;
        }

        if (subtask.status === 'in_progress') {
          subtask.status = 'pending';
          updated = true;
        }
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the orchestrator will reconcile on the next round.
  }
}

async function executeSubtaskSession(
  subtask: SubtaskInfo,
  config: BatchExecutorConfig,
  attempt: number,
): Promise<SessionResult> {
  const log = (msg: string) => config.onLog?.(msg);

  while (true) {
    const sessionResult = await config.runSubtaskSession(subtask, attempt);

    if (sessionResult.outcome === 'rate_limited') {
      log(`[BatchExecutor] Subtask ${subtask.id} rate limited, waiting for reset...`);
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
      log(`[BatchExecutor] Subtask ${subtask.id} auth failure, waiting for re-auth...`);
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

async function executeBatchSession(
  batch: SubtaskInfo[],
  config: BatchExecutorConfig,
  attempt: number,
): Promise<SessionResult> {
  const log = (msg: string) => config.onLog?.(msg);

  while (true) {
    const sessionResult = await config.runBatchSession!(batch, attempt);

    if (sessionResult.outcome === 'rate_limited') {
      log(
        `[BatchExecutor] Batch ${batch.map((subtask) => subtask.id).join(', ')} rate limited, waiting for reset...`
      );
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
      log(
        `[BatchExecutor] Batch ${batch.map((subtask) => subtask.id).join(', ')} auth failure, waiting for re-auth...`
      );
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

async function executeBatchAttempt(
  batch: SubtaskInfo[],
  config: BatchExecutorConfig,
  attempt: number,
  tracker: ReturnType<typeof createBatchProgressTracker>,
): Promise<{ sessionResult: SessionResult; cancelled: boolean }> {
  if (config.runBatchSession) {
    const sessionResult = await executeBatchSession(batch, config, attempt);
    config.onBatchSessionComplete?.(batch, sessionResult);
    parseProgressMarkers(sessionResult, tracker);
    return {
      sessionResult,
      cancelled: sessionResult.outcome === 'cancelled',
    };
  }

  const concurrency = Math.max(
    1,
    Math.min(
      config.maxConcurrentSubtasks ?? batch.length,
      batch.length,
    ),
  );

  const executionResults = await runParallelSubtasks(
    batch,
    concurrency,
    async (subtask) => {
      const sessionResult = await executeSubtaskSession(subtask, config, attempt);
      config.onSubtaskSessionComplete?.(subtask, sessionResult);
      return { subtask, sessionResult };
    },
  );

  const completedByOutcome = executionResults
    .filter(({ sessionResult }) => sessionResult.outcome === 'completed')
    .map(({ subtask, sessionResult }) => ({ id: subtask.id, summary: summarizeSessionResult(sessionResult) }));

  if (completedByOutcome.length > 0) {
    await updateSubtaskStatuses(config.specDir, completedByOutcome, 'completed');
  }

  const firstCancelled = executionResults.find(
    ({ sessionResult }) => sessionResult.outcome === 'cancelled',
  )?.sessionResult;

  const sessionResult = executionResults.find(
    ({ sessionResult }) => sessionResult.outcome !== 'completed',
  )?.sessionResult ?? executionResults[0]?.sessionResult ?? ({ outcome: 'completed' } as SessionResult);

  return {
    sessionResult: firstCancelled ?? sessionResult,
    cancelled: Boolean(firstCancelled),
  };
}

function parseProgressMarkers(
  sessionResult: SessionResult,
  tracker: ReturnType<typeof createBatchProgressTracker>,
): void {
  for (const message of sessionResult.messages) {
    if (message.role === 'assistant') {
      tracker.parseOutput(message.content);
    }
  }
}

async function runParallelSubtasks<T>(
  subtasks: SubtaskInfo[],
  concurrency: number,
  worker: (subtask: SubtaskInfo) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(subtasks.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex++;
      if (currentIndex >= subtasks.length) {
        return;
      }
      results[currentIndex] = await worker(subtasks[currentIndex]);
    }
  };

  const workerCount = Math.min(concurrency, subtasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function updateSubtaskStatuses(
  specDir: string,
  subtaskUpdates: Array<string | { id: string; summary?: string }>,
  status: 'in_progress' | 'completed',
): Promise<void> {
  if (subtaskUpdates.length === 0) {
    return;
  }

  try {
    const targetIds = new Set(subtaskUpdates.map((update) => typeof update === 'string' ? update : update.id));
    const summaries = new Map(
      subtaskUpdates
        .filter((update): update is { id: string; summary?: string } => typeof update !== 'string')
        .map((update) => [update.id, update.summary])
    );
    const plan = await loadImplementationPlan(specDir);
    if (!plan) return;

    for (const phase of plan.phases ?? []) {
      for (const subtask of phase.subtasks ?? []) {
        if (!targetIds.has(subtask.id)) {
          continue;
        }
        if (subtask.status !== status) {
          subtask.status = status;
        }
        const summary = summaries.get(subtask.id);
        if (summary && !subtask.completion_summary) {
          subtask.completion_summary = summary;
          if (!subtask.notes) {
            subtask.notes = summary;
          }
        }
      }
    }
    await saveImplementationPlanToFiles(specDir, plan as never);
  } catch {
    // Non-fatal: the orchestrator will retry or reconcile on the next round.
  }
}

function summarizeSessionResult(result: SessionResult): string | undefined {
  const content = [...result.messages]
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

/**
 * Gets pending subtasks from implementation plan.
 *
 * @param plan - Implementation plan
 * @returns Array of pending subtasks
 */
function getPendingSubtasks(plan: ImplementationPlan): SubtaskInfo[] {
  const subtasks: SubtaskInfo[] = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (subtask.status === 'pending' || subtask.status === 'in_progress') {
        subtasks.push({
          id: subtask.id,
          phaseId: phase.id ?? phase.name,
          description: subtask.description,
          filesToCreate: subtask.files_to_create,
          filesToModify: subtask.files_to_modify,
          patternFiles: subtask.pattern_files,
          verification: subtask.verification,
          status: subtask.status as 'pending' | 'in_progress',
        });
      }
    }
  }

  return subtasks;
}
