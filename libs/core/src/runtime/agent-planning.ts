import {
  analyzeAutocodeWorkDependencies,
  normalizeAutocodeWorkDependencyIds,
} from './work-dependencies.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import type { AutocodeTaskRuntimeConcurrencyResolved } from './concurrency.js';

export const AUTOCODE_DEFAULT_RUNTIME_CONCURRENCY: AutocodeTaskRuntimeConcurrencyResolved = {
  mode: 'serial',
  workers: 1,
  unit: 'work_item',
  conflictPolicy: 'lock-and-queue',
};

export interface AutocodePlanningSchedulePlan {
  phases?: AutocodePlanningSchedulePhase[];
}

export interface AutocodePlanningSchedulePhase {
  subtasks?: AutocodePlanningScheduleSubtask[];
}

export interface AutocodePlanningScheduleSubtask {
  id: string;
  status: string;
  depends_on?: unknown;
  verification?: unknown;
}

export interface AutocodePlanningSchedulingValidationOptions {
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyResolved;
  sourceType?: string | null;
}

export function isAutocodeWriteToolPlanOutputFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("tool 'write'") &&
    (lower.includes(AUTOCODE_TASK_ARTIFACTS.implementationPlan) ||
      lower.includes(AUTOCODE_TASK_ARTIFACTS.tasks) ||
      lower.includes('input json failed') ||
      lower.includes('json parsing failed') ||
      lower.includes('invalid input') ||
      lower.includes('received invalid input type'));
}

export function isAutocodeImplementationPlanFileFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes(AUTOCODE_TASK_ARTIFACTS.implementationPlan) ||
    lower.includes(AUTOCODE_TASK_ARTIFACTS.tasks);
}

export function shouldRequireAutocodePlanningSchedulingMetadata(
  options: AutocodePlanningSchedulingValidationOptions,
): boolean {
  const runtimeConcurrency = options.runtimeConcurrency ?? AUTOCODE_DEFAULT_RUNTIME_CONCURRENCY;
  if (runtimeConcurrency.mode !== 'concurrent' || runtimeConcurrency.workers <= 1) {
    return false;
  }

  return options.sourceType !== 'openspec';
}

export function validateAutocodePlanningSchedulingMetadata(
  plan: AutocodePlanningSchedulePlan | null | undefined,
  options: AutocodePlanningSchedulingValidationOptions,
): string[] {
  if (!plan || !shouldRequireAutocodePlanningSchedulingMetadata(options)) {
    return [];
  }

  const errors: string[] = [];
  const items: Array<{ id: string; status: string; dependsOn: string[] }> = [];

  for (const phase of plan.phases ?? []) {
    for (const subtask of phase.subtasks ?? []) {
      items.push({
        id: subtask.id,
        status: subtask.status,
        dependsOn: normalizeAutocodeWorkDependencyIds(subtask.depends_on),
      });

      const hasDependencyMetadata = Object.hasOwn(subtask, 'depends_on');
      const hasVerificationMetadata = Object.hasOwn(subtask, 'verification') &&
        subtask.verification !== undefined;

      if (!hasDependencyMetadata) {
        errors.push(`${subtask.id} missing _Depends on: ..._ metadata`);
      }
      if (!hasVerificationMetadata) {
        errors.push(`${subtask.id} missing _Verification: ..._ metadata`);
      }
    }
  }

  const dependencyIssues = analyzeAutocodeWorkDependencies(items, {
    statusById: new Map(items.map((item) => [item.id, 'completed'])),
  }).issues;
  errors.push(...dependencyIssues.map((issue) => issue.message));

  return errors;
}

export function buildAutocodePlanningStructuredOutputRetryPrompt(errorMessage: string): string {
  return [
    'RETRY TASKS WRITE',
    '',
    `Previous Write call failed before execution: ${errorMessage}`,
    '',
    `Retry by writing ${AUTOCODE_TASK_ARTIFACTS.tasks} with the Write tool.`,
    'Write checklist Markdown, not JSON. Each Write input is one object with file_path and content.',
    'Use forward slashes in file_path.',
    'Use "- [ ] 1. Phase title" and "- [ ] 1.1 Subtask title" with _Files_, _Depends on_, _Requirements_, and _Verification_.',
    'Every executable task must include exactly one _Depends on: ..._ line; use none only for root work.',
    'File metadata is write intent only. Use _Files to modify: none_ for read-only validation and do not mark final verification as modifying all files.',
    'Normal task lists should target 4 phases or fewer and about 24 tasks or fewer.',
    'For complex tasks, keep necessary tasks concise in the single Markdown file.',
    'Omit top-level summary, verification_strategy, qa_acceptance, research notes, copied source, and long analysis.',
  ].join('\n');
}

export function buildAutocodePlanningStructuredOutputValidationRetryPrompt(errors: string[]): string {
  return [
    'REWRITE TASKS SOURCE',
    '',
    'The previous tasks.md could not be converted into a valid runtime plan.',
    '',
    'Errors:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Retry with the Write tool; do not paste the full task list into the final response.',
    'Use forward slashes in file_path.',
    `Rewrite ${AUTOCODE_TASK_ARTIFACTS.tasks} as checklist Markdown with task markers such as "- [ ] 2.1 Title".`,
    'Every executable task must include exactly one _Depends on: ..._ line; use none only for root work.',
    'File metadata is write intent only. Use _Files to modify: none_ for read-only validation and do not mark final verification as modifying all files.',
    'Normal task lists should target 4 phases or fewer and about 24 tasks or fewer.',
    'For complex tasks, keep descriptions concise instead of splitting files.',
    'Omit top-level summary, verification_strategy, qa_acceptance, research notes, copied source, and long analysis.',
  ].join('\n');
}

export function buildAutocodeStandardTasksValidationRetryPrompt(errors: string[]): string {
  return [
    'REWRITE TASKS SOURCE',
    '',
    'The previous Standard planning output could not be converted into runtime work packages.',
    '',
    'Errors:',
    ...errors.map((error) => `- ${error}`),
    '',
    `Retry with the Write tool and rewrite ${AUTOCODE_TASK_ARTIFACTS.tasks}, not ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`,
    'Use checklist Markdown with phase items such as "- [ ] 1. Phase" and task items such as "- [ ] 1.1 Task".',
    'Every executable task must include _Depends on_ and _Verification_. Include _Files to create/modify_ when write intent is known.',
    'Use _Depends on: none_ only for root tasks. Add real dependencies for tasks that share files or consume prior outputs.',
    'Keep independent tasks dependency-free when they can run safely in parallel.',
  ].join('\n');
}
