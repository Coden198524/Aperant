import type { ExecutionPhase, Subtask } from '../../shared/types';

interface ResolveActiveSubtaskOptions {
  subtasks: Subtask[];
  currentSubtask?: string | null;
  isRunning?: boolean;
  phase?: ExecutionPhase;
}

function parseIndexHint(value: string, total: number): number {
  // Direct index hints: "2", "#2", "2/5", "subtask 2/5"
  const ratioMatch = value.match(/(\d+)\s*\/\s*(\d+)/);
  if (ratioMatch) {
    const index = Number.parseInt(ratioMatch[1], 10) - 1;
    if (Number.isFinite(index) && index >= 0 && index < total) {
      return index;
    }
  }

  const plainMatch = value.match(/^#?\s*(\d+)$/);
  if (plainMatch) {
    const index = Number.parseInt(plainMatch[1], 10) - 1;
    if (Number.isFinite(index) && index >= 0 && index < total) {
      return index;
    }
  }

  return -1;
}

export function resolveActiveSubtaskIndex({
  subtasks,
  currentSubtask,
  isRunning = false,
  phase,
}: ResolveActiveSubtaskOptions): number {
  if (!subtasks.length) {
    return -1;
  }

  const explicitInProgressIndex = subtasks.findIndex((subtask) => subtask.status === 'in_progress');
  if (explicitInProgressIndex >= 0) {
    return explicitInProgressIndex;
  }

  const hint = currentSubtask?.trim();
  if (hint) {
    const normalizedHint = hint.toLowerCase();

    const byId = subtasks.findIndex((subtask) => subtask.id.toLowerCase() === normalizedHint);
    if (byId >= 0) {
      return byId;
    }

    const byTitle = subtasks.findIndex((subtask) => subtask.title.trim().toLowerCase() === normalizedHint);
    if (byTitle >= 0) {
      return byTitle;
    }

    const hintedIndex = parseIndexHint(normalizedHint, subtasks.length);
    if (hintedIndex >= 0) {
      return hintedIndex;
    }
  }

  const isCodingActive = isRunning || phase === 'coding';
  if (isCodingActive) {
    const firstPending = subtasks.findIndex((subtask) => subtask.status === 'pending');
    if (firstPending >= 0) {
      return firstPending;
    }
  }

  return -1;
}
