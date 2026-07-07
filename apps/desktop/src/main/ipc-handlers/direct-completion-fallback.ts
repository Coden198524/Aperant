import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
  AUTOCODE_TASK_ARTIFACTS,
  getAutocodeDirectQualityGateFailureReason,
  shouldRequireAutocodeDirectValidation,
  type AutocodeDirectCodingQualityMetrics,
} from '@autocode/core';

type DirectExecutionRecord = {
  enabled?: unknown;
  outcome?: unknown;
  completed_at?: unknown;
  current_subtask_id?: unknown;
  change_request_id?: unknown;
  summary_file?: unknown;
  ai_coding_quality?: unknown;
};

export type DirectFallbackTaskMetadata = {
  category?: unknown;
  sourceType?: unknown;
  source_type?: unknown;
  ideationType?: unknown;
  ideation_type?: unknown;
  projectDocumentType?: unknown;
  project_document_type?: unknown;
  projectDocumentOutputDir?: unknown;
  project_document_output_dir?: unknown;
  projectDocumentOutputs?: unknown;
  project_document_outputs?: unknown;
  taskType?: unknown;
  task_type?: unknown;
  type?: unknown;
};

type DirectPlanSubtaskRecord = {
  id?: unknown;
  started_at?: unknown;
};

export type DirectFallbackPlan = {
  feature?: unknown;
  title?: unknown;
  description?: unknown;
  workflow_type?: unknown;
  documentation_depth?: unknown;
  documentation_profile?: unknown;
  documentation_focus?: unknown;
  project_documentation?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  direct_execution?: DirectExecutionRecord;
  phases?: Array<{
    type?: unknown;
    subtasks?: DirectPlanSubtaskRecord[];
    chunks?: DirectPlanSubtaskRecord[];
  }>;
};

export type DirectRunResultFile = {
  phase?: unknown;
  exitCode?: unknown;
  status?: unknown;
  message?: unknown;
  updatedAt?: unknown;
  quality?: unknown;
};

type DirectRunResultCandidate = {
  result: DirectRunResultFile;
  sortTimeMs?: number;
};

export type DirectFallbackPlanCandidate<TPlan extends DirectFallbackPlan = DirectFallbackPlan> = {
  plan: TPlan | null;
  fileModifiedTimeMs?: number;
};

export type DirectCompletionFallbackDecision =
  | {
      action: 'complete';
      reason: string;
      filesChanged: number;
      quality: Record<string, unknown>;
    }
  | {
      action: 'resume';
      reason: string;
      outcome: string;
      message: string;
      quality: Record<string, unknown>;
    }
  | {
      action: 'fail';
      reason: string;
      error: string;
      quality: Record<string, unknown>;
    }
  | {
      action: 'ignore';
      reason: string;
    };

const SUCCESSFUL_DIRECT_OUTCOMES = new Set(['completed', 'success', 'done']);
const RESUMABLE_DIRECT_OUTCOMES = new Set(['rate_limited', 'context_window', 'max_steps']);
const FAILED_DIRECT_OUTCOMES = new Set([
  'error',
  'failed',
  'failure',
  'timeout',
  'cancelled',
  'canceled',
  'auth_failure',
  'auth_failed',
]);

function isSuccessfulDirectRunResult(status: string, exitCode: number | undefined): boolean {
  return exitCode === 0 && SUCCESSFUL_DIRECT_OUTCOMES.has(status);
}

function isResumableDirectRunResult(status: string, exitCode: number | undefined): boolean {
  return RESUMABLE_DIRECT_OUTCOMES.has(status) && (exitCode === 0 || exitCode === undefined);
}

export function readDirectRunResultFromSpecDirs(specDirs: string[]): DirectRunResultFile | null {
  const candidates: DirectRunResultCandidate[] = [];
  for (const specDir of specDirs) {
    const runResultPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.runResult);
    if (!existsSync(runResultPath)) {
      continue;
    }
    const fileMtimeMs = fileModifiedTimeMs(runResultPath);
    try {
      const parsed = JSON.parse(readFileSync(runResultPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        candidates.push(buildRunResultCandidate(parsed as DirectRunResultFile, fileMtimeMs));
      } else {
        candidates.push(buildRunResultCandidate({
          phase: 'direct',
          status: 'error',
          message: `${AUTOCODE_TASK_ARTIFACTS.runResult} did not contain a JSON object.`,
        }, fileMtimeMs));
      }
    } catch (error) {
      candidates.push(buildRunResultCandidate({
        phase: 'direct',
        status: 'error',
        message: `${AUTOCODE_TASK_ARTIFACTS.runResult} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      }, fileMtimeMs));
    }
  }

  return candidates.reduce<DirectRunResultCandidate | null>((best, candidate) => {
    if (!best) {
      return candidate;
    }
    if (candidate.sortTimeMs === undefined) {
      return best;
    }
    if (best.sortTimeMs === undefined || candidate.sortTimeMs > best.sortTimeMs) {
      return candidate;
    }
    return best;
  }, null)?.result ?? null;
}

export function selectLatestDirectFallbackPlan<TPlan extends DirectFallbackPlan>(
  candidates: Array<DirectFallbackPlanCandidate<TPlan>>,
): TPlan | null {
  return candidates.reduce<{ plan: TPlan; sortTimeMs?: number } | null>((best, candidate) => {
    if (!candidate.plan) {
      return best;
    }
    const scored = {
      plan: candidate.plan,
      sortTimeMs: getDirectPlanCandidateSortTimeMs(candidate.plan, candidate.fileModifiedTimeMs),
    };
    if (!best) {
      return scored;
    }
    if (scored.sortTimeMs === undefined) {
      return best;
    }
    if (best.sortTimeMs === undefined || scored.sortTimeMs > best.sortTimeMs) {
      return scored;
    }
    return best;
  }, null)?.plan ?? null;
}

function getDirectPlanCandidateSortTimeMs(
  plan: DirectFallbackPlan,
  fileModifiedTimeMs: number | undefined,
): number | undefined {
  const planTimes = [
    timestampMs(stringValue(plan.updated_at)),
    timestampMs(stringValue(plan.direct_execution?.completed_at)),
    getCurrentDirectIterationStartedAtMs(plan),
    timestampMs(stringValue(plan.created_at)),
  ].filter((value): value is number => value !== undefined);
  return planTimes.length > 0 ? Math.max(...planTimes) : fileModifiedTimeMs;
}
export function evaluateDirectCompletionFallback(input: {
  exitCode: number | null;
  plan?: DirectFallbackPlan | null;
  runResult?: DirectRunResultFile | null;
  taskMetadata?: DirectFallbackTaskMetadata | null;
  fallback: string;
}): DirectCompletionFallbackDecision {
  if (input.exitCode !== 0) {
    return { action: 'ignore', reason: 'process-exit-nonzero' };
  }

  const plan = input.plan ?? null;
  const runResult = input.runResult ?? null;
  const directOutcome = normalizedString(plan?.direct_execution?.outcome);
  const runResultIsDirect = normalizedString(runResult?.phase) === 'direct';
  const runResultStatus = normalizedString(runResult?.status);
  const runResultExitCode = numberValue(runResult?.exitCode);
  const runResultSucceeded = isSuccessfulDirectRunResult(runResultStatus, runResultExitCode);
  const iterationStartedAtMs = getCurrentDirectIterationStartedAtMs(plan);
  const runResultUpdatedAtMs = runResultIsDirect ? timestampMs(stringValue(runResult?.updatedAt)) : undefined;
  const runResultIsStale = runResultIsDirect &&
    iterationStartedAtMs !== undefined &&
    runResultUpdatedAtMs !== undefined &&
    runResultUpdatedAtMs < iterationStartedAtMs;
  const durableSuccessOptional = isNonImplementationDirectTask(plan, input.taskMetadata);

  if (runResultIsDirect && !runResultIsStale && runResultSucceeded) {
    if (iterationStartedAtMs === undefined || runResultUpdatedAtMs !== undefined) {
      const qualityFailure = getDirectFallbackQualityGateFailureReason(plan, runResult, !durableSuccessOptional);
      if (qualityFailure) {
        return failDecision(
          input.fallback,
          'quality-gate-failed-run-result',
          qualityFailure,
          plan,
          runResult,
        );
      }
      return {
        action: 'complete',
        reason: 'fresh-successful-run-result',
        filesChanged: inferFilesChanged(plan, runResult),
        quality: buildFallbackQuality(input.fallback, 'fresh-successful-run-result', plan, runResult),
      };
    }
    return failDecision(
      input.fallback,
      'missing-run-result-timestamp',
      'Direct process exited cleanly, but the success result has no timestamp to prove it belongs to the current Direct iteration.',
      plan,
      runResult,
    );
  }

  if (runResultIsDirect && !runResultIsStale) {
    if (isResumableDirectRunResult(runResultStatus, runResultExitCode)) {
      return resumeDecision(
        input.fallback,
        'resumable-run-result',
        runResultStatus,
        stringValue(runResult?.message) || `Direct run result is resumable after ${runResultStatus}.`,
        plan,
        runResult,
      );
    }
    return failDecision(
      input.fallback,
      'direct-run-result-not-successful',
      stringValue(runResult?.message) || `Direct run result status is ${runResultStatus || 'unknown'}.`,
      plan,
      runResult,
    );
  }

  if (directOutcome && SUCCESSFUL_DIRECT_OUTCOMES.has(directOutcome)) {
    const completedAtMs = timestampMs(stringValue(plan?.direct_execution?.completed_at));
    if (iterationStartedAtMs === undefined || (completedAtMs !== undefined && completedAtMs >= iterationStartedAtMs)) {
      const qualityFailure = getDirectFallbackQualityGateFailureReason(plan, runResultIsStale ? null : runResult, !durableSuccessOptional);
      if (qualityFailure) {
        return failDecision(
          input.fallback,
          'quality-gate-failed-plan-outcome',
          qualityFailure,
          plan,
          runResultIsStale ? null : runResult,
        );
      }
      return {
        action: 'complete',
        reason: 'completed-plan-outcome',
        filesChanged: inferFilesChanged(plan, runResult),
        quality: buildFallbackQuality(input.fallback, 'completed-plan-outcome', plan, runResult),
      };
    }
    return failDecision(
      input.fallback,
      'stale-completed-plan-outcome',
      'Direct process exited cleanly, but the completed plan outcome belongs to an older Direct iteration.',
      plan,
      runResult,
    );
  }

  if (directOutcome && RESUMABLE_DIRECT_OUTCOMES.has(directOutcome)) {
    return resumeDecision(
      input.fallback,
      'resumable-plan-outcome',
      directOutcome,
      `Direct plan outcome is ${directOutcome}.`,
      plan,
      runResultIsStale ? null : runResult,
    );
  }

  if (directOutcome && FAILED_DIRECT_OUTCOMES.has(directOutcome)) {
    return failDecision(
      input.fallback,
      'failed-plan-outcome',
      `Direct plan outcome is ${directOutcome}.`,
      plan,
      runResult,
    );
  }

  if (durableSuccessOptional) {
    return {
      action: 'complete',
      reason: 'clean-exit-non-implementation-task',
      filesChanged: inferFilesChanged(plan, runResult),
      quality: buildFallbackQuality(input.fallback, 'clean-exit-non-implementation-task', plan, runResult),
    };
  }

  if (runResultIsStale) {
    const staleSuccessfulResult = runResultSucceeded;
    return failDecision(
      input.fallback,
      staleSuccessfulResult ? 'stale-successful-run-result' : 'stale-direct-run-result',
      staleSuccessfulResult
        ? 'Direct process exited cleanly, but the success result belongs to an older Direct iteration.'
        : 'Direct process exited cleanly, but the run result belongs to an older Direct iteration.',
      plan,
      runResult,
    );
  }

  if (directOutcome === 'running' || directOutcome === 'pending' || directOutcome === 'in_progress') {
    return failDecision(
      input.fallback,
      'unfinished-plan-outcome',
      `Direct process exited cleanly while plan outcome is ${directOutcome}.`,
      plan,
      runResult,
    );
  }

  return failDecision(
    input.fallback,
    'missing-direct-success-evidence',
    'Direct process exited cleanly without fresh durable success evidence.',
    plan,
    runResult,
  );
}

function buildRunResultCandidate(result: DirectRunResultFile, fileMtimeMs: number | undefined): DirectRunResultCandidate {
  const updatedAtMs = timestampMs(stringValue(result.updatedAt));
  const sortTimeMs = updatedAtMs ?? fileMtimeMs;
  return {
    result: updatedAtMs === undefined && fileMtimeMs !== undefined
      ? { ...result, updatedAt: new Date(fileMtimeMs).toISOString() }
      : result,
    sortTimeMs,
  };
}

function fileModifiedTimeMs(filePath: string): number | undefined {
  try {
    const timestamp = statSync(filePath).mtimeMs;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function failDecision(
  fallback: string,
  reason: string,
  error: string,
  plan: DirectFallbackPlan | null,
  runResult: DirectRunResultFile | null,
): DirectCompletionFallbackDecision {
  return {
    action: 'fail',
    reason,
    error,
    quality: buildFallbackQuality(fallback, reason, plan, runResult),
  };
}

function resumeDecision(
  fallback: string,
  reason: string,
  outcome: string,
  message: string,
  plan: DirectFallbackPlan | null,
  runResult: DirectRunResultFile | null,
): DirectCompletionFallbackDecision {
  return {
    action: 'resume',
    reason,
    outcome,
    message,
    quality: buildFallbackQuality(fallback, reason, plan, runResult),
  };
}

function buildFallbackQuality(
  fallback: string,
  reason: string,
  plan: DirectFallbackPlan | null,
  runResult: DirectRunResultFile | null,
): Record<string, unknown> {
  const planQuality = recordValue(plan?.direct_execution?.ai_coding_quality);
  const runResultQuality = recordValue(runResult?.quality);
  return {
    ...planQuality,
    ...runResultQuality,
    fallback,
    fallbackReason: reason,
  };
}

function getDirectFallbackQualityGateFailureReason(
  plan: DirectFallbackPlan | null,
  runResult: DirectRunResultFile | null,
  requireValidation: boolean,
): string | null {
  const metrics = directQualityMetricsFromRecord({
    ...recordValue(plan?.direct_execution?.ai_coding_quality),
    ...recordValue(runResult?.quality),
  });
  return metrics ? getAutocodeDirectQualityGateFailureReason(metrics, {
    requireValidation,
    requireSelfCritique: requireValidation,
  }) : null;
}

function directQualityMetricsFromRecord(record: Record<string, unknown>): AutocodeDirectCodingQualityMetrics | null {
  const validation = recordValue(record.validation);
  const selfCritique = recordValue(record.selfCritique);
  if (Object.keys(validation).length === 0 && Object.keys(selfCritique).length === 0) {
    return null;
  }

  const changedFiles = stringArray(record.changedFiles);
  const selfCritiqueMetrics = Object.keys(selfCritique).length > 0
    ? {
        status: normalizeDirectSelfCritiqueStatus(selfCritique.status),
        ...(numberValue(selfCritique.score) !== undefined ? { score: numberValue(selfCritique.score) } : {}),
        filesReviewed: nonNegativeInteger(selfCritique.filesReviewed) ?? 0,
        improvements: stringArray(selfCritique.improvements),
      }
    : undefined;

  return {
    mode: 'direct',
    outcome: stringValue(record.outcome) || 'unknown',
    changedFiles,
    filesChanged: nonNegativeInteger(record.filesChanged) ?? changedFiles.length,
    stepsExecuted: nonNegativeInteger(record.stepsExecuted) ?? 0,
    toolCallCount: nonNegativeInteger(record.toolCallCount) ?? 0,
    durationMs: nonNegativeInteger(record.durationMs) ?? 0,
    recordedAt: stringValue(record.recordedAt) || 'unknown',
    ...(selfCritiqueMetrics ? { selfCritique: selfCritiqueMetrics } : {}),
    validation: {
      status: stringValue(validation.status) || 'not_run',
      reason: stringValue(validation.reason) || 'No validation detail in Direct fallback quality.',
    },
  };
}

function normalizeDirectSelfCritiqueStatus(value: unknown): 'passed' | 'failed' | 'skipped' {
  const status = normalizedString(value);
  return status === 'passed' || status === 'failed' ? status : 'skipped';
}

function inferFilesChanged(plan: DirectFallbackPlan | null, runResult: DirectRunResultFile | null): number {
  const runResultQuality = recordValue(runResult?.quality);
  const planQuality = recordValue(plan?.direct_execution?.ai_coding_quality);
  const candidates = [
    nonNegativeInteger(runResultQuality.filesChanged),
    stringArray(runResultQuality.changedFiles).length,
    nonNegativeInteger(planQuality.filesChanged),
    stringArray(planQuality.changedFiles).length,
  ];
  return candidates.find((value) => value !== undefined && value > 0) ?? 0;
}

function isNonImplementationDirectTask(
  plan: DirectFallbackPlan | null,
  metadata: DirectFallbackTaskMetadata | null | undefined,
): boolean {
  const description = [
    stringValue(plan?.description),
    stringValue(plan?.title),
    stringValue(plan?.feature),
  ].filter(Boolean).join('\n');
  return !shouldRequireAutocodeDirectValidation({
    plan: recordValue(plan),
    metadata: recordValue(metadata),
    description,
  });
}

function getCurrentDirectIterationStartedAtMs(plan: DirectFallbackPlan | null): number | undefined {
  if (!plan) {
    return undefined;
  }
  const currentSubtaskId = stringValue(plan.direct_execution?.current_subtask_id);
  const encodedIterationStartedAtMs = parseDirectChangeRequestTimestampMs(currentSubtaskId)
    ?? parseDirectChangeRequestTimestampMs(stringValue(plan.direct_execution?.change_request_id));
  if (encodedIterationStartedAtMs !== undefined) {
    return encodedIterationStartedAtMs;
  }

  const currentSubtask = findDirectSubtask(plan, currentSubtaskId);
  return timestampMs(stringValue(currentSubtask?.started_at));
}

function findDirectSubtask(
  plan: DirectFallbackPlan,
  subtaskId: string,
): DirectPlanSubtaskRecord | undefined {
  if (!subtaskId) {
    return undefined;
  }
  for (const phase of plan.phases ?? []) {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    const match = subtasks.find((subtask) => stringValue(subtask.id) === subtaskId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function parseDirectChangeRequestTimestampMs(value: string): number | undefined {
  const match = /(?:^|-)cr-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/.exec(value);
  if (!match) {
    return undefined;
  }
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && number >= 0 ? Math.floor(number) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizedString(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function timestampMs(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
