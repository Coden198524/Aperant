/**
 * Subtask Iterator
 * ================
 *
 * See apps/desktop/src/main/ai/orchestration/subtask-iterator.ts for the TypeScript implementation.
 * Reads implementation_plan.md, finds the next pending subtask, invokes
 * the coder agent session, and tracks completion/retry/stuck state.
 */

import {
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
} from '../schema/plan-shards';
import type { ExtractedInsights, InsightExtractionConfig } from '../runners/insight-extractor';
import { extractSessionInsights } from '../runners/insight-extractor';
import type { SessionResult } from '../session/types';
import type { SubtaskInfo } from './build-orchestrator';
import {
  analyzeAutocodeWorkDependencies,
  buildAutocodeWorkDependencyStatusMap,
  describeAutocodeWorkDependencyBlocker,
  normalizeAutocodeWorkDependencyIds,
} from '@autocode/core';
import {
  writeAuthPauseFile,
  writeRateLimitPauseFile,
  waitForAuthResume,
  waitForRateLimitResume,
} from './pause-handler';
import {
  collectFilesChangedSinceBaseline,
  collectGitChangedFileSnapshot,
  loadGeneratedFilesForCritique,
  type ChangedFileSnapshot,
} from './changed-files';
import type { CritiqueResult } from './self-critique';
import type { IncrementalValidationResult } from './incremental-validation';

// =============================================================================
// Types
// =============================================================================

/** Configuration for the subtask iterator */
export interface SubtaskIteratorConfig {
  /** Spec directory containing implementation_plan.md */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** Maximum retries per subtask before marking stuck */
  maxRetries: number;
  /** Delay between subtask iterations (ms) */
  autoContinueDelayMs: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /**
   * Optional fallback spec dir in the main project (worktree mode).
   * Used to check for a RESUME file when the frontend can't find the worktree.
   */
  sourceSpecDir?: string;
  /** Called when a subtask starts */
  onSubtaskStart?: (subtask: SubtaskInfo, attempt: number) => void;
  /** Run the coder session for a subtask; returns the session result */
  runSubtaskSession: (subtask: SubtaskInfo, attempt: number) => Promise<SessionResult>;
  /** Called when a subtask session completes */
  onSubtaskComplete?: (subtask: SubtaskInfo, result: SessionResult) => void;
  /** Called when a subtask is marked stuck */
  onSubtaskStuck?: (subtask: SubtaskInfo, reason: string) => void;
  /** Called when insight extraction completes for a subtask (optional). */
  onInsightsExtracted?: (subtaskId: string, insights: ExtractedInsights) => void;
  /**
   * Whether to extract insights after each successful coder session.
   * Defaults to false (opt-in to avoid extra AI calls in test scenarios).
   */
  extractInsights?: boolean;
  /** Quality improvement configuration */
  qualityConfig?: import('./quality-integration').QualityConfig;
}

/** Result of the full subtask iteration */
export interface SubtaskIteratorResult {
  /** Total subtasks processed */
  totalSubtasks: number;
  /** Number of completed subtasks */
  completedSubtasks: number;
  /** IDs of subtasks marked as stuck */
  stuckSubtasks: string[];
  /** Whether iteration was cancelled */
  cancelled: boolean;
}

/** Single subtask result for internal tracking */
export interface SubtaskResult {
  subtaskId: string;
  success: boolean;
  attempts: number;
  stuck: boolean;
  error?: string;
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
  completed_at?: string;
  started_at?: string;
  duration_ms?: number;
  updated_at?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  pattern_files?: string[];
  depends_on?: unknown;
  verification?: string;
  work_package?: boolean;
  upstream_task_ids?: string[];
  upstream_source?: string;
  ai_coding_quality?: SubtaskQualityMetrics;
}

interface SubtaskQualityMetrics {
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

type ProtectedSubtaskField =
  | 'status'
  | 'notes'
  | 'completion_summary'
  | 'completed_at'
  | 'started_at'
  | 'duration_ms'
  | 'updated_at';

type ProtectedSubtaskState = { status: string } & Partial<Record<ProtectedSubtaskField, string | number>>;

type DependencyBlockedSubtask = {
  subtask: PlanSubtask;
  phaseName: string;
  reason: string;
};

const PROTECTED_SUBTASK_FIELDS: ProtectedSubtaskField[] = [
  'status',
  'notes',
  'completion_summary',
  'completed_at',
  'started_at',
  'duration_ms',
  'updated_at',
];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Iterate through all pending subtasks in the implementation plan.
 *
 * Replaces the inner subtask loop in agents/coder.py:
 * - Reads implementation_plan.md for the next pending subtask
 * - Invokes the coder agent session
 * - Re-reads the plan after each session (the agent updates subtask status)
 * - Tracks retry counts and marks subtasks as stuck after max retries
 * - Continues until all subtasks complete or build is stuck
 */
export async function iterateSubtasks(
  config: SubtaskIteratorConfig,
): Promise<SubtaskIteratorResult> {
  const attemptCounts = new Map<string, number>();
  const lastResults = new Map<string, SessionResult>();
  const stuckSubtasks: string[] = [];
  let completedSubtasks = 0;
  let totalSubtasks = 0;

  while (true) {
    // Check cancellation
    if (config.abortSignal?.aborted) {
      return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
    }

    // Load the plan and find next pending subtask
    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return { totalSubtasks: 0, completedSubtasks: 0, stuckSubtasks, cancelled: false };
    }

    // Normalize stale status before choosing work. Some sessions successfully
    // write a completion summary or timestamp, then a stale plan write restores
    // status to pending/in_progress. Treat that persisted evidence as completed.
    const normalizedPlan = await normalizeCompletedSubtasks(config, plan);

    // Count totals
    totalSubtasks = countTotalSubtasks(plan);
    completedSubtasks = countCompletedSubtasks(plan);

    // Find next subtask
    const next = getNextPendingSubtask(plan, stuckSubtasks);
    if (!next) {
      const blockedSubtasks = getDependencyBlockedSubtasks(plan, stuckSubtasks);
      if (blockedSubtasks.length > 0) {
        const newlyBlockedIds = [...new Set(blockedSubtasks
          .map(({ subtask }) => subtask.id))]
          .filter((subtaskId) => !stuckSubtasks.includes(subtaskId));
        stuckSubtasks.push(...newlyBlockedIds);
        await markSubtasksBlockedByDependencies(config.specDir, blockedSubtasks);
        for (const blocked of blockedSubtasks) {
          config.onSubtaskStuck?.({
            id: blocked.subtask.id,
            description: blocked.subtask.description,
            phaseName: blocked.phaseName,
            filesToCreate: blocked.subtask.files_to_create,
            filesToModify: blocked.subtask.files_to_modify,
            patternFiles: blocked.subtask.pattern_files,
            dependsOn: toStringArray(blocked.subtask.depends_on),
            verification: blocked.subtask.verification,
            hasFileMetadata: hasDeclaredFileMetadata(blocked.subtask),
            hasDependencyMetadata: hasDeclaredField(blocked.subtask, 'depends_on'),
            hasVerificationMetadata: hasDeclaredField(blocked.subtask, 'verification'),
            workPackage: blocked.subtask.work_package === true,
            upstreamTaskIds: Array.isArray(blocked.subtask.upstream_task_ids) ? blocked.subtask.upstream_task_ids : [],
            upstreamSource: typeof blocked.subtask.upstream_source === 'string' ? blocked.subtask.upstream_source : undefined,
            status: 'blocked',
          }, blocked.reason);
        }
        if (config.sourceSpecDir) {
          await syncPhasesToMain(config.specDir, config.sourceSpecDir);
        }
        for (const blocked of blockedSubtasks) {
          await learnFromFailedSubtask(
            config,
            {
              id: blocked.subtask.id,
              description: blocked.subtask.description,
              phaseName: blocked.phaseName,
              filesToCreate: blocked.subtask.files_to_create,
              filesToModify: blocked.subtask.files_to_modify,
              patternFiles: blocked.subtask.pattern_files,
              dependsOn: toStringArray(blocked.subtask.depends_on),
              verification: blocked.subtask.verification,
              hasFileMetadata: hasDeclaredFileMetadata(blocked.subtask),
              hasDependencyMetadata: hasDeclaredField(blocked.subtask, 'depends_on'),
              hasVerificationMetadata: hasDeclaredField(blocked.subtask, 'verification'),
              workPackage: blocked.subtask.work_package === true,
              upstreamTaskIds: Array.isArray(blocked.subtask.upstream_task_ids) ? blocked.subtask.upstream_task_ids : [],
              upstreamSource: typeof blocked.subtask.upstream_source === 'string' ? blocked.subtask.upstream_source : undefined,
              status: 'blocked',
            },
            createBlockedSessionResult(blocked.reason),
          );
        }
      }
      if (normalizedPlan && config.sourceSpecDir) {
        await syncPhasesToMain(config.specDir, config.sourceSpecDir);
      }
      // All subtasks completed or stuck
      break;
    }

    const { subtask, phaseName } = next;
    const subtaskInfo: SubtaskInfo = {
      id: subtask.id,
      description: subtask.description,
      phaseName,
      filesToCreate: subtask.files_to_create,
      filesToModify: subtask.files_to_modify,
      patternFiles: subtask.pattern_files,
      dependsOn: toStringArray(subtask.depends_on),
      verification: subtask.verification,
      hasFileMetadata: hasDeclaredFileMetadata(subtask),
      hasDependencyMetadata: hasDeclaredField(subtask, 'depends_on'),
      hasVerificationMetadata: hasDeclaredField(subtask, 'verification'),
      workPackage: subtask.work_package === true,
      upstreamTaskIds: Array.isArray(subtask.upstream_task_ids) ? subtask.upstream_task_ids : [],
      upstreamSource: typeof subtask.upstream_source === 'string' ? subtask.upstream_source : undefined,
      status: subtask.status as 'pending' | 'in_progress' | 'completed' | 'blocked' | 'stuck',
    };

    // Track attempts
    const currentAttempt = (attemptCounts.get(subtask.id) ?? 0) + 1;
    attemptCounts.set(subtask.id, currentAttempt);

    // Check if stuck
    if (currentAttempt > config.maxRetries) {
      stuckSubtasks.push(subtask.id);
      const reason = `Exceeded max retries (${config.maxRetries})`;
      const result = lastResults.get(subtask.id) ?? createBlockedSessionResult(reason);
      await markSubtaskFailed(config.specDir, subtask.id, reason, result);
      if (config.sourceSpecDir) {
        await syncPhasesToMain(config.specDir, config.sourceSpecDir);
      }
      await learnFromFailedSubtask(config, { ...subtaskInfo, status: 'stuck' }, result);
      config.onSubtaskStuck?.(
        subtaskInfo,
        reason,
      );
      continue;
    }

    // Persist subtask start before launching the coder session so the UI and
    // restored task state can reflect that coding has actually begun.
    await markSubtaskInProgress(config.specDir, subtask.id);
    await restampExecutionPhase(config.specDir, 'coding');
    if (config.sourceSpecDir) {
      await syncExecutionStateToMain(config.specDir, config.sourceSpecDir);
    }
    const protectedSubtaskStates = await snapshotProtectedSubtaskStates(config.specDir, subtask.id);
    const changedFileBaseline = await collectGitChangedFileSnapshot(config.projectDir);

    // Notify start
    config.onSubtaskStart?.(subtaskInfo, currentAttempt);

    // Run the session
    const result = await config.runSubtaskSession(subtaskInfo, currentAttempt);
    lastResults.set(subtask.id, result);
    await restoreProtectedSubtaskStates(config.specDir, subtask.id, protectedSubtaskStates);
    await recordSubtaskSessionDuration(config, subtask.id, result);
    const changedFilesForQuality = await collectSubtaskChangedFiles(
      config.projectDir,
      changedFileBaseline,
      subtaskInfo,
    );

    let selfCritiqueResult: CritiqueResult | null = null;
    let incrementalValidationResult: IncrementalValidationResult | null = null;

    if (result.outcome === 'completed' && config.qualityConfig?.enableSelfCritique === true) {
      const generatedFiles = await loadGeneratedFilesForCritique(config.projectDir, changedFilesForQuality);
      if (generatedFiles.length > 0) {
        const { runSelfCritique, formatCritiqueSummary } = await import('./self-critique');
        selfCritiqueResult = await runSelfCritique({
          generatedFiles,
          subtask: subtaskInfo,
          projectDir: config.projectDir,
          specDir: config.specDir,
        });
        console.log(formatCritiqueSummary(selfCritiqueResult));

        if (!selfCritiqueResult.passed) {
          const reason = `Self-critique failed: ${selfCritiqueResult.improvements.slice(0, 3).join('; ') || 'quality score below threshold'}`;
          await recordSubtaskQualityMetrics(config, subtask.id, buildSubtaskQualityMetrics(
            result,
            currentAttempt,
            changedFilesForQuality,
            selfCritiqueResult,
            null,
          ));
          await markSubtaskNeedsRetry(config.specDir, subtask.id, reason);
          if (config.sourceSpecDir) {
            await syncPhasesToMain(config.specDir, config.sourceSpecDir);
          }
          await new Promise((resolve) => setTimeout(resolve, config.autoContinueDelayMs));
          continue;
        }
      }
    }

    if (result.outcome === 'completed' && config.qualityConfig) {
      const { validateSubtaskQuality } = await import('./quality-integration');
      const validationResult = await validateSubtaskQuality(
        subtaskInfo,
        result,
        config.qualityConfig,
        config.projectDir,
        config.specDir,
        changedFilesForQuality,
      );
      incrementalValidationResult = validationResult.incrementalValidation ?? null;

      if (!validationResult.passed) {
        const errorSummary = validationResult.issues.join('; ');
        console.log(`Quality validation failed for ${subtask.id}: ${errorSummary}`);
        await recordSubtaskQualityMetrics(config, subtask.id, buildSubtaskQualityMetrics(
          result,
          currentAttempt,
          changedFilesForQuality,
          selfCritiqueResult,
          incrementalValidationResult,
        ));
        await markSubtaskNeedsRetry(config.specDir, subtask.id, `Quality validation failed: ${errorSummary}`);
        if (config.sourceSpecDir) {
          await syncPhasesToMain(config.specDir, config.sourceSpecDir);
        }
        await new Promise((resolve) => setTimeout(resolve, config.autoContinueDelayMs));
        continue;
      }

      // Learning runs from finalizeAcceptedSubtask() so both normal completion
      // and tool-updated completion follow the same path.
    }

    await recordSubtaskQualityMetrics(config, subtask.id, buildSubtaskQualityMetrics(
      result,
      currentAttempt,
      changedFilesForQuality,
      selfCritiqueResult,
      incrementalValidationResult,
    ));

    const subtaskCompletedByTool = result.completedSubtaskIds?.includes(subtask.id) === true;
    if (subtaskCompletedByTool) {
      await finalizeAcceptedSubtask(config, subtask, subtaskInfo, result, attemptCounts, changedFilesForQuality);
      config.onSubtaskComplete?.(subtaskInfo, result);

      if (result.outcome === 'cancelled') {
        return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
      }

      if (config.autoContinueDelayMs > 0) {
        await delay(config.autoContinueDelayMs, config.abortSignal);
      }
      continue;
    }

    // Notify complete
    config.onSubtaskComplete?.(subtaskInfo, result);

    // Handle outcomes
    if (result.outcome === 'cancelled') {
      return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
    }

    if (result.outcome === 'rate_limited') {
      // Write pause file so the frontend can show a countdown
      const errorMessage = result.error?.message ?? 'Rate limit reached';
      writeRateLimitPauseFile(config.specDir, errorMessage, null);

      // Wait for the rate limit to reset (or user to resume early)
      await waitForRateLimitResume(
        config.specDir,
        MAX_RATE_LIMIT_WAIT_MS_DEFAULT,
        config.sourceSpecDir,
        config.abortSignal,
      );

      // Re-check abort after waiting
      if (config.abortSignal?.aborted) {
        return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
      }

      // Continue the loop 鈥?subtask will be retried
      continue;
    }

    if (result.outcome === 'auth_failure') {
      // Write pause file so the frontend can show a re-auth prompt
      const errorMessage = result.error?.message ?? 'Authentication failed';
      writeAuthPauseFile(config.specDir, errorMessage);

      // Wait for user to re-authenticate
      await waitForAuthResume(config.specDir, config.sourceSpecDir, config.abortSignal);

      // Re-check abort after waiting
      if (config.abortSignal?.aborted) {
        return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
      }

      // Continue 鈥?subtask will be retried with fresh auth
      continue;
    }

    // Post-session: only auto-mark as completed when the session actually
    // completed. `max_steps`/`context_window` can indicate partial progress.
    // Auto-completing in those cases can prematurely advance to QA.
    if (result.outcome === 'completed') {
      await ensureSubtaskMarkedCompleted(config.specDir, subtask.id, result);
    }

    const subtaskCompletedInPlan = await isSubtaskCompleted(config.specDir, subtask.id);
    if (result.outcome === 'completed' || subtaskCompletedInPlan) {
      await finalizeAcceptedSubtask(config, subtask, subtaskInfo, result, attemptCounts, changedFilesForQuality);
    }

    // For errors, the subtask will be retried on next loop iteration
    // (implementation_plan.md status remains in_progress or pending)

    // Analyze failure and suggest recovery strategy
    if (result.outcome === 'error' && config.qualityConfig?.enableContextAwareRecovery === true) {
      const { analyzeFailureAndRecover } = await import('./context-aware-recovery');
      const failureRecord: import('./context-aware-recovery').FailureRecord = {
        attempt: currentAttempt,
        outcome: result.outcome,
        error: result.error?.message || 'Unknown error',
        timestamp: new Date().toISOString(),
      };

      const recoveryAnalysis = await analyzeFailureAndRecover(
        subtaskInfo,
        [failureRecord],
        config.projectDir,
        config.specDir,
      );

      console.log(`Recovery strategy for ${subtask.id}: ${recoveryAnalysis.strategy.type}`);
    }

    // Delay before next iteration
    if (config.autoContinueDelayMs > 0) {
      await delay(config.autoContinueDelayMs, config.abortSignal);
    }
  }

  return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: false };
}

// =============================================================================
// Post-Session Processing
// =============================================================================

async function collectSubtaskChangedFiles(
  projectDir: string,
  baseline: ChangedFileSnapshot,
  subtask: SubtaskInfo,
): Promise<string[]> {
  return collectFilesChangedSinceBaseline(projectDir, baseline, [
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ]);
}

function buildSubtaskQualityMetrics(
  result: SessionResult,
  attempt: number,
  changedFiles: string[],
  selfCritique: CritiqueResult | null,
  incrementalValidation: IncrementalValidationResult | null,
): SubtaskQualityMetrics {
  return {
    outcome: result.outcome,
    attempt,
    changed_files: changedFiles,
    files_changed: changedFiles.length,
    steps_executed: result.stepsExecuted ?? 0,
    tool_call_count: result.toolCallCount ?? 0,
    duration_ms: result.durationMs ?? 0,
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

async function recordSubtaskQualityMetrics(
  config: SubtaskIteratorConfig,
  subtaskId: string,
  metrics: SubtaskQualityMetrics,
): Promise<void> {
  try {
    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return;
    }

    let updated = false;
    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        if (getSubtaskId(subtask) !== subtaskId) {
          continue;
        }
        subtask.ai_coding_quality = metrics;
        subtask.updated_at = metrics.recorded_at;
        updated = true;
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(config.specDir, plan as never);
      if (config.sourceSpecDir) {
        await syncPhasesToMain(config.specDir, config.sourceSpecDir);
      }
    }
  } catch {
    // Non-fatal: quality metrics are diagnostic and should not block retries.
  }
}

async function finalizeAcceptedSubtask(
  config: SubtaskIteratorConfig,
  subtask: PlanSubtask,
  subtaskInfo: SubtaskInfo,
  result: SessionResult,
  attemptCounts: Map<string, number>,
  changedFiles: string[] = [],
): Promise<void> {
  await ensureSubtaskMarkedCompleted(config.specDir, subtask.id, result);

  // Re-stamp executionPhase on the worktree plan after the coder session.
  // The coder model's Edit/Write calls can overwrite executionPhase with a
  // stale value (read before persistPlanPhaseSync ran). Since the model is
  // no longer writing, we can safely correct it here.
  await restampExecutionPhase(config.specDir, 'coding');

  // Sync updated phases to main project plan (worktree mode).
  // This keeps the main plan current during execution, not just on exit.
  if (config.sourceSpecDir) {
    await syncPhasesToMain(config.specDir, config.sourceSpecDir);
  }

  attemptCounts.delete(subtask.id);

  await learnFromAcceptedSubtask(config, subtaskInfo, result);

  // Extract insights from the session (opt-in, never blocks the build)
  if (config.extractInsights) {
    extractInsightsAfterSession(config, subtask, result, changedFiles).then((insights) => {
      if (insights) config.onInsightsExtracted?.(subtask.id, insights);
    }).catch(() => { /* insight extraction is non-blocking */ });
  }
}

async function learnFromAcceptedSubtask(
  config: SubtaskIteratorConfig,
  subtask: SubtaskInfo,
  result: SessionResult,
): Promise<void> {
  if (!config.qualityConfig?.enableActiveMemoryLearning) {
    return;
  }

  try {
    const { learnFromSession } = await import('./quality-integration');
    await learnFromSession(
      subtask,
      result,
      config.qualityConfig,
      config.projectDir,
      config.specDir,
    );
  } catch (error) {
    console.error('Failed to learn from accepted subtask:', error);
  }
}

async function learnFromFailedSubtask(
  config: SubtaskIteratorConfig,
  subtask: SubtaskInfo,
  result: SessionResult,
): Promise<void> {
  if (!config.qualityConfig?.enableActiveMemoryLearning) {
    return;
  }

  try {
    const { learnFromSession } = await import('./quality-integration');
    await learnFromSession(
      subtask,
      result,
      config.qualityConfig,
      config.projectDir,
      config.specDir,
    );
  } catch (error) {
    console.error('Failed to learn from failed subtask:', error);
  }
}

async function recordSubtaskSessionDuration(
  config: SubtaskIteratorConfig,
  subtaskId: string,
  result: SessionResult,
): Promise<void> {
  const durationMs = getSessionDurationMs(result);
  if (durationMs <= 0) {
    return;
  }

  try {
    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return;
    }

    let updated = false;
    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const id = getSubtaskId(subtask);
        if (id !== subtaskId) {
          continue;
        }
        subtask.duration_ms = getExistingDurationMs(subtask) + durationMs;
        subtask.updated_at = new Date().toISOString();
        updated = true;
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(config.specDir, plan as never);
      if (config.sourceSpecDir) {
        await syncPhasesToMain(config.specDir, config.sourceSpecDir);
      }
    }
  } catch {
    // Non-fatal: duration is only used for reporting and should not block execution.
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

/**
 * Ensure a subtask is marked as completed in implementation_plan.md.
 *
 * The coder agent is instructed to update the subtask status itself, but it
 * doesn't always do so reliably. This function is called after each successful
 * coder session as a fallback: if the subtask is still pending or in_progress,
 * it is marked completed with a timestamp.
 *
 * Only ADD/UPDATE fields 鈥?never removes existing data.
 */
async function ensureSubtaskMarkedCompleted(
  specDir: string,
  subtaskId: string,
  result?: SessionResult,
): Promise<void> {
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) return; // JSON corrupt beyond repair
    let updated = false;
    const completionSummary = result ? summarizeSessionResult(result) : undefined;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        // Normalize subtask_id 鈫?id (Fix 2: planner sometimes writes subtask_id)
        const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
        if (withLegacyId.subtask_id && !subtask.id) {
          subtask.id = withLegacyId.subtask_id;
          updated = true;
        }

        // Mark this specific subtask as completed if it isn't already
        if (subtask.id === subtaskId && subtask.status !== 'completed') {
          subtask.status = 'completed';
          (subtask as PlanSubtask & { completed_at?: string }).completed_at =
            new Date().toISOString();
          updated = true;
        }

        if (subtask.id === subtaskId && completionSummary && !subtask.completion_summary) {
          subtask.completion_summary = completionSummary;
          if (!subtask.notes) {
            subtask.notes = completionSummary;
          }
          updated = true;
        }
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: if we can't update the plan the loop will retry or mark stuck
  }
}

async function isSubtaskCompleted(
  specDir: string,
  subtaskId: string,
): Promise<boolean> {
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return false;
    }

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
        const id = subtask.id ?? withLegacyId.subtask_id;
        if (id === subtaskId) {
          return hasSubtaskCompletionEvidence(subtask);
        }
      }
    }
  } catch {
    // Non-fatal: fall back to normal retry handling.
  }
  return false;
}

function summarizeSessionResult(result: SessionResult): string | undefined {
  const content = [...result.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())?.content;
  if (!content) {
    return undefined;
  }

  const tableSummary = extractCompletionSummaryTable(content);
  if (tableSummary) {
    return tableSummary;
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

function summarizeFailureResult(result: SessionResult, fallback: string): string {
  const finalAssistantText = [...result.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())?.content
    ?.replace(/\s+/g, ' ')
    .trim();
  const error = result.error?.message;
  return [error, finalAssistantText, fallback]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' | ')
    .slice(0, 3000);
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

function extractCompletionSummaryTable(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const start = lines.findIndex((line, index) => {
    const next = lines[index + 1] ?? '';
    return /^\|\s*(Item|椤圭洰)\s*\|\s*(Details|璇︽儏)\s*\|$/i.test(line) &&
      /^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(next);
  });

  if (start < 0) {
    return undefined;
  }

  const tableLines = lines
    .slice(start)
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  return tableLines.length >= 3 ? tableLines.join('\n') : undefined;
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

async function markSubtaskInProgress(
  specDir: string,
  subtaskId: string,
): Promise<void> {
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return;
    }

    let updated = false;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
        if (withLegacyId.subtask_id && !subtask.id) {
          subtask.id = withLegacyId.subtask_id;
          updated = true;
        }

        if (
          subtask.id === subtaskId &&
          subtask.status === 'pending' &&
          !hasSubtaskCompletionEvidence(subtask)
        ) {
          subtask.status = 'in_progress';
          updated = true;
        }
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the session can still run even if progress persistence fails
  }
}

async function markSubtaskNeedsRetry(
  specDir: string,
  subtaskId: string,
  reason: string,
): Promise<void> {
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return;
    }

    const now = new Date().toISOString();
    let updated = false;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const id = getSubtaskId(subtask);
        if (id !== subtaskId) {
          continue;
        }

        subtask.status = 'in_progress';
        delete subtask.completed_at;
        delete subtask.completion_summary;
        subtask.notes = [reason, subtask.notes]
          .filter((value): value is string => Boolean(value && value.trim()))
          .join('\n\n');
        subtask.updated_at = now;
        updated = true;
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the iterator will retry or eventually mark the task stuck.
  }
}

async function markSubtaskFailed(
  specDir: string,
  subtaskId: string,
  reason: string,
  result?: SessionResult,
): Promise<void> {
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return;
    }

    const summary = result ? summarizeFailureResult(result, reason) : reason;
    const now = new Date().toISOString();
    let updated = false;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
        const id = subtask.id ?? withLegacyId.subtask_id;
        if (id !== subtaskId) {
          continue;
        }

        if (subtask.status !== 'failed') {
          subtask.status = 'failed';
          updated = true;
        }
        if (!subtask.notes || !subtask.notes.includes(reason)) {
          subtask.notes = summary;
          updated = true;
        }
        subtask.updated_at = now;
        updated = true;
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the iterator result still reports the stuck subtask.
  }
}

async function markSubtasksBlockedByDependencies(
  specDir: string,
  blockedSubtasks: DependencyBlockedSubtask[],
): Promise<void> {
  if (blockedSubtasks.length === 0) {
    return;
  }

  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return;
    }

    const blockedIds = new Set(blockedSubtasks.map(({ subtask }) => subtask.id));
    const reasonBySubtaskId = new Map(blockedSubtasks.map((blocked) => [blocked.subtask.id, blocked.reason]));
    const now = new Date().toISOString();
    let updated = false;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        if (!blockedIds.has(subtask.id)) {
          continue;
        }
        const reason = reasonBySubtaskId.get(subtask.id) ?? 'Blocked by unresolved dependencies.';
        if (subtask.status !== 'blocked') {
          subtask.status = 'blocked';
          updated = true;
        }
        if (!subtask.notes || !subtask.notes.includes(reason)) {
          subtask.notes = reason;
          updated = true;
        }
        subtask.updated_at = now;
        updated = true;
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the iterator result still reports the blocked subtasks.
  }
}

async function snapshotProtectedSubtaskStates(
  specDir: string,
  currentSubtaskId: string,
): Promise<Map<string, ProtectedSubtaskState>> {
  const states = new Map<string, ProtectedSubtaskState>();
  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return states;
    }

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const subtaskId = getSubtaskId(subtask);
        if (!subtaskId || subtaskId === currentSubtaskId) {
          continue;
        }
        states.set(subtaskId, pickProtectedSubtaskState(subtask));
      }
    }
  } catch {
    // Best-effort guard; normal session flow should continue.
  }
  return states;
}

async function restoreProtectedSubtaskStates(
  specDir: string,
  currentSubtaskId: string,
  protectedStates: Map<string, ProtectedSubtaskState>,
): Promise<void> {
  if (protectedStates.size === 0) {
    return;
  }

  try {
    const plan = await loadImplementationPlan(specDir);
    if (!plan) {
      return;
    }

    let updated = false;
    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const subtaskId = getSubtaskId(subtask);
        if (!subtaskId || subtaskId === currentSubtaskId) {
          continue;
        }
        const protectedState = protectedStates.get(subtaskId);
        if (!protectedState) {
          continue;
        }
        const mutableSubtask = subtask as unknown as Record<string, string | number | undefined>;

        for (const field of PROTECTED_SUBTASK_FIELDS) {
          const nextValue = protectedState[field];
          if (nextValue === undefined) {
            if (mutableSubtask[field] !== undefined) {
              delete mutableSubtask[field];
              updated = true;
            }
            continue;
          }
          if (mutableSubtask[field] !== nextValue) {
            mutableSubtask[field] = nextValue;
            updated = true;
          }
        }
      }
    }

    if (updated) {
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal: the current subtask completion fallback still runs below.
  }
}

function pickProtectedSubtaskState(subtask: PlanSubtask): ProtectedSubtaskState {
  const state: ProtectedSubtaskState = {
    status: subtask.status,
  };
  const values = subtask as unknown as Record<string, string | number | undefined>;
  for (const field of PROTECTED_SUBTASK_FIELDS) {
    if (field !== 'status' && values[field] !== undefined) {
      state[field] = values[field];
    }
  }
  return state;
}

function getSubtaskId(subtask: PlanSubtask): string | undefined {
  const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
  return subtask.id ?? withLegacyId.subtask_id;
}

/**
 * Re-stamp executionPhase on the plan file after a coder session.
 *
 * During a coder session, the model reads implementation_plan.md, edits
 * subtask statuses, and writes the file back. If the model read the plan
 * before persistPlanPhaseSync set executionPhase to 'coding', the model's
 * write overwrites executionPhase with the stale value (e.g., 'planning').
 *
 * This function runs AFTER the session ends (no more model writes) and
 * corrects executionPhase to the actual current phase.
 *
 * @internal Exported for unit testing only.
 */
export async function restampExecutionPhase(
  specDir: string,
  phase: string,
): Promise<void> {
  try {
    const plan = await loadImplementationPlanFromFiles(specDir);
    if (!plan) {
      console.warn(`[restampExecutionPhase] Could not parse implementation_plan.md in ${specDir} 鈥?skipping restamp`);
      return;
    }

    if (plan.executionPhase !== phase) {
      plan.executionPhase = phase;
      plan.updated_at = new Date().toISOString();
      await saveImplementationPlanToFiles(specDir, plan as never);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Sync phases from the worktree plan to the main project plan.
 * Keeps the main plan's subtask statuses up-to-date during execution,
 * not just on process exit. Non-fatal: skip silently on any error.
 */
async function syncPhasesToMain(
  worktreeSpecDir: string,
  mainSpecDir: string,
): Promise<void> {
  try {
    const worktreePlan = await loadImplementationPlan(worktreeSpecDir);
    if (!worktreePlan?.phases) return;

    const mainPlan = await loadImplementationPlanFromFiles(mainSpecDir);
    if (!mainPlan) return;

    mainPlan.phases = worktreePlan.phases as never;
    mainPlan.updated_at = new Date().toISOString();

    await saveImplementationPlanToFiles(mainSpecDir, mainPlan);
  } catch (err) {
    // Non-fatal: the exit handler will do a final definitive sync.
    // Log so we can diagnose subtask-status-not-updating issues.
    console.warn(
      `[syncPhasesToMain] Failed to sync phases from ${worktreeSpecDir} to ${mainSpecDir}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function syncExecutionStateToMain(
  worktreeSpecDir: string,
  mainSpecDir: string,
): Promise<void> {
  try {
    const worktreePlan = await loadImplementationPlanFromFiles(worktreeSpecDir);
    if (!worktreePlan) return;

    const mainPlan = await loadImplementationPlanFromFiles(mainSpecDir);
    if (!mainPlan) return;

    mainPlan.phases = worktreePlan.phases;
    if (typeof worktreePlan.executionPhase === 'string') {
      mainPlan.executionPhase = worktreePlan.executionPhase;
    }
    mainPlan.updated_at = new Date().toISOString();

    await saveImplementationPlanToFiles(mainSpecDir, mainPlan);
  } catch (err) {
    console.warn(
      `[syncExecutionStateToMain] Failed to sync execution state from ${worktreeSpecDir} to ${mainSpecDir}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// =============================================================================
// Plan Queries
// =============================================================================

/**
 * Load and parse implementation_plan.md.
 */
async function loadImplementationPlan(
  specDir: string,
): Promise<ImplementationPlan | null> {
  return loadImplementationPlanFromFiles(specDir) as Promise<ImplementationPlan | null>;
}

/**
 * Get the next pending subtask from the plan.
 * Skips subtasks that are completed, in_progress (may be worked on by another session),
 * or marked as stuck.
 */
function getNextPendingSubtask(
  plan: ImplementationPlan,
  stuckSubtaskIds: string[],
): { subtask: PlanSubtask; phaseName: string } | null {
  const statusById = getSubtaskStatusMap(plan);
  const candidates: Array<{
    id: string;
    status: string;
    dependsOn: string[];
    subtask: PlanSubtask;
    phaseName: string;
  }> = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (hasSubtaskCompletionEvidence(subtask)) {
        continue;
      }
      if (
        (subtask.status === 'pending' || subtask.status === 'in_progress') &&
        !stuckSubtaskIds.includes(subtask.id)
      ) {
        candidates.push({
          id: subtask.id,
          status: subtask.status,
          dependsOn: toStringArray(subtask.depends_on),
          subtask,
          phaseName: phase.name,
        });
      }
    }
  }

  const next = analyzeAutocodeWorkDependencies(candidates, { statusById }).runnable[0];
  return next ? { subtask: next.subtask, phaseName: next.phaseName } : null;
}

function getDependencyBlockedSubtasks(
  plan: ImplementationPlan,
  stuckSubtaskIds: string[],
): DependencyBlockedSubtask[] {
  const statusById = getSubtaskStatusMap(plan);
  const candidates: Array<{
    id: string;
    status: string;
    dependsOn: string[];
    subtask: PlanSubtask;
    phaseName: string;
  }> = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (hasSubtaskCompletionEvidence(subtask) || stuckSubtaskIds.includes(subtask.id)) {
        continue;
      }
      if (subtask.status === 'pending' || subtask.status === 'in_progress') {
        candidates.push({
          id: subtask.id,
          status: subtask.status,
          dependsOn: toStringArray(subtask.depends_on),
          subtask,
          phaseName: phase.name,
        });
      }
    }
  }

  return analyzeAutocodeWorkDependencies(candidates, { statusById }).blocked
    .filter((blocked) => blocked.item.dependsOn.length > 0 || blocked.issues.length > 0)
    .map((blocked) => ({
      subtask: blocked.item.subtask,
      phaseName: blocked.item.phaseName,
      reason: describeAutocodeWorkDependencyBlocker(blocked, statusById),
    }));
}

function getSubtaskStatusMap(plan: ImplementationPlan): Map<string, string> {
  return buildAutocodeWorkDependencyStatusMap(
    plan.phases.flatMap((phase) => phase.subtasks.map((subtask) => ({
      id: subtask.id,
      status: subtask.status,
      dependsOn: toStringArray(subtask.depends_on),
    }))),
  );
}

function toStringArray(value: unknown): string[] {
  return normalizeAutocodeWorkDependencyIds(value);
}

function hasDeclaredField(value: object, field: string): boolean {
  return  Object.hasOwn(value, field);
}

function hasDeclaredFileMetadata(subtask: PlanSubtask): boolean {
  return hasDeclaredField(subtask, 'files_to_create') ||
    hasDeclaredField(subtask, 'files_to_modify') ||
    hasDeclaredField(subtask, 'pattern_files');
}

/**
 * Count total subtasks across all phases.
 */
function countTotalSubtasks(plan: ImplementationPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    count += phase.subtasks.length;
  }
  return count;
}

/**
 * Count completed subtasks across all phases.
 */
function countCompletedSubtasks(plan: ImplementationPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (hasSubtaskCompletionEvidence(subtask)) {
        count++;
      }
    }
  }
  return count;
}

function hasSubtaskCompletionEvidence(subtask: PlanSubtask): boolean {
  if (subtask.status === 'completed') {
    return true;
  }

  if (typeof subtask.completed_at === 'string' && subtask.completed_at.trim().length > 0) {
    return true;
  }

  return typeof subtask.completion_summary === 'string' &&
    subtask.completion_summary.trim().length > 0;
}

async function normalizeCompletedSubtasks(
  config: SubtaskIteratorConfig,
  plan: ImplementationPlan,
): Promise<boolean> {
  let updated = false;

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
      if (withLegacyId.subtask_id && !subtask.id) {
        subtask.id = withLegacyId.subtask_id;
        updated = true;
      }

      if (hasSubtaskCompletionEvidence(subtask) && subtask.status !== 'completed') {
        subtask.status = 'completed';
        if (!subtask.completed_at) {
          subtask.completed_at = new Date().toISOString();
        }
        updated = true;
      }
    }
  }

  if (updated) {
    await saveImplementationPlanToFiles(config.specDir, plan as never);
  }

  return updated;
}

// =============================================================================
// Post-session Insight Extraction
// =============================================================================

/** Default max wait for a rate-limit reset (2 hours), matching Python constant. */
const MAX_RATE_LIMIT_WAIT_MS_DEFAULT = 7_200_000;

/**
 * Run insight extraction for a completed subtask session.
 *
 * This is fire-and-forget 鈥?it never blocks the build loop.
 * Returns null on any error so the caller can safely ignore failures.
 */
async function extractInsightsAfterSession(
  config: SubtaskIteratorConfig,
  subtask: PlanSubtask,
  result: SessionResult,
  changedFiles: string[] = [],
): Promise<ExtractedInsights | null> {
  try {
    const insightConfig: InsightExtractionConfig = {
      subtaskId: subtask.id,
      subtaskDescription: subtask.description,
      sessionNum: 1,
      success: result.outcome === 'completed',
      diff: '',           // Diff gathering requires git; left empty for now
      changedFiles,
      commitMessages: '',
      attemptHistory: [],
    };

    return await extractSessionInsights(insightConfig);
  } catch {
    return null;
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Delay with abort signal support.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
