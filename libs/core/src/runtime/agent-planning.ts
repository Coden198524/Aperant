import {
  analyzeAutocodeWorkDependencies,
  normalizeAutocodeWorkDependencyIds,
} from './work-dependencies.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { isTraceableAutocodeEvidence } from '../tasks/plan-quality.js';
import {
  compactAutocodeRetryLine,
  formatAutocodeRetryErrorLines,
} from '../text/compaction.js';
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
  evidence?: unknown;
  verification?: unknown;
}

export interface AutocodePlanningSchedulingValidationOptions {
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyResolved;
  requireEvidence?: boolean;
  developmentMode?: string;
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

  return true;
}

export function validateAutocodePlanningSchedulingMetadata(
  plan: AutocodePlanningSchedulePlan | null | undefined,
  options: AutocodePlanningSchedulingValidationOptions,
): string[] {
  const requireEvidence = options.requireEvidence === true || options.developmentMode === 'standard';
  if (!plan || (!shouldRequireAutocodePlanningSchedulingMetadata(options) && !requireEvidence)) {
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
      const hasEvidenceMetadata = Object.hasOwn(subtask, 'evidence') &&
        isTraceableAutocodeEvidence(subtask.evidence);
      const hasVerificationMetadata = Object.hasOwn(subtask, 'verification') &&
        subtask.verification !== undefined;

      if (!hasDependencyMetadata) {
        errors.push(`${subtask.id} missing _Depends on: ..._ metadata`);
      }
      if (requireEvidence && !hasEvidenceMetadata) {
        errors.push(`${subtask.id} missing _Evidence: ..._ metadata`);
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
    `Previous Write call failed before execution: ${compactAutocodeRetryLine(errorMessage, 420)}`,
    '',
    `Retry by writing ${AUTOCODE_TASK_ARTIFACTS.tasks} with the Write tool.`,
    'Write checklist Markdown, not JSON. Each Write input is one object with file_path and content.',
    'Use forward slashes in file_path.',
    'Use "- [ ] 1. Phase title" and "- [ ] 1.1 Subtask title" with _Files_, _Depends on_, _Requirements_, _Evidence_, and _Verification_.',
    'Every executable task must include exactly one _Depends on: ..._ line; use none only for root work.',
    'Every executable task must include one _Evidence: ..._ line citing spec.md, requirements.md, context.md, project source/docs, or verified official/industry references.',
    'Cover every requirement, scenario, acceptance criterion, or success criterion from spec.md/requirements.md; call out blocked or out-of-scope items instead of dropping them.',
    'Keep each executable task small enough for one focused coding session and include a clear done signal in guidance or _Done when: ..._.',
    'File metadata is write intent only. Use _Files to modify: none_ for read-only validation and do not mark final verification as modifying all files.',
    'Do not cap tasks.md by phase or task count; include every concrete required task.',
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
    ...formatAutocodeRetryErrorLines(errors),
    '',
    'Retry with the Write tool; do not paste the full task list into the final response.',
    'Use forward slashes in file_path.',
    `Rewrite ${AUTOCODE_TASK_ARTIFACTS.tasks} as checklist Markdown with task markers such as "- [ ] 2.1 Title".`,
    'Every executable task must include exactly one _Depends on: ..._ line; use none only for root work.',
    'Every executable task must include one _Evidence: ..._ line citing spec.md, requirements.md, context.md, project source/docs, or verified official/industry references.',
    'Cover every requirement, scenario, acceptance criterion, or success criterion from spec.md/requirements.md; call out blocked or out-of-scope items instead of dropping them.',
    'Keep each executable task small enough for one focused coding session and include a clear done signal in guidance or _Done when: ..._.',
    'File metadata is write intent only. Use _Files to modify: none_ for read-only validation and do not mark final verification as modifying all files.',
    'Do not cap tasks.md by phase or task count; include every concrete required task.',
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
    ...formatAutocodeRetryErrorLines(errors),
    '',
    `Retry with the Write tool and rewrite ${AUTOCODE_TASK_ARTIFACTS.tasks}, not ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`,
    'Use checklist Markdown with phase items such as "- [ ] 1. Phase" and task items such as "- [ ] 1.1 Task".',
    'Every executable task must include _Depends on_, _Evidence_, and _Verification_. Include _Files to create/modify_ when write intent is known.',
    'Evidence must cite spec.md, requirements.md, context.md, project source/docs, existing project patterns, or verified official/industry references. Do not use "none" or vague guesses.',
    'Cover every requirement, scenario, acceptance criterion, or success criterion from spec.md/requirements.md; call out blocked or out-of-scope items instead of dropping them.',
    'Keep each executable task small enough for one focused coding session and include a clear done signal in guidance or _Done when: ..._.',
    'Use _Depends on: none_ only for root tasks. Add real dependencies for tasks that share files or consume prior outputs.',
    'Keep independent tasks dependency-free when they can run safely in parallel.',
  ].join('\n');
}
