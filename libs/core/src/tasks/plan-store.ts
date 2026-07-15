import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  MutableAutocodePlanWithPhases,
  MutableAutocodePlanPhase,
  MutableAutocodePlanSubtask,
} from './plan-file.js';
import {
  AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS,
  AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS,
  buildAutocodeRuntimeDefinitionFingerprint,
  isAutocodeSlimRuntimeLedger,
  type AutocodeRuntimeDefinitionFingerprintInput,
} from './runtime-ledger.js';
import { getAutocodeDesignReferenceFingerprint } from './design-quality.js';

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
  designRefs: string[];
  architecture?: string;
  evidence?: string;
  verification?: string;
  hasFilesField: boolean;
  hasFilesToCreateField: boolean;
  hasFilesToModifyField: boolean;
  hasPatternFilesField: boolean;
  hasDependsOnField: boolean;
  hasRequirementsField: boolean;
  hasDesignRefsField: boolean;
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
  'planRevision',
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

export function parseAutocodeImplementationPlanMarkdown(content: string): MutableAutocodePlanWithPhases {
  const plan: MutableAutocodePlanWithPhases = { phases: [] };
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
        designRefs: [],
        architecture: undefined,
        evidence: undefined,
        hasFilesField: false,
        hasFilesToCreateField: false,
        hasFilesToModifyField: false,
        hasPatternFilesField: false,
        hasDependsOnField: false,
        hasRequirementsField: false,
        hasDesignRefsField: false,
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

    if (/^#{1,6}\s+\S/.test(line.trim())) {
      current = undefined;
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
  const slimRuntimeLedger = isAutocodeSlimRuntimeLedger(plan);
  const lines: string[] = [slimRuntimeLedger ? '# Runtime Execution Ledger' : '# Implementation Plan', ''];
  if (!slimRuntimeLedger) {
    addMetadataLine(lines, 'Feature', plan.feature);
    addMetadataLine(lines, 'Workflow', plan.workflow_type);
  }
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

  if (!slimRuntimeLedger) {
    addMarkdownSection(lines, 'Description', plan.description);
  }

  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  for (const [phaseIndex, phase] of phases.entries()) {
    const phaseId = stringifyPlanValue(phase.id ?? phase.phase ?? phaseIndex + 1);
    const phaseName = slimRuntimeLedger
      ? getRuntimeWorkPackagePhaseName(plan)
      : stringifyPlanValue(phase.name)
        || stringifyPlanValue(phase.title)
        || `Phase ${phaseIndex + 1}`;
    const phaseStatus = inferPhaseMarkdownStatus(phase);
    lines.push(`- [${STATUS_TO_MARKER[phaseStatus]}] ${phaseId}. ${phaseName}`);

    const phaseDependsOn = arrayFromUnknown(phase.depends_on);
    if (phaseDependsOn.length > 0) {
      lines.push(`  - _Depends on: ${phaseDependsOn.join(', ')}_`);
    }

    for (const [subtaskIndex, subtask] of getPhaseSubtasks(phase).entries()) {
      const fallbackId = `${phaseId}.${subtaskIndex + 1}`;
      const subtaskId = stringifyPlanValue(subtask.id ?? subtask.subtask_id ?? fallbackId);
      const title = slimRuntimeLedger
        ? 'Work package'
        : stringifyPlanValue(subtask.title)
          || stringifyPlanValue(subtask.description)
          || `Subtask ${subtaskId}`;
      const status = normalizeMarkdownStatus(subtask.status);
      lines.push('');
      lines.push(`  - [${STATUS_TO_MARKER[status]}] ${subtaskId} ${title}`);

      const description = slimRuntimeLedger ? '' : stringifyPlanValue(subtask.description);
      if (!slimRuntimeLedger && description && description !== title) {
        for (const detailLine of description.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
          lines.push(`    - ${detailLine}`);
        }
      }

      if (!slimRuntimeLedger) {
        addListField(lines, 'Files', subtask.files, '    ');
        addListField(lines, 'Files to create', subtask.files_to_create, '    ');
        addListField(lines, 'Files to modify', subtask.files_to_modify, '    ', { writeNoneWhenEmptyArray: true });
        addListField(lines, 'Pattern files', subtask.pattern_files, '    ');
      }
      addListField(lines, 'Depends on', subtask.depends_on, '    ', { writeNoneWhenEmptyArray: true });
      if (!slimRuntimeLedger) {
        addListField(lines, 'Requirements', subtask.requirements, '    ');
        addListField(lines, 'Design', subtask.design_refs, '    ');
      }

      const architecture = slimRuntimeLedger ? '' : stringifyPlanValue(subtask.architecture);
      if (architecture) {
        lines.push(`    - _Architecture: ${compactInlineMarkdownField(architecture)}_`);
      }

      const evidence = slimRuntimeLedger ? '' : stringifyPlanValue(subtask.evidence);
      if (evidence) {
        lines.push(`    - _Evidence: ${compactInlineMarkdownField(evidence)}_`);
      }

      const verification = slimRuntimeLedger ? '' : stringifyVerification(subtask.verification);
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

export function stringifyAutocodeTaskDefinitionsMarkdown(plan: MutableAutocodePlan): string {
  const phases = (plan.phases ?? []).map((phase) => {
    const staticPhase: MutableAutocodePlanPhase = {
      ...phase,
      status: 'pending',
    };
    const staticTasks = getPhaseSubtasks(phase).map((subtask) => {
      const staticTask: MutableAutocodePlanSubtask = {
        ...subtask,
        status: 'pending',
      };
      for (const key of AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS) {
        if (key !== 'depends_on') {
          delete staticTask[key];
        }
      }
      return staticTask;
    });
    if (Array.isArray(phase.subtasks)) {
      staticPhase.subtasks = staticTasks;
      delete staticPhase.chunks;
    } else {
      staticPhase.chunks = staticTasks;
      delete staticPhase.subtasks;
    }
    return staticPhase;
  });
  const staticPlan: MutableAutocodePlan = {
    phases,
  };
  return stringifyAutocodeImplementationPlanMarkdown(staticPlan)
    .replace(/^# Implementation Plan\s*/m, '# Tasks\n\nTasks-Contract: 1\n\n')
    .replace(/^<!-- autocode-plan-meta: .*?-->\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function inferPhaseMarkdownStatus(phase: MutableAutocodePlanPhase): AutocodePlanMarkdownStatus {
  const subtasks = getPhaseSubtasks(phase);
  if (subtasks.length === 0) {
    return normalizeMarkdownStatus(phase.status);
  }
  if (subtasks.some((subtask) => normalizeMarkdownStatus(subtask.status) === 'failed')) {
    return 'failed';
  }
  if (subtasks.some((subtask) => normalizeMarkdownStatus(subtask.status) === 'in_progress')) {
    return 'in_progress';
  }
  if (subtasks.every((subtask) => normalizeMarkdownStatus(subtask.status) === 'completed')) {
    return 'completed';
  }
  if (subtasks.some((subtask) => normalizeMarkdownStatus(subtask.status) === 'blocked')) {
    return 'blocked';
  }
  return 'pending';
}

export function loadAutocodeImplementationPlanSync(specDirOrPlanPath: string): MutableAutocodePlanWithPhases | null {
  const specDir = resolveAutocodePlanSpecDir(specDirOrPlanPath);
  const planPath = getAutocodeImplementationPlanPath(specDir);
  if (!existsSync(planPath)) {
    return null;
  }
  try {
    const plan = parseAutocodeImplementationPlanMarkdown(readFileSync(planPath, 'utf-8'));
    return hydrateAutocodeSlimRuntimeLedger(plan, specDir);
  } catch {
    return null;
  }
}

export async function loadAutocodeImplementationPlan(specDirOrPlanPath: string): Promise<MutableAutocodePlanWithPhases | null> {
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
      if (subtask.status === 'in_progress') {
        subtask.started_at = subtask.started_at || now;
        subtask.active_started_at = subtask.active_started_at || now;
        subtask.completed_at = undefined;
      } else if (subtask.active_started_at !== undefined) {
        subtask.active_started_at = undefined;
      }
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
  const fieldsToPersist = isAutocodeSlimRuntimeLedger(plan)
    ? AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS
    : [
        ...AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS,
        ...AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS,
      ];
  for (const phase of plan.phases ?? []) {
    for (const subtask of getPhaseSubtasks(phase)) {
      const id = stringifyPlanValue(subtask.id ?? subtask.subtask_id);
      if (!id) {
        continue;
      }
      const fields: Record<string, unknown> = {};
      for (const key of fieldsToPersist) {
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
        ...AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS,
        ...AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS,
      ]) {
        if (fieldRecord[key] !== undefined) {
          (subtask as Record<string, unknown>)[key] = fieldRecord[key];
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
    case 'file intent':
    case 'files intent':
    case 'file intents':
      item.hasFilesField = true;
      item.files = extractPlanFileIntentPaths(value);
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
    case 'design':
    case 'design ref':
    case 'design refs':
    case 'design reference':
    case 'design references':
      item.hasDesignRefsField = true;
      item.designRefs = splitPlanList(value).map((entry) => entry.toUpperCase());
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
  if (item.designRefs.length > 0 || item.hasDesignRefsField) subtask.design_refs = item.designRefs;
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
  if (!trimmed || isNonePlanListToken(trimmed)) {
    return [];
  }
  return trimmed
    .split(/[,;\u3001\uFF0C\uFF1B]+/u)
    .map((item) => item.trim())
    .filter((item) => item && !isNonePlanListToken(item));
}

function isNonePlanListToken(value: string): boolean {
  return /^(?:none|no dependencies?|n\/a|na|nil|null|\u65E0|\u65E0\u4F9D\u8D56|\u6CA1\u6709|\u6CA1\u6709\u4F9D\u8D56)$/iu.test(value.trim());
}

function extractPlanFileIntentPaths(value: string): string[] {
  const codeSpanCandidates = Array.from(value.matchAll(/`([^`\r\n]+)`/g), (match) => match[1].trim());
  const candidates = codeSpanCandidates.filter(isLikelyPlanFilePath);
  if (candidates.length === 0) {
    candidates.push(...(value.match(/(?:[A-Za-z]:[\\/])?(?:[A-Za-z0-9_.@()\-]+[\\/])*[A-Za-z0-9_.@()\-]+\.[A-Za-z0-9_\-]{1,12}/g) ?? []));
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = candidate.replace(/\\/g, '/').toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function isLikelyPlanFilePath(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate) || /^#/.test(candidate)) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:(?![\\/])/.test(candidate)) {
    return false;
  }
  return /[\\/]/.test(candidate) ||
    /^(?:\.[A-Za-z0-9_.-]+|[A-Za-z0-9_.@()\-]+\.[A-Za-z0-9_\-]{1,12})$/.test(candidate);
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

export function hydrateAutocodeSlimRuntimeLedger<T extends MutableAutocodePlan>(
  plan: T,
  specDir: string,
): T {
  if (!isAutocodeSlimRuntimeLedger(plan)) {
    return plan;
  }

  const sourceTask = asPlanRecord(plan.source_task);
  const tasksPath = resolveLinkedTasksPath(specDir, stringifyPlanValue(sourceTask?.tasks));
  if (!tasksPath || !existsSync(tasksPath)) {
    return plan;
  }

  let tasksPlan: MutableAutocodePlan;
  try {
    tasksPlan = parseAutocodeImplementationPlanMarkdown(readFileSync(tasksPath, 'utf-8'));
  } catch {
    return plan;
  }

  const taskDefinitions = new Map<string, MutableAutocodePlanSubtask>();
  for (const phase of tasksPlan.phases ?? []) {
    for (const task of getPhaseSubtasks(phase)) {
      const id = stringifyPlanValue(task.id ?? task.subtask_id);
      if (id) {
        taskDefinitions.set(id, task);
      }
    }
  }

  const designContract = asPlanRecord(sourceTask?.design_contract);
  const designPath = resolveLinkedTasksPath(specDir, stringifyPlanValue(designContract?.path));
  let designMarkdown = '';
  if (designPath && existsSync(designPath)) {
    try {
      designMarkdown = readFileSync(designPath, 'utf-8');
    } catch {
      designMarkdown = '';
    }
  }

  for (const phase of plan.phases ?? []) {
    phase.name = getRuntimeWorkPackagePhaseName(plan);
    for (const workPackage of getPhaseSubtasks(phase)) {
      const sourceIds = arrayFromUnknown(workPackage.upstream_task_ids);
      const definitions = sourceIds
        .map((id) => taskDefinitions.get(id))
        .filter((task): task is MutableAutocodePlanSubtask => Boolean(task));
      if (definitions.length === 0) {
        continue;
      }

      const fingerprintInputs = definitions.map((task) =>
        toRuntimeDefinitionFingerprintInput(task, designMarkdown),
      );
      const filesToCreate = uniquePlanStrings(fingerprintInputs.flatMap((task) => task.filesToCreate));
      const filesToModify = uniquePlanStrings(fingerprintInputs.flatMap((task) => task.filesToModify));
      const patternFiles = uniquePlanStrings(fingerprintInputs.flatMap((task) => task.patternFiles));
      const hasPatternFiles = definitions.some((task) => Array.isArray(task.pattern_files));
      const requirements = uniquePlanStrings([
        ...sourceIds,
        ...fingerprintInputs.flatMap((task) => task.requirements),
      ]);
      const designRefs = uniquePlanStrings(fingerprintInputs.flatMap((task) => task.designRefs));
      const architecture = uniquePlanStrings(fingerprintInputs.map((task) => task.architecture ?? ''));
      const evidence = uniquePlanStrings(fingerprintInputs.map((task) => task.evidence ?? ''));
      const verification = uniquePlanStrings(
        fingerprintInputs.map((task) => stringifyVerification(task.verification)),
      );

      workPackage.title = buildHydratedWorkPackageTitle(fingerprintInputs);
      workPackage.description = buildHydratedWorkPackageDescription(fingerprintInputs);
      workPackage.files_to_create = filesToCreate;
      workPackage.files_to_modify = filesToModify;
      if (hasPatternFiles) {
        workPackage.pattern_files = patternFiles;
      } else {
        delete workPackage.pattern_files;
      }
      workPackage.requirements = requirements;
      workPackage.design_refs = designRefs;
      workPackage.architecture = architecture.join('; ');
      workPackage.evidence = evidence.join('; ');
      workPackage.verification = {
        type: 'manual',
        run: verification.join('; '),
      };
      if (!stringifyPlanValue(workPackage.definition_fingerprint)) {
        workPackage.definition_fingerprint = buildAutocodeRuntimeDefinitionFingerprint(fingerprintInputs);
      }
      if (!asPlanRecord(workPackage.source_task_fingerprints)) {
        workPackage.source_task_fingerprints = Object.fromEntries(
          fingerprintInputs.map((task) => [
            task.id,
            buildAutocodeRuntimeDefinitionFingerprint([task]),
          ]),
        );
      }
      if (!asPlanRecord(workPackage.design_task_fingerprints) && designMarkdown) {
        workPackage.design_task_fingerprints = Object.fromEntries(
          fingerprintInputs
            .filter((task) => task.designRefs.length > 0)
            .map((task) => [
              task.id,
              getAutocodeDesignReferenceFingerprint(designMarkdown, task.designRefs),
            ]),
        );
      }
      workPackage.upstream_source = stringifyPlanValue(sourceTask?.tasks) || AUTOCODE_TASK_ARTIFACTS.tasks;
      workPackage.work_package = true;
    }
  }

  plan.feature = plan.feature || tasksPlan.feature;
  plan.workflow_type = plan.workflow_type || tasksPlan.workflow_type;
  plan.description = plan.description || tasksPlan.description;
  return plan;
}

function getRuntimeWorkPackagePhaseName(plan: MutableAutocodePlan): string {
  const sourceTask = asPlanRecord(plan.source_task);
  return stringifyPlanValue(sourceTask?.language).toLowerCase().startsWith('zh')
    ? '\u8fd0\u884c\u5de5\u4f5c\u5305'
    : 'Runtime work packages';
}

function toRuntimeDefinitionFingerprintInput(
  task: MutableAutocodePlanSubtask,
  designMarkdown = '',
): AutocodeRuntimeDefinitionFingerprintInput {
  const id = stringifyPlanValue(task.id ?? task.subtask_id);
  const title = stringifyPlanValue(task.title) || id;
  const designRefs = arrayFromUnknown(task.design_refs);
  return {
    id,
    title,
    description: stringifyPlanValue(task.description) || title,
    filesToCreate: arrayFromUnknown(task.files_to_create),
    filesToModify: uniquePlanStrings([
      ...arrayFromUnknown(task.files),
      ...arrayFromUnknown(task.files_to_modify),
    ]),
    patternFiles: arrayFromUnknown(task.pattern_files),
    dependsOn: arrayFromUnknown(task.depends_on),
    requirements: arrayFromUnknown(task.requirements),
    designRefs,
    ...(designMarkdown && designRefs.length > 0
      ? { designFingerprint: getAutocodeDesignReferenceFingerprint(designMarkdown, designRefs) }
      : {}),
    architecture: stringifyPlanValue(task.architecture),
    evidence: stringifyPlanValue(task.evidence),
    verification: task.verification,
  };
}

function buildHydratedWorkPackageTitle(tasks: AutocodeRuntimeDefinitionFingerprintInput[]): string {
  if (tasks.length === 1) {
    return tasks[0].title;
  }
  return `${tasks[0].title} (+${tasks.length - 1})`;
}

function buildHydratedWorkPackageDescription(
  tasks: AutocodeRuntimeDefinitionFingerprintInput[],
): string {
  return [
    'Implement the linked static task definitions from tasks.md.',
    '',
    'Included tasks:',
    ...tasks.flatMap((task) => [
      `- ${task.id} ${task.title}`,
      `  ${task.description}`,
    ]),
  ].join('\n');
}

function resolveLinkedTasksPath(specDir: string, sourcePath: string): string | null {
  if (!sourcePath) {
    return null;
  }
  const normalizedSpecDir = resolve(specDir);
  const candidate = isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(normalizedSpecDir, sourcePath);
  const relativePath = relative(normalizedSpecDir, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return candidate;
}

function uniquePlanStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function asPlanRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
