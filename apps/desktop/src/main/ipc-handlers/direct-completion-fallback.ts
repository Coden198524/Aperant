import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';

type DirectExecutionRecord = {
  enabled?: unknown;
  outcome?: unknown;
  completed_at?: unknown;
  current_subtask_id?: unknown;
  change_request_id?: unknown;
  summary_file?: unknown;
  ai_coding_quality?: unknown;
};

type DirectPlanSubtaskRecord = {
  id?: unknown;
  started_at?: unknown;
};

export type DirectFallbackPlan = {
  workflow_type?: unknown;
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

export type DirectCompletionFallbackDecision =
  | {
      action: 'complete';
      reason: string;
      filesChanged: number;
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

const SUCCESSFUL_DIRECT_OUTCOMES = new Set(['completed', 'success', 'done', 'max_steps']);
const FAILED_DIRECT_OUTCOMES = new Set([
  'error',
  'failed',
  'failure',
  'rate_limited',
  'context_window',
  'timeout',
  'cancelled',
  'canceled',
  'auth_failed',
]);

export function readDirectRunResultFromSpecDirs(specDirs: string[]): DirectRunResultFile | null {
  for (const specDir of specDirs) {
    const runResultPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.runResult);
    if (!existsSync(runResultPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(runResultPath, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as DirectRunResultFile;
      }
      return {
        phase: 'direct',
        status: 'error',
        message: `${AUTOCODE_TASK_ARTIFACTS.runResult} did not contain a JSON object.`,
      };
    } catch (error) {
      return {
        phase: 'direct',
        status: 'error',
        message: `${AUTOCODE_TASK_ARTIFACTS.runResult} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return null;
}

export function evaluateDirectCompletionFallback(input: {
  exitCode: number | null;
  plan?: DirectFallbackPlan | null;
  runResult?: DirectRunResultFile | null;
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
  const iterationStartedAtMs = getCurrentDirectIterationStartedAtMs(plan);

  if (runResultIsDirect && runResultStatus === 'success' && runResultExitCode === 0) {
    const updatedAtMs = timestampMs(stringValue(runResult?.updatedAt));
    if (iterationStartedAtMs === undefined || (updatedAtMs !== undefined && updatedAtMs >= iterationStartedAtMs)) {
      return {
        action: 'complete',
        reason: 'fresh-successful-run-result',
        filesChanged: inferFilesChanged(plan, runResult),
        quality: buildFallbackQuality(input.fallback, 'fresh-successful-run-result', plan, runResult),
      };
    }
    return failDecision(
      input.fallback,
      'stale-successful-run-result',
      'Direct process exited cleanly, but the success result belongs to an older Direct iteration.',
      plan,
      runResult,
    );
  }

  if (runResultIsDirect) {
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

  if (directOutcome && FAILED_DIRECT_OUTCOMES.has(directOutcome)) {
    return failDecision(
      input.fallback,
      'failed-plan-outcome',
      `Direct plan outcome is ${directOutcome}.`,
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

function getCurrentDirectIterationStartedAtMs(plan: DirectFallbackPlan | null): number | undefined {
  if (!plan) {
    return undefined;
  }
  const currentSubtaskId = stringValue(plan.direct_execution?.current_subtask_id);
  const currentSubtask = findDirectSubtask(plan, currentSubtaskId);
  const timestamps = [
    timestampMs(stringValue(currentSubtask?.started_at)),
    parseDirectChangeRequestTimestampMs(currentSubtaskId),
    parseDirectChangeRequestTimestampMs(stringValue(plan.direct_execution?.change_request_id)),
  ].filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
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
