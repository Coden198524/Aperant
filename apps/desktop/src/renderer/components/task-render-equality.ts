import type { Task } from '../../shared/types';

/**
 * Compare the task fields that affect kanban card rendering.
 * Keep this in sync with TaskCard's rendered data so parent memo layers
 * do not swallow card updates.
 */
export function isTaskRenderEquivalent(prevTask: Task, nextTask: Task): boolean {
  return (
    prevTask.id === nextTask.id &&
    prevTask.status === nextTask.status &&
    prevTask.title === nextTask.title &&
    prevTask.description === nextTask.description &&
    prevTask.updatedAt === nextTask.updatedAt &&
    prevTask.reviewReason === nextTask.reviewReason &&
    prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
    prevTask.executionProgress?.phaseProgress === nextTask.executionProgress?.phaseProgress &&
    prevTask.executionProgress?.currentSubtask === nextTask.executionProgress?.currentSubtask &&
    prevTask.subtasks.length === nextTask.subtasks.length &&
    prevTask.metadata?.workflowMode === nextTask.metadata?.workflowMode &&
    prevTask.metadata?.category === nextTask.metadata?.category &&
    prevTask.metadata?.complexity === nextTask.metadata?.complexity &&
    prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
    prevTask.metadata?.prUrl === nextTask.metadata?.prUrl &&
    prevTask.tokenUsage?.stepsExecuted === nextTask.tokenUsage?.stepsExecuted &&
    prevTask.tokenUsage?.promptTokens === nextTask.tokenUsage?.promptTokens &&
    prevTask.tokenUsage?.completionTokens === nextTask.tokenUsage?.completionTokens &&
    prevTask.tokenUsage?.totalTokens === nextTask.tokenUsage?.totalTokens &&
    prevTask.subtasks.every((subtask, index) =>
      subtask.status === nextTask.subtasks[index]?.status &&
      subtask.title === nextTask.subtasks[index]?.title &&
      subtask.description === nextTask.subtasks[index]?.description &&
      subtask.completionSummary === nextTask.subtasks[index]?.completionSummary
    )
  );
}

export function areTaskListsRenderEquivalent(prevTasks: Task[], nextTasks: Task[]): boolean {
  if (prevTasks.length !== nextTasks.length) return false;
  if (prevTasks === nextTasks) return true;

  for (let i = 0; i < prevTasks.length; i++) {
    if (!isTaskRenderEquivalent(prevTasks[i], nextTasks[i])) {
      return false;
    }
  }

  return true;
}
