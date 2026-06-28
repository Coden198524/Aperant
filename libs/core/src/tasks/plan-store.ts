import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { foldRepeatedAutocodePromptLines } from '../runtime/prompt-context.js';
import {
  type AutocodeRuntimeFileWriteLockInput,
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  withAutocodeRuntimeFileWriteLock,
  withAutocodeRuntimeFileWriteLockSync,
} from '../runtime/workspace-claims.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import type {
  MutableAutocodePlan,
  MutableAutocodePlanPhase,
  MutableAutocodePlanSubtask,
} from './plan-file.js';

export type AutocodePlanMarkdownStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';

const MAX_AUTOCODE_PLAN_NOTE_FIELD_CHARS = 1200;

export type AutocodePlanUpdateResult = MutableAutocodePlan | void | false | null;
export type AutocodePlanUpdater = (
  plan: MutableAutocodePlan,
) => AutocodePlanUpdateResult | Promise<AutocodePlanUpdateResult>;

interface ParsedPlanItem {
  id: string;
  title: string;
  status: AutocodePlanMarkdownStatus;
  indent: number;
  details: string[];
  files: string[];
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  dependsOn: string[];
  requirements: string[];
  architecture?: string;
  evidence?: string;
  verification?: string;
  hasFilesField: boolean;
  hasFilesToCreateField: boolean;
  hasFilesToModifyField: boolean;
  hasPatternFilesField: boolean;
  hasDependsOnField: boolean;
  hasRequirementsField: boolean;
  hasArchitectureField: boolean;
  hasEvidenceField: boolean;
  hasVerificationField: boolean;
  completion?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  updatedAt?: string;
}

const STATUS_TO_MARKER: Record<AutocodePlanMarkdownStatus, string> = {
  pending: ' ',
  in_progress: '/',
  completed: 'x',
  blocked: '-',
  failed: '!',
};

const MARKER_TO_STATUS: Record<string, AutocodePlanMarkdownStatus> = {
  ' ': 'pending',
  '/': 'in_progress',
  x: 'completed',
  X: 'completed',
  '-': 'blocked',
  '!': 'failed',
};

const PLAN_ITEM_PATTERN = /^(\s*)-\s+\[([ xX/!\-])\]\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\.)?\s+(.+?)\s*$/;
const PLAN_FIELD_PATTERN = /^\s*-\s+(?:[_*`]+)?\s*([^:：*_`]+?)\s*(?:[_*`]+)?\s*[:：]\s*(?:[_*`]+)?\s*(.*?)\s*(?:[_*`]+)?\s*$/u;
const PLAN_DETAIL_PATTERN = /^\s*-\s+(.*)$/;
const PLAN_MACHINE_META_PATTERN = /^<!--\s*autocode-plan-meta:\s*(\{.*\})\s*-->\s*$/;
const planUpdateQueues = new Map<string, Promise<void>>();

const MACHINE_META_KEYS = [
  'planStatus',
  'xstateState',
  'last_updated',
  'stagedInMainProject',
  'stagedAt',
  'tokenUsage',
  'qa_signoff',
  'qa_iteration_history',
  'qa_stats',
  'direct_execution',
  'source_task',
  'services_involved',
  'documentation_depth',
  'project_type',
  'documentation_profile',
  'documentation_focus',
  'document_outputs',
  'subtaskMetadata',
] as const;

export function getAutocodeImplementationPlanPath(specDir: string): string {
  return join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
}

export function resolveAutocodePlanSpecDir(specDirOrPlanPath: string): string {
  return basename(specDirOrPlanPath) === AUTOCODE_TASK_ARTIFACTS.implementationPlan
    ? dirname(specDirOrPlanPath)
    : specDirOrPlanPath;
}

export function parseAutocodeImplementationPlanMarkdown(content: string): MutableAutocodePlan {
  const plan: MutableAutocodePlan = { phases: [] };
  const items: ParsedPlanItem[] = [];
  let descriptionSectionLines: string[] | null = null;
  let current: ParsedPlanItem | undefined;

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const machineMeta = parseMachineMetadataLine(line);
    if (machineMeta) {
      Object.assign(plan, machineMeta);
      continue;
    }

    const itemMatch = PLAN_ITEM_PATTERN.exec(line);
    if (itemMatch) {
      current = {
        id: itemMatch[3],
        title: itemMatch[4].trim(),
        status: MARKER_TO_STATUS[itemMatch[2]] ?? 'pending',
        indent: itemMatch[1].length,
        details: [],
        files: [],
        filesToCreate: [],
        filesToModify: [],
        patternFiles: [],
        dependsOn: [],
        requirements: [],
        architecture: undefined,
        evidence: undefined,
        hasFilesField: false,
        hasFilesToCreateField: false,
        hasFilesToModifyField: false,
        hasPatternFilesField: false,
        hasDependsOnField: false,
        hasRequirementsField: false,
        hasArchitectureField: false,
        hasEvidenceField: false,
        hasVerificationField: false,
      };
      items.push(current);
      continue;
    }

    if (!current && /^##\s+Description\s*$/i.test(line.trim())) {
      descriptionSectionLines = [];
      continue;
    }

    if (!current && descriptionSectionLines) {
      descriptionSectionLines.push(line);
      continue;
    }

    const metadata = parsePlanMetadataLine(line);
    if (metadata && !current) {
      plan[metadata.key] = metadata.value;
      continue;
    }

    if (!current) {
      continue;
    }

    const fieldMatch = PLAN_FIELD_PATTERN.exec(line);
    if (fieldMatch) {
      applyPlanItemField(current, fieldMatch[1], fieldMatch[2]);
      continue;
    }

    const detailMatch = PLAN_DETAIL_PATTERN.exec(line);
    if (detailMatch) {
      const detail = detailMatch[1].trim();
      if (detail) {
        current.details.push(detail);
      }
    } else if (line.trim()) {
      current.details.push(line.trim());
    }
  }

  const descriptionSection = normalizeMarkdownSectionText(descriptionSectionLines);
  if (descriptionSection) {
    plan.description = descriptionSection;
  } else if (typeof plan.description === 'string') {
    plan.description = expandLegacyInlineDescriptionMarkdown(plan.description, plan.feature);
  }

  plan.phases = buildPlanPhases(items);
  applySubtaskMachineMetadata(plan);
  return plan;
}

export function stringifyAutocodeImplementationPlanMarkdown(plan: MutableAutocodePlan): string {
  const lines: string[] = ['# Implementation Plan', ''];
  addMetadataLine(lines, 'Feature', plan.feature);
  addMetadataLine(lines, 'Workflow', plan.workflow_type);
  addMetadataLine(lines, 'Status', plan.status ?? plan.planStatus);
  addMetadataLine(lines, 'Review Reason', plan.reviewReason);
  addMetadataLine(lines, 'Execution Phase', plan.executionPhase);
  addMetadataLine(lines, 'Created', plan.created_at);
  addMetadataLine(lines, 'Updated', plan.updated_at);
  const machineMetadata = pickMachineMetadata(plan);
  if (machineMetadata) {
    lines.push(`<!-- autocode-plan-meta: ${JSON.stringify(machineMetadata)} -->`);
  }
  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }

  addMarkdownSection(lines, 'Description', plan.description);

  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  for (const [phaseIndex, phase] of phases.entries()) {
    const phaseId = stringifyPlanValue(phase.id ?? phase.phase ?? phaseIndex + 1);
    const phaseName = stringifyPlanValue(phase.name)
      || stringifyPlanValue(phase.title)
      || `Phase ${phaseIndex + 1}`;
    lines.push(`- [ ] ${phaseId}. ${phaseName}`);

    const phaseDependsOn = arrayFromUnknown(phase.depends_on);
    if (phaseDependsOn.length > 0) {
      lines.push(`  - _Depends on: ${phaseDependsOn.join(', ')}_`);
    }

    for (const [subtaskIndex, subtask] of getPhaseSubtasks(phase).entries()) {
      const fallbackId = `${phaseId}.${subtaskIndex + 1}`;
      const subtaskId = stringifyPlanValue(subtask.id ?? subtask.subtask_id ?? fallbackId);
      const title = stringifyPlanValue(subtask.title)
        || stringifyPlanValue(subtask.description)
        || `Subtask ${subtaskId}`;
      const status = normalizeMarkdownStatus(subtask.status);
      lines.push('');
      lines.push(`  - [${STATUS_TO_MARKER[status]}] ${subtaskId} ${title}`);

      const description = stringifyPlanValue(subtask.description);
      if (description && description !== title) {
        for (const detailLine of description.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
          lines.push(`    - ${detailLine}`);
        }
      }

      addListField(lines, 'Files', subtask.files, '    ');
      addListField(lines, 'Files to create', subtask.files_to_create, '    ');
      addListField(lines, 'Files to modify', subtask.files_to_modify, '    ', { writeNoneWhenEmptyArray: true });
      addListField(lines, 'Pattern files', subtask.pattern_files, '    ');
      addListField(lines, 'Depends on', subtask.depends_on, '    ', { writeNoneWhenEmptyArray: true });
      addListField(lines, 'Requirements', subtask.requirements, '    ');

      const architecture = stringifyPlanValue(subtask.architecture);
      if (architecture) {
        lines.push(`    - _Architecture: ${compactInlineMarkdownField(architecture)}_`);
      }

      const evidence = stringifyPlanValue(subtask.evidence);
      if (evidence) {
        lines.push(`    - _Evidence: ${compactInlineMarkdownField(evidence)}_`);
      }

      const verification = stringifyVerification(subtask.verification);
      if (verification) {
        lines.push(`    - _Verification: ${verification}_`);
      }

      const completion = stringifyPlanValue(
        subtask.completion_summary ?? subtask.completionSummary ?? subtask.completed_summary ?? subtask.notes,
      );
      if (completion && status === 'completed') {
        lines.push(`    - _Completion: ${compactInlineMarkdownField(completion)}_`);
      }

      const started = stringifyPlanValue(subtask.started_at);
      if (started) {
        lines.push(`    - _Started: ${compactInlineMarkdownField(started)}_`);
      }

      const completed = stringifyPlanValue(subtask.completed_at);
      if (completed) {
        lines.push(`    - _Completed: ${compactInlineMarkdownField(completed)}_`);
      }

      const updated = stringifyPlanValue(subtask.updated_at ?? subtask.completed_at);
      if (updated) {
        lines.push(`    - _Updated: ${compactInlineMarkdownField(updated)}_`);
      }
    }

    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function loadAutocodeImplementationPlanSync(specDirOrPlanPath: string): MutableAutocodePlan | null {
  const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
  const planPath = getAutocodeImplementationPlanPath(specDir);
  if (!existsSync(planPath)) {
    return null;
  }
  try {
    return parseAutocodeImplementationPlanMarkdown(readFileSync(planPath, 'utf-8'));
  } catch {
    return null;
  }
}

export async function loadAutocodeImplementationPlan(specDirOrPlanPath: string): Promise<MutableAutocodePlan | null> {
  return loadAutocodeImplementationPlanSync(specDirOrPlanPath);
}

export async function saveAutocodeImplementationPlan(
  specDirOrPlanPath: string,
  plan: MutableAutocodePlan,
): Promise<void> {
  await enqueueAutocodePlanUpdate(specDirOrPlanPath, async () => {
    const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
    await withAutocodeRuntimeFileWriteLock(
      getAutocodePlanFileWriteLockInput(specDir, 'implementation-plan:save'),
      async () => {
        mkdirSync(specDir, { recursive: true });
        await writeFile(
          getAutocodeImplementationPlanPath(specDir),
          stringifyAutocodeImplementationPlanMarkdown(plan),
          'utf-8',
        );
      },
    );
  });
}

export function saveAutocodeImplementationPlanSync(specDirOrPlanPath: string, plan: MutableAutocodePlan): void {
  const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
  withAutocodeRuntimeFileWriteLockSync(
    getAutocodePlanFileWriteLockInput(specDir, 'implementation-plan:save-sync'),
    () => {
      mkdirSync(specDir, { recursive: true });
      writeFileSync(
        getAutocodeImplementationPlanPath(specDir),
        stringifyAutocodeImplementationPlanMarkdown(plan),
        'utf-8',
      );
    },
  );
}

export async function updateAutocodeImplementationPlan(
  specDirOrPlanPath: string,
  updater: AutocodePlanUpdater,
): Promise<MutableAutocodePlan | null> {
  return enqueueAutocodePlanUpdate(specDirOrPlanPath, async () => {
    const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
    return withAutocodeRuntimeFileWriteLock(
      getAutocodePlanFileWriteLockInput(specDir, 'implementation-plan:update'),
      async () => {
        const plan = loadAutocodeImplementationPlanSync(specDir);
        if (!plan) {
          return null;
        }

        const updateResult = await updater(plan);
        if (updateResult === false || updateResult === null) {
          return plan;
        }

        const nextPlan = updateResult ?? plan;
        mkdirSync(specDir, { recursive: true });
        await writeFile(
          getAutocodeImplementationPlanPath(specDir),
          stringifyAutocodeImplementationPlanMarkdown(nextPlan),
          'utf-8',
        );
        return nextPlan;
      },
    );
  });
}

export function listAutocodeImplementationPlanWatchFiles(specDir: string): string[] {
  const planPath = getAutocodeImplementationPlanPath(specDir);
  return existsSync(planPath) ? [planPath] : [];
}

export function updateAutocodePlanSubtask(
  plan: MutableAutocodePlan,
  subtaskId: string,
  input: {
    status: AutocodePlanMarkdownStatus | string;
    notes?: string;
    completionSummary?: string;
    now?: string;
  },
): boolean {
  const now = input.now ?? new Date().toISOString();
  for (const phase of plan.phases ?? []) {
    for (const subtask of getPhaseSubtasks(phase)) {
      const id = stringifyPlanValue(subtask.id ?? subtask.subtask_id);
      if (id !== subtaskId) {
        continue;
      }
      subtask.status = normalizeMarkdownStatus(input.status);
      if (input.notes) {
        subtask.notes = compactStoredPlanNoteField(input.notes);
      }
      if (subtask.status === 'completed') {
        const summary = compactStoredPlanNoteField(input.completionSummary || input.notes);
        if (summary) {
          subtask.completion_summary = summary;
          subtask.notes = summary;
        }
      }
      subtask.updated_at = now;
      plan.updated_at = now;
      plan.last_updated = now;
      return true;
    }
  }
  return false;
}

async function enqueueAutocodePlanUpdate<T>(
  specDirOrPlanPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
  const planPath = resolve(getAutocodeImplementationPlanPath(specDir));
  const previous = planUpdateQueues.get(planPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  planUpdateQueues.set(planPath, settled);

  try {
    return await current;
  } finally {
    if (planUpdateQueues.get(planPath) === settled) {
      planUpdateQueues.delete(planPath);
    }
  }
}

function getAutocodePlanFileWriteLockInput(
  specDir: string,
  ownerId: string,
): AutocodeRuntimeFileWriteLockInput {
  const scope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(specDir);
  return {
    ...scope,
    filePath: getAutocodeImplementationPlanPath(specDir),
    ownerId,
  };
}

export function applyAutocodePlanQaSignoff(
  plan: MutableAutocodePlan,
  input: {
    status: string;
    issues?: unknown[];
    testsPassed?: Record<string, unknown>;
    now?: string;
  },
): number {
  const current = plan.qa_signoff && typeof plan.qa_signoff === 'object'
    ? plan.qa_signoff as { qa_session?: unknown }
    : undefined;
  let qaSession = typeof current?.qa_session === 'number' ? current.qa_session : 0;
  if (input.status === 'in_review' || input.status === 'rejected') {
    qaSession++;
  }

  const now = input.now ?? new Date().toISOString();
  plan.qa_signoff = {
    status: input.status,
    qa_session: qaSession,
    issues_found: input.issues ?? [],
    tests_passed: input.testsPassed ?? {},
    timestamp: now,
    ready_for_qa_revalidation: input.status === 'fixes_applied',
  };
  plan.updated_at = now;
  plan.last_updated = now;
  return qaSession;
}

function parsePlanMetadataLine(line: string): { key: string; value: string } | null {
  const match = /^(Feature|Description|Workflow|Status|Review Reason|Execution Phase|Created|Updated):\s*(.*?)\s*$/i.exec(line);
  if (!match || !match[2]) {
    return null;
  }
  const keyMap: Record<string, string> = {
    feature: 'feature',
    description: 'description',
    workflow: 'workflow_type',
    status: 'status',
    'review reason': 'reviewReason',
    'execution phase': 'executionPhase',
    created: 'created_at',
    updated: 'updated_at',
  };
  return { key: keyMap[match[1].toLowerCase()], value: match[2].trim() };
}

function parseMachineMetadataLine(line: string): Record<string, unknown> | null {
  const match = PLAN_MACHINE_META_PATTERN.exec(line.trim());
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function pickMachineMetadata(plan: MutableAutocodePlan): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  for (const key of MACHINE_META_KEYS) {
    const value = plan[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  const subtaskMetadata = collectSubtaskMachineMetadata(plan);
  if (Object.keys(subtaskMetadata).length > 0) {
    metadata.subtaskMetadata = subtaskMetadata;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function collectSubtaskMachineMetadata(plan: MutableAutocodePlan): Record<string, Record<string, unknown>> {
  const metadata: Record<string, Record<string, unknown>> = {};
  for (const phase of plan.phases ?? []) {
    for (const subtask of getPhaseSubtasks(phase)) {
      const id = stringifyPlanValue(subtask.id ?? subtask.subtask_id);
      if (!id) {
        continue;
      }
      const fields: Record<string, unknown> = {};
      for (const key of [
        'completion_summary',
        'notes',
        'completed_at',
        'started_at',
        'duration_ms',
        'work_package',
        'upstream_task_ids',
        'upstream_source',
        'files',
        'files_to_create',
        'files_to_modify',
        'pattern_files',
        'depends_on',
        'requirements',
        'architecture',
        'evidence',
        'verification',
        'service',
      ]) {
        if (subtask[key] !== undefined) {
          fields[key] = key === 'completion_summary' || key === 'notes'
            ? compactStoredPlanNoteField(subtask[key])
            : subtask[key];
        }
      }
      if (Object.keys(fields).length > 0) {
        metadata[id] = fields;
      }
    }
  }
  return metadata;
}

function applySubtaskMachineMetadata(plan: MutableAutocodePlan): void {
  const metadata = plan.subtaskMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return;
  }
  for (const phase of plan.phases ?? []) {
    for (const subtask of getPhaseSubtasks(phase)) {
      const id = stringifyPlanValue(subtask.id ?? subtask.subtask_id);
      if (!id) {
        continue;
      }
      const fields = (metadata as Record<string, unknown>)[id];
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        continue;
      }
      const fieldRecord = fields as Record<string, unknown>;
      for (const key of [
        'completion_summary',
        'notes',
        'completed_at',
        'started_at',
        'duration_ms',
        'work_package',
        'upstream_task_ids',
        'upstream_source',
        'files',
        'files_to_create',
        'files_to_modify',
        'pattern_files',
        'depends_on',
        'requirements',
        'architecture',
        'evidence',
        'verification',
        'service',
      ]) {
        if (fieldRecord[key] !== undefined) {
          subtask[key] = fieldRecord[key];
        }
      }
    }
  }
}

function applyPlanItemField(item: ParsedPlanItem, rawKey: string, rawValue: string): void {
  const key = normalizePlanFieldKey(rawKey);
  const value = rawValue.trim();
  switch (key) {
    case 'files':
    case 'files to create/modify':
    case 'files to create or modify':
    case 'files to update':
    case 'files to change':
    case 'file write intent':
    case 'write intent':
    case '文件':
    case '相关文件':
    case '涉及文件':
    case '文件写入意图':
      item.hasFilesField = true;
      item.files = splitPlanList(value);
      break;
    case 'files to create':
    case 'files to add':
    case '创建文件':
    case '新增文件':
    case '待创建文件':
      item.hasFilesToCreateField = true;
      item.filesToCreate = splitPlanList(value);
      break;
    case 'files to modify':
    case 'files to update/modify':
    case 'files to create/update':
    case 'files to create or update':
    case '修改文件':
    case '待修改文件':
    case '更新文件':
      item.hasFilesToModifyField = true;
      item.filesToModify = splitPlanList(value);
      break;
    case 'pattern files':
    case 'patterns from':
    case 'source pattern':
    case 'source patterns':
    case '参考文件':
    case '参考模式':
      item.hasPatternFilesField = true;
      item.patternFiles = splitPlanList(value);
      break;
    case 'depends on':
    case 'dependency':
    case 'dependencies':
    case '依赖':
    case '前置依赖':
      item.hasDependsOnField = true;
      item.dependsOn = splitPlanList(value);
      break;
    case 'requirements':
    case 'requirement':
    case 'requirements coverage':
    case 'acceptance criteria':
    case 'success criteria':
    case '需求':
    case '需求覆盖':
    case '验收标准':
    case '成功标准':
      item.hasRequirementsField = true;
      item.requirements = splitPlanList(value);
      break;
    case 'architecture':
    case 'architecture/pattern':
    case 'design pattern':
    case 'pattern guidance':
    case 'boundary/pattern':
    case '架构':
    case '设计模式':
      item.hasArchitectureField = true;
      item.architecture = item.architecture || value;
      break;
    case 'evidence':
    case 'source evidence':
    case 'evidence sources':
    case '证据':
    case '证据来源':
    case '依据':
      item.hasEvidenceField = true;
      item.evidence = value;
      break;
    case 'verification':
    case 'verify':
    case 'validation':
    case '验证':
    case '验证方式':
      item.hasVerificationField = true;
      item.verification = value;
      break;
    case 'completion':
      item.completion = value;
      break;
    case 'started':
      item.startedAt = value;
      break;
    case 'completed':
      item.completedAt = value;
      break;
    case 'duration':
      {
        const durationMs = parseDurationMs(value);
        if (durationMs !== undefined) {
          item.durationMs = durationMs;
        }
      }
      break;
    case 'updated':
      item.updatedAt = value;
      break;
    default:
      if (value) {
        item.details.push(`${rawKey}: ${value}`);
      }
  }
}

function normalizePlanFieldKey(rawKey: string): string {
  return rawKey
    .trim()
    .replace(/^[`*_]+|[`*_]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildPlanPhases(items: ParsedPlanItem[]): MutableAutocodePlanPhase[] {
  const childCounts = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const parentId = getParentPlanItemId(item.id);
    if (parentId) {
      childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }
    const next = items[index + 1];
    if (!parentId && next && next.indent > item.indent) {
      childCounts.set(item.id, (childCounts.get(item.id) ?? 0) + 1);
    }
  }

  const phaseById = new Map<string, MutableAutocodePlanPhase>();
  const phaseTitles = new Map<string, string>();
  for (const item of items) {
    if (!getParentPlanItemId(item.id) && childCounts.has(item.id)) {
      phaseTitles.set(item.id, item.title);
    }
  }

  const phases: MutableAutocodePlanPhase[] = [];
  for (const item of items) {
    const idParent = getParentPlanItemId(item.id);
    const parentId = item.indent > 0 && phases.length > 0
      ? stringifyPlanValue(phases[phases.length - 1].id ?? phases[phases.length - 1].phase)
      : idParent;
    const isPhaseOnly = item.indent === 0 && !idParent && childCounts.has(item.id);
    const phaseId = parentId || item.id;
    let phase = phaseById.get(phaseId);
    if (!phase) {
      phase = {
        id: phaseId,
        name: phaseTitles.get(phaseId) ?? (isPhaseOnly ? item.title : `Phase ${phaseId}`),
        subtasks: [],
      };
      phaseById.set(phaseId, phase);
      phases.push(phase);
    } else if (isPhaseOnly) {
      phase.name = item.title;
    }

    if (!isPhaseOnly) {
      phase.subtasks = [...getPhaseSubtasks(phase), planItemToSubtask(item)];
    }
  }
  return phases;
}

function planItemToSubtask(item: ParsedPlanItem): MutableAutocodePlanSubtask {
  const filesToModify = item.filesToModify.length > 0 ? item.filesToModify : item.files;
  const subtask: MutableAutocodePlanSubtask = {
    id: item.id,
    title: item.title,
    description: item.details.join('\n') || item.title,
    status: item.status,
  };
  if (item.filesToCreate.length > 0 || item.hasFilesToCreateField) subtask.files_to_create = item.filesToCreate;
  if (filesToModify.length > 0 || item.hasFilesField || item.hasFilesToModifyField) {
    subtask.files_to_modify = filesToModify;
  }
  if (item.patternFiles.length > 0 || item.hasPatternFilesField) subtask.pattern_files = item.patternFiles;
  if (item.dependsOn.length > 0 || item.hasDependsOnField) subtask.depends_on = item.dependsOn;
  if (item.requirements.length > 0 || item.hasRequirementsField) subtask.requirements = item.requirements;
  if (item.architecture || item.hasArchitectureField) subtask.architecture = item.architecture ?? '';
  if (item.evidence || item.hasEvidenceField) subtask.evidence = item.evidence ?? '';
  if (item.verification) subtask.verification = { type: 'manual', run: item.verification };
  if (item.completion) {
    const completion = compactStoredPlanNoteField(item.completion);
    subtask.completion_summary = completion;
    subtask.notes = completion;
  }
  if (item.startedAt) subtask.started_at = item.startedAt;
  if (item.completedAt) subtask.completed_at = item.completedAt;
  if (item.durationMs !== undefined) subtask.duration_ms = item.durationMs;
  if (item.updatedAt) subtask.updated_at = item.updatedAt;
  return subtask;
}

function getPhaseSubtasks(phase: MutableAutocodePlanPhase): MutableAutocodePlanSubtask[] {
  return Array.isArray(phase.subtasks)
    ? phase.subtasks
    : Array.isArray(phase.chunks)
      ? phase.chunks
      : [];
}

function normalizeMarkdownStatus(value: unknown): AutocodePlanMarkdownStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'blocked' || value === 'failed') {
    return value;
  }
  return 'pending';
}

function getParentPlanItemId(id: string): string | null {
  const separatorIndex = id.indexOf('.');
  if (separatorIndex <= 0) {
    return null;
  }
  return id.slice(0, separatorIndex);
}

function addMetadataLine(lines: string[], label: string, value: unknown): void {
  const text = stringifyPlanValue(value);
  if (text) {
    lines.push(`${label}: ${compactInlineMarkdownField(text)}`);
  }
}

function addMarkdownSection(lines: string[], heading: string, value: unknown): void {
  const text = stringifyPlanValue(value);
  if (!text) {
    return;
  }

  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }
  lines.push(`## ${heading}`);
  lines.push('');
  lines.push(...text.replace(/\r\n/g, '\n').split('\n'));
  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }
}

function addListField(
  lines: string[],
  label: string,
  value: unknown,
  indent = '  ',
  options: { writeNoneWhenEmptyArray?: boolean } = {},
): void {
  const items = arrayFromUnknown(value);
  if (items.length > 0) {
    lines.push(`${indent}- _${label}: ${items.join(', ')}_`);
  } else if (options.writeNoneWhenEmptyArray && Array.isArray(value)) {
    lines.push(`${indent}- _${label}: none_`);
  }
}

function splitPlanList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || /^(none|no dependencies?|n\/a|na|nil|null|无|无依赖|没有|没有依赖)$/i.test(trimmed)) {
    return [];
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !/^(none|no dependencies?|n\/a|na|nil|null|无|无依赖|没有|没有依赖)$/i.test(item));
}

function stringifyPlanValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parseDurationMs(value: string): number | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  const unit = match[2] ?? 'ms';
  const multiplier = unit === 'h' || unit === 'hr' || unit === 'hrs' || unit === 'hour' || unit === 'hours'
    ? 3_600_000
    : unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes'
      ? 60_000
      : unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds'
        ? 1000
        : 1;
  return Math.round(numeric * multiplier);
}

function stringifyVerification(value: unknown): string {
  if (typeof value === 'string') return compactInlineMarkdownField(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return compactInlineMarkdownField(stringifyPlanValue(record.run ?? record.command ?? record.scenario ?? record.description));
  }
  return '';
}

function compactInlineMarkdownField(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compactStoredPlanNoteField(value: unknown): string {
  const text = foldRepeatedAutocodePromptLines(
    stringifyPlanValue(value)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n'),
  ).trim();
  if (text.length <= MAX_AUTOCODE_PLAN_NOTE_FIELD_CHARS) {
    return text;
  }
  return `${text.slice(0, Math.max(0, MAX_AUTOCODE_PLAN_NOTE_FIELD_CHARS - 3)).trimEnd()}...`;
}

function normalizeMarkdownSectionText(lines: string[] | null): string {
  if (!lines) {
    return '';
  }

  const normalized = lines.map((line) => line.trimEnd());
  while (normalized.length > 0 && !normalized[0].trim()) {
    normalized.shift();
  }
  while (normalized.length > 0 && !normalized[normalized.length - 1].trim()) {
    normalized.pop();
  }
  return normalized.join('\n').trim();
}

function expandLegacyInlineDescriptionMarkdown(description: string, feature: unknown): string {
  let text = description.trim();
  if (!text || text.includes('\n')) {
    return text;
  }

  const featureText = stringifyPlanValue(feature);
  if (featureText && text.startsWith(`# ${featureText} `)) {
    text = `# ${featureText}\n\n${text.slice(featureText.length + 3).trimStart()}`;
  }

  const knownHeadings = [
    'Rationale',
    'Category',
    'Current State',
    'Proposed Change',
    'User Benefit',
    'Affected Components',
  ];
  for (const heading of knownHeadings) {
    const pattern = new RegExp(`\\s+##\\s+${escapeRegExp(heading)}\\s+`, 'g');
    text = text.replace(pattern, `\n\n## ${heading}\n\n`);
  }

  text = text.replace(
    /[ \t]+-\s+(?=(?:src|apps|libs|packages|tests|guides|\.github|\.autocode|package(?:\.json)?|[A-Za-z0-9_.-]+\/))/g,
    '\n- ',
  );
  return text.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function arrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringifyPlanValue(item)).filter(Boolean);
}
