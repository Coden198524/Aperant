import type { AutocodeSessionResult } from './agent-session-types.js';
import {
  analyzeAutocodeWorkDependencies,
  buildAutocodeWorkDependencyStatusMap,
  describeAutocodeWorkDependencyBlocker,
  normalizeAutocodeWorkDependencyIds,
} from './work-dependencies.js';

export interface AutocodeSubtaskPlan<TSubtask extends AutocodePlanSubtask = AutocodePlanSubtask> {
  phases: Array<AutocodeSubtaskPlanPhase<TSubtask>>;
}

export interface AutocodeSubtaskPlanPhase<TSubtask extends AutocodePlanSubtask = AutocodePlanSubtask> {
  name: string;
  subtasks: TSubtask[];
}

export interface AutocodePlanSubtask {
  id?: string;
  subtask_id?: string;
  status?: string;
  completion_summary?: string;
  completed_at?: string;
  files_to_create?: unknown;
  files_to_modify?: unknown;
  pattern_files?: unknown;
  depends_on?: unknown;
}

export interface AutocodeDependencyBlockedSubtask<TSubtask extends AutocodePlanSubtask = AutocodePlanSubtask> {
  subtask: TSubtask;
  phaseName: string;
  reason: string;
}

interface AutocodeDependencyCandidate<TSubtask extends AutocodePlanSubtask> {
  id: string;
  status: string;
  dependsOn: string[];
  subtask: TSubtask;
  phaseName: string;
}

export function toAutocodeStringArray(value: unknown): string[] {
  return normalizeAutocodeWorkDependencyIds(value);
}

export function hasAutocodeDeclaredField(value: object, field: string): boolean {
  return Object.hasOwn(value, field);
}

export function hasAutocodeDeclaredFileMetadata(subtask: AutocodePlanSubtask): boolean {
  return hasAutocodeDeclaredField(subtask, 'files_to_create') ||
    hasAutocodeDeclaredField(subtask, 'files_to_modify') ||
    hasAutocodeDeclaredField(subtask, 'pattern_files');
}

export function getAutocodeSubtaskId(subtask: AutocodePlanSubtask): string | undefined {
  return subtask.id ?? subtask.subtask_id;
}

export function hasAutocodeSubtaskCompletionEvidence(subtask: AutocodePlanSubtask): boolean {
  if (subtask.status === 'completed') {
    return true;
  }

  if (typeof subtask.completed_at === 'string' && subtask.completed_at.trim().length > 0) {
    return true;
  }

  return typeof subtask.completion_summary === 'string' &&
    subtask.completion_summary.trim().length > 0;
}

export function countAutocodeSubtaskPlanSubtasks(plan: AutocodeSubtaskPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    count += phase.subtasks.length;
  }
  return count;
}

export function countAutocodeCompletedSubtaskPlanSubtasks(plan: AutocodeSubtaskPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (hasAutocodeSubtaskCompletionEvidence(subtask)) {
        count += 1;
      }
    }
  }
  return count;
}

export function getAutocodeSubtaskStatusMap(plan: AutocodeSubtaskPlan): Map<string, string> {
  return buildAutocodeWorkDependencyStatusMap(
    plan.phases.flatMap((phase) => phase.subtasks.map((subtask) => ({
      id: getAutocodeSubtaskId(subtask) ?? '',
      status: subtask.status ?? '',
      dependsOn: toAutocodeStringArray(subtask.depends_on),
    }))),
  );
}

function collectAutocodeDependencyCandidates<TSubtask extends AutocodePlanSubtask>(
  plan: AutocodeSubtaskPlan<TSubtask>,
  stuckSubtaskIds: readonly string[],
): Array<AutocodeDependencyCandidate<TSubtask>> {
  const stuck = new Set(stuckSubtaskIds);
  const candidates: Array<AutocodeDependencyCandidate<TSubtask>> = [];

  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      const subtaskId = getAutocodeSubtaskId(subtask);
      if (!subtaskId || hasAutocodeSubtaskCompletionEvidence(subtask) || stuck.has(subtaskId)) {
        continue;
      }
      if (subtask.status === 'pending' || subtask.status === 'in_progress') {
        candidates.push({
          id: subtaskId,
          status: subtask.status,
          dependsOn: toAutocodeStringArray(subtask.depends_on),
          subtask,
          phaseName: phase.name,
        });
      }
    }
  }

  return candidates;
}

export function getAutocodeNextPendingSubtask<TSubtask extends AutocodePlanSubtask>(
  plan: AutocodeSubtaskPlan<TSubtask>,
  stuckSubtaskIds: readonly string[],
): { subtask: TSubtask; phaseName: string } | null {
  const statusById = getAutocodeSubtaskStatusMap(plan);
  const next = analyzeAutocodeWorkDependencies(
    collectAutocodeDependencyCandidates(plan, stuckSubtaskIds),
    { statusById },
  ).runnable[0];

  return next ? { subtask: next.subtask, phaseName: next.phaseName } : null;
}

export function getAutocodeDependencyBlockedSubtasks<TSubtask extends AutocodePlanSubtask>(
  plan: AutocodeSubtaskPlan<TSubtask>,
  stuckSubtaskIds: readonly string[],
): Array<AutocodeDependencyBlockedSubtask<TSubtask>> {
  const statusById = getAutocodeSubtaskStatusMap(plan);
  return analyzeAutocodeWorkDependencies(
    collectAutocodeDependencyCandidates(plan, stuckSubtaskIds),
    { statusById },
  ).blocked
    .filter((blocked) => blocked.item.dependsOn.length > 0 || blocked.issues.length > 0)
    .map((blocked) => ({
      subtask: blocked.item.subtask,
      phaseName: blocked.item.phaseName,
      reason: describeAutocodeWorkDependencyBlocker(blocked, statusById),
    }));
}

export function summarizeAutocodeSessionResult(
  result: Pick<AutocodeSessionResult, 'messages' | 'outcome' | 'error'>,
): string | undefined {
  const content = [...result.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim())?.content;

  if (content) {
    const table = extractAutocodeCompletionSummaryTable(content);
    if (table) {
      return table;
    }

    const normalized = content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[#*_>\-[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (normalized) {
      const maxLength = 3000;
      return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
    }
  }

  if (result.outcome === 'completed') {
    return 'Session completed successfully.';
  }

  if (result.error?.message) {
    return result.error.message;
  }

  return undefined;
}

export function summarizeAutocodeFailureResult(
  result: Pick<AutocodeSessionResult, 'messages' | 'outcome' | 'error'>,
  fallback: string,
): string {
  return summarizeAutocodeSessionResult(result) ?? fallback;
}

export function createAutocodeBlockedSessionResult(reason: string): AutocodeSessionResult {
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

export function extractAutocodeCompletionSummaryTable(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const tableStart = lines.findIndex((line) =>
    /^\|\s*(Item|项目)\s*\|\s*(Details|详情)\s*\|$/i.test(line.trim()),
  );
  if (tableStart < 0) {
    return undefined;
  }

  const tableLines: string[] = [];
  for (const line of lines.slice(tableStart)) {
    if (!line.trim().startsWith('|')) {
      break;
    }
    tableLines.push(line);
  }

  return tableLines.length > 0 ? tableLines.join('\n') : undefined;
}
