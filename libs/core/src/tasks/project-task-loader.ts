import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { safeParseAutocodeJson } from './json-repair.js';
import {
  inferAutocodeExecutionProgress,
  inferAutocodeExecutionProgressFromXState,
  type MutableAutocodePlan,
  type AutocodeTokenUsage,
} from './plan-file.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import {
  loadAutocodeImplementationPlanSync,
  saveAutocodeImplementationPlanSync,
} from './plan-store.js';
import { loadAutocodeTaskRequirementsSync } from './requirements-store.js';
import {
  getAutocodeSpecsDir,
  type AutocodeExecutionPhase,
  type AutocodePlanSubtask,
  type AutocodeReviewReason,
  type AutocodeSubtaskStatus,
  type AutocodeTaskMetadata,
  type AutocodeTaskStatus,
} from './spec-store.js';
import {
  readAutocodeTaskLogsFromSpecDir,
  type AutocodeTaskLogs,
} from './logs.js';

export const AUTOCODE_JSON_ERROR_PREFIX = '__JSON_ERROR__:';
export const AUTOCODE_JSON_ERROR_TITLE_SUFFIX = '__JSON_ERROR_SUFFIX__';

export const AUTOCODE_TASK_STATUS_PRIORITY: Record<AutocodeTaskStatus, number> = {
  done: 100,
  pr_created: 90,
  human_review: 80,
  ai_review: 70,
  in_progress: 50,
  queue: 30,
  backlog: 20,
  error: 10,
} as const;

export interface AutocodeProjectTaskExecutionProgress {
  phase: AutocodeExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
}

export interface AutocodeProjectTask {
  id: string;
  specId: string;
  projectId?: string;
  projectRoot: string;
  title: string;
  description: string;
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
  subtasks: AutocodePlanSubtask[];
  logs: string[];
  metadata?: AutocodeTaskMetadata;
  executionProgress?: AutocodeProjectTaskExecutionProgress;
  tokenUsage?: AutocodeTokenUsage;
  stagedInMainProject?: boolean;
  stagedAt?: string;
  location?: 'main' | 'worktree';
  specsPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadAutocodeProjectTasksInput {
  projectRoot: string;
  dataDirName: string;
  projectId?: string;
  worktreesDir?: string;
  persistStaleStatusCorrections?: boolean;
  staleStatusCorrectionAgeMs?: number;
}

interface ImplementationPlanFile {
  feature?: string;
  title?: string;
  description?: string;
  status?: string;
  planStatus?: string;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: string;
  xstateState?: string;
  stagedInMainProject?: boolean;
  stagedAt?: string;
  tokenUsage?: AutocodeTokenUsage;
  phases?: Array<{
    subtasks?: RawProjectPlanSubtask[];
    chunks?: RawProjectPlanSubtask[];
  }>;
  created_at?: string;
  updated_at?: string;
}

interface RawProjectPlanSubtask {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  completion_summary?: unknown;
  completionSummary?: unknown;
  completed_summary?: unknown;
  notes?: unknown;
  actual_output?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  files_to_create?: unknown;
  files_to_modify?: unknown;
  pattern_files?: unknown;
  depends_on?: unknown;
  work_package?: unknown;
  upstream_task_ids?: unknown;
  upstream_source?: unknown;
}

export function loadAutocodeProjectTasks(input: LoadAutocodeProjectTasksInput): AutocodeProjectTask[] {
  const allTasks: AutocodeProjectTask[] = [];
  const mainSpecsDir = getAutocodeSpecsDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  });
  const mainSpecIds = new Set<string>();

  if (existsSync(mainSpecsDir)) {
    const mainTasks = loadAutocodeTasksFromSpecsDir({
      ...input,
      specsDir: mainSpecsDir,
      taskProjectRoot: input.projectRoot,
      location: 'main',
    });
    allTasks.push(...mainTasks);
    mainTasks.forEach((task) => mainSpecIds.add(task.specId));
  }

  if (input.worktreesDir && existsSync(input.worktreesDir)) {
    try {
      for (const worktree of readdirSync(input.worktreesDir, { withFileTypes: true })) {
        if (!worktree.isDirectory()) {
          continue;
        }
        const worktreeRoot = join(input.worktreesDir, worktree.name);
        const worktreeSpecsDir = getAutocodeSpecsDir({
          projectRoot: worktreeRoot,
          dataDirName: input.dataDirName,
        });
        if (!existsSync(worktreeSpecsDir)) {
          continue;
        }
        const worktreeTasks = loadAutocodeTasksFromSpecsDir({
          ...input,
          specsDir: worktreeSpecsDir,
          taskProjectRoot: worktreeRoot,
          location: 'worktree',
        }).filter((task) => mainSpecIds.has(task.specId));
        allTasks.push(...worktreeTasks);
      }
    } catch {
      // Host applications may log worktree scan failures if they need more detail.
    }
  }

  return dedupeAutocodeProjectTasks(allTasks);
}

export function loadAutocodeTasksFromSpecsDir(input: LoadAutocodeProjectTasksInput & {
  specsDir: string;
  taskProjectRoot: string;
  location: 'main' | 'worktree';
}): AutocodeProjectTask[] {
  let specDirs: Dirent[];
  try {
    specDirs = readdirSync(input.specsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return specDirs.flatMap((dir) => {
    if (!dir.isDirectory() || dir.name === '.gitkeep') {
      return [];
    }
    const task = readAutocodeProjectTaskFromSpecDir({
      ...input,
      specId: dir.name,
      specDir: join(input.specsDir, dir.name),
    });
    return task ? [task] : [];
  });
}

export function dedupeAutocodeProjectTasks(tasks: AutocodeProjectTask[]): AutocodeProjectTask[] {
  const taskMap = new Map<string, AutocodeProjectTask>();
  for (const task of tasks) {
    const existing = taskMap.get(task.id);
    if (!existing) {
      taskMap.set(task.id, task);
      continue;
    }

    const existingIsMain = existing.location === 'main';
    const newIsMain = task.location === 'main';
    if (existingIsMain && !newIsMain) {
      taskMap.set(task.id, mergeMissingAutocodeProjectTaskFields(existing, task));
    } else if (!existingIsMain && newIsMain) {
      taskMap.set(task.id, mergeMissingAutocodeProjectTaskFields(task, existing));
    } else {
      const existingPriority = AUTOCODE_TASK_STATUS_PRIORITY[existing.status] || 0;
      const newPriority = AUTOCODE_TASK_STATUS_PRIORITY[task.status] || 0;
      taskMap.set(
        task.id,
        newPriority > existingPriority
          ? mergeMissingAutocodeProjectTaskFields(task, existing)
          : mergeMissingAutocodeProjectTaskFields(existing, task),
      );
    }
  }
  return Array.from(taskMap.values());
}

export function determineAutocodeProjectTaskStatus(
  plan: Pick<ImplementationPlanFile, 'status' | 'reviewReason'> | null,
): { status: AutocodeTaskStatus; reviewReason?: AutocodeReviewReason } {
  if (!plan?.status) {
    return { status: 'backlog' };
  }

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
  const status = statusMap[plan.status] ?? 'backlog';
  return {
    status,
    ...(status === 'human_review' && plan.reviewReason ? { reviewReason: plan.reviewReason } : {}),
  };
}

function readAutocodeProjectTaskFromSpecDir(input: LoadAutocodeProjectTasksInput & {
  specId: string;
  specDir: string;
  taskProjectRoot: string;
  location: 'main' | 'worktree';
}): AutocodeProjectTask | null {
  const planPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
  const specFilePath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
  const metadataPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata);

  let plan: ImplementationPlanFile | null = null;
  let hasJsonError = false;
  let jsonErrorMessage = '';
  if (existsSync(planPath)) {
    plan = loadAutocodeImplementationPlanSync(input.specDir) as ImplementationPlanFile | null;
    if (!plan) {
      hasJsonError = true;
      jsonErrorMessage = `Malformed Markdown in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}`;
    }
  }

  const metadata = readJsonFile<AutocodeTaskMetadata>(metadataPath) ?? undefined;
  const requirements = loadAutocodeTaskRequirementsSync(input.specDir);
  const specTitle = readSpecTitle(specFilePath);
  const description = getProjectTaskDescription(requirements, plan, specFilePath);
  const finalDescription = hasJsonError ? `${AUTOCODE_JSON_ERROR_PREFIX}${jsonErrorMessage}` : description;
  const { status, reviewReason } = hasJsonError
    ? { status: 'human_review' as const, reviewReason: 'errors' as const }
    : determineAutocodeProjectTaskStatus(plan);
  const subtasks = extractProjectPlanSubtasks(plan);
  const taskLogs = readAutocodeTaskLogsFromSpecDir(input.specDir, input.specId);
  const corrected = correctStaleAutocodeTaskStatus({
    subtasks,
    hasJsonError,
    status,
    reviewReason,
    plan,
    planPath,
    specId: input.specId,
    persist: input.persistStaleStatusCorrections !== false,
    minAgeMs: input.staleStatusCorrectionAgeMs ?? 30_000,
  });

  const rawTitle = hasJsonError
    ? `${input.specId}${AUTOCODE_JSON_ERROR_TITLE_SUFFIX}`
    : stringFrom(metadata?.taskTitle, specTitle, plan?.feature, plan?.title, input.specId);
  const title = /^\d{3}-/.test(rawTitle) && !hasJsonError
    ? stringFrom(specTitle, rawTitle)
    : rawTitle;

  const progress = inferAutocodeProjectTaskProgress({
    plan,
    subtasks,
    logs: taskLogs,
    status: corrected.status,
    reviewReason: corrected.reviewReason,
  });

  return {
    id: input.specId,
    specId: input.specId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    projectRoot: input.projectRoot,
    title,
    description: finalDescription,
    status: corrected.status,
    subtasks,
    logs: [],
    ...(metadata ? { metadata } : {}),
    ...(corrected.reviewReason ? { reviewReason: corrected.reviewReason } : {}),
    ...(progress ? { executionProgress: progress } : {}),
    ...(plan?.tokenUsage ? { tokenUsage: plan.tokenUsage } : {}),
    ...(plan?.stagedInMainProject !== undefined ? { stagedInMainProject: plan.stagedInMainProject } : {}),
    ...(plan?.stagedAt ? { stagedAt: plan.stagedAt } : {}),
    location: input.location,
    specsPath: input.specDir,
    createdAt: stringFrom(plan?.created_at, new Date(0).toISOString()),
    updatedAt: stringFrom(plan?.updated_at, plan?.created_at, new Date(0).toISOString()),
  };
}

function inferAutocodeProjectTaskProgress(input: {
  plan: ImplementationPlanFile | null;
  subtasks: Array<{ status: string }>;
  logs: AutocodeTaskLogs | null;
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
}): AutocodeProjectTaskExecutionProgress | undefined {
  const persistedProgress = progressFromPhase(input.plan?.executionPhase);
  const xstateProgress = input.plan?.xstateState
    ? inferAutocodeExecutionProgressFromXState(input.plan.xstateState)
    : undefined;
  const statusProgress = inferAuthoritativeProgressFromTaskStatus(input.status, input.reviewReason);
  const planStatusProgress = input.plan?.status && !persistedProgress && !xstateProgress
    ? inferAutocodeExecutionProgress(input.plan.status)
    : undefined;
  const activityProgress = strongestProgress([
    inferProgressFromTaskLogs(input.logs),
    inferProgressFromSubtasks(input.subtasks),
  ]);

  let progress = strongestProgress([persistedProgress, xstateProgress]) ?? statusProgress ?? planStatusProgress;

  if (statusProgress && phaseRank(statusProgress.phase) > phaseRank(progress?.phase)) {
    progress = statusProgress;
  }
  if (activityProgress && phaseRank(activityProgress.phase) > phaseRank(progress?.phase)) {
    progress = activityProgress;
  }

  return progress ?? activityProgress;
}

function inferAuthoritativeProgressFromTaskStatus(
  status: AutocodeTaskStatus,
  reviewReason?: AutocodeReviewReason,
): AutocodeProjectTaskExecutionProgress | undefined {
  switch (status) {
    case 'done':
    case 'pr_created':
      return progressFromPhase('complete');
    case 'human_review':
      return progressFromPhase(reviewReason === 'plan_review' ? 'planning' : 'complete');
    case 'ai_review':
      return progressFromPhase('qa_review');
    case 'error':
      return progressFromPhase('failed');
    default:
      return undefined;
  }
}

function inferProgressFromTaskLogs(logs: AutocodeTaskLogs | null): AutocodeProjectTaskExecutionProgress | undefined {
  if (!logs) {
    return undefined;
  }

  const validation = logs.phases.validation;
  if (validation?.status === 'active' || validation?.entries?.length > 0) {
    return progressFromPhase(validation.status === 'failed' ? 'failed' : 'qa_review');
  }
  if (validation?.status === 'failed') {
    return progressFromPhase('failed');
  }

  const coding = logs.phases.coding;
  if (coding?.status === 'active' || coding?.entries?.length > 0) {
    return progressFromPhase(coding.status === 'failed' ? 'failed' : 'coding');
  }
  if (coding?.status === 'failed') {
    return progressFromPhase('failed');
  }

  const planning = logs.phases.planning;
  if (planning?.status === 'failed') {
    return progressFromPhase('failed');
  }
  if (planning?.status === 'active' || planning?.status === 'completed' || planning?.entries?.length > 0) {
    return progressFromPhase('planning');
  }

  return undefined;
}

function inferProgressFromSubtasks(
  subtasks: Array<{ status: string }>,
): AutocodeProjectTaskExecutionProgress | undefined {
  if (subtasks.some((subtask) => subtask.status === 'in_progress' || subtask.status === 'completed' || subtask.status === 'failed')) {
    return progressFromPhase('coding');
  }
  return undefined;
}

function strongestProgress(
  candidates: Array<AutocodeProjectTaskExecutionProgress | undefined>,
): AutocodeProjectTaskExecutionProgress | undefined {
  return candidates.reduce<AutocodeProjectTaskExecutionProgress | undefined>((strongest, candidate) => {
    if (!candidate) {
      return strongest;
    }
    return phaseRank(candidate.phase) > phaseRank(strongest?.phase) ? candidate : strongest;
  }, undefined);
}

function progressFromPhase(phase: string | undefined): AutocodeProjectTaskExecutionProgress | undefined {
  const normalized = normalizeAutocodeProjectTaskPhase(phase);
  if (!normalized) {
    return undefined;
  }
  const complete = normalized === 'complete';
  const failed = normalized === 'failed';
  return {
    phase: normalized,
    phaseProgress: complete ? 100 : failed || normalized === 'idle' ? 0 : 50,
    overallProgress: complete ? 100 : failed || normalized === 'idle' ? 0 : 50,
  };
}

function normalizeAutocodeProjectTaskPhase(phase: string | undefined): AutocodeExecutionPhase | undefined {
  switch (phase) {
    case 'spec':
      return 'planning';
    case 'review':
      return 'qa_review';
    case 'idle':
    case 'planning':
    case 'coding':
    case 'qa_review':
    case 'qa_fixing':
    case 'complete':
    case 'failed':
    case 'stopped':
      return phase;
    default:
      return undefined;
  }
}

function phaseRank(phase: string | undefined): number {
  switch (phase) {
    case 'idle':
      return 0;
    case 'spec':
    case 'planning':
      return 1;
    case 'coding':
      return 2;
    case 'review':
    case 'qa_review':
      return 3;
    case 'qa_fixing':
      return 4;
    case 'complete':
    case 'stopped':
      return 5;
    case 'failed':
      return 6;
    default:
      return -1;
  }
}

function getProjectTaskDescription(
  requirements: Record<string, unknown> | null,
  plan: ImplementationPlanFile | null,
  specFilePath: string,
): string {
  const requirementDescription = stringFrom(requirements?.task_description);
  if (requirementDescription) {
    return requirementDescription;
  }
  if (plan?.description) {
    return plan.description;
  }
  if (!existsSync(specFilePath)) {
    return '';
  }
  try {
    const content = readFileSync(specFilePath, 'utf8');
    const overviewMatch = content.match(/## Overview\s*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/);
    return overviewMatch?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

function extractProjectPlanSubtasks(plan: ImplementationPlanFile | null): AutocodePlanSubtask[] {
  if (!Array.isArray(plan?.phases)) {
    return [];
  }
  return plan.phases.flatMap((phase, phaseIndex) => {
    const items = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return items.map((subtask, subtaskIndex) => {
      const fallbackLabel = stringFrom(subtask.id, `${phaseIndex + 1}.${subtaskIndex + 1}`);
      const title = stringFrom(subtask.title, subtask.description, `Subtask ${fallbackLabel}`);
      const description = stringFrom(subtask.description, subtask.title, title);
      const completionSummary = subtask.status === 'completed'
        ? stringFrom(
            subtask.completion_summary,
            subtask.completionSummary,
            subtask.completed_summary,
            subtask.notes,
            subtask.actual_output,
          )
        : '';
      return {
        id: stringFrom(subtask.id, `subtask-${phaseIndex + 1}-${subtaskIndex + 1}`),
        title,
        description,
        ...(completionSummary ? { completionSummary } : {}),
        ...(stringFrom(subtask.started_at) ? { startedAt: stringFrom(subtask.started_at) } : {}),
        ...(stringFrom(subtask.completed_at) ? { completedAt: stringFrom(subtask.completed_at) } : {}),
        status: normalizeSubtaskStatus(subtask.status),
        files: [
          ...toStringArray(subtask.files_to_create),
          ...toStringArray(subtask.files_to_modify),
          ...toStringArray(subtask.pattern_files),
        ],
        ...(toStringArray(subtask.depends_on).length > 0 ? { dependsOn: toStringArray(subtask.depends_on) } : {}),
        ...(subtask.work_package === true ? { workPackage: true } : {}),
        ...(toStringArray(subtask.upstream_task_ids).length > 0 ? { upstreamTaskIds: toStringArray(subtask.upstream_task_ids) } : {}),
        ...(stringFrom(subtask.upstream_source) ? { upstreamSource: stringFrom(subtask.upstream_source) } : {}),
      };
    });
  });
}

function correctStaleAutocodeTaskStatus(input: {
  subtasks: Array<{ status: string }>;
  hasJsonError: boolean;
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
  plan: ImplementationPlanFile | null;
  planPath: string;
  specId: string;
  persist: boolean;
  minAgeMs: number;
}): { status: AutocodeTaskStatus; reviewReason?: AutocodeReviewReason } {
  if (input.subtasks.length === 0 || input.hasJsonError) {
    return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
  }

  const allCompleted = input.subtasks.every((subtask) => subtask.status === 'completed');
  if (
    !allCompleted ||
    input.status === 'human_review' ||
    input.status === 'done' ||
    input.status === 'pr_created' ||
    input.status === 'ai_review' ||
    input.status === 'error'
  ) {
    return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
  }

  if (input.plan?.updated_at) {
    const ageMs = Date.now() - new Date(input.plan.updated_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < input.minAgeMs) {
      return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
    }
  }

  if (input.persist && input.plan) {
    const correctedPlan: ImplementationPlanFile = {
      ...input.plan,
      status: 'human_review',
      planStatus: 'review',
      reviewReason: 'completed',
      updated_at: new Date().toISOString(),
      xstateState: 'human_review',
      executionPhase: 'complete',
    };
    try {
      saveAutocodeImplementationPlanSync(input.planPath, correctedPlan as unknown as MutableAutocodePlan);
      Object.assign(input.plan, correctedPlan);
    } catch {
      return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
    }
  }

  return { status: 'human_review', reviewReason: 'completed' };
}

function mergeMissingAutocodeProjectTaskFields(
  preferred: AutocodeProjectTask,
  fallback: AutocodeProjectTask,
): AutocodeProjectTask {
  let merged = preferred;
  if (!preferred.description.trim() && fallback.description.trim()) {
    merged = { ...merged, description: fallback.description };
  }

  if (!preferred.metadata && fallback.metadata) {
    merged = { ...merged, metadata: fallback.metadata };
  } else if (preferred.metadata && fallback.metadata) {
    const mergedMetadata: AutocodeTaskMetadata = {
      ...fallback.metadata,
      ...preferred.metadata,
    };
    const preferredSource = preferred.metadata.sourceType;
    const fallbackSource = fallback.metadata.sourceType;
    if ((!preferredSource && fallbackSource) || (preferredSource === 'manual' && fallbackSource && fallbackSource !== 'manual')) {
      mergedMetadata.sourceType = fallbackSource;
    }
    merged = { ...merged, metadata: mergedMetadata };
  }

  const mergedTokenUsage = mergeProjectTokenUsage(preferred.tokenUsage, fallback.tokenUsage);
  if (mergedTokenUsage) {
    merged = { ...merged, tokenUsage: mergedTokenUsage };
  }

  if (shouldRestoreProjectSubtasks(preferred, fallback)) {
    merged = { ...merged, subtasks: fallback.subtasks };
  }

  return merged;
}

function mergeProjectTokenUsage(
  preferred: AutocodeTokenUsage | undefined,
  fallback: AutocodeTokenUsage | undefined,
): AutocodeTokenUsage | undefined {
  if (!preferred) return fallback;
  if (!fallback) return preferred;
  return {
    promptTokens: Math.max(preferred.promptTokens ?? 0, fallback.promptTokens ?? 0),
    completionTokens: Math.max(preferred.completionTokens ?? 0, fallback.completionTokens ?? 0),
    totalTokens: Math.max(preferred.totalTokens ?? 0, fallback.totalTokens ?? 0),
    thinkingTokens: Math.max(preferred.thinkingTokens ?? 0, fallback.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(preferred.cacheReadTokens ?? 0, fallback.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(preferred.cacheCreationTokens ?? 0, fallback.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(preferred.stepsExecuted ?? 0, fallback.stepsExecuted ?? 0) || undefined,
  };
}

function shouldRestoreProjectSubtasks(preferred: AutocodeProjectTask, fallback: AutocodeProjectTask): boolean {
  if (fallback.subtasks.length === 0) {
    return false;
  }
  if (preferred.subtasks.length === 0) {
    return true;
  }
  if (fallback.subtasks.length !== preferred.subtasks.length) {
    return fallback.subtasks.length > preferred.subtasks.length;
  }
  return getProjectSubtaskProgressScore(fallback.subtasks) > getProjectSubtaskProgressScore(preferred.subtasks);
}

function getProjectSubtaskProgressScore(subtasks: Array<{ status: string }>): number {
  return subtasks.reduce((score, subtask) => {
    switch (subtask.status) {
      case 'completed':
        return score + 3;
      case 'in_progress':
      case 'failed':
        return score + 2;
      default:
        return score + 1;
    }
  }, 0);
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

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return safeParseAutocodeJson<T>(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeSubtaskStatus(value: unknown): AutocodeSubtaskStatus {
  return value === 'in_progress' || value === 'completed' || value === 'failed' ? value : 'pending';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => stringFrom(item))
    .filter(Boolean);
}

function stringFrom(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}
