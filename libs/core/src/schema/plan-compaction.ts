/**
 * Implementation Plan Compaction
 * ==============================
 *
 * Keeps implementation_plan.md small enough for downstream agents to read
 * reliably. Planner prompts can drift toward large analysis-heavy JSON; this
 * module preserves the executable plan surface and drops bulky optional fields
 * before the plan is written to disk.
 */

import {
  ImplementationPlanSchema,
  type ValidatedImplementationPlan,
  type ValidatedPlanPhase,
  type ValidatedPlanSubtask,
} from './implementation-plan.js';

type PlanCompactionLimits = Required<PlanCompactionOptions>;

export const PLAN_COMPACTION_LIMITS: PlanCompactionLimits = {
  maxPhases: Number.MAX_SAFE_INTEGER,
  maxTotalSubtasks: Number.MAX_SAFE_INTEGER,
  maxSubtasksPerPhase: Number.MAX_SAFE_INTEGER,
  maxFeatureChars: 240,
  maxPhaseNameChars: 120,
  maxSubtaskTitleChars: 120,
  maxSubtaskDescriptionChars: 700,
  maxSubtaskCompletionSummaryChars: 1200,
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
  maxSubtaskCompletionSummaryChars?: number;
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

type CompactVerification = {
  type: string;
  run?: string;
  scenario?: string;
};

const PLAN_TEXT_COMPACTION_NOTICE = ' ... [plan middle omitted for context budget] ... ';
const PLAN_REPEATED_LINE_MIN_CHARS = 24;

function mergeLimits(options?: PlanCompactionOptions): PlanCompactionLimits {
  return {
    ...PLAN_COMPACTION_LIMITS,
    ...options,
  };
}

function compactText(
  value: unknown,
  maxChars: number,
  fallback = '',
  options: { preserveTail?: boolean } = {},
): string {
  const text = typeof value === 'string' ? value : fallback;
  const normalized = foldRepeatedPlanLines(
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n'),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (options.preserveTail) {
    return limitHeadTailText(normalized, maxChars);
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function compactMultilineText(
  value: unknown,
  maxChars: number,
  fallback = '',
  options: { preserveTail?: boolean } = {},
): string {
  const text = typeof value === 'string' ? value : fallback;
  const normalized = foldRepeatedPlanLines(
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (options.preserveTail) {
    return limitHeadTailText(normalized, maxChars);
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function limitHeadTailText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= PLAN_TEXT_COMPACTION_NOTICE.length + 2) {
    return value.slice(0, maxChars);
  }

  const budget = maxChars - PLAN_TEXT_COMPACTION_NOTICE.length;
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    value.slice(0, headLength).trimEnd(),
    PLAN_TEXT_COMPACTION_NOTICE,
    value.slice(-tailLength).trimStart(),
  ].join('');
}

function compactCompletionSummary(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : '';
  const normalized = foldRepeatedPlanLines(
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  ).trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const leadingTableLines: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('|') || !line.endsWith('|')) {
      break;
    }
    leadingTableLines.push(line);
  }
  if (leadingTableLines.length >= 3) {
    const extraText = lines.slice(leadingTableLines.length).join(' ');
    const tableBudget = extraText ? Math.max(700, maxChars - 180) : maxChars;
    const perLineLimit = Math.max(120, Math.floor((tableBudget - leadingTableLines.length + 1) / leadingTableLines.length));
    const compactedTable = leadingTableLines
      .map((line) => compactTableLine(line, perLineLimit))
      .join('\n');
    if (!extraText) {
      return compactedTable.length <= maxChars
        ? compactedTable
        : `${compactedTable.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
    }
    const remaining = maxChars - compactedTable.length - 1;
    if (remaining <= 20) {
      return compactedTable.length <= maxChars
        ? compactedTable
        : `${compactedTable.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
    }
    return `${compactedTable}\n${compactText(extraText, remaining, '', { preserveTail: true })}`;
  }

  return compactMultilineText(normalized, maxChars, '', { preserveTail: true });
}

function compactTableLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) {
    return line;
  }

  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells.length <= 1) {
    return `${line.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const firstCell = cells[0];
  const detail = cells.slice(1).join(' | ');
  const availableForDetail = Math.max(20, maxChars - firstCell.length - 10);
  const compactedDetail = detail.length <= availableForDetail
    ? detail
    : limitHeadTailText(detail, availableForDetail);
  return `| ${firstCell} | ${compactedDetail} |`;
}

function foldRepeatedPlanLines(value: string): string {
  const lines = value.split('\n');
  const folded: string[] = [];
  let previousKey = '';
  let repeatedCount = 0;

  const flushRepeatedMarker = (): void => {
    if (repeatedCount <= 0) {
      return;
    }
    folded.push(`[... ${repeatedCount} repeated line(s) omitted for plan budget ...]`);
    repeatedCount = 0;
  };

  for (const line of lines) {
    const key = line.trim().replace(/\s+/g, ' ');
    if (
      key.length >= PLAN_REPEATED_LINE_MIN_CHARS &&
      key === previousKey
    ) {
      repeatedCount += 1;
      continue;
    }

    flushRepeatedMarker();
    folded.push(line);
    previousKey = key;
  }

  flushRepeatedMarker();
  return folded.join('\n');
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

function getEffectiveDescriptionLimit(totalSubtasks: number, limits: PlanCompactionLimits): number {
  if (totalSubtasks > 120) {
    return Math.min(limits.maxSubtaskDescriptionChars, 220);
  }
  if (totalSubtasks > 60) {
    return Math.min(limits.maxSubtaskDescriptionChars, 320);
  }
  if (totalSubtasks > 24) {
    return Math.min(limits.maxSubtaskDescriptionChars, 450);
  }
  return limits.maxSubtaskDescriptionChars;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function compactVerification(value: unknown, limits: PlanCompactionLimits): CompactVerification | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    const run = compactText(value, limits.maxVerificationRunChars, '', { preserveTail: true });
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
    '',
    { preserveTail: true },
  );
  const scenario = compactText(record.scenario ?? record.description, limits.maxVerificationRunChars, '', { preserveTail: true });

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
    { preserveTail: true },
  );
  const patternFiles = toStringArray(
    rawSubtask.pattern_files ?? rawSubtask.patterns_from ?? rawSubtask.files_to_reference,
    limits.maxPatternFiles,
    limits.maxFilePathChars,
  );
  const dependsOn = toStringArray(rawSubtask.depends_on, limits.maxSubtasksPerPhase, 80);
  const verification = compactVerification(subtask.verification ?? rawSubtask.verification, limits);
  const completionSummary = subtask.status === 'completed'
    ? compactCompletionSummary(
        rawSubtask.completion_summary
          ?? rawSubtask.completionSummary
          ?? rawSubtask.completed_summary
          ?? rawSubtask.notes
          ?? rawSubtask.actual_output,
        limits.maxSubtaskCompletionSummaryChars,
      )
    : '';
  const notes = compactText(rawSubtask.notes, limits.maxSubtaskDescriptionChars, '', { preserveTail: true });

  return {
    id: compactText(subtask.id, 80, `${phaseIndex + 1}-${subtaskIndex + 1}`),
    title,
    description,
    ...(completionSummary ? { completion_summary: completionSummary } : {}),
    ...(notes && notes !== completionSummary ? { notes } : {}),
    status: subtask.status,
    files_to_create: toStringArray(subtask.files_to_create, limits.maxFileRefsPerList, limits.maxFilePathChars),
    files_to_modify: toStringArray(subtask.files_to_modify, limits.maxFileRefsPerList, limits.maxFilePathChars),
    ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
    ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
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
  const effectiveLimits = {
    ...limits,
    maxSubtaskDescriptionChars: getEffectiveDescriptionLimit(originalSubtaskCount, limits),
  };
  const compactedPhases: Record<string, unknown>[] = [];
  let remainingSubtasks = effectiveLimits.maxTotalSubtasks;

  for (const phase of sourcePlan.phases.slice(0, effectiveLimits.maxPhases)) {
    if (remainingSubtasks <= 0) {
      break;
    }

    const compactedPhase = compactPhase(phase, compactedPhases.length, effectiveLimits, remainingSubtasks);
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
