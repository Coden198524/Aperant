import type { AutocodeSessionResult } from './agent-session-types.js';

export interface AutocodeWorkExecutorItem {
  id: string;
  phaseId?: string;
  phaseName?: string;
  description: string;
  verification?: string;
  dependsOn?: string[];
  hasFileMetadata?: boolean;
}

export interface AutocodeWorkExecutorResult<TSession extends { outcome: string } = AutocodeSessionResult> {
  completed: string[];
  failed: string[];
  blocked: string[];
  sessionResult: TSession;
}

const HIGH_RISK_UNSCOPED_WORK_PATTERN =
  /\b(refactor|restructure|architecture|migration|global|cross-cutting|shared|config|schema|security|auth|permission|database|persistence|routing|build|pipeline|concurrent|parallel|framework)\b/i;

export function createAutocodeAdaptiveConcurrency<TSession extends { outcome: string }>(
  maxWorkers: number,
  log: (message: string) => void,
) {
  let workers = Math.max(1, Math.floor(maxWorkers || 1));
  let cleanConcurrentGroups = 0;

  return {
    current() {
      return workers;
    },
    recordGroupResult(
      result: AutocodeWorkExecutorResult<TSession>,
      mode: 'concurrent' | 'serial',
      pressure: 'rate_limited' | 'auth_failure' | null,
    ) {
      if (mode !== 'concurrent' || maxWorkers <= 1) {
        return;
      }

      if (
        result.failed.length > 0 ||
        pressure ||
        result.sessionResult.outcome === 'rate_limited' ||
        result.sessionResult.outcome === 'auth_failure'
      ) {
        cleanConcurrentGroups = 0;
        const nextWorkers = Math.max(1, Math.floor(workers / 2));
        if (nextWorkers < workers) {
          workers = nextWorkers;
          log(`[ConcurrentWorkExecutor] Reduced concurrent workers to ${workers} after ${pressure ?? 'failure'} pressure`);
        }
        return;
      }

      if (result.completed.length > 0 && workers < maxWorkers) {
        cleanConcurrentGroups += 1;
        if (cleanConcurrentGroups >= 1) {
          workers += 1;
          cleanConcurrentGroups = 0;
          log(`[ConcurrentWorkExecutor] Increased concurrent workers to ${workers}`);
        }
      }
    },
  };
}

export function shouldSerializeAutocodeHighRiskUnscopedWorkItem(
  workItem: AutocodeWorkExecutorItem,
): boolean {
  if (workItem.hasFileMetadata !== false) {
    return false;
  }

  const intentText = [
    workItem.description,
    workItem.phaseName,
    workItem.phaseId,
    workItem.verification,
    ...(workItem.dependsOn ?? []),
  ].filter(Boolean).join(' ');

  return HIGH_RISK_UNSCOPED_WORK_PATTERN.test(intentText);
}

export function partitionAutocodeHighRiskUnscopedWorkItems<T extends AutocodeWorkExecutorItem>(
  workItems: T[],
): {
  scopedItems: T[];
  highRiskUnscopedItems: T[];
} {
  const scopedItems: T[] = [];
  const highRiskUnscopedItems: T[] = [];

  for (const workItem of workItems) {
    if (shouldSerializeAutocodeHighRiskUnscopedWorkItem(workItem)) {
      highRiskUnscopedItems.push(workItem);
    } else {
      scopedItems.push(workItem);
    }
  }

  return { scopedItems, highRiskUnscopedItems };
}

export function summarizeAutocodeWorkItemResults<
  TResult extends AutocodeWorkExecutorResult<TSession>,
  TSession extends { outcome: string },
>(results: TResult[], completedSessionResult: TSession): AutocodeWorkExecutorResult<TSession> {
  const completed = results.flatMap((result) => result.completed);
  const failed = results.flatMap((result) => result.failed);
  const blocked = results.flatMap((result) => result.blocked);
  const sessionResult = results.find((result) => result.sessionResult.outcome !== 'completed')?.sessionResult
    ?? results[0]?.sessionResult
    ?? completedSessionResult;

  return { completed, failed, blocked, sessionResult };
}
