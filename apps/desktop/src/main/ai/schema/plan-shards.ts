import {
  listAutocodeImplementationPlanWatchFiles,
  loadAutocodeImplementationPlan,
  loadAutocodeImplementationPlanSync,
  saveAutocodeImplementationPlan,
  saveAutocodeImplementationPlanSync,
  updateAutocodeImplementationPlan,
  type AutocodePlanUpdater,
  type MutableAutocodePlan,
} from '@autocode/core';

export const PLAN_SHARD_SUBTASK_THRESHOLD = Number.MAX_SAFE_INTEGER;

export type ShardableImplementationPlan = MutableAutocodePlan;

export interface WriteImplementationPlanFilesResult {
  plan: ShardableImplementationPlan;
  split: false;
  totalSubtasks: number;
  filesWritten: string[];
}

export async function writeImplementationPlanFiles(
  specDir: string,
  rawPlan: unknown,
): Promise<WriteImplementationPlanFilesResult | null> {
  if (!rawPlan || typeof rawPlan !== 'object') {
    return null;
  }
  const plan = rawPlan as ShardableImplementationPlan;
  await saveAutocodeImplementationPlan(specDir, plan);
  return {
    plan,
    split: false,
    totalSubtasks: countSubtasks(plan),
    filesWritten: listAutocodeImplementationPlanWatchFiles(specDir),
  };
}

export async function rewriteImplementationPlanFiles(
  specDir: string,
): Promise<WriteImplementationPlanFilesResult | null> {
  const plan = await loadImplementationPlanFromFiles(specDir);
  if (!plan) {
    return null;
  }
  return writeImplementationPlanFiles(specDir, plan);
}

export async function loadImplementationPlanFromFiles(
  specDirOrPlanPath: string,
): Promise<ShardableImplementationPlan | null> {
  return loadAutocodeImplementationPlan(specDirOrPlanPath) as Promise<ShardableImplementationPlan | null>;
}

export function loadImplementationPlanFromFilesSync(
  specDirOrPlanPath: string,
): ShardableImplementationPlan | null {
  return loadAutocodeImplementationPlanSync(specDirOrPlanPath) as ShardableImplementationPlan | null;
}

export async function saveImplementationPlanToFiles(
  specDirOrPlanPath: string,
  plan: ShardableImplementationPlan,
): Promise<void> {
  await saveAutocodeImplementationPlan(specDirOrPlanPath, plan);
}

export async function updateImplementationPlanInFiles(
  specDirOrPlanPath: string,
  updater: AutocodePlanUpdater,
): Promise<ShardableImplementationPlan | null> {
  const plan = await updateAutocodeImplementationPlan(specDirOrPlanPath, updater);
  return plan as ShardableImplementationPlan | null;
}

export function saveImplementationPlanToFilesSync(
  specDirOrPlanPath: string,
  plan: ShardableImplementationPlan,
): void {
  saveAutocodeImplementationPlanSync(specDirOrPlanPath, plan);
}

export function listImplementationPlanWatchFiles(specDir: string): string[] {
  return listAutocodeImplementationPlanWatchFiles(specDir);
}

function countSubtasks(plan: ShardableImplementationPlan): number {
  return (plan.phases ?? []).reduce((total, phase) => {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return total + subtasks.length;
  }, 0);
}
