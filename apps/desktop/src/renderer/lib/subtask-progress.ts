import { resolveAutocodeActiveSubtaskIndex } from '@autocode/core/frontend/subtask-progress';
import type { ExecutionPhase, Subtask } from '../../shared/types';

interface ResolveActiveSubtaskOptions {
  subtasks: Subtask[];
  currentSubtask?: string | null;
  isRunning?: boolean;
  phase?: ExecutionPhase;
}

export function resolveActiveSubtaskIndex(options: ResolveActiveSubtaskOptions): number {
  return resolveAutocodeActiveSubtaskIndex(options);
}
