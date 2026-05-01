/**
 * Implementation Plan Compaction
 * ==============================
 *
 * Keeps implementation_plan.json small enough for downstream agents to read
 * reliably. Planner prompts can drift toward large analysis-heavy JSON; this
 * module preserves the executable plan surface and drops bulky optional fields
 * before the plan is written to disk.
 */

import { readFile } from 'node:fs/promises';

import { safeParseJson } from '../../utils/json-repair';
import { writeFileAtomic } from '../../utils/atomic-file';
import {
  ImplementationPlanSchema,
  type ValidatedImplementationPlan,
  type ValidatedPlanPhase,
  type ValidatedPlanSubtask,
} from './implementation-plan';

type PlanCompactionLimits = Required<PlanCompactionOptions>;

export const PLAN_COMPACTION_LIMITS: PlanCompactionLimits = {
  maxPhases: 4,
  maxTotalSubtasks: 24,
  maxSubtasksPerPhase: 8,
  maxFeatureChars: 240,
  maxPhaseNameChars: 120,
  maxSubtaskTitleChars: 120,
  maxSubtaskDescriptionChars: 700,
  maxFileRefsPerList: 12,
  maxFilePathChars: 240,
  maxVerificationRunChars: 300,
  maxPatternFiles: 8,
};

export interface PlanCompactionOptions {
  maxPhases?: number;
  maxTotalSubtasks?: number;
  maxSubtasksPerPhase?: number;
  maxFeatureChars?: number;
  maxPhaseNameChars?: number;
  maxSubtaskTitleChars?: number;
  maxSubtaskDescriptionChars?: number;
  maxFileRefsPerList?: number;
  maxFilePathChars?: number;
  maxVerificationRunChars?: number;
  maxPatternFiles?: number;
}

export interface PlanCompactionResult {
  plan: Record<string, unknown>;
  changed: boolean;
  originalPhaseCount: number;
  compactedPhaseCount: number;
  originalSubtaskCount: number;
  compactedSubtaskCount: number;
}

export interface PlanFileCompactionResult extends PlanCompactionResult {
  valid: true;
}

export interface PlanFileCompactionSkipped {
  valid: false;
  reason: string;
}

type CompactVerification = {
  type: string;
  run?: string;
  scenario?: string;
};

function mergeLimits(options?: PlanCompactionOptions): PlanCompactionLimits {
  return {
    ...PLAN_COMPACTION_LIMITS,
    ...options,
  };
}

function compactText(value: unknown, maxChars: number, fallback = ''): string {
  const text = typeof value === 'string' ? value : fallback;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function toStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (result.length >= maxItems) {
      break;
    }
    if (typeof item !== 'string') {
      continue;
    }
    const compacted = compactText(item, maxChars);
    if (!compacted || seen.has(compacted)) {
      continue;
    }
    seen.add(compacted);
    result.push(compacted);
  }

  return result;
}

function countSubtasks(plan: ValidatedImplementationPlan): number {
  return plan.phases.reduce((total, phase) => total + phase.subtasks.length, 0);
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function compactVerification(value: unknown, limits: PlanCompactionLimits): CompactVerification | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    const run = compactText(value, limits.maxVerificationRunChars);
    return run ? { type: 'manual', run } : undefined;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = compactText(record.type ?? record.method, 40, 'manual') || 'manual';
  const run = compactText(
    record.run ?? record.command ?? record.instructions ?? record.expected ?? record.expected_outcome,
    limits.maxVerificationRunChars,
  );
  const scenario = compactText(record.scenario ?? record.description, limits.maxVerificationRunChars);

  return {
    type,
    ...(run ? { run } : {}),
    ...(scenario ? { scenario } : {}),
  };
}

function compactPhase(
  phase: ValidatedPlanPhase,
  phaseIndex: number,
  limits: PlanCompactionLimits,
  remainingSubtasks: number,
): Record<string, unknown> | null {
  const rawPhase = getRecord(phase);
  const subtasks = phase.subtasks.slice(0, Math.min(limits.maxSubtasksPerPhase, remainingSubtasks));

  if (subtasks.length === 0) {
    return null;
  }

  const compactedSubtasks = subtasks.map((subtask, subtaskIndex) => compactSubtask(
    subtask,
    phaseIndex,
    subtaskIndex,
    limits,
  ));

  return {
    id: compactText(phase.id ?? rawPhase.phase ?? String(phaseIndex + 1), 80, String(phaseIndex + 1)),
    name: compactText(phase.name, limits.maxPhaseNameChars, `Phase ${phaseIndex + 1}`),
    ...(Array.isArray(phase.depends_on) && phase.depends_on.length > 0
      ? { depends_on: phase.depends_on.slice(0, limits.maxPhases).map(String) }
      : {}),
    subtasks: compactedSubtasks,
  };
}

function compactSubtask(
  subtask: ValidatedPlanSubtask,
  phaseIndex: number,
  subtaskIndex: number,
  limits: PlanCompactionLimits,
): Record<string, unknown> {
  const rawSubtask = getRecord(subtask);
  const title = compactText(subtask.title, limits.maxSubtaskTitleChars, `Task ${phaseIndex + 1}-${subtaskIndex + 1}`);
  const description = compactText(
    subtask.description,
    limits.maxSubtaskDescriptionChars,
    title,
  );
  const patternFiles = toStringArray(
    rawSubtask.pattern_files ?? rawSubtask.patterns_from ?? rawSubtask.files_to_reference,
    limits.maxPatternFiles,
    limits.maxFilePathChars,
  );
  const verification = compactVerification(subtask.verification ?? rawSubtask.verification, limits);

  return {
    id: compactText(subtask.id, 80, `${phaseIndex + 1}-${subtaskIndex + 1}`),
    title,
    description,
    status: subtask.status,
    files_to_create: toStringArray(subtask.files_to_create, limits.maxFileRefsPerList, limits.maxFilePathChars),
    files_to_modify: toStringArray(subtask.files_to_modify, limits.maxFileRefsPerList, limits.maxFilePathChars),
    ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
    ...(verification ? { verification } : {}),
  };
}

export function compactImplementationPlan(
  rawPlan: unknown,
  options?: PlanCompactionOptions,
): PlanCompactionResult | null {
  const parsed = ImplementationPlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    return null;
  }

  const limits = mergeLimits(options);
  const sourcePlan = parsed.data;
  const originalPhaseCount = sourcePlan.phases.length;
  const originalSubtaskCount = countSubtasks(sourcePlan);
  const compactedPhases: Record<string, unknown>[] = [];
  let remainingSubtasks = limits.maxTotalSubtasks;

  for (const phase of sourcePlan.phases.slice(0, limits.maxPhases)) {
    if (remainingSubtasks <= 0) {
      break;
    }

    const compactedPhase = compactPhase(phase, compactedPhases.length, limits, remainingSubtasks);
    if (!compactedPhase) {
      continue;
    }

    compactedPhases.push(compactedPhase);
    remainingSubtasks -= (compactedPhase.subtasks as unknown[]).length;
  }

  if (compactedPhases.length === 0) {
    return null;
  }

  const compactedSubtaskCount = compactedPhases.reduce(
    (total, phase) => total + ((phase.subtasks as unknown[])?.length ?? 0),
    0,
  );
  const rawRecord = getRecord(sourcePlan);
  const compactedPlan: Record<string, unknown> = {
    feature: compactText(sourcePlan.feature, limits.maxFeatureChars, 'Implementation task'),
    workflow_type: compactText(sourcePlan.workflow_type, 40, 'feature'),
    phases: compactedPhases,
  };

  if (rawRecord.qa_signoff !== undefined) {
    compactedPlan.qa_signoff = rawRecord.qa_signoff;
  }

  const changed = JSON.stringify(sourcePlan) !== JSON.stringify(compactedPlan);

  return {
    plan: compactedPlan,
    changed,
    originalPhaseCount,
    compactedPhaseCount: compactedPhases.length,
    originalSubtaskCount,
    compactedSubtaskCount,
  };
}

export async function compactImplementationPlanFile(
  filePath: string,
  options?: PlanCompactionOptions,
): Promise<PlanFileCompactionResult | PlanFileCompactionSkipped> {
  let rawContent: string;
  try {
    rawContent = await readFile(filePath, 'utf-8');
  } catch {
    return { valid: false, reason: `File not found: ${filePath}` };
  }

  const parsed = safeParseJson<unknown>(rawContent);
  if (parsed === null) {
    return { valid: false, reason: 'Invalid JSON syntax that could not be compacted' };
  }

  const result = compactImplementationPlan(parsed, options);
  if (!result) {
    return { valid: false, reason: 'Plan does not match the implementation plan schema' };
  }

  if (result.changed) {
    await writeFileAtomic(filePath, JSON.stringify(result.plan, null, 2), {
      encoding: 'utf-8',
    });
  }

  return {
    valid: true,
    ...result,
  };
}
