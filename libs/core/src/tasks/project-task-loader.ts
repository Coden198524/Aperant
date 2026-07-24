import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
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
import {
  AUTOCODE_DIRECT_SESSION_STATE_VERSION,
  resolveAutocodeDirectSessionState,
  saveAutocodeDirectSessionState,
} from '../runtime/direct-session-state.js';

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
  workflow_type?: string;
  status?: string;
  planStatus?: string;
  reviewReason?: AutocodeReviewReason;
  executionPhase?: string;
  xstateState?: string;
  stagedInMainProject?: boolean;
  stagedAt?: string;
  tokenUsage?: AutocodeTokenUsage;
  direct_execution?: {
    enabled?: boolean;
    outcome?: string;
    completed_at?: string;
    current_subtask_id?: string;
    change_request_id?: string;
    summary_file?: string;
  };
  phases?: Array<{
    subtasks?: RawProjectPlanSubtask[];
    chunks?: RawProjectPlanSubtask[];
    type?: string;
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
  active_started_at?: unknown;
  completed_at?: unknown;
  updated_at?: unknown;
  duration_ms?: unknown;
  durationMs?: unknown;
  files_to_create?: unknown;
  files_to_modify?: unknown;
  pattern_files?: unknown;
  changed_files?: unknown;
  depends_on?: unknown;
  work_package?: unknown;
  upstream_task_ids?: unknown;
  upstream_source?: unknown;
}

interface AutocodeRunResultFile {
  phase?: string;
  exitCode?: number | null;
  status?: string;
  message?: string;
  updatedAt?: string;
}

interface CodingWorkItemLogStatusEvent {
  id: string;
  status: 'completed' | 'failed';
  timestamp?: string;
  content: string;
  completionSummary?: string;
  changedFiles?: string[];
}

interface RecoverableImplementationPlan extends Record<string, unknown> {
  phases?: Array<{
    subtasks?: RawProjectPlanSubtask[];
    chunks?: RawProjectPlanSubtask[];
    type?: string;
  }>;
  updated_at?: string;
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
  const runResultPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.runResult);

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
  const runResult = readJsonFile<AutocodeRunResultFile>(runResultPath) ?? undefined;
  const runResultMtimeMs = fileModifiedTimeMs(runResultPath);
  const requirements = loadAutocodeTaskRequirementsSync(input.specDir);
  const specTitle = readSpecTitle(specFilePath);
  const description = getProjectTaskDescription(requirements, plan, specFilePath);
  const finalDescription = hasJsonError ? `${AUTOCODE_JSON_ERROR_PREFIX}${jsonErrorMessage}` : description;
  let { status, reviewReason } = hasJsonError
    ? { status: 'human_review' as const, reviewReason: 'errors' as const }
    : determineAutocodeProjectTaskStatus(plan);
  let subtasks = extractProjectPlanSubtasks(plan);
  const taskLogs = readAutocodeTaskLogsFromSpecDir(input.specDir, input.specId);
  if (!hasJsonError && plan && taskLogs) {
    const recovery = recoverAutocodeCodingWorkItemStatusesFromLogs({ plan: plan as unknown as Record<string, unknown>, logs: taskLogs });
    if (recovery.recoveredCount > 0 && recovery.plan) {
      try {
        if (input.persistStaleStatusCorrections !== false) {
          saveAutocodeImplementationPlanSync(planPath, recovery.plan as unknown as MutableAutocodePlan);
        }
        plan = recovery.plan as ImplementationPlanFile;
        subtasks = extractProjectPlanSubtasks(plan);
        ({ status, reviewReason } = determineAutocodeProjectTaskStatus(plan));
      } catch {
        // Keep the on-disk plan authoritative if recovery cannot be persisted.
      }
    }
  }
  const corrected = correctStaleAutocodeTaskStatus({
    subtasks,
    hasJsonError,
    status,
    reviewReason,
    plan,
    planPath,
    specDir: input.specDir,
    specId: input.specId,
    metadata,
    runResult,
    runResultMtimeMs,
    logs: taskLogs,
    taskDescription: finalDescription,
    persist: input.persistStaleStatusCorrections !== false,
    minAgeMs: input.staleStatusCorrectionAgeMs ?? 30_000,
  });
  subtasks = extractProjectPlanSubtasks(plan);

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
  const isStoppedReview = input.status === 'human_review' && input.reviewReason === 'stopped';
  if (isStoppedReview) {
    return progressFromPhase('stopped');
  }

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
      if (reviewReason === 'stopped') {
        return undefined;
      }
      return progressFromPhase(reviewReason === 'plan_review' ? 'planning' : 'complete');
    case 'ai_review':
      return progressFromPhase('qa_review');
    case 'error':
      return progressFromPhase('failed');
    default:
      return undefined;
  }
}

function inferProgressFromTaskLogs(
  logs: AutocodeTaskLogs | null,
  options: { ignoreFailedStatus?: boolean } = {},
): AutocodeProjectTaskExecutionProgress | undefined {
  if (!logs) {
    return undefined;
  }

  const validation = logs.phases.validation;
  if (validation?.status === 'active' || validation?.entries?.length > 0) {
    return progressFromPhase(validation.status === 'failed' && !options.ignoreFailedStatus ? 'failed' : 'qa_review');
  }
  if (validation?.status === 'failed' && !options.ignoreFailedStatus) {
    return progressFromPhase('failed');
  }

  const coding = logs.phases.coding;
  if (coding?.status === 'active' || coding?.entries?.length > 0) {
    return progressFromPhase(coding.status === 'failed' && !options.ignoreFailedStatus ? 'failed' : 'coding');
  }
  if (coding?.status === 'failed' && !options.ignoreFailedStatus) {
    return progressFromPhase('failed');
  }

  const planning = logs.phases.planning;
  if (planning?.status === 'failed' && !options.ignoreFailedStatus) {
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
  const inactive = normalized === 'idle' || normalized === 'stopped';
  return {
    phase: normalized,
    phaseProgress: complete ? 100 : failed || inactive ? 0 : 50,
    overallProgress: complete ? 100 : failed || inactive ? 0 : 50,
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
    case 'stopped':
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
      const durationMs = numberFrom(subtask.duration_ms, subtask.durationMs);
      const changedFiles = toStringArray(subtask.changed_files);
      const plannedFiles = [
        ...toStringArray(subtask.files_to_create),
        ...toStringArray(subtask.files_to_modify),
        ...toStringArray(subtask.pattern_files),
      ];
      return {
        id: stringFrom(subtask.id, `subtask-${phaseIndex + 1}-${subtaskIndex + 1}`),
        title,
        description,
        ...(completionSummary ? { completionSummary } : {}),
        ...(stringFrom(subtask.started_at) ? { startedAt: stringFrom(subtask.started_at) } : {}),
        ...(stringFrom(subtask.active_started_at) ? { activeStartedAt: stringFrom(subtask.active_started_at) } : {}),
        ...(stringFrom(subtask.completed_at) ? { completedAt: stringFrom(subtask.completed_at) } : {}),
        ...(stringFrom(subtask.updated_at) ? { updatedAt: stringFrom(subtask.updated_at) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        status: normalizeSubtaskStatus(subtask.status),
        files: changedFiles.length > 0 ? changedFiles : plannedFiles,
        ...(toStringArray(subtask.depends_on).length > 0 ? { dependsOn: toStringArray(subtask.depends_on) } : {}),
        ...(subtask.work_package === true ? { workPackage: true } : {}),
        ...(toStringArray(subtask.upstream_task_ids).length > 0 ? { upstreamTaskIds: toStringArray(subtask.upstream_task_ids) } : {}),
        ...(stringFrom(subtask.upstream_source) ? { upstreamSource: stringFrom(subtask.upstream_source) } : {}),
      };
    });
  });
}

export function recoverAutocodeCodingWorkItemStatusesFromLogs(input: {
  plan: Record<string, unknown> | null | undefined;
  logs: AutocodeTaskLogs | null | undefined;
  now?: string;
}): { plan: Record<string, unknown> | null; recoveredCount: number; latestRecoveredAt?: string } {
  const plan = input.plan as RecoverableImplementationPlan | null | undefined;
  if (!plan || !Array.isArray(plan.phases) || !input.logs) {
    return { plan: input.plan ?? null, recoveredCount: 0 };
  }

  const events = readCodingWorkItemStatusEvents(input.logs);
  if (events.size === 0) {
    return { plan: input.plan ?? null, recoveredCount: 0 };
  }

  let recoveredCount = 0;
  let latestRecoveredAt = '';
  const rewriteItems = (items: RawProjectPlanSubtask[] | undefined): RawProjectPlanSubtask[] | undefined => {
    if (!Array.isArray(items)) {
      return items;
    }

    return items.map((subtask) => {
      const subtaskId = stringFrom(subtask.id);
      const event = events.get(subtaskId);
      const currentStatus = normalizeSubtaskStatus(subtask.status);
      if (!event || (currentStatus !== 'in_progress' && currentStatus !== 'completed')) {
        return subtask;
      }
      if (!isCodingWorkItemStatusEventFreshForSubtask(event, subtask)) {
        return subtask;
      }

      if (currentStatus === 'completed') {
        if (event.status !== 'completed') {
          return subtask;
        }
        const existingSummary = getRawProjectSubtaskCompletionSummary(subtask);
        const completionSummary = selectRecoveredCompletionSummary(
          existingSummary,
          event.completionSummary,
        );
        const existingChangedFiles = toStringArray(subtask.changed_files);
        const changedFiles = event.changedFiles && event.changedFiles.length > 0
          ? event.changedFiles
          : existingChangedFiles;
        const shouldUpdateSummary = Boolean(completionSummary && completionSummary !== existingSummary);
        const shouldUpdateChangedFiles = changedFiles.length > 0 &&
          !areStringArraysEqual(existingChangedFiles, changedFiles);
        if (!shouldUpdateSummary && !shouldUpdateChangedFiles) {
          return subtask;
        }

        recoveredCount += 1;
        const eventTimestamp = stringFrom(event.timestamp, input.now, new Date().toISOString());
        latestRecoveredAt = maxIsoTimestamp(latestRecoveredAt, eventTimestamp);
        return {
          ...subtask,
          ...(completionSummary
            ? { completion_summary: completionSummary, notes: completionSummary }
            : {}),
          ...(changedFiles.length > 0 ? { changed_files: changedFiles } : {}),
        };
      }

      recoveredCount += 1;
      const eventTimestamp = stringFrom(event.timestamp, input.now, new Date().toISOString());
      latestRecoveredAt = maxIsoTimestamp(latestRecoveredAt, eventTimestamp);
      if (event.status === 'completed') {
        const completionSummary = selectRecoveredCompletionSummary(
          getRawProjectSubtaskCompletionSummary(subtask),
          event.completionSummary,
        ) || 'Recovered completed status from task log.';
        return {
          ...subtask,
          status: 'completed',
          completed_at: stringFrom(subtask.completed_at, eventTimestamp),
          completion_summary: completionSummary,
          notes: completionSummary,
          ...(event.changedFiles && event.changedFiles.length > 0
            ? { changed_files: event.changedFiles }
            : {}),
        };
      }

      const rest = { ...subtask } as RawProjectPlanSubtask & { completionSummary?: unknown };
      delete rest.completed_at;
      delete rest.completion_summary;
      delete rest.completionSummary;
      delete rest.completed_summary;
      return {
        ...rest,
        status: 'failed',
        updated_at: eventTimestamp,
        notes: stringFrom(subtask.notes, event.content, 'Recovered failed status from task log.'),
        actual_output: stringFrom(subtask.actual_output, event.content, 'Recovered failed status from task log.'),
      };
    });
  };

  const phases = plan.phases.map((phase) => ({
    ...phase,
    subtasks: rewriteItems(phase.subtasks),
    chunks: rewriteItems(phase.chunks),
  }));

  if (recoveredCount === 0) {
    return { plan: input.plan ?? null, recoveredCount: 0 };
  }

  const recoveredPlan: RecoverableImplementationPlan = {
    ...plan,
    updated_at: maxIsoTimestamp(stringFrom(plan.updated_at), latestRecoveredAt) || latestRecoveredAt,
    phases,
  };
  return { plan: recoveredPlan, recoveredCount, latestRecoveredAt };
}

function readCodingWorkItemStatusEvents(logs: AutocodeTaskLogs): Map<string, CodingWorkItemLogStatusEvent> {
  const events = new Map<string, CodingWorkItemLogStatusEvent>();
  const latestModelSummaryBySubtask = new Map<string, string>();
  for (const entry of logs.phases.coding?.entries ?? []) {
    const entrySubtaskId = stringFrom(entry.subtask_id);
    if (entrySubtaskId && entry.type === 'text') {
      const summary = compactRecoveredCompletionSummary(stringFrom(entry.detail, entry.content));
      if (summary) {
        latestModelSummaryBySubtask.set(entrySubtaskId, summary);
      }
    }

    const text = stringFrom(entry.content);
    const match = /\bWork item\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)\s+(completed|failed|interrupted)\b/i.exec(text);
    if (!match) {
      continue;
    }
    const status = match[2].toLowerCase() === 'completed' ? 'completed' : 'failed';
    events.set(match[1], {
      id: match[1],
      status,
      timestamp: stringFrom(entry.timestamp),
      content: text,
      completionSummary: latestModelSummaryBySubtask.get(match[1]),
      changedFiles: toStringArray(entry.changed_files),
    });
  }
  return events;
}

function getRawProjectSubtaskCompletionSummary(subtask: RawProjectPlanSubtask): string {
  return stringFrom(
    subtask.completion_summary,
    subtask.completionSummary,
    subtask.completed_summary,
    subtask.notes,
    subtask.actual_output,
  );
}

function selectRecoveredCompletionSummary(existing: string, recovered: string | undefined): string {
  if (!recovered) {
    return existing;
  }
  return !existing || isGenericProjectCompletionSummary(existing) ? recovered : existing;
}

function isGenericProjectCompletionSummary(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return /^Completed by (?:Autocode )?(?:Direct )?CLI (?:runner|run)\.?$/i.test(normalized) ||
    /^Recovered completed status from task log\.?$/i.test(normalized);
}

function compactRecoveredCompletionSummary(value: string): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (normalized.length <= 1200) {
    return normalized;
  }
  return normalized.slice(0, 1197).trimEnd() + '...';
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCodingWorkItemStatusEventFreshForSubtask(
  event: CodingWorkItemLogStatusEvent,
  subtask: RawProjectPlanSubtask,
): boolean {
  const startedMs = timestampMs(stringFrom(subtask.started_at));
  const eventMs = timestampMs(event.timestamp);
  return startedMs === undefined || eventMs === undefined || eventMs >= startedMs - 1000;
}

function maxIsoTimestamp(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === undefined) return right;
  if (rightMs === undefined) return left;
  return rightMs > leftMs ? right : left;
}

function correctStaleAutocodeTaskStatus(input: {
  subtasks: Array<{ status: string }>;
  hasJsonError: boolean;
  status: AutocodeTaskStatus;
  reviewReason?: AutocodeReviewReason;
  plan: ImplementationPlanFile | null;
  planPath: string;
  specDir: string;
  specId: string;
  metadata?: AutocodeTaskMetadata;
  runResult?: AutocodeRunResultFile;
  runResultMtimeMs?: number;
  logs?: AutocodeTaskLogs | null;
  taskDescription?: string;
  persist: boolean;
  minAgeMs: number;
}): { status: AutocodeTaskStatus; reviewReason?: AutocodeReviewReason } {
  if (input.hasJsonError) {
    return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
  }

  if (shouldResumeStaleCompletedDirectIteration(input)) {
    if (input.persist && input.plan) {
      const now = new Date().toISOString();
      const correctedPlan = applyRunningDirectIterationCorrection(input.plan, now);
      try {
        saveAutocodeImplementationPlanSync(input.planPath, correctedPlan as unknown as MutableAutocodePlan);
        Object.assign(input.plan, correctedPlan);
      } catch {
        return { status: 'in_progress' };
      }
    }
    return { status: 'in_progress' };
  }

  if (hasFreshTerminalFailedDirectRunResult(input)) {
    if (input.persist && input.plan) {
      const now = new Date().toISOString();
      const correctedPlan = applyFailedDirectRunCorrection(input.plan, input.runResult, now);
      try {
        saveAutocodeImplementationPlanSync(input.planPath, correctedPlan as unknown as MutableAutocodePlan);
        Object.assign(input.plan, correctedPlan);
      } catch {
        return { status: 'error', reviewReason: 'errors' };
      }
    }
    return { status: 'error', reviewReason: 'errors' };
  }

  if (isCompletedDirectRun(input)) {
    if (input.persist && input.plan) {
      const now = new Date().toISOString();
      const correctedPlan = applyCompletedDirectRunCorrection(input.plan, input.runResult, now);
      try {
        saveAutocodeImplementationPlanSync(input.planPath, correctedPlan as unknown as MutableAutocodePlan);
        ensureDirectSessionStateForCompletedRun(input, now);
        Object.assign(input.plan, correctedPlan);
      } catch {
        return { status: 'human_review', reviewReason: 'completed' };
      }
    }
    return { status: 'human_review', reviewReason: 'completed' };
  }

  if (input.subtasks.length === 0) {
    return { status: input.status, ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}) };
  }

  const allCompleted = input.subtasks.every((subtask) => subtask.status === 'completed');
  if (allCompleted && input.status === 'human_review' && !input.reviewReason) {
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
        return { status: 'human_review', reviewReason: 'completed' };
      }
    }
    return { status: 'human_review', reviewReason: 'completed' };
  }

  if (!allCompleted && shouldResumeIncompleteReviewStatus(input.status, input.reviewReason)) {
    if (input.persist && input.plan) {
      const correctedPlan: ImplementationPlanFile = {
        ...input.plan,
        status: 'coding',
        planStatus: 'coding',
        updated_at: new Date().toISOString(),
        xstateState: 'coding',
        executionPhase: 'coding',
      };
      delete correctedPlan.reviewReason;
      try {
        saveAutocodeImplementationPlanSync(input.planPath, correctedPlan as unknown as MutableAutocodePlan);
        Object.assign(input.plan, correctedPlan);
      } catch {
        return { status: 'in_progress' };
      }
    }
    return { status: 'in_progress' };
  }

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

function isCompletedDirectRun(input: Parameters<typeof correctStaleAutocodeTaskStatus>[0]): boolean {
  if (
    input.status === 'done' ||
    input.status === 'pr_created' ||
    (input.status === 'human_review' && input.reviewReason === 'completed')
  ) {
    return false;
  }

  if (!isDirectAutocodeTask(input)) {
    return false;
  }

  if (hasFreshNonSuccessfulDirectRunResult(input)) {
    return false;
  }

  return hasFreshSuccessfulDirectRunResult(input) || hasFreshCompletedDirectPlanOutcome(input);
}

function shouldResumeStaleCompletedDirectIteration(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): boolean {
  if (!input.plan || !isDirectAutocodeTask(input)) {
    return false;
  }

  const isCompletedStatus = input.status === 'done' ||
    input.status === 'pr_created' ||
    (input.status === 'human_review' && input.reviewReason === 'completed') ||
    input.plan.direct_execution?.outcome === 'completed';
  if (!isCompletedStatus) {
    return false;
  }

  const iterationStartedAtMs = getCurrentDirectIterationStartedAtMs(input.plan);
  if (iterationStartedAtMs === undefined) {
    return false;
  }

  const completionEvidenceMs = getFreshestDirectCompletionEvidenceMs(input);
  if (completionEvidenceMs !== undefined && completionEvidenceMs >= iterationStartedAtMs) {
    return false;
  }

  const latestLogActivityMs = getLatestTaskLogActivityMs(input.logs);
  if (latestLogActivityMs !== undefined && latestLogActivityMs < iterationStartedAtMs) {
    return false;
  }

  return true;
}

function isDirectAutocodeTask(input: Parameters<typeof correctStaleAutocodeTaskStatus>[0]): boolean {
  return input.metadata?.developmentMode === 'direct' ||
    input.metadata?.workflowMode === 'off' ||
    input.plan?.workflow_type === 'direct' ||
    input.plan?.direct_execution?.enabled === true;
}

function hasFreshSuccessfulDirectRunResult(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): boolean {
  return isSuccessfulDirectRunResult(input.runResult) &&
    isDirectEvidenceFreshForCurrentIteration(input, getDirectRunResultEvidenceMs(input));
}

function isSuccessfulDirectRunResult(runResult: AutocodeRunResultFile | undefined): boolean {
  return runResult?.phase === 'direct' &&
    runResult.exitCode === 0 &&
    isSuccessfulDirectOutcome(runResult.status);
}

function hasFreshNonSuccessfulDirectRunResult(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): boolean {
  if (input.runResult?.phase !== 'direct') {
    return false;
  }
  if (isSuccessfulDirectRunResult(input.runResult)) {
    return false;
  }
  return isDirectEvidenceFreshForCurrentIteration(input, getDirectRunResultEvidenceMs(input));
}

function hasFreshTerminalFailedDirectRunResult(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): boolean {
  return isTerminalFailedDirectRunResult(input.runResult) &&
    isDirectEvidenceFreshForCurrentIteration(input, getDirectRunResultEvidenceMs(input));
}

function isTerminalFailedDirectRunResult(runResult: AutocodeRunResultFile | undefined): boolean {
  if (runResult?.phase !== 'direct' || isSuccessfulDirectRunResult(runResult)) {
    return false;
  }
  const normalized = runResult.status?.trim().toLowerCase();
  if (
    normalized === 'error' ||
    normalized === 'failed' ||
    normalized === 'failure' ||
    normalized === 'auth_failure' ||
    normalized === 'auth_failed' ||
    normalized === 'timeout' ||
    normalized === 'cancelled' ||
    normalized === 'canceled'
  ) {
    return true;
  }
  return typeof runResult.exitCode === 'number' && runResult.exitCode !== 0;
}

function hasFreshCompletedDirectPlanOutcome(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): boolean {
  if (!isSuccessfulDirectOutcome(input.plan?.direct_execution?.outcome)) {
    return false;
  }
  const completedAtMs = timestampMs(input.plan?.direct_execution?.completed_at);
  if (hasActiveCodingLogAfter(input.logs, completedAtMs)) {
    return false;
  }
  return isDirectEvidenceFreshForCurrentIteration(input, completedAtMs);
}

function hasActiveCodingLogAfter(
  logs: AutocodeTaskLogs | null | undefined,
  evidenceMs: number | undefined,
): boolean {
  if (evidenceMs === undefined || logs?.phases?.coding?.status !== 'active') {
    return false;
  }
  const coding = logs.phases.coding;
  const timestamps = [
    timestampMs(logs.updated_at),
    timestampMs(coding.started_at ?? undefined),
    timestampMs(coding.completed_at ?? undefined),
    ...coding.entries.map((entry) => timestampMs(entry.timestamp)),
  ].filter((value): value is number => value !== undefined);
  return timestamps.some((timestamp) => timestamp > evidenceMs);
}

function isDirectEvidenceFreshForCurrentIteration(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
  evidenceMs: number | undefined,
): boolean {
  const iterationStartedAtMs = getCurrentDirectIterationStartedAtMs(input.plan);
  if (iterationStartedAtMs === undefined) {
    return true;
  }
  return evidenceMs !== undefined && evidenceMs >= iterationStartedAtMs;
}

function getDirectRunResultEvidenceMs(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): number | undefined {
  return timestampMs(input.runResult?.updatedAt) ?? input.runResultMtimeMs;
}

function getFreshestDirectCompletionEvidenceMs(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
): number | undefined {
  const timestamps: number[] = [];
  if (isSuccessfulDirectOutcome(input.plan?.direct_execution?.outcome)) {
    const completedAtMs = timestampMs(input.plan?.direct_execution?.completed_at);
    if (completedAtMs !== undefined && !hasActiveCodingLogAfter(input.logs, completedAtMs)) {
      timestamps.push(completedAtMs);
    }
  }
  if (isSuccessfulDirectRunResult(input.runResult)) {
    const runResultUpdatedAtMs = getDirectRunResultEvidenceMs(input);
    if (runResultUpdatedAtMs !== undefined) {
      timestamps.push(runResultUpdatedAtMs);
    }
  }

  const directSession = resolveAutocodeDirectSessionState(input.specDir);
  if (isSuccessfulDirectOutcome(directSession?.lastOutcome)) {
    const sessionUpdatedAtMs = timestampMs(directSession?.updatedAt);
    if (sessionUpdatedAtMs !== undefined) {
      timestamps.push(sessionUpdatedAtMs);
    }
  }

  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function isSuccessfulDirectOutcome(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'success' || normalized === 'completed' || normalized === 'done';
}

function getCurrentDirectIterationStartedAtMs(plan: ImplementationPlanFile | null): number | undefined {
  if (!plan) {
    return undefined;
  }
  const directSubtaskId = stringFrom(plan.direct_execution?.current_subtask_id);
  const encodedIterationStartedAtMs = parseDirectChangeRequestTimestampMs(directSubtaskId)
    ?? parseDirectChangeRequestTimestampMs(stringFrom(plan.direct_execution?.change_request_id));
  if (encodedIterationStartedAtMs !== undefined) {
    return encodedIterationStartedAtMs;
  }

  const currentSubtask = findDirectSubtask(plan, directSubtaskId);
  return timestampMs(stringFrom(currentSubtask?.started_at));
}

function findDirectSubtask(
  plan: ImplementationPlanFile,
  subtaskId: string,
): RawProjectPlanSubtask | undefined {
  if (!subtaskId) {
    return undefined;
  }
  for (const phase of plan.phases ?? []) {
    const items = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    const match = items.find((subtask) => stringFrom(subtask.id) === subtaskId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function parseDirectChangeRequestTimestampMs(value: string): number | undefined {
  const match = /(?:^|-)cr-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/.exec(value);
  if (!match) {
    return undefined;
  }
  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getLatestTaskLogActivityMs(logs: AutocodeTaskLogs | null | undefined): number | undefined {
  if (!logs) {
    return undefined;
  }
  const timestamps = [
    timestampMs(logs.updated_at),
    ...Object.values(logs.phases ?? {}).flatMap((phase) => [
      timestampMs(phase.started_at ?? undefined),
      timestampMs(phase.completed_at ?? undefined),
      ...phase.entries.map((entry) => timestampMs(entry.timestamp)),
    ]),
  ].filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function applyCompletedDirectRunCorrection(
  plan: ImplementationPlanFile,
  runResult: AutocodeRunResultFile | undefined,
  now: string,
): ImplementationPlanFile {
  const directSubtaskId = stringFrom(plan.direct_execution?.current_subtask_id);
  const completionSummary = stringFrom(runResult?.message, 'Completed by Autocode Direct CLI run.');
  const phases = (plan.phases ?? []).map((phase) => {
    const phaseIsDirect = phase.type === 'direct';
    const rewriteItems = (items: RawProjectPlanSubtask[] | undefined): RawProjectPlanSubtask[] | undefined => {
      if (!Array.isArray(items)) {
        return items;
      }
      return items.map((subtask) => {
        const subtaskId = stringFrom(subtask.id);
        const shouldRewrite = directSubtaskId ? subtaskId === directSubtaskId : phaseIsDirect;
        if (!shouldRewrite) {
          return subtask;
        }
        return {
          ...subtask,
          status: 'completed',
          completed_at: stringFrom(subtask.completed_at, now),
          completion_summary: completionSummary,
          notes: completionSummary,
        };
      });
    };
    return {
      ...phase,
      subtasks: rewriteItems(phase.subtasks),
      chunks: rewriteItems(phase.chunks),
    };
  });

  return {
    ...plan,
    status: 'human_review',
    planStatus: 'review',
    reviewReason: 'completed',
    updated_at: now,
    xstateState: 'human_review',
    executionPhase: 'complete',
    direct_execution: {
      ...plan.direct_execution,
      enabled: true,
      outcome: 'completed',
      completed_at: now,
      summary_file: plan.direct_execution?.summary_file || AUTOCODE_TASK_ARTIFACTS.directSummary,
      ...(directSubtaskId ? { current_subtask_id: directSubtaskId } : {}),
    },
    phases,
  };
}

function applyFailedDirectRunCorrection(
  plan: ImplementationPlanFile,
  runResult: AutocodeRunResultFile | undefined,
  now: string,
): ImplementationPlanFile {
  const directSubtaskId = stringFrom(plan.direct_execution?.current_subtask_id);
  const failureOutcome = normalizeFailedDirectRunOutcome(runResult?.status);
  const failureSummary = stringFrom(runResult?.message, 'Autocode Direct run failed.');
  const failedAt = stringFrom(runResult?.updatedAt, now);
  const phases = (plan.phases ?? []).map((phase) => {
    const phaseIsDirect = phase.type === 'direct';
    const rewriteItems = (items: RawProjectPlanSubtask[] | undefined): RawProjectPlanSubtask[] | undefined => {
      if (!Array.isArray(items)) {
        return items;
      }
      return items.map((subtask) => {
        const subtaskId = stringFrom(subtask.id);
        if (!phaseIsDirect && (!directSubtaskId || subtaskId !== directSubtaskId)) {
          return subtask;
        }
        const rest = { ...subtask } as RawProjectPlanSubtask & { completionSummary?: unknown };
        delete rest.completed_at;
        delete rest.completion_summary;
        delete rest.completionSummary;
        delete rest.completed_summary;
        return {
          ...rest,
          status: 'failed',
          updated_at: failedAt,
          notes: stringFrom(subtask.notes, subtask.actual_output, failureSummary),
          actual_output: stringFrom(subtask.actual_output, subtask.notes, failureSummary),
        };
      });
    };
    return {
      ...phase,
      subtasks: rewriteItems(phase.subtasks),
      chunks: rewriteItems(phase.chunks),
    };
  });

  const directExecution = {
    ...(plan.direct_execution ?? {}),
    enabled: true,
    outcome: failureOutcome,
    summary_file: plan.direct_execution?.summary_file || AUTOCODE_TASK_ARTIFACTS.directSummary,
    ...(directSubtaskId ? { current_subtask_id: directSubtaskId } : {}),
  };
  delete directExecution.completed_at;

  const correctedPlan: ImplementationPlanFile = {
    ...plan,
    status: 'error',
    planStatus: 'error',
    reviewReason: 'errors',
    updated_at: now,
    xstateState: 'error',
    executionPhase: 'failed',
    direct_execution: directExecution,
    phases,
  };
  return correctedPlan;
}

function normalizeFailedDirectRunOutcome(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'failed';
}

function applyRunningDirectIterationCorrection(plan: ImplementationPlanFile, now: string): ImplementationPlanFile {
  const directSubtaskId = stringFrom(plan.direct_execution?.current_subtask_id);
  const phases = (plan.phases ?? []).map((phase) => {
    const rewriteItems = (items: RawProjectPlanSubtask[] | undefined): RawProjectPlanSubtask[] | undefined => {
      if (!Array.isArray(items) || !directSubtaskId) {
        return items;
      }
      return items.map((subtask) => {
        if (stringFrom(subtask.id) !== directSubtaskId) {
          return subtask;
        }
        const rest = { ...subtask } as RawProjectPlanSubtask & { completionSummary?: unknown };
        delete rest.completed_at;
        delete rest.completion_summary;
        delete rest.completionSummary;
        delete rest.completed_summary;
        delete rest.notes;
        delete rest.actual_output;
        return {
          ...rest,
          status: 'in_progress',
          started_at: stringFrom(subtask.started_at, now),
          updated_at: now,
        };
      });
    };
    return {
      ...phase,
      subtasks: rewriteItems(phase.subtasks),
      chunks: rewriteItems(phase.chunks),
    };
  });

  const directExecution = {
    ...(plan.direct_execution ?? {}),
    enabled: true,
    outcome: 'running',
    summary_file: plan.direct_execution?.summary_file || AUTOCODE_TASK_ARTIFACTS.directSummary,
    ...(directSubtaskId ? { current_subtask_id: directSubtaskId } : {}),
  };
  delete directExecution.completed_at;

  const correctedPlan: ImplementationPlanFile = {
    ...plan,
    status: 'coding',
    planStatus: 'coding',
    updated_at: now,
    xstateState: 'coding',
    executionPhase: 'coding',
    direct_execution: directExecution,
    phases,
  };
  delete correctedPlan.reviewReason;
  return correctedPlan;
}

function ensureDirectSessionStateForCompletedRun(
  input: Parameters<typeof correctStaleAutocodeTaskStatus>[0],
  now: string,
): void {
  if (resolveAutocodeDirectSessionState(input.specDir)) {
    return;
  }

  try {
    const summary = readTextFile(join(input.specDir, AUTOCODE_TASK_ARTIFACTS.directSummary)) ||
      input.runResult?.message ||
      'Autocode Direct run completed.';
    saveAutocodeDirectSessionState(input.specDir, {
      version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
      sessionId: input.plan?.tokenUsage?.sessionId || `direct-${input.specId}`,
      createdAt: input.plan?.created_at || now,
      updatedAt: now,
      iteration: 1,
      provider: 'codex-cli',
      originalRequest: input.taskDescription,
      latestSummary: summary,
      changedFiles: [],
      lastOutcome: input.runResult?.status || 'success',
    });
  } catch {
    // Status correction should not fail just because the compact continuation state
    // could not be backfilled for an old CLI run.
  }
}

function shouldResumeIncompleteReviewStatus(
  status: AutocodeTaskStatus,
  reviewReason?: AutocodeReviewReason,
): boolean {
  if (status === 'human_review') {
    return reviewReason !== 'plan_review' &&
      reviewReason !== 'stopped' &&
      reviewReason !== 'errors';
  }
  return status === 'ai_review' || status === 'done' || status === 'pr_created';
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

  const mergedSubtasks = mergeAutocodeProjectSubtasks(preferred.subtasks, fallback.subtasks);
  if (mergedSubtasks !== preferred.subtasks) {
    merged = { ...merged, subtasks: mergedSubtasks };
  }

  const worktreeTask = preferred.location === 'worktree'
    ? preferred
    : fallback.location === 'worktree'
      ? fallback
      : undefined;
  if (worktreeTask) {
    merged = {
      ...merged,
      location: 'worktree',
      projectRoot: worktreeTask.projectRoot,
      specsPath: worktreeTask.specsPath,
    };
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

function mergeAutocodeProjectSubtasks(
  preferred: AutocodePlanSubtask[],
  fallback: AutocodePlanSubtask[],
): AutocodePlanSubtask[] {
  if (fallback.length === 0) {
    return preferred;
  }
  if (preferred.length === 0) {
    return fallback;
  }

  const fallbackById = new Map(fallback.map((subtask) => [subtask.id, subtask]));
  const preferredIds = new Set(preferred.map((subtask) => subtask.id));
  const merged = preferred.map((preferredSubtask) => {
    const fallbackSubtask = fallbackById.get(preferredSubtask.id);
    if (!fallbackSubtask) {
      return preferredSubtask;
    }
    const fallbackIsFurtherAlong = getProjectSubtaskProgressScore([fallbackSubtask]) >
      getProjectSubtaskProgressScore([preferredSubtask]);
    return fallbackIsFurtherAlong
      ? mergeAutocodeProjectSubtaskFields(fallbackSubtask, preferredSubtask)
      : mergeAutocodeProjectSubtaskFields(preferredSubtask, fallbackSubtask);
  });
  for (const fallbackSubtask of fallback) {
    if (!preferredIds.has(fallbackSubtask.id)) {
      merged.push(fallbackSubtask);
    }
  }
  return merged;
}

function mergeAutocodeProjectSubtaskFields(
  preferred: AutocodePlanSubtask,
  fallback: AutocodePlanSubtask,
): AutocodePlanSubtask {
  const title = shouldUseFallbackProjectSubtaskText(preferred.title, fallback.title, preferred.id)
    ? fallback.title
    : preferred.title;
  const description = shouldUseFallbackProjectSubtaskText(
    preferred.description,
    fallback.description,
    preferred.id,
  )
    ? fallback.description
    : preferred.description;
  const completionSummary = !preferred.completionSummary ||
    (isGenericProjectCompletionSummary(preferred.completionSummary) &&
      fallback.completionSummary &&
      !isGenericProjectCompletionSummary(fallback.completionSummary))
    ? fallback.completionSummary
    : preferred.completionSummary;
  const files = Array.from(new Set([...preferred.files, ...fallback.files]));

  return {
    ...fallback,
    ...preferred,
    title,
    description,
    files,
    ...(completionSummary ? { completionSummary } : {}),
    ...(preferred.dependsOn?.length || fallback.dependsOn?.length
      ? { dependsOn: preferred.dependsOn?.length ? preferred.dependsOn : fallback.dependsOn }
      : {}),
    ...(preferred.upstreamTaskIds?.length || fallback.upstreamTaskIds?.length
      ? {
          upstreamTaskIds: preferred.upstreamTaskIds?.length
            ? preferred.upstreamTaskIds
            : fallback.upstreamTaskIds,
        }
      : {}),
    ...(preferred.workPackage || fallback.workPackage ? { workPackage: true } : {}),
  };
}

function shouldUseFallbackProjectSubtaskText(
  preferred: string,
  fallback: string,
  subtaskId: string,
): boolean {
  if (!fallback.trim()) {
    return false;
  }
  if (!preferred.trim()) {
    return true;
  }
  const normalized = preferred.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized === 'work package' ||
    normalized === 'runtime work package' ||
    normalized === 'subtask ' + subtaskId.toLowerCase();
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
    const match = /^#\s+(?:(?:Quick Spec|Specification|\u89c4\u683c)[:\uff1a])?\s*(.+)$/m.exec(readFileSync(filePath, 'utf8'));
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function fileModifiedTimeMs(filePath: string): number | undefined {
  try {
    const timestamp = statSync(filePath).mtimeMs;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
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

function readTextFile(filePath: string): string {
  if (!existsSync(filePath)) {
    return '';
  }
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function normalizeSubtaskStatus(value: unknown): AutocodeSubtaskStatus {
  return value === 'in_progress' || value === 'completed' || value === 'failed' ? value : 'pending';
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return undefined;
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
