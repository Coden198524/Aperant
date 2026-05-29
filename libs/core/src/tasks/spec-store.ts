import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AUTOCODE_SPECS_DIR_NAME,
  AUTOCODE_TASK_ARTIFACTS,
  normalizeAutocodeProjectDataDirName,
} from './artifacts.js';
import {
  loadAutocodeImplementationPlanSync,
  saveAutocodeImplementationPlanSync,
} from './plan-store.js';
import {
  loadAutocodeTaskRequirementsSync,
  saveAutocodeTaskRequirementsSync,
  type AutocodeTaskRequirements,
} from './requirements-store.js';
import type { MutableAutocodePlan } from './plan-file.js';
export type { AutocodeTaskRequirements } from './requirements-store.js';

export type AutocodeTaskStatus =
  | 'backlog'
  | 'queue'
  | 'in_progress'
  | 'ai_review'
  | 'human_review'
  | 'done'
  | 'pr_created'
  | 'error';

export type AutocodeReviewReason = 'completed' | 'errors' | 'qa_rejected' | 'plan_review' | 'stopped';

export type AutocodeTaskCategory =
  | 'feature'
  | 'bug_fix'
  | 'refactoring'
  | 'documentation'
  | 'security'
  | 'performance'
  | 'ui_ux'
  | 'infrastructure'
  | 'testing';

export type AutocodeTaskComplexity = 'trivial' | 'small' | 'medium' | 'large' | 'complex';
export type AutocodeTaskImpact = 'low' | 'medium' | 'high' | 'critical';
export type AutocodeTaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type AutocodeTaskWorkflowMode = 'off' | 'conservative' | 'balanced' | 'aggressive';
export type AutocodeSubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AutocodeExecutionPhase =
  | 'idle'
  | 'spec'
  | 'planning'
  | 'coding'
  | 'qa_review'
  | 'qa_fixing'
  | 'complete'
  | 'review'
  | 'failed'
  | 'stopped';

export interface AutocodeTaskMetadata {
  sourceType?: 'ideation' | 'manual' | 'imported' | 'insights' | 'roadmap' | 'linear' | 'yunxiao' | 'github' | 'gitlab' | 'project_docs';
  category?: AutocodeTaskCategory;
  complexity?: AutocodeTaskComplexity;
  impact?: AutocodeTaskImpact;
  priority?: AutocodeTaskPriority;
  model?: string;
  thinkingLevel?: string;
  provider?: string;
  phaseModels?: Record<string, string>;
  phaseThinking?: Record<string, string>;
  phaseProviders?: Record<string, string>;
  workflowMode?: AutocodeTaskWorkflowMode;
  enableBatchExecution?: boolean;
  requireReviewBeforeCoding?: boolean;
  useWorktree?: boolean;
  pushNewBranches?: boolean;
  [key: string]: unknown;
}

export interface AutocodeTaskCreationContext {
  projectRoot: string;
  dataDirName: string;
  specId: string;
  specDir: string;
  title: string;
  description: string;
  metadata: AutocodeTaskMetadata;
  now: string;
}

export interface AutocodeTaskCreationArtifacts {
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
}

export interface AutocodePlanSubtask {
  id: string;
  title: string;
  description: string;
  status: AutocodeSubtaskStatus;
  completionSummary?: string;
  files: string[];
}

export interface AutocodeTask {
  id: string;
  specId: string;
  projectRoot: string;
  title: string;
  description: string;
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: AutocodeExecutionPhase | string;
  subtasks: AutocodePlanSubtask[];
  metadata?: AutocodeTaskMetadata;
  specsPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAutocodeTaskInput {
  projectRoot: string;
  dataDirName?: string;
  title: string;
  description: string;
  specId?: string;
  fallbackSlug?: string;
  overwrite?: boolean;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  now?: string;
  prepareSpecArtifacts?: (context: AutocodeTaskCreationContext) => AutocodeTaskCreationArtifacts | void;
}

export interface CreateImportedAutocodeTaskInput extends CreateAutocodeTaskInput {
  metadata: AutocodeTaskMetadata & { sourceType: NonNullable<AutocodeTaskMetadata['sourceType']> };
}

export interface ListAutocodeTasksInput {
  projectRoot: string;
  dataDirName?: string;
}

export interface AutocodeTaskPathsInput {
  projectRoot: string;
  dataDirName?: string;
  specId?: string;
}

export type AutocodePlanStatus =
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'coding'
  | 'review'
  | 'completed'
  | 'done'
  | 'human_review'
  | 'ai_review'
  | 'pr_created'
  | 'backlog'
  | 'error'
  | 'queue'
  | 'queued';

export interface UpdateAutocodeTaskPlanStatusInput {
  projectRoot: string;
  dataDirName?: string;
  taskId: string;
  planStatus: AutocodePlanStatus;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: AutocodeExecutionPhase | string;
}

interface ImplementationPlanFile {
  feature?: string;
  title?: string;
  description?: string;
  status?: string;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: string;
  phases?: Array<{
    subtasks?: RawPlanSubtask[];
    chunks?: RawPlanSubtask[];
  }>;
  created_at?: string;
  updated_at?: string;
}

interface RawPlanSubtask {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  completion_summary?: unknown;
  completionSummary?: unknown;
  notes?: unknown;
  actual_output?: unknown;
  status?: unknown;
  files_to_create?: unknown;
  files_to_modify?: unknown;
  pattern_files?: unknown;
}

const MAX_SPEC_SLUG_LENGTH = 50;
const DEFAULT_SPEC_SLUG = 'task';

export function getAutocodeSpecsDir(input: AutocodeTaskPathsInput): string {
  return join(input.projectRoot, normalizeAutocodeProjectDataDirName(input.dataDirName), AUTOCODE_SPECS_DIR_NAME);
}

export function getAutocodeSpecDir(input: AutocodeTaskPathsInput & { specId: string }): string {
  return join(getAutocodeSpecsDir(input), input.specId);
}

export function listAutocodeTasks(input: ListAutocodeTasksInput): AutocodeTask[] {
  const specsDir = getAutocodeSpecsDir(input);
  if (!existsSync(specsDir)) {
    return [];
  }

  return readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readAutocodeTask({ ...input, specId: entry.name }))
    .filter((task): task is AutocodeTask => task !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createAutocodeTask(input: CreateAutocodeTaskInput): AutocodeTask {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const description = requireNonEmpty(input.description, 'description');
  const title = input.title.trim() || truncateToTitle(description);
  const specsDir = getAutocodeSpecsDir({ projectRoot, dataDirName });
  mkdirSync(specsDir, { recursive: true });

  const requestedSpecId = input.specId?.trim();
  const specId = requestedSpecId || buildAutocodeSpecId(nextSpecNumber(specsDir), title, input.fallbackSlug);
  const specDir = join(specsDir, specId);
  if (requestedSpecId && existsSync(specDir) && input.overwrite !== true) {
    throw new Error(`Task spec already exists: ${specId}`);
  }
  mkdirSync(specDir, { recursive: true });

  const now = input.now ?? new Date().toISOString();
  let metadata: AutocodeTaskMetadata = {
    sourceType: 'manual',
    ...input.metadata,
    enableBatchExecution: input.metadata?.enableBatchExecution === true,
  };

  const prepared = input.prepareSpecArtifacts?.({
    projectRoot,
    dataDirName,
    specId,
    specDir,
    title,
    description,
    metadata,
    now,
  });
  if (prepared?.metadata) {
    const preparedMetadata = { ...metadata, ...prepared.metadata };
    metadata = {
      ...preparedMetadata,
      enableBatchExecution: preparedMetadata.enableBatchExecution === true,
    };
  }

  const plan: ImplementationPlanFile = {
    feature: title,
    description,
    created_at: now,
    updated_at: now,
    status: 'pending',
    phases: [],
  };

  saveAutocodeImplementationPlanSync(specDir, plan as MutableAutocodePlan);
  writeJson(join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata), metadata);
  saveAutocodeTaskRequirementsSync(
    specDir,
    buildAutocodeTaskRequirements(description, metadata, {
      ...input.requirements,
      ...prepared?.requirements,
    }),
  );

  return {
    id: specId,
    specId,
    projectRoot,
    title,
    description,
    status: 'backlog',
    subtasks: [],
    metadata,
    specsPath: specDir,
    createdAt: now,
    updatedAt: now,
  };
}

export function createImportedAutocodeTask(input: CreateImportedAutocodeTaskInput): AutocodeTask {
  return createAutocodeTask({
    ...input,
    metadata: {
      ...input.metadata,
      sourceType: input.metadata.sourceType,
      enableBatchExecution: input.metadata.enableBatchExecution === true,
    },
  });
}

export function buildAutocodeTaskRequirements(
  description: string,
  metadata: AutocodeTaskMetadata = {},
  requirements: AutocodeTaskRequirements = {},
): AutocodeTaskRequirements {
  const requestedWorkflowType = typeof requirements.workflow_type === 'string' && requirements.workflow_type.trim()
    ? requirements.workflow_type.trim()
    : undefined;
  const workflowType = metadata.category ?? requestedWorkflowType ?? 'feature';
  return {
    ...requirements,
    task_description: description,
    workflow_type: workflowType,
  };
}

export function updateAutocodeTaskPlanStatus(input: UpdateAutocodeTaskPlanStatusInput): AutocodeTask {
  const task = listAutocodeTasks({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  }).find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);

  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const specDir = getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });
  const plan = loadAutocodeImplementationPlanSync(specDir) as ImplementationPlanFile | null ?? {
    feature: task.title,
    description: task.description,
    created_at: task.createdAt,
    phases: [],
  };
  const now = new Date().toISOString();

  plan.status = input.planStatus;
  plan.updated_at = now;
  if (!plan.created_at) {
    plan.created_at = task.createdAt || now;
  }

  if (input.reviewReason) {
    plan.reviewReason = input.reviewReason;
  } else if (input.planStatus !== 'human_review') {
    delete plan.reviewReason;
  }

  if (input.executionPhase) {
    plan.executionPhase = input.executionPhase;
  } else {
    delete plan.executionPhase;
  }

  saveAutocodeImplementationPlanSync(specDir, plan as unknown as MutableAutocodePlan);

  const updated = readAutocodeTask({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });
  if (!updated) {
    throw new Error(`Task not found after status update: ${input.taskId}`);
  }
  return updated;
}

export function buildAutocodeSpecId(specNumber: number, title: string, fallbackSlug = DEFAULT_SPEC_SLUG): string {
  const normalizedNumber = Number.isFinite(specNumber) && specNumber > 0 ? Math.floor(specNumber) : 1;
  const paddedNumber = String(normalizedNumber).padStart(3, '0');
  const slug = slugifySpecTitle(title) || slugifySpecTitle(fallbackSlug) || DEFAULT_SPEC_SLUG;
  return `${paddedNumber}-${slug}`;
}

export function slugifySpecTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, MAX_SPEC_SLUG_LENGTH);
}

function readAutocodeTask(input: AutocodeTaskPathsInput & { specId: string }): AutocodeTask | null {
  const specDir = getAutocodeSpecDir(input);
  const plan = loadAutocodeImplementationPlanSync(specDir) as ImplementationPlanFile | null;
  const requirements = loadAutocodeTaskRequirementsSync(specDir);
  const metadata = readJson<AutocodeTaskMetadata>(join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata)) ?? undefined;
  const specTitle = readSpecTitle(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile));

  if (!plan && !requirements && !metadata && !specTitle) {
    return null;
  }

  const title = stringFrom(plan?.feature, plan?.title, specTitle, input.specId);
  const description = stringFrom(requirements?.task_description, plan?.description, '');
  const { status, reviewReason } = mapPlanStatus(plan?.status, plan?.reviewReason);
  const createdAt = stringFrom(plan?.created_at, new Date(0).toISOString());
  const updatedAt = stringFrom(plan?.updated_at, createdAt);
  const executionPhase = optionalStringFrom(plan?.executionPhase);

  return {
    id: input.specId,
    specId: input.specId,
    projectRoot: input.projectRoot,
    title,
    description,
    status,
    ...(reviewReason ? { reviewReason } : {}),
    ...(executionPhase ? { executionPhase } : {}),
    subtasks: extractSubtasks(plan),
    ...(metadata ? { metadata } : {}),
    specsPath: specDir,
    createdAt,
    updatedAt,
  };
}

function extractSubtasks(plan: ImplementationPlanFile | null): AutocodePlanSubtask[] {
  if (!plan?.phases) {
    return [];
  }

  return plan.phases.flatMap((phase, phaseIndex) => {
    const rawSubtasks = Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [];
    return rawSubtasks.map((subtask, subtaskIndex) => {
      const fallbackId = `${phaseIndex + 1}.${subtaskIndex + 1}`;
      const id = stringFrom(subtask.id, `subtask-${fallbackId}`);
      const title = stringFrom(subtask.title, subtask.description, `Subtask ${fallbackId}`);
      const description = stringFrom(subtask.description, subtask.title, title);
      const completionSummary = optionalStringFrom(
        subtask.completion_summary,
        subtask.completionSummary,
        subtask.notes,
        subtask.actual_output,
      );
      return {
        id,
        title,
        description,
        status: normalizeSubtaskStatus(subtask.status),
        ...(completionSummary ? { completionSummary } : {}),
        files: [
          ...toStringArray(subtask.files_to_create),
          ...toStringArray(subtask.files_to_modify),
          ...toStringArray(subtask.pattern_files),
        ],
      };
    });
  });
}

function mapPlanStatus(
  planStatus: string | undefined,
  reviewReason: AutocodeReviewReason | undefined,
): { status: AutocodeTaskStatus; reviewReason?: AutocodeReviewReason } {
  const statusMap: Record<string, AutocodeTaskStatus> = {
    pending: 'backlog',
    planning: 'in_progress',
    in_progress: 'in_progress',
    coding: 'in_progress',
    review: 'ai_review',
    completed: 'done',
    done: 'done',
    human_review: 'human_review',
    ai_review: 'ai_review',
    pr_created: 'pr_created',
    backlog: 'backlog',
    error: 'error',
    queue: 'queue',
    queued: 'queue',
  };
  const status = planStatus ? statusMap[planStatus] ?? 'backlog' : 'backlog';
  return {
    status,
    ...(status === 'human_review' && reviewReason ? { reviewReason } : {}),
  };
}

function normalizeSubtaskStatus(value: unknown): AutocodeSubtaskStatus {
  return value === 'in_progress' || value === 'completed' || value === 'failed' ? value : 'pending';
}

function nextSpecNumber(specsDir: string): number {
  const existingNumbers = readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = /^(\d+)/.exec(entry.name);
      return match ? Number.parseInt(match[1], 10) : 0;
    })
    .filter((value) => value > 0);
  return existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function truncateToTitle(description: string): string {
  const firstLine = description.split('\n')[0]?.trim() || 'Untitled task';
  return firstLine.length > 60 ? `${firstLine.substring(0, 60)}...` : firstLine;
}

function readSpecTitle(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const match = /^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$/m.exec(readFileSync(filePath, 'utf8'));
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function optionalStringFrom(...values: unknown[]): string | undefined {
  const value = stringFrom(...values);
  return value || undefined;
}

function stringFrom(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}
