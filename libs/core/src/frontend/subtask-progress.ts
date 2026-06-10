export interface AutocodeSubtaskProgressItem {
  id: string;
  title: string;
  status: string;
}

export interface ResolveAutocodeActiveSubtaskOptions {
  subtasks: AutocodeSubtaskProgressItem[];
  currentSubtask?: string | null;
  isRunning?: boolean;
  phase?: string;
}

function parseAutocodeSubtaskIndexHint(value: string, total: number): number {
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

export function resolveAutocodeActiveSubtaskIndex({
  subtasks,
  currentSubtask,
  isRunning = false,
  phase,
}: ResolveAutocodeActiveSubtaskOptions): number {
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

    const hintedIndex = parseAutocodeSubtaskIndexHint(normalizedHint, subtasks.length);
    if (hintedIndex >= 0) {
      return hintedIndex;
    }
  }

  if (isRunning || phase === 'coding') {
    const firstPending = subtasks.findIndex((subtask) => subtask.status === 'pending');
    if (firstPending >= 0) {
      return firstPending;
    }
  }

  return -1;
}
