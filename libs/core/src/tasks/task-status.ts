import type { AutocodeReviewReason, AutocodeTaskStatus } from './spec-store.js';

export function isCompletedAutocodeTask(
  status: AutocodeTaskStatus,
  reviewReason?: AutocodeReviewReason,
): boolean {
  if (status === 'done' || status === 'pr_created') {
    return true;
  }
  return status === 'human_review' && reviewReason === 'completed';
}

export const isCompletedTask = isCompletedAutocodeTask;
