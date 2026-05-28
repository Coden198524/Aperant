import type { AutocodeSubtaskStatus } from './spec-store.js';

export function calculateProgress(subtasks: ReadonlyArray<{ status: string }>): number {
  if (subtasks.length === 0) return 0;
  const completed = subtasks.filter((subtask) => subtask.status === 'completed').length;
  return Math.round((completed / subtasks.length) * 100);
}

export function countSubtasksByStatus(
  subtasks: ReadonlyArray<{ status: AutocodeSubtaskStatus }>,
): Record<AutocodeSubtaskStatus, number> {
  return {
    pending: subtasks.filter((subtask) => subtask.status === 'pending').length,
    in_progress: subtasks.filter((subtask) => subtask.status === 'in_progress').length,
    completed: subtasks.filter((subtask) => subtask.status === 'completed').length,
    failed: subtasks.filter((subtask) => subtask.status === 'failed').length,
  };
}

export function determineOverallStatus(
  subtasks: ReadonlyArray<{ status: string }>,
): 'not_started' | 'in_progress' | 'completed' | 'failed' {
  if (subtasks.length === 0) return 'not_started';

  const hasCompleted = subtasks.some((subtask) => subtask.status === 'completed');
  const hasFailed = subtasks.some((subtask) => subtask.status === 'failed');
  const hasInProgress = subtasks.some((subtask) => subtask.status === 'in_progress');
  const allCompleted = subtasks.every((subtask) => subtask.status === 'completed');
  const allPending = subtasks.every((subtask) => subtask.status === 'pending');

  if (allCompleted) return 'completed';
  if (hasFailed) return 'failed';
  if (hasInProgress || hasCompleted) return 'in_progress';
  if (allPending) return 'not_started';

  return 'in_progress';
}

export function formatProgressString(completed: number, total: number): string {
  if (total === 0) return 'No subtasks';
  return `${completed}/${total} subtasks`;
}

export function estimateRemainingTime(startTime: Date, progress: number): number | null {
  if (progress <= 0 || progress >= 100) return null;

  const elapsed = Date.now() - startTime.getTime();
  const estimatedTotal = (elapsed / progress) * 100;
  const remaining = estimatedTotal - elapsed;

  return Math.max(0, Math.round(remaining));
}
