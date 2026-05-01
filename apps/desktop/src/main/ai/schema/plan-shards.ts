/**
 * Implementation Plan Shards
 * ==========================
 *
 * Large tasks can produce implementation plans with many subtasks. Keeping all
 * subtask details in one implementation_plan.json makes every read/write heavy
 * and increases the chance of tool-call truncation. This module stores the main
 * plan as an index and writes each phase's subtasks to its own phase plan file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { safeParseJson } from '../../utils/json-repair';
import { writeFileAtomic, writeFileAtomicSync } from '../../utils/atomic-file';
import { compactImplementationPlan } from './plan-compaction';

export const PLAN_SHARD_SUBTASK_THRESHOLD = 40;
const PLAN_INDEX_FILE = 'implementation_plan.json';
const PLAN_SHARD_PREFIX = 'implementation_plan.phase-';
const PLAN_SHARD_SUFFIX = '.json';

interface PlanSubtask {
  id: string;
  status?: string;
  [key: string]: unknown;
}

interface PlanPhase {
  id?: string;
  phase?: number;
  name?: string;
  subtasks?: PlanSubtask[];
  subtasks_file?: string;
  subtask_count?: number;
  status_counts?: Record<string, number>;
  [key: string]: unknown;
}

export interface ShardableImplementationPlan extends Record<string, unknown> {
  feature?: string;
  workflow_type?: string;
  split_plan?: boolean;
  plan_files?: Array<{
    phase_id: string;
    phase_name: string;
    file: string;
    subtask_count: number;
  }>;
  phases?: PlanPhase[];
}

export interface WriteImplementationPlanFilesResult {
  plan: ShardableImplementationPlan;
  split: boolean;
  totalSubtasks: number;
  filesWritten: string[];
}

function countSubtasks(plan: ShardableImplementationPlan): number {
  return (plan.phases ?? []).reduce((total, phase) => total + (phase.subtasks?.length ?? 0), 0);
}

function statusCounts(subtasks: PlanSubtask[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const subtask of subtasks) {
    const status = typeof subtask.status === 'string' ? subtask.status : 'pending';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function safeFilePart(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : fallback;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return normalized || fallback;
}

function phaseId(phase: PlanPhase, index: number): string {
  return String(phase.id ?? phase.phase ?? index + 1);
}

function phaseName(phase: PlanPhase, index: number): string {
  return typeof phase.name === 'string' && phase.name.trim()
    ? phase.name.trim()
    : `Phase ${index + 1}`;
}

function phaseFileName(phase: PlanPhase, index: number): string {
  return `${PLAN_SHARD_PREFIX}${safeFilePart(phaseId(phase, index), String(index + 1))}${PLAN_SHARD_SUFFIX}`;
}

function isSplitPlan(plan: ShardableImplementationPlan): boolean {
  return plan.split_plan === true || (plan.phases ?? []).some((phase) => typeof phase.subtasks_file === 'string');
}

function toPlan(rawPlan: unknown): ShardableImplementationPlan | null {
  const compacted = compactImplementationPlan(rawPlan);
  const plan = (compacted?.plan ?? rawPlan) as ShardableImplementationPlan;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.phases)) {
    return null;
  }
  return plan;
}

function phaseFromShard(raw: unknown, indexPhase: PlanPhase): PlanPhase | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const phase = record.phase && typeof record.phase === 'object'
    ? record.phase as PlanPhase
    : Array.isArray(record.phases)
      ? record.phases[0] as PlanPhase | undefined
      : record as PlanPhase;

  if (!phase || !Array.isArray(phase.subtasks)) {
    return null;
  }

  return {
    ...indexPhase,
    ...phase,
    subtasks: phase.subtasks,
  };
}

function buildIndexPlan(plan: ShardableImplementationPlan): ShardableImplementationPlan {
  const phases = plan.phases ?? [];
  const planFiles: NonNullable<ShardableImplementationPlan['plan_files']> = [];
  const indexPhases = phases.map((phase, index) => {
    const subtasks = phase.subtasks ?? [];
    const file = phaseFileName(phase, index);
    const id = phaseId(phase, index);
    const name = phaseName(phase, index);
    planFiles.push({
      phase_id: id,
      phase_name: name,
      file,
      subtask_count: subtasks.length,
    });

    const { subtasks: _subtasks, ...phaseMeta } = phase;
    return {
      ...phaseMeta,
      id,
      name,
      subtasks_file: file,
      subtask_count: subtasks.length,
      status_counts: statusCounts(subtasks),
      subtasks: [],
    };
  });

  return {
    ...plan,
    split_plan: true,
    plan_files: planFiles,
    phases: indexPhases,
  };
}

function buildPhaseShard(
  plan: ShardableImplementationPlan,
  phase: PlanPhase,
  index: number,
): ShardableImplementationPlan {
  return {
    feature: plan.feature,
    workflow_type: plan.workflow_type,
    split_plan_phase: true,
    phase_id: phaseId(phase, index),
    phase_name: phaseName(phase, index),
    phase: {
      ...phase,
      id: phaseId(phase, index),
      name: phaseName(phase, index),
      subtasks: phase.subtasks ?? [],
    },
  };
}

export async function writeImplementationPlanFiles(
  specDir: string,
  rawPlan: unknown,
  options: { forceSplit?: boolean; threshold?: number } = {},
): Promise<WriteImplementationPlanFilesResult | null> {
  const plan = toPlan(rawPlan);
  if (!plan) {
    return null;
  }

  const totalSubtasks = countSubtasks(plan);
  const shouldSplit = options.forceSplit === true ||
    totalSubtasks > (options.threshold ?? PLAN_SHARD_SUBTASK_THRESHOLD);
  const planPath = join(specDir, PLAN_INDEX_FILE);

  if (!shouldSplit) {
    await writeFileAtomic(planPath, JSON.stringify({
      ...plan,
      split_plan: false,
      plan_files: undefined,
    }, null, 2), { encoding: 'utf-8' });
    return {
      plan,
      split: false,
      totalSubtasks,
      filesWritten: [planPath],
    };
  }

  const filesWritten: string[] = [];
  for (const [index, phase] of (plan.phases ?? []).entries()) {
    const file = phaseFileName(phase, index);
    const shardPath = join(specDir, file);
    await writeFileAtomic(shardPath, JSON.stringify(buildPhaseShard(plan, phase, index), null, 2), {
      encoding: 'utf-8',
    });
    filesWritten.push(shardPath);
  }

  const indexPlan = buildIndexPlan(plan);
  await writeFileAtomic(planPath, JSON.stringify(indexPlan, null, 2), { encoding: 'utf-8' });
  filesWritten.push(planPath);

  return {
    plan: indexPlan,
    split: true,
    totalSubtasks,
    filesWritten,
  };
}

export async function rewriteImplementationPlanFiles(
  specDir: string,
  options: { forceSplit?: boolean; threshold?: number } = {},
): Promise<WriteImplementationPlanFilesResult | null> {
  const plan = await loadImplementationPlanFromFiles(specDir);
  if (!plan) {
    return null;
  }
  return writeImplementationPlanFiles(specDir, plan, options);
}

export async function loadImplementationPlanFromFiles(
  specDir: string,
): Promise<ShardableImplementationPlan | null> {
  try {
    const planPath = join(specDir, PLAN_INDEX_FILE);
    const raw = await readFile(planPath, 'utf-8');
    const plan = safeParseJson<ShardableImplementationPlan>(raw);
    if (!plan) {
      return null;
    }
    return hydratePlan(specDir, plan);
  } catch {
    return null;
  }
}

export function loadImplementationPlanFromFilesSync(
  specDirOrPlanPath: string,
): ShardableImplementationPlan | null {
  try {
    const planPath = basename(specDirOrPlanPath) === PLAN_INDEX_FILE
      ? specDirOrPlanPath
      : join(specDirOrPlanPath, PLAN_INDEX_FILE);
    const raw = readFileSync(planPath, 'utf-8');
    const plan = safeParseJson<ShardableImplementationPlan>(raw);
    if (!plan) {
      return null;
    }
    return hydratePlan(dirname(planPath), plan);
  } catch {
    return null;
  }
}

function hydratePlan(
  specDir: string,
  plan: ShardableImplementationPlan,
): ShardableImplementationPlan {
  if (!isSplitPlan(plan)) {
    return plan;
  }

  const hydratedPhases = (plan.phases ?? []).map((phase) => {
    if (Array.isArray(phase.subtasks) && phase.subtasks.length > 0) {
      return phase;
    }
    if (typeof phase.subtasks_file !== 'string') {
      return phase;
    }

    try {
      const shardPath = join(specDir, phase.subtasks_file);
      const raw = readFileSync(shardPath, 'utf-8');
      const shard = safeParseJson<unknown>(raw);
      return phaseFromShard(shard, phase) ?? phase;
    } catch {
      return phase;
    }
  });

  return {
    ...plan,
    phases: hydratedPhases,
  };
}

export async function saveImplementationPlanToFiles(
  specDir: string,
  plan: ShardableImplementationPlan,
): Promise<void> {
  if (!isSplitPlan(plan)) {
    await writeFileAtomic(join(specDir, PLAN_INDEX_FILE), JSON.stringify(plan, null, 2), {
      encoding: 'utf-8',
    });
    return;
  }
  await writeImplementationPlanFiles(specDir, plan, { forceSplit: true });
}

export function saveImplementationPlanToFilesSync(
  specDirOrPlanPath: string,
  plan: ShardableImplementationPlan,
): void {
  const planPath = basename(specDirOrPlanPath) === PLAN_INDEX_FILE
    ? specDirOrPlanPath
    : join(specDirOrPlanPath, PLAN_INDEX_FILE);
  const specDir = dirname(planPath);

  if (!isSplitPlan(plan)) {
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    return;
  }

  for (const [index, phase] of (plan.phases ?? []).entries()) {
    const file = typeof phase.subtasks_file === 'string'
      ? phase.subtasks_file
      : phaseFileName(phase, index);
    writeFileAtomicSync(
      join(specDir, file),
      JSON.stringify(buildPhaseShard(plan, phase, index), null, 2),
    );
  }

  writeFileAtomicSync(planPath, JSON.stringify(buildIndexPlan(plan), null, 2));
}

export function listImplementationPlanWatchFiles(specDir: string): string[] {
  const planPath = join(specDir, PLAN_INDEX_FILE);
  if (!existsSync(planPath)) {
    return [];
  }

  const files = [planPath];
  try {
    const plan = loadImplementationPlanFromFilesSync(specDir);
    if (plan?.split_plan && Array.isArray(plan.plan_files)) {
      for (const item of plan.plan_files) {
        if (typeof item.file === 'string') {
          files.push(join(specDir, item.file));
        }
      }
    }
  } catch {
    // Main plan is still enough to watch.
  }

  return Array.from(new Set(files));
}
