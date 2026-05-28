import type { AutocodeReviewReason, AutocodeTaskStatus } from './spec-store.js';
import type { ExecutionPhase } from './phase-protocol.js';

export const TASK_STATE_NAMES = [
  'backlog',
  'planning',
  'plan_review',
  'coding',
  'qa_review',
  'qa_fixing',
  'human_review',
  'error',
  'creating_pr',
  'pr_created',
  'done',
] as const;

export type TaskStateName = (typeof TASK_STATE_NAMES)[number];

export const XSTATE_SETTLED_STATES: ReadonlySet<string> = new Set<TaskStateName>([
  'plan_review',
  'human_review',
  'error',
  'creating_pr',
  'pr_created',
  'done',
]);

export const XSTATE_ACTIVE_STATES: ReadonlySet<string> = new Set<TaskStateName>([
  'planning',
  'coding',
  'qa_review',
  'qa_fixing',
]);

export const XSTATE_TO_PHASE: Record<TaskStateName, ExecutionPhase> & Record<string, ExecutionPhase | undefined> = {
  backlog: 'idle',
  planning: 'planning',
  plan_review: 'planning',
  coding: 'coding',
  qa_review: 'qa_review',
  qa_fixing: 'qa_fixing',
  human_review: 'complete',
  error: 'failed',
  creating_pr: 'complete',
  pr_created: 'complete',
  done: 'complete',
};

export function mapStateToLegacy(
  state: string,
  reviewReason?: AutocodeReviewReason,
): { status: AutocodeTaskStatus; reviewReason?: AutocodeReviewReason } {
  switch (state) {
    case 'backlog':
      return { status: 'backlog' };
    case 'planning':
    case 'coding':
      return { status: 'in_progress' };
    case 'plan_review':
      return { status: 'human_review', reviewReason: 'plan_review' };
    case 'qa_review':
    case 'qa_fixing':
      return { status: 'ai_review' };
    case 'human_review':
      return { status: 'human_review', reviewReason: reviewReason ?? 'completed' };
    case 'error':
      return { status: 'human_review', reviewReason: 'errors' };
    case 'creating_pr':
      return { status: 'human_review', reviewReason: 'completed' };
    case 'pr_created':
      return { status: 'pr_created' };
    case 'done':
      return { status: 'done' };
    default:
      return { status: 'backlog' };
  }
}
