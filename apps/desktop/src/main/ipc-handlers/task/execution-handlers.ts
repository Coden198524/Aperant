import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import {
  AUTOCODE_PROJECT_DATA_DIR_NAME,
  AUTOCODE_TASK_ARTIFACTS,
  classifyAutocodeChangeRequestImpact,
  createAutocodeAgentRuntimePlan,
  getAutocodeAgentRuntimeModeLabel,
  isAutocodeImplementationFailureFeedback,
  selectAutocodeChangeRequestDesignOwnerStage,
  readAutocodeTaskLogsFromSpecDir,
  recoverAutocodeCodingWorkItemStatusesFromLogs,
  resolveAutocodeTaskDevelopmentMode,
  resolveAutocodeTaskStartEvent,
  startAutocodeAgentRuntime,
  type AutocodeChangeRequestImpact,
  type AutocodeChangeRequestScope,
} from '@autocode/core';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, ImageAttachment, Task, Project } from '../../../shared/types';
import type { TaskEvent } from '../../../shared/state-machines/task-machine';
import path from 'path';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync, execFileSync } from 'child_process';
import {
  loadImplementationPlanFromFilesSync,
  saveImplementationPlanToFilesSync,
  type ShardableImplementationPlan,
} from '../../ai/schema/plan-shards';
import { getToolPath } from '../../cli-tool-manager';
import { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskAndProject } from './shared';
import { checkGitStatus } from '../../project-initializer';
import { initializeClaudeProfileManager, type ClaudeProfileManager } from '../../claude-profile-manager';
import { taskStateManager } from '../../task-state-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists,
  resetStuckSubtasks,
  hasPlanWithSubtasks
} from './plan-file-utils';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { getIsolatedGitEnv, detectWorktreeBranch } from '../../utils/git-isolation';
import { cleanupWorktree, isWorktreeUntrackedByGit } from '../../utils/worktree-cleanup';
import { cancelFallbackTimer } from '../agent-events-handlers';
import { readSettingsFile } from '../../settings-utils';
import type { ProviderAccount } from '../../../shared/types/provider-account';
import { createDesktopAgentRuntimeAdapter } from '../../agent/core-runtime-adapter';
import type { OpenSpecService } from '../../openspec/openspec-service';

const TASK_STOP_STARTUP_GRACE_MS = 5000;
const CHANGE_REQUESTS_LOG_FILE = 'change_requests.jsonl';
type ChangeRequestScope = AutocodeChangeRequestScope;
type ChangeRequestImpact = AutocodeChangeRequestImpact;
type ChangeRequestFlowDocument =
  | 'HUMAN_INPUT.md'
  | 'change_requests.jsonl'
  | 'spec.md'
  | 'requirements.md'
  | 'requirement_model.md'
  | 'domain_model.md'
  | 'design.md'
  | 'design_model.md'
  | 'implementation_model.md'
  | 'design_review.md'
  | 'tasks.md'
  | 'implementation_plan.md'
  | 'qa_report.md'
  | 'direct_summary.md'
  | 'direct_session.json';

interface ChangeRequestIterationPlan {
  mode: 'standard-planning' | 'standard-implementation' | 'direct-implementation';
  flowDocuments: ChangeRequestFlowDocument[];
  requiredActions: string[];
  validation: string[];
  commitPolicy: string;
}

interface ChangeRequestRecord {
  id: string;
  createdAt: string;
  taskId: string;
  specId: string;
  taskTitle: string;
  scope: ChangeRequestScope;
  impacts: ChangeRequestImpact[];
  iteration: ChangeRequestIterationPlan;
  feedback: string;
  attachmentsMarkdown?: string;
}

type CoreTaskModeMetadata = Parameters<typeof resolveAutocodeTaskDevelopmentMode>[0];

/**
 * Check if any provider account is configured (API key or OAuth).
 * Used to bypass the legacy hasValidAuth() check for non-Anthropic providers.
 */
function hasAnyProviderAccount(): boolean {
  const settings = readSettingsFile();
  const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined) ?? [];
  return accounts.length > 0;
}

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if file doesn't exist or can't be read.
 */
function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    // ENOENT (file not found) is expected, other errors should be logged
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
    }
    return null;
  }
}

/**
 * Helper function to check subtask completion status
 */
function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
  allSubtasks: Array<{ status: string }>;
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
} {
  const allSubtasks = (plan?.phases as Array<{ subtasks?: Array<{ status: string }> }> | undefined)?.flatMap(phase =>
    phase.subtasks || []
  ) || [];
  const completedCount = allSubtasks.filter(s => s.status === 'completed').length;
  const totalCount = allSubtasks.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  return { allSubtasks, completedCount, totalCount, allCompleted };
}

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 *
 * @returns Success with profile manager, or failure with error message
 */
async function ensureProfileManagerInitialized(): Promise<
  | { success: true; profileManager: ClaudeProfileManager }
  | { success: false; error: string }
> {
  try {
    const profileManager = await initializeClaudeProfileManager();
    return { success: true, profileManager };
  } catch (error) {
    console.error('[ensureProfileManagerInitialized] Failed to initialize:', error);
    // Include actual error details for debugging while providing actionable guidance
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`
    };
  }
}

/**
 * Get the spec directory for file watching, preferring the worktree path if it exists.
 * When a task runs in a worktree, implementation_plan.md is written there,
 * not in the main project's spec directory.
 */
function getSpecDirForWatcher(projectPath: string, specsBaseDir: string, specId: string): string {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    const worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
    if (existsSync(path.join(worktreeSpecDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan))) {
      return worktreeSpecDir;
    }
  }
  return path.join(projectPath, specsBaseDir, specId);
}

/**
 * Check whether implementation_plan.md contains at least one subtask.
 */
function hasPlanSubtasks(planFilePath: string): boolean {
  const plan = loadImplementationPlanFromFilesSync(planFilePath);
  return plan ? checkSubtasksCompletion(plan).totalCount > 0 : false;
}

function hasPlanSubtasksInAnyPath(planFilePaths: string[]): boolean {
  return Array.from(new Set(planFilePaths)).some((planFilePath) => hasPlanSubtasks(planFilePath));
}

function getPlanFilePathsForTask(project: Project, task: Task, specsBaseDir: string): string[] {
  const paths = [
    path.join(project.path, specsBaseDir, task.specId, AUTOCODE_TASK_ARTIFACTS.implementationPlan),
  ];

  const worktreePath = findTaskWorktree(project.path, task.specId);
  if (worktreePath) {
    paths.push(path.join(worktreePath, specsBaseDir, task.specId, AUTOCODE_TASK_ARTIFACTS.implementationPlan));
  }

  return paths;
}

function getPlanTimestamp(plan: Record<string, unknown>): number {
  const rawTimestamp = typeof plan.updated_at === 'string'
    ? plan.updated_at
    : typeof plan.updatedAt === 'string'
      ? plan.updatedAt
      : typeof plan.last_updated === 'string'
        ? plan.last_updated
        : '';
  const timestamp = Date.parse(rawTimestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isStoppedReviewPlan(plan: Record<string, unknown>): boolean {
  return (
    plan.status === 'human_review' &&
    plan.reviewReason === 'stopped'
  ) || (
    plan.xstateState === 'human_review' &&
    plan.executionPhase === 'stopped'
  );
}

function applyStoppedReviewPlanStatus(plan: Record<string, unknown>, updatedAt: string): Record<string, unknown> {
  return {
    ...plan,
    status: 'human_review',
    planStatus: 'review',
    reviewReason: 'stopped',
    xstateState: 'human_review',
    executionPhase: 'stopped',
    updated_at: updatedAt,
  };
}

function persistStoppedReviewStatusAcrossPlanPaths(planFilePaths: string[], logPrefix: string): boolean {
  const updatedAt = new Date().toISOString();
  let persisted = false;

  for (const planPath of Array.from(new Set(planFilePaths))) {
    try {
      if (!existsSync(planPath)) {
        continue;
      }
      const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        continue;
      }
      saveImplementationPlanToFilesSync(
        planPath,
        applyStoppedReviewPlanStatus(plan, updatedAt) as ShardableImplementationPlan,
      );
      persisted = true;
      console.warn(`${logPrefix} Persisted stopped state to: ${planPath}`);
    } catch (error) {
      console.error(`${logPrefix} Failed to persist stopped state to: ${planPath}`, error);
    }
  }

  return persisted;
}

function applyCompletedReviewPlanStatus(plan: Record<string, unknown>, updatedAt: string): Record<string, unknown> {
  return {
    ...plan,
    status: 'human_review',
    planStatus: 'review',
    reviewReason: 'completed',
    xstateState: 'human_review',
    executionPhase: 'complete',
    updated_at: updatedAt,
  };
}

function persistCompletedReviewStatusAcrossPlanPaths(planFilePaths: string[], logPrefix: string): boolean {
  const updatedAt = new Date().toISOString();
  let persisted = false;

  for (const planPath of Array.from(new Set(planFilePaths))) {
    try {
      if (!existsSync(planPath)) {
        continue;
      }
      const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        continue;
      }
      saveImplementationPlanToFilesSync(
        planPath,
        applyCompletedReviewPlanStatus(plan, updatedAt) as ShardableImplementationPlan,
      );
      persisted = true;
      console.warn(`${logPrefix} Persisted completed review state to: ${planPath}`);
    } catch (error) {
      console.error(`${logPrefix} Failed to persist completed review state to: ${planPath}`, error);
    }
  }

  return persisted;
}

function loadLatestPlanFromPaths(planFilePaths: string[]): Record<string, unknown> | null {
  let latestPlan: Record<string, unknown> | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const planPath of Array.from(new Set(planFilePaths))) {
    try {
      if (!existsSync(planPath)) {
        continue;
      }
      const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        continue;
      }
      const timestamp = getPlanTimestamp(plan);
      if (!latestPlan || timestamp >= latestTimestamp) {
        latestPlan = plan;
        latestTimestamp = timestamp;
      }
    } catch (error) {
      console.error(`[plan-file-utils] Failed to inspect plan completion at ${planPath}:`, error);
    }
  }

  return latestPlan;
}

function isLatestPlanFullyCompleted(planFilePaths: string[]): boolean {
  const latestPlan = loadLatestPlanFromPaths(planFilePaths);
  return checkSubtasksCompletion(latestPlan).allCompleted;
}

function emitCompletedReviewStatus(mainWindow: BrowserWindow | null, taskId: string, projectId: string): void {
  if (!mainWindow) {
    return;
  }

  mainWindow.webContents.send(
    IPC_CHANNELS.TASK_STATUS_CHANGE,
    taskId,
    'human_review',
    projectId,
    'completed',
  );
  mainWindow.webContents.send(
    IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
    taskId,
    {
      phase: 'complete',
      phaseProgress: 100,
      overallProgress: 100,
    },
    projectId,
  );
}
function applyRuntimeStartedPlanStatus(
  plan: Record<string, unknown>,
  executionPhase: 'planning' | 'coding',
  updatedAt: string,
): Record<string, unknown> {
  const nextPlan: Record<string, unknown> = {
    ...plan,
    status: 'in_progress',
    planStatus: executionPhase === 'planning' ? 'planning' : 'in_progress',
    xstateState: executionPhase,
    executionPhase,
    updated_at: updatedAt,
  };
  delete nextPlan.reviewReason;
  return nextPlan;
}

function persistRuntimeStartedStatusAcrossPlanPaths(
  planFilePaths: string[],
  executionPhase: 'planning' | 'coding',
  logPrefix: string,
  projectId?: string,
): boolean {
  const updatedAt = new Date().toISOString();
  let persisted = false;

  for (const planPath of Array.from(new Set(planFilePaths))) {
    try {
      if (!existsSync(planPath)) {
        continue;
      }
      const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        continue;
      }
      saveImplementationPlanToFilesSync(
        planPath,
        applyRuntimeStartedPlanStatus(plan, executionPhase, updatedAt) as ShardableImplementationPlan,
      );
      persisted = true;
      console.warn(`${logPrefix} Persisted runtime ${executionPhase} state to: ${planPath}`);
    } catch (error) {
      console.error(`${logPrefix} Failed to persist runtime ${executionPhase} state to: ${planPath}`, error);
    }
  }

  if (persisted && projectId) {
    projectStore.invalidateTasksCache(projectId);
  }

  return persisted;
}

function syncStoppedReviewStatusAcrossPlanPaths(planFilePaths: string[], logPrefix: string): boolean {
  const snapshots = Array.from(new Set(planFilePaths))
    .map((planPath) => {
      try {
        if (!existsSync(planPath)) {
          return null;
        }
        const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
        return plan ? { planPath, plan, timestamp: getPlanTimestamp(plan) } : null;
      } catch (error) {
        console.warn(`${logPrefix} Failed to read plan for stopped-state sync:`, planPath, error);
        return null;
      }
    })
    .filter((value): value is { planPath: string; plan: Record<string, unknown>; timestamp: number } => Boolean(value));

  if (snapshots.length < 2) {
    return false;
  }

  const latestStopped = snapshots
    .filter((snapshot) => isStoppedReviewPlan(snapshot.plan))
    .sort((left, right) => right.timestamp - left.timestamp)[0];

  if (!latestStopped) {
    return false;
  }

  const latestOtherTimestamp = Math.max(
    0,
    ...snapshots
      .filter((snapshot) => !isStoppedReviewPlan(snapshot.plan))
      .map((snapshot) => snapshot.timestamp),
  );

  if (latestOtherTimestamp > latestStopped.timestamp) {
    return false;
  }

  const updatedAt = typeof latestStopped.plan.updated_at === 'string'
    ? latestStopped.plan.updated_at
    : new Date().toISOString();
  let synced = false;

  for (const snapshot of snapshots) {
    if (isStoppedReviewPlan(snapshot.plan)) {
      continue;
    }
    try {
      saveImplementationPlanToFilesSync(
        snapshot.planPath,
        applyStoppedReviewPlanStatus(snapshot.plan, updatedAt) as ShardableImplementationPlan,
      );
      synced = true;
      console.warn(`${logPrefix} Synced stopped task state to stale plan:`, snapshot.planPath);
    } catch (error) {
      console.error(`${logPrefix} Failed to sync stopped task state to:`, snapshot.planPath, error);
    }
  }

  return synced;
}

function getSpecDirFromPlanFilePath(planFilePath: string): string {
  return path.basename(planFilePath) === AUTOCODE_TASK_ARTIFACTS.implementationPlan
    ? path.dirname(planFilePath)
    : planFilePath;
}

function recoverCodingWorkItemStatusesAcrossPlanPaths(planFilePaths: string[], specId: string, logPrefix: string): boolean {
  const uniquePlanPaths = Array.from(new Set(planFilePaths));
  const logSources = Array.from(new Set(uniquePlanPaths.map(getSpecDirFromPlanFilePath)))
    .map((specDir) => {
      try {
        return readAutocodeTaskLogsFromSpecDir(specDir, specId);
      } catch (error) {
        console.warn(`${logPrefix} Failed to read task logs for recovery:`, specDir, error);
        return null;
      }
    })
    .filter((logs): logs is NonNullable<ReturnType<typeof readAutocodeTaskLogsFromSpecDir>> => Boolean(logs));

  if (logSources.length === 0) {
    return false;
  }

  let recoveredAny = false;
  for (const planPath of uniquePlanPaths) {
    try {
      if (!existsSync(planPath)) {
        continue;
      }

      let plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        continue;
      }

      let recoveredCount = 0;
      for (const logs of logSources) {
        const recovery = recoverAutocodeCodingWorkItemStatusesFromLogs({ plan, logs });
        if (recovery.recoveredCount > 0 && recovery.plan) {
          plan = recovery.plan;
          recoveredCount += recovery.recoveredCount;
        }
      }

      if (recoveredCount === 0 || !plan) {
        continue;
      }

      saveImplementationPlanToFilesSync(planPath, plan as ShardableImplementationPlan);
      recoveredAny = true;
      console.warn(`${logPrefix} Recovered ${recoveredCount} coding work item status(es) from task logs in:`, planPath);
    } catch (error) {
      console.warn(`${logPrefix} Failed to recover coding work item statuses for:`, planPath, error);
    }
  }

  return recoveredAny;
}

function isDirectWorkflowTask(task: Task): boolean {
  return resolveAutocodeTaskDevelopmentMode(task.metadata as CoreTaskModeMetadata, 'standard') === 'direct';
}

function isStandardWorkflowTask(task: Task): boolean {
  return resolveAutocodeTaskDevelopmentMode(task.metadata as CoreTaskModeMetadata, 'standard') === 'standard';
}

function isOpenSpecWorkflowTask(task: Task): boolean {
  return resolveAutocodeTaskDevelopmentMode(task.metadata as CoreTaskModeMetadata, 'standard') === 'spec';
}

function isPlanReviewRequest(task: Task, currentXState?: string | null): boolean {
  if (isDirectWorkflowTask(task)) {
    return false;
  }

  if (currentXState === 'plan_review' || task.reviewReason === 'plan_review') {
    return true;
  }

  if (task.reviewReason) {
    return false;
  }

  return task.status === 'human_review' && task.executionProgress?.phase === 'planning';
}

const STANDARD_PLANNING_ITERATION_MARKERS = [
  'Standard Iteration Protocol',
  'incremental task-iteration planning pass',
  'Autocode Standard iteration flow',
  'Do not implement code in this planning pass',
  'planning artifacts were patched locally',
  '"mode":"standard-planning"',
  '"scope":"planning"',
];

interface StandardPlanningRequestMarker {
  id: string;
  createdAtMs: number;
  order: number;
}

interface StandardPlanningTransactionMarker {
  changeRequestId?: string;
  status: string;
  stage: string;
  updatedAtMs: number;
  order: number;
}

function readLatestStandardPlanningRequest(
  content: string,
): StandardPlanningRequestMarker | null {
  let latest: StandardPlanningRequestMarker | null = null;
  let order = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    order += 1;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const iteration = record.iteration && typeof record.iteration === 'object'
        ? record.iteration as Record<string, unknown>
        : null;
      if (record.scope !== 'planning' && iteration?.mode !== 'standard-planning') {
        continue;
      }
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id) {
        continue;
      }
      const parsedCreatedAt = typeof record.createdAt === 'string'
        ? Date.parse(record.createdAt)
        : Number.NaN;
      const candidate = {
        id,
        createdAtMs: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0,
        order,
      };
      if (
        !latest ||
        candidate.createdAtMs > latest.createdAtMs ||
        (candidate.createdAtMs === latest.createdAtMs && candidate.order > latest.order)
      ) {
        latest = candidate;
      }
    } catch {
      // Ignore malformed historical JSONL entries.
    }
  }
  return latest;
}

function readStandardPlanningTransaction(
  content: string | null,
  order: number,
): StandardPlanningTransactionMarker | null {
  if (!content) {
    return null;
  }
  try {
    const transaction = JSON.parse(content) as Record<string, unknown>;
    if (transaction.phase !== 'planning') {
      return null;
    }
    const rawUpdatedAt = typeof transaction.updatedAt === 'string'
      ? transaction.updatedAt
      : typeof transaction.createdAt === 'string'
        ? transaction.createdAt
        : '';
    const parsedUpdatedAt = rawUpdatedAt ? Date.parse(rawUpdatedAt) : Number.NaN;
    const changeRequestId = typeof transaction.changeRequestId === 'string'
      ? transaction.changeRequestId.trim()
      : typeof transaction.change_request_id === 'string'
        ? transaction.change_request_id.trim()
        : '';
    return {
      ...(changeRequestId ? { changeRequestId } : {}),
      status: typeof transaction.status === 'string' ? transaction.status : '',
      stage: typeof transaction.stage === 'string' ? transaction.stage : '',
      updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
      order,
    };
  } catch {
    return null;
  }
}

function hasStandardPlanningIterationInput(planFilePaths: string[]): boolean {
  const specDirs = Array.from(new Set(planFilePaths.map(getSpecDirFromPlanFilePath)));
  let hasPlanningMarker = false;
  let latestPlanningRequest: StandardPlanningRequestMarker | null = null;
  const transactions: StandardPlanningTransactionMarker[] = [];

  for (const [index, specDir] of specDirs.entries()) {
    const humanInput = safeReadFileSync(path.join(specDir, 'HUMAN_INPUT.md')) ?? '';
    const changeRequests = safeReadFileSync(path.join(specDir, CHANGE_REQUESTS_LOG_FILE)) ?? '';
    const text = `${humanInput}\n${changeRequests}`;
    hasPlanningMarker = hasPlanningMarker ||
      STANDARD_PLANNING_ITERATION_MARKERS.some((marker) => text.includes(marker));

    const request = readLatestStandardPlanningRequest(changeRequests);
    if (
      request &&
      (
        !latestPlanningRequest ||
        request.createdAtMs > latestPlanningRequest.createdAtMs ||
        (
          request.createdAtMs === latestPlanningRequest.createdAtMs &&
          request.order > latestPlanningRequest.order
        )
      )
    ) {
      latestPlanningRequest = request;
    }

    const transaction = readStandardPlanningTransaction(
      safeReadFileSync(path.join(specDir, AUTOCODE_TASK_ARTIFACTS.planningTransaction)),
      index,
    );
    if (transaction) {
      transactions.push(transaction);
    }
  }

  const relevantTransactions = latestPlanningRequest
    ? transactions.filter((transaction) =>
        transaction.changeRequestId === latestPlanningRequest?.id ||
        (
          !transaction.changeRequestId &&
          transaction.updatedAtMs >= latestPlanningRequest.createdAtMs
        ),
      )
    : transactions;
  const latestTransaction = relevantTransactions
    .sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs || right.order - left.order,
    )[0];

  if (latestTransaction) {
    if (
      latestTransaction.status === 'completed' &&
      latestTransaction.stage === 'committed'
    ) {
      return false;
    }
    if (
      latestTransaction.status === 'active' ||
      latestTransaction.status === 'repair_required'
    ) {
      return true;
    }
  }

  return hasPlanningMarker;
}

function markInterruptedPlanningRuntimeArtifacts(
  specDirs: string[],
  logPrefix: string,
): void {
  const now = new Date().toISOString();
  for (const specDir of new Set(specDirs)) {
    const runResultPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.runResult);
    try {
      const result = JSON.parse(readFileSync(runResultPath, 'utf-8')) as Record<string, unknown>;
      if (
        result.status === 'running' &&
        (result.phase === 'planning' || result.phase === 'spec')
      ) {
        result.status = 'interrupted';
        result.message = 'Planning process ended before completion; resume from the persisted planning transaction.';
        result.updatedAt = now;
        writeFileAtomicSync(runResultPath, JSON.stringify(result, null, 2) + '\n');
        console.warn(logPrefix + ' Marked stale planning run as interrupted: ' + runResultPath);
      }
    } catch {
      // A missing or malformed run result is handled by the normal recovery path.
    }

    const transactionPath = path.join(
      specDir,
      AUTOCODE_TASK_ARTIFACTS.planningTransaction,
    );
    try {
      const transaction = JSON.parse(
        readFileSync(transactionPath, 'utf-8'),
      ) as Record<string, unknown>;
      if (
        transaction.phase === 'planning' &&
        transaction.status === 'active'
      ) {
        const interruptedStage = typeof transaction.stage === 'string'
          ? transaction.stage
          : undefined;
        if (
          !transaction.checkpoint &&
          interruptedStage &&
          ['sources_validated', 'plan_derived', 'plan_validated'].includes(interruptedStage)
        ) {
          transaction.checkpoint = interruptedStage;
        }
        transaction.status = 'repair_required';
        transaction.interruptedFromStage = interruptedStage;
        transaction.stage = 'interrupted';
        transaction.updatedAt = now;
        transaction.detail = 'Recovered after the planning process stopped before finalization.';
        writeFileAtomicSync(transactionPath, JSON.stringify(transaction, null, 2) + '\n');
      }
    } catch {
      // The next planning run can create a fresh journal when none is usable.
    }
  }
}
function shouldForceStandardPlanningIterationOnStart(
  task: Task,
  currentXState: string | undefined,
  planFilePaths: string[],
): boolean {
  if (!isStandardWorkflowTask(task)) {
    return false;
  }

  if (currentXState === 'plan_review' || task.reviewReason === 'plan_review') {
    return false;
  }

  return hasStandardPlanningIterationInput(planFilePaths);
}

function getTaskBaseBranch(task: Task, project: Project): string | undefined {
  return task.metadata?.baseBranch || project.settings?.mainBranch;
}

function createRuntimePlanForTask(input: {
  taskId: string;
  task: Task;
  project: Project;
  specDir: string;
  hasSpec: boolean;
  planHasSubtasks: boolean;
  forcePlanning?: boolean;
}) {
  return createAutocodeAgentRuntimePlan({
    projectRoot: input.project.path,
    dataDirName: input.project.autoBuildPath || AUTOCODE_PROJECT_DATA_DIR_NAME,
    projectId: input.project.id,
    taskId: input.taskId,
    task: input.task,
    specDir: input.specDir,
    hasSpec: input.hasSpec,
    planHasSubtasks: input.planHasSubtasks,
    baseBranch: getTaskBaseBranch(input.task, input.project),
    forcePlanning: input.forcePlanning,
  });
}

function hasDirectReviewArtifact(specDir: string): boolean {
  if (existsSync(path.join(specDir, 'direct_summary.md'))) {
    return true;
  }

  const plan = loadImplementationPlanFromFilesSync(path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan)) as Record<string, unknown> | null;
  return Boolean(plan?.direct_execution);
}

const IMPLEMENTATION_FAILURE_FEEDBACK_PATTERNS: RegExp[] = [
  /\bcompile (?:failed|failure|error|errors)\b/i,
  /\bcompilation (?:failed|failure|error|errors)\b/i,
  /\bbuild (?:failed|failure|error|errors)\b/i,
  /\btype(?:script)? (?:error|errors|failed|failure)\b/i,
  /\btypecheck\b/i,
  /\btsc\b/i,
  /\blint(?:ing)? (?:error|errors|failed|failure)\b/i,
  /\beslint\b/i,
  /\btest(?:s)? (?:failed|failure|error|errors)\b/i,
  /\bunit test(?:s)? (?:failed|failure)\b/i,
  /\bexit code\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bmodule not found\b/i,
  /\bcannot find module\b/i,
  /编译失败|编译报错|构建失败|构建报错|打包失败|打包报错|运行失败|启动失败|类型错误|类型检查失败|测试失败|单测失败|校验失败|语法错误/,
];

function feedbackRequiresImplementationRestart(feedback: string): boolean {
  const normalized = feedback.trim();
  if (!normalized) {
    return false;
  }

  return isAutocodeImplementationFailureFeedback(normalized) ||
    IMPLEMENTATION_FAILURE_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyChangeRequestImpact(
  task: Task,
  feedback: string,
  scope: ChangeRequestScope,
): ChangeRequestImpact[] {
  const normalized = feedback.toLowerCase();
  const impacts = new Set<ChangeRequestImpact>(
    classifyAutocodeChangeRequestImpact({ feedback, scope }),
  );

  if (scope === 'planning') {
    impacts.add('tasks');
    impacts.add('validation');
  } else {
    impacts.add('implementation');
  }

  if (
    /\b(requirement|acceptance|behavior|flow|rule|must|support|feature|scenario)\b/i.test(feedback) ||
    /\u9700\u6c42|\u9a8c\u6536|\u884c\u4e3a|\u6d41\u7a0b|\u89c4\u5219|\u5fc5\u987b|\u65b0\u589e|\u652f\u6301|\u529f\u80fd|\u573a\u666f|\u903b\u8f91/.test(feedback) ||
    /需求|验收|行为|流程|规则|必须|新增|支持|场景|逻辑/.test(feedback)
  ) {
    impacts.add('requirements');
  }

  if (
    /\b(design|architecture|api|schema|protocol|state machine|interface|contract|data model)\b/i.test(feedback) ||
    /\u8bbe\u8ba1|\u67b6\u6784|\u63a5\u53e3|\u534f\u8bae|\u72b6\u6001\u673a|\u6570\u636e\u7ed3\u6784|\u6570\u636e\u6a21\u578b|\u5951\u7ea6/.test(feedback) ||
    /设计|架构|接口|协议|状态机|数据结构|数据模型|契约/.test(feedback)
  ) {
    impacts.add('design');
  }

  if (
    /\b(plan|task|subtask|work package|split|separate|checklist|milestone)\b/i.test(feedback) ||
    /\u8ba1\u5212|\u4efb\u52a1|\u5b50\u4efb\u52a1|\u5de5\u4f5c\u5305|\u62c6\u5206|\u91cc\u7a0b\u7891|\u6e05\u5355/.test(feedback) ||
    /计划|任务|子任务|工作包|拆分|里程碑|清单/.test(feedback)
  ) {
    impacts.add('tasks');
  }

  if (feedbackRequiresImplementationRestart(feedback)) {
    impacts.add('implementation');
    impacts.add('validation');
  }

  if (
    /\b(test|tests|verify|validation|build|compile|typecheck|lint|qa)\b/i.test(feedback) ||
    /\u6d4b\u8bd5|\u9a8c\u8bc1|\u6784\u5efa|\u7f16\u8bd1|\u7c7b\u578b\u68c0\u67e5|\u6821\u9a8c|\u5ba1\u6838/.test(feedback) ||
    /测试|验证|构建|编译|类型检查|校验|审核/.test(feedback)
  ) {
    impacts.add('validation');
  }

  if (
    scope === 'planning' &&
    isStandardWorkflowTask(task) &&
    !feedbackRequiresImplementationRestart(feedback) &&
    !normalized.includes('only code') &&
    !normalized.includes('implementation only')
  ) {
    impacts.add('tasks');
  }

  const orderedImpacts: ChangeRequestImpact[] = [
    'requirements',
    'design',
    'tasks',
    'implementation',
    'validation',
  ];
  return orderedImpacts.filter((impact) => impacts.has(impact));
}

function shouldRunPlanningIterationForFeedback(task: Task, _impacts: ChangeRequestImpact[], _feedback: string): boolean {
  if (isDirectWorkflowTask(task)) {
    return false;
  }

  // Standard Request Changes must always go through the same-task planning
  // iteration first. Coding directly from review feedback skips requirements,
  // tasks.md, and implementation_plan regeneration.
  return isStandardWorkflowTask(task);
}

function normalizeDirectChangeImpacts(impacts: ChangeRequestImpact[]): ChangeRequestImpact[] {
  const directImpacts = impacts.filter((impact) =>
    impact === 'implementation' || impact === 'validation'
  );
  return directImpacts.length > 0 ? directImpacts : ['implementation'];
}

function createChangeRequestRecord(input: {
  task: Task;
  feedback: string;
  imageReferences: string;
  scope: ChangeRequestScope;
  impacts: ChangeRequestImpact[];
}): ChangeRequestRecord {
  const now = new Date().toISOString();
  return {
    id: `cr-${now.replace(/[-:.TZ]/g, '').slice(0, 17)}`,
    createdAt: now,
    taskId: input.task.id,
    specId: input.task.specId,
    taskTitle: input.task.title,
    scope: input.scope,
    impacts: input.impacts,
    iteration: buildChangeRequestIterationPlan(
      input.task,
      input.impacts,
      input.scope,
      input.feedback,
    ),
    feedback: input.feedback || 'No feedback provided',
    ...(input.imageReferences.trim() ? { attachmentsMarkdown: input.imageReferences.trim() } : {}),
  };
}

function buildChangeRequestIterationPlan(
  task: Task,
  impacts: ChangeRequestImpact[],
  scope: ChangeRequestScope,
  feedback: string,
): ChangeRequestIterationPlan {
  const flowDocuments = new Set<ChangeRequestFlowDocument>([
    'HUMAN_INPUT.md',
    CHANGE_REQUESTS_LOG_FILE,
  ]);
  const requiredActions = new Set<string>();
  const validation = new Set<string>();
  const standardTask = isStandardWorkflowTask(task);

  if (standardTask) {
    flowDocuments.add('implementation_plan.md');
    requiredActions.add('Keep this as the same Standard task iteration; do not create a new task for the follow-up requirement.');
    requiredActions.add('Update changed flow documents before starting the coding pass.');
    requiredActions.add('Keep one canonical tasks.md definition per behavior/file/requirement boundary; revise pending definitions in place instead of appending duplicates.');
    requiredActions.add('Keep completed task definitions immutable; when completed behavior needs more work, preserve the old definition and add a new pending task ID without runtime-state markers.');
    requiredActions.add('During planning, do not edit implementation_plan.md directly; validated tasks.md is the source for derived runtime work packages.');
    requiredActions.add('Add or adjust verification metadata for every new or revised task.');
    validation.add('Run the smallest reliable targeted validation for the affected area.');
    validation.add('Record validation results in the implementation plan completion note or QA report.');

    const requirementsChanged = impacts.includes('requirements');
    const designChanged = impacts.includes('design');
    const tasksChanged = impacts.includes('tasks') || requirementsChanged || designChanged;
    const designOwnerStage = selectAutocodeChangeRequestDesignOwnerStage({ feedback, impacts });
    const designFlow: Array<{
      stage: NonNullable<ReturnType<typeof selectAutocodeChangeRequestDesignOwnerStage>>;
      document: ChangeRequestFlowDocument;
    }> = [
      { stage: 'requirement_model', document: 'requirement_model.md' },
      { stage: 'domain_model', document: 'domain_model.md' },
      { stage: 'design', document: 'design.md' },
      { stage: 'design_model', document: 'design_model.md' },
      { stage: 'implementation_model', document: 'implementation_model.md' },
    ];
    const addDesignFlowFrom = (
      firstStage: NonNullable<ReturnType<typeof selectAutocodeChangeRequestDesignOwnerStage>>,
    ): void => {
      const firstIndex = designFlow.findIndex(({ stage }) => stage === firstStage);
      for (const { document } of designFlow.slice(Math.max(0, firstIndex))) {
        flowDocuments.add(document);
      }
      flowDocuments.add('design_review.md');
      flowDocuments.add('tasks.md');
    };

    if (requirementsChanged) {
      flowDocuments.add('requirements.md');
      flowDocuments.add('spec.md');
      addDesignFlowFrom('requirement_model');
      requiredActions.add('Revise requirements, acceptance criteria, constraints, risks, and open questions before regenerating runtime work.');
      requiredActions.add('Regenerate only affected requirement/domain/design package sections from the earliest impacted model, preserving unaffected stable IDs and the smallest justified Design Budget.');
      requiredActions.add('Run an independent design review and require design_review.md Status: PASSED before updating executable tasks.');
    } else if (designChanged && designOwnerStage) {
      addDesignFlowFrom(designOwnerStage);
      requiredActions.add(`Revise the design package from ${designOwnerStage} through its downstream models only; preserve unaffected upstream artifacts and stable IDs.`);
      requiredActions.add('Run an independent design review and require design_review.md Status: PASSED before updating executable tasks.');
    } else if (tasksChanged) {
      flowDocuments.add('tasks.md');
    }
    if (tasksChanged) {
      requiredActions.add('Regenerate tasks.md incrementally from the approved design, keeping unaffected checklist items stable and adding valid _Design_ references.');
    }
    if (impacts.includes('validation')) {
      flowDocuments.add('qa_report.md');
      validation.add('Run or queue the relevant build/test/typecheck/lint command before human review.');
    }

    return {
      mode: scope === 'planning' ? 'standard-planning' : 'standard-implementation',
      flowDocuments: orderChangeRequestFlowDocuments(flowDocuments),
      requiredActions: Array.from(requiredActions),
      validation: Array.from(validation),
      commitPolicy: 'After validation passes, keep the iteration in the same task and use the normal task commit flow; include this change request ID in the summary or commit context when committing is enabled.',
    };
  }

  flowDocuments.add('direct_summary.md');
  flowDocuments.add('direct_session.json');
  requiredActions.add('Continue the existing Direct model session when provider continuation is available; otherwise continue from the saved Direct session summary.');
  requiredActions.add('Handle the feedback in one direct implementation pass.');
  requiredActions.add('Do not create planning artifacts, work packages, or a new task unless the user explicitly asks for one.');
  validation.add('Run one relevant validation check, or record why validation was not possible.');

  return {
    mode: 'direct-implementation',
    flowDocuments: orderChangeRequestFlowDocuments(flowDocuments),
    requiredActions: Array.from(requiredActions),
    validation: Array.from(validation),
    commitPolicy: 'Keep the iteration in the same Direct task session after validation if commits are enabled; do not push automatically.',
  };
}

function orderChangeRequestFlowDocuments(
  documents: Set<ChangeRequestFlowDocument>,
): ChangeRequestFlowDocument[] {
  const order: ChangeRequestFlowDocument[] = [
    'HUMAN_INPUT.md',
    'change_requests.jsonl',
    'requirements.md',
    'spec.md',
    'requirement_model.md',
    'domain_model.md',
    'design.md',
    'design_model.md',
    'implementation_model.md',
    'design_review.md',
    'tasks.md',
    'implementation_plan.md',
    'qa_report.md',
    'direct_summary.md',
    'direct_session.json',
  ];
  return order.filter((document) => documents.has(document));
}

function buildIterationProtocolSection(changeRequest?: ChangeRequestRecord): string {
  if (!changeRequest) {
    return '';
  }

  const protocolTitle = changeRequest.iteration.mode === 'direct-implementation'
    ? 'Direct Iteration Protocol'
    : 'Standard Iteration Protocol';

  return (
    `## ${protocolTitle}\n\n` +
    `- Mode: ${changeRequest.iteration.mode}\n` +
    `- Flow/runtime documents involved: ${changeRequest.iteration.flowDocuments.join(', ')}\n` +
    `- Validation: ${changeRequest.iteration.validation.join('; ')}\n` +
    `- Commit policy: ${changeRequest.iteration.commitPolicy}\n\n` +
    `### Required Actions\n\n` +
    changeRequest.iteration.requiredActions.map((action) => `- ${action}`).join('\n') +
    `\n\n`
  );
}

function writeChangeRequestArtifacts(specDirs: Iterable<string>, record: ChangeRequestRecord): void {
  for (const specDir of new Set(specDirs)) {
    try {
      mkdirSync(specDir, { recursive: true });

      const jsonlPath = path.join(specDir, CHANGE_REQUESTS_LOG_FILE);
      appendFileSync(
        jsonlPath,
        `${JSON.stringify(record)}\n`,
        'utf-8',
      );

    } catch (error) {
      console.warn('[TASK_REVIEW] Failed to write change request artifacts:', error);
    }
  }
}

function buildHumanInputContent(
  feedback: string,
  imageReferences: string,
  scope: 'planning' | 'implementation' = 'implementation',
  changeRequest?: ChangeRequestRecord,
): string {
  const changeRequestSection = changeRequest
    ? (
        `## Change Request\n\n` +
        `- ID: ${changeRequest.id}\n` +
        `- Created: ${changeRequest.createdAt}\n` +
        `- Scope: ${changeRequest.scope}\n` +
        `- Impact analysis: ${changeRequest.impacts.join(', ') || 'implementation'}\n` +
      `- Audit trail: ${CHANGE_REQUESTS_LOG_FILE}\n\n`
      )
    : '';
  const iterationProtocolSection = buildIterationProtocolSection(changeRequest);

  if (scope === 'planning') {
    return (
      `# Human Input\n\n` +
      `The user reviewed the generated plan/specification and requested planning changes.\n\n` +
      changeRequestSection +
      iterationProtocolSection +
      `## Requested Changes\n\n` +
      `${feedback || 'No feedback provided'}${imageReferences}\n\n` +
      `## Instructions\n\n` +
      `- Treat this as an iteration of the existing task. Do not create a new task unless the user explicitly asks for a separate follow-up task.\n` +
      `- First run an incremental task-iteration planning pass before any coding pass.\n` +
      `- Update only the owner artifacts listed in this change request's flowDocuments; keep all other artifacts and completed work stable.\n` +
      `- requirements.md owns complete R*/AC*/C*/A*/Q*/E* facts. spec.md owns only observable SCN-* behavior and references those IDs without copying their prose.\n` +
      `- The Design-Contract: 5 package has separate owners: requirement_model.md owns RM/FUN/SSD, domain_model.md owns DOM, design.md owns architecture/ADR decisions, design_model.md owns SYS/DES/STATE/FLOW/CONTRACT/PAT/REV, and implementation_model.md owns LANG/IMP mappings.\n` +
      `- tasks.md owns static task definitions; implementation_plan.md owns runtime state only. Revise pending definitions in place, keep completed definitions immutable, and add a new task ID when completed behavior needs more work.\n` +
      `- Use the Autocode Standard iteration flow incrementally from the earliest affected model through review, affected tasks, and the derived runtime plan. Do not regenerate unaffected upstream artifacts or the entire task plan.\n` +
      `- Do not edit implementation_plan.md directly in this planning pass; the runtime derives it from validated tasks.md after planning succeeds.\n` +
      `- Edit incrementally: only touch affected requirement IDs and their downstream model/design/task definitions. Keep unaffected files, sections, stable IDs, and dependency relationships unchanged.\n` +
      `- Every new or revised requirement/design/task must keep or add Evidence. If evidence is missing, record an assumption/open question or add a validation task instead of guessing.\n` +
      `- Revise task lists incrementally: keep one canonical checklist item per behavior/file/requirement boundary; edit pending work in place and add a new ID for revised completed work. Never put runtime or needs_revision state in tasks.md.\n` +
      `- Remove or compact obsolete executable checklist items after recording the change request so duplicate active work is not carried into the next coding pass; never prefix task titles or work package titles with needs_revision, obsolete, or other state labels.\n` +
      `- Update verification metadata for revised tasks, and ensure the next coding/QA pass runs the relevant tests before the task is committed.\n` +
      `- Keep this iteration commit-ready: the final coding pass should use the normal task commit flow after validation succeeds.\n` +
      `- Do not implement code in this planning pass.\n`
    );
  }

  return (
    `# Human Input\n\n` +
    `The user reviewed the previous implementation and reported issues that require another coding pass.\n\n` +
    changeRequestSection +
    iterationProtocolSection +
    `## Requested Fixes\n\n` +
    `${feedback || 'No feedback provided'}${imageReferences}\n\n` +
    `## Instructions\n\n` +
    `- Treat this as an iteration of the existing task. Do not create a new task unless the user explicitly asks for a separate follow-up task.\n` +
    `- If the feedback changes requirements, design, user behavior, or task scope, stop and update the relevant planning artifacts before coding.\n` +
    `- Fix the reported implementation issues.\n` +
    `- Re-run the relevant build/test/validation steps.\n` +
    `- Keep this iteration commit-ready: after validation passes, use the normal task commit flow when commits are enabled.\n` +
    `- Do not edit tasks.md or implementation_plan.md during coding; report progress and verification so the runtime can update its execution ledger.\n`
  );
}

function buildDirectHumanInputContent(
  feedback: string,
  imageReferences: string,
  changeRequest: ChangeRequestRecord,
): string {
  const changeRequestSection =
    `## Change Request\n\n` +
    `- ID: ${changeRequest.id}\n` +
    `- Created: ${changeRequest.createdAt}\n` +
    `- Scope: ${changeRequest.scope}\n` +
    `- Impact analysis: ${changeRequest.impacts.join(', ') || 'implementation'}\n` +
    `- Audit trail: ${CHANGE_REQUESTS_LOG_FILE}\n\n`;
  const iterationProtocolSection = buildIterationProtocolSection(changeRequest);

  return (
    `# Human Input\n\n` +
    `The user reviewed the previous Direct implementation and requested a focused continuation.\n\n` +
    changeRequestSection +
    iterationProtocolSection +
    `## Requested Changes\n\n` +
    `${feedback || 'No feedback provided'}${imageReferences}\n\n` +
    `## Direct Instructions\n\n` +
    `- Continue the existing Direct task session when provider continuation is available; otherwise use direct_session.json and direct_summary.md as compact continuation context.\n` +
    `- Apply only the latest requested changes unless the feedback explicitly asks to revisit earlier behavior.\n` +
    `- Do not create planning artifacts, work packages, or a separate task for this iteration.\n` +
    `- Preserve accepted behavior from the previous Direct implementation unless this feedback overrides it.\n` +
    `- Inspect only the files needed to understand and fix the reported issue.\n` +
    `- Run one focused validation check when practical, or record why validation was not possible.\n` +
    `- Update direct_summary.md with what changed and the validation result.\n`
  );
}

function buildFollowupSummary(feedback: string): string {
  const normalized = feedback
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!normalized) {
    return '';
  }

  // Remove common markdown list prefixes to keep title concise.
  const cleaned = normalized.replace(/^[-*+\d.)\s]+/, '').trim();
  if (!cleaned) {
    return '';
  }

  const maxLength = 26;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}


function buildChangeRequestVerification(changeRequest: ChangeRequestRecord): string {
  if (changeRequest.impacts.includes('validation')) {
    return 'Run the targeted build/test/typecheck/lint command for the affected area and record the result.';
  }
  return 'Run the smallest reliable targeted validation for the affected area, or record why manual verification is sufficient.';
}

function compactChangeRequestFeedback(feedback: string, maxLength = 1000): string {
  const compact = (feedback || 'No feedback provided')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function buildDirectChangeRequestSubtaskId(changeRequest: ChangeRequestRecord): string {
  const suffix = changeRequest.id
    .replace(/^cr-/, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 17);
  return `direct-cr-${suffix || Date.now()}`;
}

function ensureDirectRuntimePhase(plan: ShardableImplementationPlan): {
  phase?: number;
  id?: string;
  name?: string;
  type?: string;
  subtasks?: Array<Record<string, unknown>>;
} {
  if (!Array.isArray(plan.phases)) {
    plan.phases = [];
  }

  let directPhase = plan.phases.find((phase) => phase.type === 'direct') as
    | {
        phase?: number;
        id?: string;
        name?: string;
        type?: string;
        subtasks?: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!directPhase) {
    directPhase = {
      id: 'direct',
      phase: 1,
      name: 'Direct execution',
      type: 'direct',
      subtasks: [],
    };
    plan.phases.unshift(directPhase);
  }

  directPhase.id = directPhase.id ?? 'direct';
  directPhase.phase = typeof directPhase.phase === 'number' ? directPhase.phase : 1;
  directPhase.name = directPhase.name || 'Direct execution';
  directPhase.type = 'direct';
  if (!Array.isArray(directPhase.subtasks)) {
    directPhase.subtasks = [];
  }

  return directPhase;
}

function patchDirectChangeRequestRuntimePlan(
  specDirs: Iterable<string>,
  changeRequest: ChangeRequestRecord,
): string {
  const now = new Date().toISOString();
  const directSubtaskId = buildDirectChangeRequestSubtaskId(changeRequest);
  const summary = buildFollowupSummary(changeRequest.feedback) || changeRequest.id;

  for (const specDir of new Set(specDirs)) {
    try {
      mkdirSync(specDir, { recursive: true });
      const existingPlan = loadImplementationPlanFromFilesSync(specDir);
      const plan: ShardableImplementationPlan = existingPlan ?? {
        feature: changeRequest.specId,
        workflow_type: 'direct',
        phases: [],
        created_at: now,
        updated_at: now,
      };

      plan.feature = typeof plan.feature === 'string' && plan.feature.trim()
        ? plan.feature
        : changeRequest.specId;
      plan.workflow_type = 'direct';
      plan.status = 'in_progress';
      plan.planStatus = 'in_progress';
      plan.reviewReason = undefined;
      plan.xstateState = 'coding';
      plan.executionPhase = 'coding';
      plan.updated_at = now;
      if (!plan.created_at) {
        plan.created_at = now;
      }
      plan.direct_execution = {
        enabled: true,
        outcome: 'running',
        current_subtask_id: directSubtaskId,
        change_request_id: changeRequest.id,
        summary_file: 'direct_summary.md',
      };

      const directPhase = ensureDirectRuntimePhase(plan);
      const subtasks = directPhase.subtasks ?? [];
      const existingSubtask = subtasks.find((subtask) => subtask.id === directSubtaskId);
      const directSubtask = existingSubtask ?? {
        id: directSubtaskId,
        created_at: now,
      };

      directSubtask.title = `Direct Request Changes: ${summary}`;
      directSubtask.description = [
        `Continue the same Direct model session for change request ${changeRequest.id}.`,
        `Feedback: ${compactChangeRequestFeedback(changeRequest.feedback, 600)}`,
        'This is a Direct runtime iteration node, not a Standard work package.',
      ].join('\n');
      directSubtask.status = 'in_progress';
      directSubtask.started_at = now;
      delete directSubtask.completed_at;
      delete directSubtask.completion_summary;
      delete directSubtask.notes;
      delete directSubtask.duration_ms;
      delete directSubtask.actual_output;
      directSubtask.files_to_modify = [];
      directSubtask.depends_on = [];
      directSubtask.requirements = [changeRequest.id];
      directSubtask.evidence = `HUMAN_INPUT.md ${changeRequest.id}; ${CHANGE_REQUESTS_LOG_FILE} latest entry`;
      directSubtask.verification = {
        type: 'targeted',
        run: buildChangeRequestVerification(changeRequest),
      };
      directSubtask.direct_iteration = true;
      directSubtask.change_request_id = changeRequest.id;

      if (!existingSubtask) {
        subtasks.push(directSubtask);
      }

      saveImplementationPlanToFilesSync(specDir, plan);
    } catch (error) {
      console.warn('[TASK_REVIEW] Failed to patch Direct change request runtime plan:', error);
    }
  }

  return directSubtaskId;
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null,
  openSpecService?: OpenSpecService,
): void {
  taskStateManager.configure(getMainWindow);
  const runtimeAdapter = createDesktopAgentRuntimeAdapter(agentManager);
  const isRuntimeRunning = (taskId: string, projectId?: string): boolean =>
    runtimeAdapter.isRuntimeRunning?.(taskId, projectId) ?? false;
  const stopRuntime = (taskId: string, projectId?: string): Promise<void> | void =>
    runtimeAdapter.stopRuntime(taskId, projectId);
  const getRuntimeStartErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Failed to start task runtime';
  const rollbackFailedRuntimeStart = (
    taskId: string,
    task: Task,
    project: Project,
    planFilePaths: string[],
    logPrefix: string,
  ): void => {
    const hasPlan = hasPlanSubtasksInAnyPath(planFilePaths);
    taskStateManager.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan }, task, project);
    persistStoppedReviewStatusAcrossPlanPaths(planFilePaths, logPrefix);
    projectStore.invalidateTasksCache(project.id);
    fileWatcher.unwatch(taskId, project.id).catch((err) => {
      console.error(`${logPrefix} Failed to unwatch after failed runtime start for ${taskId}:`, err);
    });
  };

  const startTaskExecutionFromCurrentPlan = async (
    taskId: string,
    task: Task,
    project: Project,
    logPrefix: string,
    options: { forcePlanning?: boolean } = {}
  ): Promise<void> => {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const specDir = path.join(project.path, specsBaseDir, task.specId);
    const planPath = getPlanPath(project, task);
    const planFilePaths = getPlanFilePathsForTask(project, task, specsBaseDir);

    const resetResult = await resetStuckSubtasks(planPath, project.id);
    if (resetResult.success && resetResult.resetCount > 0) {
      console.warn(`${logPrefix} Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
    }

    const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
    fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
      console.error(`${logPrefix} Failed to watch spec dir for ${taskId}:`, err);
    });

    const specFilePath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
    const hasSpec = existsSync(specFilePath);
    const planHasSubtasks = hasPlanSubtasksInAnyPath(planFilePaths);
    const runtimePlan = createRuntimePlanForTask({
      taskId,
      task,
      project,
      specDir,
      hasSpec,
      planHasSubtasks,
      forcePlanning: options.forcePlanning,
    });

    console.warn(
      `${logPrefix} hasSpec:`,
      hasSpec,
      'planHasSubtasks:',
      planHasSubtasks,
      'runtimeMode:',
      runtimePlan.mode,
      'forcePlanning:',
      options.forcePlanning === true,
    );

    console.warn(`${logPrefix} Starting ${getAutocodeAgentRuntimeModeLabel(runtimePlan.mode)} for:`, task.specId);
    const runtimeExecutionPhase = runtimePlan.mode === 'spec' || runtimePlan.mode === 'planning' ? 'planning' : 'coding';
    persistRuntimeStartedStatusAcrossPlanPaths(planFilePaths, runtimeExecutionPhase, logPrefix, project.id);
    try {
      await startAutocodeAgentRuntime(runtimePlan, runtimeAdapter);
    } catch (error) {
      rollbackFailedRuntimeStart(
        taskId,
        task,
        project,
        planFilePaths,
        logPrefix,
      );
      throw error;
    }
  };

  /**
   * Start a task
   */
  ipcMain.on(
    IPC_CHANNELS.TASK_START,
    async (_, taskId: string, options?: TaskStartOptions) => {
      console.warn('[TASK_START] Received request for taskId:', taskId);
      const requestedProjectId = options?.projectId;

      // Cancel any pending fallback timer from previous process exit
      // This prevents the stale timer from incorrectly stopping the newly restarted task
      cancelFallbackTimer(taskId, requestedProjectId);

      const mainWindow = getMainWindow();
      if (!mainWindow) {
        console.warn('[TASK_START] No main window found');
        return;
      }

      // Ensure profile manager is initialized before checking auth
      // This prevents race condition where auth check runs before profile data loads from disk
      const initResult = await ensureProfileManagerInitialized();
      if (!initResult.success) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          initResult.error,
          requestedProjectId
        );
        return;
      }
      const profileManager = initResult.profileManager;

      // Scope task lookup to the renderer's project when available.
      // Task IDs are spec directory names and can overlap across projects.
      const { task, project: foundProject } = findTaskAndProject(taskId, requestedProjectId);

      if (!task || !foundProject) {
        console.warn('[TASK_START] Task or project not found for taskId:', taskId);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Task or project not found',
          requestedProjectId
        );
        return;
      }

      // Use task's own projectId as the authoritative source (prevents wrong-project execution)
      const project = (task.projectId && task.projectId !== foundProject.id)
        ? (projectStore.getProject(task.projectId) ?? foundProject)
        : foundProject;

      // Check git status - Autocode requires git for worktree-based builds
      const gitStatus = checkGitStatus(project.path);
      if (!gitStatus.isGitRepo) {
        console.warn('[TASK_START] Project is not a git repository:', project.path);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Git repository required. Please run "git init" in your project directory. Autocode uses git worktrees for isolated builds.',
          project.id
        );
        return;
      }
      if (!gitStatus.hasCommits) {
        console.warn('[TASK_START] Git repository has no commits:', project.path);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
          project.id
        );
        return;
      }

      // Check authentication - requires valid legacy profile OR provider account
      if (!profileManager.hasValidAuth() && !hasAnyProviderAccount()) {
        console.warn('[TASK_START] No valid authentication for active profile or provider accounts');
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Authentication required. Please add an account in Settings > Accounts before starting tasks.',
          project.id
        );
        return;
      }

      console.warn('[TASK_START] Found task:', task.specId, 'status:', task.status, 'reviewReason:', task.reviewReason, 'subtasks:', task.subtasks.length);

      // Spec is an isolated OpenSpec workflow. Route it before any Standard
      // plan lookup, XState transition, file watcher, or runtime-plan creation.
      if (isOpenSpecWorkflowTask(task)) {
        if (!openSpecService) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_ERROR,
            taskId,
            'OpenSpec service is unavailable.',
            project.id,
          );
          return;
        }
        try {
          await openSpecService.startTask(task, project);
        } catch (error) {
          const message = getRuntimeStartErrorMessage(error);
          console.error('[TASK_START] Failed to start OpenSpec Action:', error);
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_ERROR,
            taskId,
            message,
            project.id,
          );
        }
        return;
      }

      // Check if implementation_plan.md has valid subtasks BEFORE XState handling.
      // This is more reliable than task.subtasks.length which may not be loaded yet.
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );
      const planFilePaths = getPlanFilePathsForTask(project, task, specsBaseDir);
      const syncedStoppedState = syncStoppedReviewStatusAcrossPlanPaths(planFilePaths, '[TASK_START]');
      const recoveredCodingStatuses = recoverCodingWorkItemStatusesAcrossPlanPaths(planFilePaths, task.specId, '[TASK_START]');
      if (syncedStoppedState || recoveredCodingStatuses) {
        projectStore.invalidateTasksCache(project.id);
        taskStateManager.clearTask(taskId, project.id);
      }

      const isCompletedHumanReviewStart =
        task.status === 'human_review' &&
        (!task.reviewReason || task.reviewReason === 'completed') &&
        isLatestPlanFullyCompleted(planFilePaths);
      if (isCompletedHumanReviewStart) {
        console.warn('[TASK_START] Task is already fully complete; keeping human_review completed without starting runtime:', taskId);
        persistCompletedReviewStatusAcrossPlanPaths(planFilePaths, '[TASK_START]');
        projectStore.invalidateTasksCache(project.id);
        taskStateManager.clearTask(taskId, project.id);
        emitCompletedReviewStatus(mainWindow, taskId, project.id);
        return;
      }

      // Clear stale tracking state from any previous execution so that:
      // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
      // - lastSequenceByTask doesn't drop events from the new process
      taskStateManager.prepareForRestart(taskId, project.id);

      const taskForStart: Task = syncedStoppedState
        ? {
            ...task,
            status: 'human_review',
            reviewReason: 'stopped',
            executionProgress: { phase: 'stopped', phaseProgress: 0, overallProgress: 0 },
          }
        : task;
      const planHasSubtasks = hasPlanSubtasksInAnyPath(planFilePaths);

      // Immediately mark as started so the UI moves the card to In Progress.
      // Use XState actor state as source of truth (if actor exists), with task data as fallback.
      // - plan_review: User approved the plan, send PLAN_APPROVED to transition to coding
      // - human_review/error: User resuming, send USER_RESUMED
      // - backlog/other: Fresh start, send PLANNING_STARTED
      const currentXState = taskStateManager.getCurrentState(taskId, project.id);
      const forcePlanningIteration = shouldForceStandardPlanningIterationOnStart(
        taskForStart,
        currentXState,
        planFilePaths,
      );
      console.warn(
        '[TASK_START] Current XState:',
        currentXState,
        '| Task status:',
        taskForStart.status,
        taskForStart.reviewReason,
        '| forcePlanningIteration:',
        forcePlanningIteration,
      );

      const startEvent = forcePlanningIteration
        ? { type: 'PLANNING_STARTED' } as TaskEvent
        : resolveAutocodeTaskStartEvent({
            task: taskForStart,
            currentState: currentXState,
            planHasSubtasks,
          });
      console.warn('[TASK_START] Runtime start event:', startEvent.type);
      try {
        taskStateManager.handleUiEvent(taskId, startEvent as TaskEvent, taskForStart, project);

        // Reset any stuck subtasks before starting execution
        // This handles recovery from previous rate limits or crashes
        for (const planPath of planFilePaths) {
          const resetResult = await resetStuckSubtasks(planPath, project.id);
          if (resetResult.success && resetResult.resetCount > 0) {
            console.warn(`[TASK_START] Reset ${resetResult.resetCount} stuck subtask(s) before starting in ${planPath}`);
          }
        }

        // Start file watcher for this task
        // Use worktree path if it exists, since the backend writes implementation_plan.md there
        const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
        fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
          console.error(`[TASK_START] Failed to watch spec dir for ${taskId}:`, err);
        });

        // Check if spec.md exists (indicates spec creation was already done or in progress)
        // Check main project path for spec file (spec is created before worktree)
        const specFilePath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
        const hasSpec = existsSync(specFilePath);

        const runtimePlan = createRuntimePlanForTask({
          taskId,
          task: taskForStart,
          project,
          specDir,
          hasSpec,
          planHasSubtasks,
          forcePlanning: forcePlanningIteration,
        });
        console.warn('[TASK_START] Runtime mode:', runtimePlan.mode, 'label:', getAutocodeAgentRuntimeModeLabel(runtimePlan.mode));
        const runtimeExecutionPhase = runtimePlan.mode === 'spec' || runtimePlan.mode === 'planning' ? 'planning' : 'coding';
        persistRuntimeStartedStatusAcrossPlanPaths(planFilePaths, runtimeExecutionPhase, '[TASK_START]', project.id);
        await startAutocodeAgentRuntime(runtimePlan, runtimeAdapter);
      } catch (error) {
        const message = getRuntimeStartErrorMessage(error);
        console.error('[TASK_START] Failed to start task runtime:', error);
        rollbackFailedRuntimeStart(taskId, taskForStart, project, planFilePaths, '[TASK_START]');
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          message,
          project.id,
        );
        return;
      }
    }
  );

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string, projectId?: string) => {
    const scoped = findTaskAndProject(taskId, projectId);
    if (scoped.task && scoped.project && isOpenSpecWorkflowTask(scoped.task)) {
      if (!openSpecService) return;
      try {
        openSpecService.stopTask(scoped.task, scoped.project);
      } catch (error) {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) {
          window.webContents.send(
            IPC_CHANNELS.TASK_ERROR,
            taskId,
            error instanceof Error ? error.message : String(error),
            scoped.project.id,
          );
        }
      }
      return;
    }

    const runtimeMs = typeof agentManager.getTaskRuntimeMs === 'function'
      ? agentManager.getTaskRuntimeMs(taskId, projectId)
      : null;
    if (runtimeMs !== null && runtimeMs < TASK_STOP_STARTUP_GRACE_MS) {
      console.warn('[TASK_STOP] Ignoring stop during startup grace period:', {
        taskId,
        projectId,
        runtimeMs,
        graceMs: TASK_STOP_STARTUP_GRACE_MS,
      });
      return;
    }

    console.warn('[TASK_STOP] Received stop request:', {
      taskId,
      projectId,
      runtimeMs,
    });

    void stopRuntime(taskId, projectId);

    // Find task and project to emit USER_STOPPED with plan context
    const { task, project } = findTaskAndProject(taskId, projectId);

    if (!task || !project) return;

    fileWatcher.unwatch(taskId, project.id).catch((err) => {
      console.error('[TASK_STOP] Failed to unwatch:', err);
    });

    // Use shared utility to determine if a valid implementation plan exists
    const hasPlan = hasPlanWithSubtasks(project, task);

    taskStateManager.handleUiEvent(
      taskId,
      { type: 'USER_STOPPED', hasPlan },
      task,
      project
    );

    // Clear stale tracking state so a subsequent restart works correctly
    taskStateManager.prepareForRestart(taskId, project.id);
  });

  /**
   * Review a task (approve or reject)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string,
      images?: ImageAttachment[],
      projectId?: string
    ): Promise<IPCResult> => {
      // Find task and project
      const { task, project } = findTaskAndProject(taskId, projectId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Spec feedback never enters Standard QA or the Iteration Protocol.
      // Approval is a strict OpenSpec validation; requested changes run the
      // official Update Action with feedback as the user message.
      if (isOpenSpecWorkflowTask(task)) {
        if (!openSpecService) {
          return { success: false, error: 'OpenSpec service is unavailable.' };
        }
        try {
          if (approved) {
            const validation = await openSpecService.validate(task, project, {
              taskId: task.id,
              projectId: project.id,
              changeName: task.metadata?.openSpec?.changeName,
              strict: true,
            });
            return validation.valid
              ? { success: true, data: validation }
              : {
                  success: false,
                  data: validation,
                  error: 'OpenSpec validation failed. Resolve the reported issues before approval.',
                };
          }
          if (!feedback?.trim() && (!images || images.length === 0)) {
            return { success: false, error: 'Feedback is required to update an OpenSpec change.' };
          }
          const attachmentNote = images?.length
            ? `\n\nThe user attached ${images.length} image(s). Inspect the task attachments if relevant.`
            : '';
          const result = await openSpecService.runAction(task, project, {
            taskId: task.id,
            projectId: project.id,
            action: 'update',
            changeName: task.metadata?.openSpec?.changeName,
            arguments: `${feedback?.trim() ?? ''}${attachmentNote}`.trim(),
          });
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Check if dev mode is enabled for this project
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Check if worktree exists - QA needs to run in the worktree where the build happened
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;
      const hasWorktree = worktreePath !== null;
      const currentXState = taskStateManager.getCurrentState(taskId, project.id);
      const isPlanReview = isPlanReviewRequest(task, currentXState);

      if (approved) {
        if (isPlanReview) {
          taskStateManager.prepareForRestart(taskId, project.id);
          taskStateManager.handleUiEvent(
            taskId,
            { type: 'PLAN_APPROVED' },
            task,
            project
          );

          try {
            await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]');
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to start coding after plan approval:', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to start coding after plan approval'
            };
          }

          return { success: true };
        }

        if (!isDirectWorkflowTask(task)) {
          // Write approval to QA report for Standard workflow tasks.
          const qaReportPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.qaReport);
          try {
            writeFileSync(
              qaReportPath,
              `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`,
              'utf-8'
            );
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to write QA report:', error);
            return { success: false, error: 'Failed to write QA report file' };
          }
        }

        taskStateManager.handleUiEvent(
          taskId,
          { type: 'MARK_DONE' },
          task,
          project
        );
      } else {
        const isDirectReview = isDirectWorkflowTask(task);
        const isErrorRecovery = !isDirectReview && (currentXState === 'error' || task.reviewReason === 'errors');
        const needsImplementationRestart = task.status === 'human_review'
          && !isPlanReview
          && !isErrorRecovery;

        // For error recovery, restart normal execution instead of QA fixing.
        // QA fixer requires completed implementation context and can dead-end error recovery.
        if (isErrorRecovery) {
          const specsBaseDir = getSpecsDir(project.autoBuildPath);
          const specDirForState = path.join(project.path, specsBaseDir, task.specId);
          const planHasSubtasks = hasPlanSubtasks(path.join(specDirForState, AUTOCODE_TASK_ARTIFACTS.implementationPlan));

          taskStateManager.prepareForRestart(taskId, project.id);

          if (!planHasSubtasks) {
            taskStateManager.handleUiEvent(
              taskId,
              { type: 'PLANNING_STARTED' },
              task,
              project
            );
          } else {
            taskStateManager.handleUiEvent(
              taskId,
              { type: 'USER_RESUMED' },
              task,
              project
            );
          }

          try {
            await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]');
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to restart execution after rejection:', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to restart task execution'
            };
          }

          return { success: true };
        }

        // Reset and discard all changes from worktree merge in main
        // The worktree still has all changes, so nothing is lost
        if (hasWorktree) {
          // Step 1: Unstage all changes
          const resetResult = spawnSync(getToolPath('git'), ['reset', 'HEAD'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (resetResult.status === 0) {
            console.log('[TASK_REVIEW] Unstaged changes in main');
          }

          // Step 2: Discard all working tree changes (restore to pre-merge state)
          const checkoutResult = spawnSync(getToolPath('git'), ['checkout', '--', '.'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (checkoutResult.status === 0) {
            console.log('[TASK_REVIEW] Discarded working tree changes in main');
          }

          // Step 3: Clean untracked files that came from the merge
          // IMPORTANT: Exclude .autocode directory to preserve specs and worktree data
          const cleanResult = spawnSync(getToolPath('git'), ['clean', '-fd', '-e', AUTOCODE_PROJECT_DATA_DIR_NAME], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe',
            env: getIsolatedGitEnv()
          });
          if (cleanResult.status === 0) {
            console.log('[TASK_REVIEW] Cleaned untracked files in main (excluding .autocode)');
          }

          console.log('[TASK_REVIEW] Main branch restored to pre-merge state');
        }

        // Write feedback for QA fixer - write to WORKTREE spec dir if it exists
        // The QA process runs in the worktree where the build and implementation_plan.md are
        const targetSpecDir = hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
        const fixRequestPath = path.join(targetSpecDir, 'QA_FIX_REQUEST.md');

        console.warn('[TASK_REVIEW] Writing QA fix request to:', fixRequestPath);
        console.warn('[TASK_REVIEW] hasWorktree:', hasWorktree, 'worktreePath:', worktreePath);

        // Process images if provided
        let imageReferences = '';
        if (images && images.length > 0) {
          const attachmentsDir = path.join(targetSpecDir, 'feedback_attachments');
          try {
            if (!existsSync(attachmentsDir)) {
              mkdirSync(attachmentsDir, { recursive: true });
            }
            const savedFiles: Array<{ path: string; isImage: boolean }> = [];
            for (const image of images) {
              try {
                if (!image.data) {
                  console.warn('[TASK_REVIEW] Skipping file with no data:', image.filename);
                  continue;
                }
                // Server-side MIME type validation (defense in depth - frontend also validates)
                // Allow common file types for feedback
                const ALLOWED_MIME_TYPES = [
                  // Images
                  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
                  // Text files
                  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css', 'text/javascript',
                  // Documents
                  'application/json', 'application/xml', 'application/pdf',
                  // Code files (often sent as text/plain or application/octet-stream)
                  'application/octet-stream'
                ];
                const isImage = image.mimeType.startsWith('image/');
                // For non-image files, be more lenient with MIME type validation
                if (!isImage && image.mimeType && !ALLOWED_MIME_TYPES.includes(image.mimeType)) {
                  console.warn('[TASK_REVIEW] Skipping file with disallowed MIME type:', image.mimeType);
                  continue;
                }
                // Sanitize filename to prevent path traversal attacks
                const sanitizedFilename = path.basename(image.filename);
                if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
                  console.warn('[TASK_REVIEW] Skipping file with invalid filename:', image.filename);
                  continue;
                }
                // Remove data URL prefix if present (e.g., "data:image/png;base64," or "data:text/plain;base64,")
                const base64Data = image.data.replace(/^data:[^;]+;base64,/, '');
                const fileBuffer = Buffer.from(base64Data, 'base64');
                const filePath = path.join(attachmentsDir, sanitizedFilename);
                // Verify the resolved path is within the attachments directory (defense in depth)
                const resolvedPath = path.resolve(filePath);
                const resolvedAttachmentsDir = path.resolve(attachmentsDir);
                if (!resolvedPath.startsWith(resolvedAttachmentsDir + path.sep)) {
                  console.warn('[TASK_REVIEW] Skipping file with path outside target directory:', image.filename);
                  continue;
                }
                writeFileSync(filePath, fileBuffer);
                savedFiles.push({
                  path: `feedback_attachments/${sanitizedFilename}`,
                  isImage
                });
                console.log('[TASK_REVIEW] Saved file:', sanitizedFilename);
              } catch (fileError) {
                console.error('[TASK_REVIEW] Failed to save file:', image.filename, fileError);
              }
            }
            if (savedFiles.length > 0) {
              const imageFiles = savedFiles.filter(f => f.isImage);
              const otherFiles = savedFiles.filter(f => !f.isImage);

              let references = '';
              if (imageFiles.length > 0) {
                references += '\n\n## Reference Images\n\n' +
                  imageFiles.map(f => `![Feedback Image](${f.path})`).join('\n\n');
              }
              if (otherFiles.length > 0) {
                references += '\n\n## Attached Files\n\n' +
                  otherFiles.map(f => `- [${path.basename(f.path)}](${f.path})`).join('\n');
              }
              imageReferences = references;
            }
          } catch (dirError) {
            console.error('[TASK_REVIEW] Failed to create attachments directory:', dirError);
          }
        }

        if (isDirectReview) {
          const reviewFeedback = feedback || 'No feedback provided';
          const changeImpacts = normalizeDirectChangeImpacts(
            classifyChangeRequestImpact(task, reviewFeedback, 'implementation')
          );
          const changeRequest = createChangeRequestRecord({
            task,
            feedback: reviewFeedback,
            imageReferences,
            scope: 'implementation',
            impacts: changeImpacts,
          });
          const humanInputContent = buildDirectHumanInputContent(
            reviewFeedback,
            imageReferences,
            changeRequest,
          );
          const humanInputPaths = new Set<string>([
            path.join(targetSpecDir, 'HUMAN_INPUT.md'),
            path.join(specDir, 'HUMAN_INPUT.md'),
          ]);
          writeChangeRequestArtifacts([targetSpecDir, specDir], changeRequest);
          const directSubtaskId = patchDirectChangeRequestRuntimePlan([targetSpecDir, specDir], changeRequest);

          for (const humanInputPath of humanInputPaths) {
            try {
              writeFileSync(humanInputPath, humanInputContent, 'utf-8');
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to write Direct HUMAN_INPUT.md:', error);
              return { success: false, error: 'Failed to write human input file' };
            }
          }

          taskStateManager.prepareForRestart(taskId, project.id);
          if (currentXState === 'plan_review') {
            taskStateManager.handleUiEvent(
              taskId,
              {
                type: 'CODING_STARTED',
                subtaskId: directSubtaskId,
                subtaskDescription: 'Direct model continuation',
              },
              task,
              project
            );
          } else {
            taskStateManager.handleUiEvent(
              taskId,
              { type: 'USER_RESUMED' },
              task,
              project
            );
          }
          projectStore.invalidateTasksCache(project.id);

          const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
          fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
            console.error(`[TASK_REVIEW] Failed to watch Direct spec dir for ${taskId}:`, err);
          });

          try {
            await agentManager.startDirectTaskExecution(
              taskId,
              project.path,
              task.specId,
              { directSubtaskId },
              project.id
            );
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to restart Direct execution after review feedback:', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to restart direct task execution'
            };
          }

          return { success: true };
        }

        if (isPlanReview) {
          const reviewFeedback = feedback || 'Address the reported plan review issues and regenerate the implementation plan.';
          const changeImpacts = classifyChangeRequestImpact(task, reviewFeedback, 'planning');
          const changeRequest = createChangeRequestRecord({
            task,
            feedback: reviewFeedback,
            imageReferences,
            scope: 'planning',
            impacts: changeImpacts,
          });
          const humanInputContent = buildHumanInputContent(
            reviewFeedback,
            imageReferences,
            'planning',
            changeRequest,
          );

          const humanInputPaths = new Set<string>([
            path.join(targetSpecDir, 'HUMAN_INPUT.md'),
            path.join(specDir, 'HUMAN_INPUT.md'),
          ]);
          writeChangeRequestArtifacts([targetSpecDir, specDir], changeRequest);

          for (const humanInputPath of humanInputPaths) {
            try {
              writeFileSync(humanInputPath, humanInputContent, 'utf-8');
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to write HUMAN_INPUT.md for plan review:', error);
              return { success: false, error: 'Failed to write human input file' };
            }
          }

          taskStateManager.prepareForRestart(taskId, project.id);
          taskStateManager.handleUiEvent(
            taskId,
            { type: 'PLANNING_STARTED' },
            task,
            project
          );
          projectStore.invalidateTasksCache(project.id);

          try {
            await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]', {
              forcePlanning: true,
            });
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to restart planning after plan review rejection:', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to restart task execution'
            };
          }

          return { success: true };
        }

        if (needsImplementationRestart) {
          const reviewFeedback = feedback || '';
          const initialScope: ChangeRequestScope = isStandardWorkflowTask(task) ? 'planning' : 'implementation';
          const changeImpacts = classifyChangeRequestImpact(task, reviewFeedback, initialScope);
          const runPlanningIteration = shouldRunPlanningIterationForFeedback(task, changeImpacts, reviewFeedback);
          const changeRequest = createChangeRequestRecord({
            task,
            feedback: reviewFeedback || 'No feedback provided',
            imageReferences,
            scope: runPlanningIteration ? 'planning' : 'implementation',
            impacts: changeImpacts,
          });
          if (!runPlanningIteration && !feedbackRequiresImplementationRestart(reviewFeedback)) {
            console.warn('[TASK_REVIEW] Human review rejected - creating follow-up coding subtask.');
          }
          const humanInputContent = buildHumanInputContent(
            reviewFeedback || 'No feedback provided',
            imageReferences,
            runPlanningIteration ? 'planning' : 'implementation',
            changeRequest,
          );
          const humanInputPaths = new Set<string>([
            path.join(targetSpecDir, 'HUMAN_INPUT.md'),
            path.join(specDir, 'HUMAN_INPUT.md'),
          ]);
          writeChangeRequestArtifacts([targetSpecDir, specDir], changeRequest);

          for (const humanInputPath of humanInputPaths) {
            try {
              writeFileSync(humanInputPath, humanInputContent, 'utf-8');
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to write HUMAN_INPUT.md:', error);
              return { success: false, error: 'Failed to write human input file' };
            }
          }

          if (runPlanningIteration) {
            console.warn('[TASK_REVIEW] Standard review feedback requires incremental task iteration planning.');
            taskStateManager.prepareForRestart(taskId, project.id);
            taskStateManager.handleUiEvent(
              taskId,
              { type: 'PLANNING_STARTED' },
              task,
              project
            );
            projectStore.invalidateTasksCache(project.id);

            try {
              await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]', {
                forcePlanning: true,
              });
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to restart planning after Standard review feedback:', error);
              return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to restart task execution'
              };
            }

            return { success: true };
          }
        }

        try {
          writeFileSync(
            fixRequestPath,
            `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}${imageReferences}\n\nCreated at: ${new Date().toISOString()}\n`,
            'utf-8'
          );
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to write QA fix request:', error);
          return { success: false, error: 'Failed to write QA fix request file' };
        }

        // Clear stale tracking state before starting new QA process
        taskStateManager.prepareForRestart(taskId, project.id);

        // Restart QA process - use worktree path if it exists, otherwise main project
        // The QA process needs to run where the implementation_plan.md with completed subtasks is
        const qaProjectPath = hasWorktree ? worktreePath : project.path;
        console.warn('[TASK_REVIEW] Starting QA process with projectPath:', qaProjectPath);
        try {
          await agentManager.startQAProcess(taskId, qaProjectPath, task.specId, project.id);
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to start QA process:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to start QA process'
          };
        }

        taskStateManager.handleUiEvent(
          taskId,
          { type: 'USER_RESUMED' },
          task,
          project
        );
      }

      return { success: true };
    }
  );

  /**
   * Update task status manually
   * Options:
   * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus,
      options?: { forceCleanup?: boolean; keepWorktree?: boolean; projectId?: string }
    ): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> => {
      const requestedProjectId = options?.projectId;
      // Find task and project first (needed for worktree check)
      const { task, project } = findTaskAndProject(taskId, requestedProjectId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Validate status transition - 'done' can only be set through merge handler
      // UNLESS there's no worktree (limbo state - already merged/discarded or failed)
      // OR forceCleanup is requested (user confirmed they want to delete the worktree)
      // OR keepWorktree is requested (user wants to mark done without deleting worktree)
      if (status === 'done') {
        // Check if worktree exists (task.specId matches worktree folder name)
        const worktreePath = findTaskWorktree(project.path, task.specId);
        const hasWorktree = worktreePath !== null;

        if (hasWorktree) {
          if (options?.keepWorktree) {
            // User explicitly chose to keep worktree - allow marking as done
            console.warn(`[TASK_UPDATE_STATUS] Marking task ${taskId} as done while keeping worktree at ${worktreePath}`);
          } else if (options?.forceCleanup) {
            // User confirmed cleanup - delete worktree and branch
            console.warn(`[TASK_UPDATE_STATUS] Cleaning up worktree for task ${taskId} (user confirmed)`);
            try {
              // Use the shared hardened cleanup: it deletes the directory with retries (Windows
              // releases file locks a moment after the agent exits), prunes git's worktree
              // references, and deletes the branch. A bare `git worktree remove --force` used to
              // fail here whenever a file was still locked or the directory was held as a
              // process working directory.
              const cleanupResult = await cleanupWorktree({
                worktreePath,
                projectPath: project.path,
                specId: task.specId,
                logPrefix: '[TASK_UPDATE_STATUS]'
              });

              if (!cleanupResult.success) {
                // The directory could not be removed. If git no longer tracks this worktree, the
                // task is logically clean and only an empty leftover directory remains (a common
                // Windows case when a process still holds it as its working directory), so let
                // the task complete instead of blocking on it.
                if (isWorktreeUntrackedByGit(project.path, worktreePath)) {
                  console.warn(
                    `[TASK_UPDATE_STATUS] Worktree directory could not be deleted but git no longer tracks it; ` +
                    `treating cleanup as complete and leaving the leftover directory: ${worktreePath}`
                  );
                } else {
                  return {
                    success: false,
                    error: `Failed to cleanup worktree: ${cleanupResult.warnings.join('; ') || 'unknown error'}`
                  };
                }
              }

              console.warn(`[TASK_UPDATE_STATUS] Worktree cleanup completed successfully`);
            } catch (cleanupError) {
              console.error(`[TASK_UPDATE_STATUS] Failed to cleanup worktree:`, cleanupError);
              return {
                success: false,
                error: `Failed to cleanup worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
              };
            }
          } else {
            // Worktree exists but no forceCleanup - return special response for UI to show confirmation
            console.warn(`[TASK_UPDATE_STATUS] Worktree exists for task ${taskId}. Requesting user confirmation.`);
            return {
              success: false,
              worktreeExists: true,
              worktreePath: worktreePath,
              error: "A worktree still exists for this task. Would you like to delete it and mark the task as complete?"
            };
          }
        } else {
          // No worktree - allow marking as done (limbo state recovery)
          console.warn(`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} (no worktree found - limbo state)`);
        }
      }

      // Validate status transition - 'human_review' requires actual work to have been done
      // This prevents tasks from being incorrectly marked as ready for review when execution failed
      if (status === 'human_review') {
        const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
        const specDirForValidation = path.join(
          project.path,
          specsBaseDirForValidation,
          task.specId
        );
        const specFilePath = path.join(specDirForValidation, AUTOCODE_TASK_ARTIFACTS.specFile);

        // Check if spec.md exists and has meaningful content (at least 100 chars)
        const MIN_SPEC_CONTENT_LENGTH = 100;
        let specContent = '';
        try {
          if (existsSync(specFilePath)) {
            specContent = readFileSync(specFilePath, 'utf-8');
          }
        } catch {
          // Ignore read errors - treat as empty spec
        }

        const hasReviewArtifact = isDirectWorkflowTask(task)
          ? hasDirectReviewArtifact(specDirForValidation)
          : Boolean(specContent && specContent.length >= MIN_SPEC_CONTENT_LENGTH);

        if (!hasReviewArtifact) {
          console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`);
          return {
            success: false,
            error: "Cannot move to human review - no review artifact has been created yet. The task must complete processing before review."
          };
        }
      }

      // Get the spec directory and plan path using shared utility
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(project.path, specsBaseDir, task.specId);
      const planPath = getPlanPath(project, task);

      try {
        const handledByMachine = taskStateManager.handleManualStatusChange(taskId, status, task, project);
        if (!handledByMachine) {
          // Use shared utility for thread-safe plan file updates (legacy/manual override)
          const persisted = await persistPlanStatus(planPath, status, project.id);

          if (!persisted) {
            // If no implementation plan exists yet, create a basic one
            await createPlanIfNotExists(planPath, task, status);
            // Invalidate cache after creating new plan
            projectStore.invalidateTasksCache(project.id);
          }
        }

        // Auto-stop task when status changes AWAY from 'in_progress' and process IS running
        // This handles the case where user drags a running task back to Planning/backlog
        if (status !== 'in_progress' && isRuntimeRunning(taskId, project.id)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          await stopRuntime(taskId, project.id);
        }

        // Auto-start task when status changes to 'in_progress' and no process is running
        if (status === 'in_progress' && !isRuntimeRunning(taskId, project.id)) {
          // Clear stale tracking state before starting a new process
          taskStateManager.prepareForRestart(taskId, project.id);
          const mainWindow = getMainWindow();

          // Check git status before auto-starting
          const gitStatusCheck = checkGitStatus(project.path);
          if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
            console.warn('[TASK_UPDATE_STATUS] Git check failed, cannot auto-start task');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                gitStatusCheck.error || 'Git repository with commits required to run tasks.',
                project.id
              );
            }
            return { success: false, error: gitStatusCheck.error || 'Git repository required' };
          }

          // Check authentication before auto-starting
          // Ensure profile manager is initialized to prevent race condition
          const initResult = await ensureProfileManagerInitialized();
          if (!initResult.success) {
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                initResult.error,
                project.id
              );
            }
            return { success: false, error: initResult.error };
          }
          const profileManager = initResult.profileManager;
          if (!profileManager.hasValidAuth() && !hasAnyProviderAccount()) {
            console.warn('[TASK_UPDATE_STATUS] No valid authentication for active profile or provider accounts');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                'Authentication required. Please add an account in Settings > Accounts before starting tasks.',
                project.id
              );
            }
            return { success: false, error: 'Authentication required' };
          }

          console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);

          // Cancel any pending fallback timer from previous process exit
          // This prevents the stale timer from incorrectly stopping the newly started task
          cancelFallbackTimer(taskId, project.id);

          try {
            // Reset any stuck subtasks before starting execution
            // This handles recovery from previous rate limits or crashes
            const resetResult = await resetStuckSubtasks(planPath, project.id);
            if (resetResult.success && resetResult.resetCount > 0) {
              console.warn(`[TASK_UPDATE_STATUS] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
            }

            // Start file watcher for this task
            // Use worktree path if it exists, since the backend writes implementation_plan.md there
            const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
            fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
              console.error(`[TASK_UPDATE_STATUS] Failed to watch spec dir for ${taskId}:`, err);
            });

            // Check if spec.md exists
            const specFilePath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
            const hasSpec = existsSync(specFilePath);
            // FIX (#1562): Check actual plan file for subtasks, not just task.subtasks.length
            const updatePlanFilePath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
            const updatePlanFilePaths = getPlanFilePathsForTask(project, task, specsBaseDir);
            let updatePlanHasSubtasks = false;
            const updatePlan = loadImplementationPlanFromFilesSync(updatePlanFilePath);
            updatePlanHasSubtasks = updatePlan ? checkSubtasksCompletion(updatePlan).totalCount > 0 : false;
            const updateForcePlanningIteration = shouldForceStandardPlanningIterationOnStart(
              task,
              taskStateManager.getCurrentState(taskId, project.id),
              updatePlanFilePaths,
            );
            const runtimePlan = createRuntimePlanForTask({
              taskId,
              task,
              project,
              specDir,
              hasSpec,
              planHasSubtasks: updatePlanHasSubtasks,
              forcePlanning: updateForcePlanningIteration,
            });

            console.warn(
              '[TASK_UPDATE_STATUS] Runtime mode:',
              runtimePlan.mode,
              'label:',
              getAutocodeAgentRuntimeModeLabel(runtimePlan.mode),
              'forcePlanningIteration:',
              updateForcePlanningIteration,
            );
            const runtimeExecutionPhase = runtimePlan.mode === 'spec' || runtimePlan.mode === 'planning' ? 'planning' : 'coding';
            persistRuntimeStartedStatusAcrossPlanPaths(
              updatePlanFilePaths,
              runtimeExecutionPhase,
              '[TASK_UPDATE_STATUS]',
              project.id,
            );
            await startAutocodeAgentRuntime(runtimePlan, runtimeAdapter);
          } catch (error) {
            const message = getRuntimeStartErrorMessage(error);
            console.error('[TASK_UPDATE_STATUS] Failed to auto-start task runtime:', error);
            rollbackFailedRuntimeStart(
              taskId,
              task,
              project,
              getPlanFilePathsForTask(project, task, specsBaseDir),
              '[TASK_UPDATE_STATUS]',
            );
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                message,
                project.id,
              );
            }
            return { success: false, error: message };
          }

          // Notify renderer about status change
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.TASK_STATUS_CHANGE,
              taskId,
              'in_progress',
              project.id
            );
          }
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to update task status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task status'
        };
      }
    }
  );

  /**
   * Check if a task is actually running (has active process)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string, _projectId?: string): Promise<IPCResult<boolean>> => {
      const isRunning = isRuntimeRunning(taskId, _projectId);
      return { success: true, data: isRunning };
    }
  );

  /**
   * Resume a paused task (rate limited or auth failure paused)
   * This writes a RESUME file to the spec directory to signal the backend to continue
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RESUME_PAUSED,
    async (_, taskId: string, projectId?: string): Promise<IPCResult> => {
      // Find task and project
      const { task, project } = findTaskAndProject(taskId, projectId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = task.specsPath || path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Write RESUME file to signal backend to continue
      const resumeFilePath = path.join(specDir, 'RESUME');

      try {
        const resumeContent = JSON.stringify({
          resumed_at: new Date().toISOString(),
          resumed_by: 'user'
        });
        writeFileAtomicSync(resumeFilePath, resumeContent);
        console.log(`[TASK_RESUME_PAUSED] Wrote RESUME file to: ${resumeFilePath}`);

        // Also write to worktree if it exists (backend may be running inside the worktree)
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          const worktreeResumeFilePath = path.join(worktreePath, specsBaseDir, task.specId, 'RESUME');
          try {
            writeFileAtomicSync(worktreeResumeFilePath, resumeContent);
            console.log(`[TASK_RESUME_PAUSED] Also wrote RESUME file to worktree: ${worktreeResumeFilePath}`);
          } catch (worktreeError) {
            // Non-fatal - main spec dir RESUME is sufficient
            console.warn(`[TASK_RESUME_PAUSED] Could not write to worktree (non-fatal):`, worktreeError);
          }
        } else if (
          task.executionProgress?.phase === 'rate_limit_paused' ||
          task.executionProgress?.phase === 'auth_failure_paused'
        ) {
          // Warn if worktree not found for a paused task - the backend is likely
          // running inside the worktree and may not see the RESUME file in the main spec dir
          console.warn(
            `[TASK_RESUME_PAUSED] Worktree not found for paused task ${task.specId}. ` +
            `Backend may not detect the RESUME file if running inside a worktree.`
          );
        }

        return { success: true };
      } catch (error) {
        console.error('[TASK_RESUME_PAUSED] Failed to write RESUME file:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to signal resume'
        };
      }
    }
  );

  /**
   * Recover a stuck task (status says in_progress but no process running)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    async (
      _,
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean; projectId?: string }
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const requestedProjectId = options?.projectId;
      const targetStatus = options?.targetStatus;
      const autoRestart = options?.autoRestart ?? false;
      // Check if task is actually running
      const isActuallyRunning = isRuntimeRunning(taskId, requestedProjectId);

      if (isActuallyRunning) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: {
            taskId,
            recovered: false,
            newStatus: 'in_progress' as TaskStatus,
            message: 'Task is still running'
          }
        };
      }

      // Find task and project
      const { task, project } = findTaskAndProject(taskId, requestedProjectId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Spec recovery is owned exclusively by OpenSpec. It must be routed
      // before reading or mutating any Standard implementation_plan artifact.
      if (isOpenSpecWorkflowTask(task)) {
        if (!autoRestart) {
          return {
            success: false,
            error: 'Spec tasks must be recovered through the OpenSpec workflow. Enable automatic restart to resume the current OpenSpec action.',
            data: {
              taskId,
              recovered: false,
              newStatus: task.status,
              message: 'OpenSpec recovery requires automatic restart.',
              autoRestarted: false,
            },
          };
        }

        if (!openSpecService) {
          return {
            success: false,
            error: 'Cannot restart Spec task: OpenSpec service is unavailable.',
          };
        }

        const gitStatusForRestart = checkGitStatus(project.path);
        if (!gitStatusForRestart.isGitRepo || !gitStatusForRestart.hasCommits) {
          return {
            success: false,
            error: `Cannot restart Spec task: ${gitStatusForRestart.error || 'Git repository with commits required.'}`,
          };
        }

        const initResult = await ensureProfileManagerInitialized();
        if (!initResult.success) {
          return {
            success: false,
            error: `Cannot restart Spec task: ${initResult.error}`,
          };
        }
        if (!initResult.profileManager.hasValidAuth() && !hasAnyProviderAccount()) {
          return {
            success: false,
            error: 'Cannot restart Spec task: authentication required. Please add an account in Settings > Accounts.',
          };
        }

        try {
          cancelFallbackTimer(taskId, project.id);
          taskStateManager.prepareForRestart(taskId, project.id);
          await openSpecService.startTask(task, project);
          return {
            success: true,
            data: {
              taskId,
              recovered: true,
              newStatus: 'in_progress',
              message: 'Spec task recovered and restarted through OpenSpec successfully',
              autoRestarted: true,
            },
          };
        } catch (error) {
          const message = getRuntimeStartErrorMessage(error);
          console.error('[TASK_RECOVER_STUCK] Failed to restart OpenSpec Action:', error);
          return {
            success: false,
            error: `Failed to restart Spec task through OpenSpec: ${message}`,
          };
        }
      }

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      // This is critical: task might exist in worktree, and getTasks() prefers worktree version.
      // If we write to main project but task is in worktree, the worktree's old status takes precedence on refresh.
      const specDir = task.specsPath || path.join(
        project.path,
        getSpecsDir(project.autoBuildPath),
        task.specId
      );

      // Update implementation_plan.md
      const planPath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
      console.log(`[Recovery] Writing to plan file at: ${planPath} (task location: ${task.location || 'main'})`);

      // Also update the OTHER location if task exists in both main and worktree
      // This ensures consistency regardless of which version getTasks() prefers
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;

      // Collect all plan file paths that need updating
      const planPathsToUpdate: string[] = [planPath];
      if (mainSpecDir !== specDir && existsSync(path.join(mainSpecDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan))) {
        planPathsToUpdate.push(path.join(mainSpecDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan));
      }
      if (worktreeSpecDir && worktreeSpecDir !== specDir && existsSync(path.join(worktreeSpecDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan))) {
        planPathsToUpdate.push(path.join(worktreeSpecDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan));
      }
      console.log(`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`, planPathsToUpdate);

      markInterruptedPlanningRuntimeArtifacts(
        planPathsToUpdate.map((planFilePath) => path.dirname(planFilePath)),
        '[Recovery]',
      );

      const syncedStoppedState = syncStoppedReviewStatusAcrossPlanPaths(planPathsToUpdate, '[Recovery]');
      if (syncedStoppedState) {
        projectStore.invalidateTasksCache(project.id);
        taskStateManager.clearTask(taskId, project.id);
      }

      try {
        // Read the plan to analyze subtask progress
        // Using safe read to avoid TOCTOU race conditions
        let plan: Record<string, unknown> | null = null;
        plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;

        if (plan) {
          const taskLogs = readAutocodeTaskLogsFromSpecDir(specDir, task.specId);
          const recovery = recoverAutocodeCodingWorkItemStatusesFromLogs({ plan, logs: taskLogs });
          if (recovery.recoveredCount > 0 && recovery.plan) {
            plan = recovery.plan;
            let recoveryWriteSucceeded = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                saveImplementationPlanToFilesSync(pathToUpdate, plan as ShardableImplementationPlan);
                recoveryWriteSucceeded = true;
                console.log(`[Recovery] Recovered ${recovery.recoveredCount} work item status(es) from task logs in: ${pathToUpdate}`);
              } catch (writeError) {
                console.error(`[Recovery] Failed to write task-log status recovery at ${pathToUpdate}:`, writeError);
              }
            }
            if (!recoveryWriteSucceeded) {
              return {
                success: false,
                error: 'Failed to write task-log status recovery before stuck-task reset'
              };
            }
            projectStore.invalidateTasksCache(project.id);
          }
        }

        // Determine the target status intelligently based on subtask progress
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks.
        // Interrupted coding work should be resumable, not moved back to backlog/planning.
        let newStatus: TaskStatus = targetStatus || 'human_review';
        let newReviewReason: Task['reviewReason'] | undefined = targetStatus ? undefined : 'stopped';

        if (!targetStatus && plan?.phases && Array.isArray(plan.phases)) {
          // Analyze subtask statuses to determine appropriate recovery status
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review (ai_review or human_review based on source)
              // For recovery, human_review is safer as it requires manual verification.
              newStatus = 'human_review';
              newReviewReason = 'completed';
            } else {
              // No process is running, so show this as stopped/resumable instead of pending planning.
              // Auto-restart will set it back to in_progress only after launch succeeds.
              newStatus = 'human_review';
              newReviewReason = 'stopped';
            }
          }
        }

        if (plan) {
          // Update status
          plan.status = newStatus;
          if (newStatus === 'human_review' && newReviewReason) {
            plan.reviewReason = newReviewReason;
          }
          plan.planStatus = newStatus === 'done' ? 'completed'
            : newStatus === 'in_progress' ? 'in_progress'
            : newStatus === 'ai_review' ? 'review'
            : newStatus === 'human_review' ? 'review'
            : 'pending';
          plan.updated_at = new Date().toISOString();

          // Sync executionPhase and xstateState with the recovery status.
          // Without this, project-store.ts uses the stale executionPhase (which has
          // priority over xstateState) when loading tasks, causing the Kanban spinner
          // to persist even though the task status has been corrected.
          plan.xstateState = newStatus;
          if (newStatus === 'human_review' && newReviewReason === 'stopped') {
            plan.executionPhase = 'stopped';
          } else if (newStatus === 'human_review' || newStatus === 'done') {
            plan.executionPhase = 'complete';
          } else if (newStatus === 'backlog') {
            plan.executionPhase = 'idle';
          } else if (newStatus === 'in_progress') {
            plan.executionPhase = 'coding';
          }
          if (newStatus !== 'human_review' && newStatus !== 'ai_review') {
            delete plan.reviewReason;
          }

          // Add recovery note
          plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;

          // Check if task is actually stuck or just completed and waiting for merge
          const { allCompleted } = checkSubtasksCompletion(plan);

          if (allCompleted) {
            console.log('[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart');
            // Don't reset any subtasks - task is done!
            // Just update status in plan file (project store reads from file, no separate update needed)
            plan.status = 'human_review';
            plan.planStatus = 'review';
            plan.reviewReason = 'completed';
            newReviewReason = 'completed';
            plan.executionPhase = 'complete';
            plan.xstateState = 'human_review';

            // Write to ALL plan file locations to ensure consistency
            let writeSucceededForComplete = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                saveImplementationPlanToFilesSync(pathToUpdate, plan as ShardableImplementationPlan);
                console.log(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
                writeSucceededForComplete = true;
              } catch (writeError) {
                console.error(`[Recovery] Failed to write plan file at ${pathToUpdate}:`, writeError);
                // Continue trying other paths
              }
            }

            if (!writeSucceededForComplete) {
              return {
                success: false,
                error: 'Failed to write plan file during recovery (all locations failed)'
              };
            }

            // CRITICAL: Invalidate cache AFTER file writes complete
            // This ensures getTasks() returns fresh data reflecting the recovery
            projectStore.invalidateTasksCache(project.id);

            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus: 'human_review',
                message: 'Task is complete and ready for review',
                autoRestarted: false
              }
            };
          }

          // Task is not complete - reset only stuck subtasks for retry
          // Keep completed subtasks as-is so run.py can resume from where it left off
          // Use shared utility to reset stuck subtasks in ALL plan file locations
          let totalResetCount = 0;
          let resetSucceeded = false;
          let resetFailedCount = 0;
          for (const pathToUpdate of planPathsToUpdate) {
            try {
              const resetResult = await resetStuckSubtasks(pathToUpdate, project.id);
              if (resetResult.success) {
                resetSucceeded = true;
                totalResetCount += resetResult.resetCount;
                if (resetResult.resetCount > 0) {
                  console.log(`[Recovery] Reset ${resetResult.resetCount} stuck subtask(s) in: ${pathToUpdate}`);
                }
              } else {
                resetFailedCount++;
              }
            } catch (resetError) {
              resetFailedCount++;
              console.error(`[Recovery] Failed to reset stuck subtasks at ${pathToUpdate}:`, resetError);
            }
          }

          if (!resetSucceeded) {
            return {
              success: false,
              error: 'Failed to reset stuck subtasks during recovery'
            };
          }

          if (resetFailedCount > 0) {
            console.warn(`[Recovery] Partial reset: ${totalResetCount} subtask(s) reset, but ${resetFailedCount} location(s) failed`);
          }

          console.log(`[Recovery] Total ${totalResetCount} subtask(s) reset across all locations`);

          // resetStuckSubtasks reloads and writes the plan file independently, so
          // re-apply the top-level recovery status after subtask reset. Without
          // this, a stopped coding task can fall back to backlog/planning on
          // refresh or when auto-restart preflight exits early.
          let recoveryStatusWriteSucceeded = false;
          for (const pathToUpdate of planPathsToUpdate) {
            try {
              const recoveredPlan = loadImplementationPlanFromFilesSync(pathToUpdate) as Record<string, unknown> | null;
              if (!recoveredPlan) {
                continue;
              }

              recoveredPlan.status = newStatus;
              recoveredPlan.planStatus = newStatus === 'done' ? 'completed'
                : newStatus === 'in_progress' ? 'in_progress'
                : newStatus === 'ai_review' ? 'review'
                : newStatus === 'human_review' ? 'review'
                : 'pending';
              recoveredPlan.xstateState = newStatus;
              recoveredPlan.updated_at = new Date().toISOString();
              recoveredPlan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;

              if (newStatus === 'human_review' && newReviewReason) {
                recoveredPlan.reviewReason = newReviewReason;
              } else if (newStatus !== 'ai_review') {
                delete recoveredPlan.reviewReason;
              }

              if (newStatus === 'human_review' && newReviewReason === 'stopped') {
                recoveredPlan.executionPhase = 'stopped';
              } else if (newStatus === 'human_review' || newStatus === 'done') {
                recoveredPlan.executionPhase = 'complete';
              } else if (newStatus === 'backlog') {
                recoveredPlan.executionPhase = 'idle';
              } else if (newStatus === 'in_progress') {
                recoveredPlan.executionPhase = 'coding';
              }

              saveImplementationPlanToFilesSync(pathToUpdate, recoveredPlan as ShardableImplementationPlan);
              if (pathToUpdate === planPath) {
                plan = recoveredPlan;
              }
              recoveryStatusWriteSucceeded = true;
              console.log(`[Recovery] Re-applied recovered task status to: ${pathToUpdate}`);
            } catch (writeError) {
              console.error(`[Recovery] Failed to re-apply recovered task status at ${pathToUpdate}:`, writeError);
            }
          }

          if (!recoveryStatusWriteSucceeded) {
            return {
              success: false,
              error: 'Failed to persist recovered task status after subtask reset'
            };
          }

          projectStore.invalidateTasksCache(project.id);

          // Clear attempt_history.json to break infinite recovery loops.
          // Without this, the backend re-reads stuck markers from attempt_history
          // and immediately re-stucks the same subtasks after recovery.
          const specDirsToClean = new Set<string>([specDir]);
          if (mainSpecDir !== specDir) specDirsToClean.add(mainSpecDir);
          if (worktreeSpecDir && worktreeSpecDir !== specDir) specDirsToClean.add(worktreeSpecDir);

          for (const dir of specDirsToClean) {
            const attemptHistoryPath = path.join(dir, 'memory', 'attempt_history.json');
            const historyContent = safeReadFileSync(attemptHistoryPath);
            if (!historyContent) continue;

            try {
              const history = JSON.parse(historyContent);

              // Collect stuck subtask IDs before clearing
              const stuckIds = new Set<string>(
                (history.stuck_subtasks || [])
                  .map((s: { subtask_id?: string }) => s.subtask_id)
                  .filter((id: string | undefined): id is string => Boolean(id))
              );

              // Clear stuck_subtasks array
              history.stuck_subtasks = [];

              // Reset attempt entries for previously-stuck subtasks
              if (history.subtasks && stuckIds.size > 0) {
                for (const stuckId of stuckIds) {
                  if (history.subtasks[stuckId]) {
                    history.subtasks[stuckId] = { attempts: [], status: 'pending' };
                  }
                }
              }

              history.metadata = {
                ...history.metadata,
                last_updated: new Date().toISOString()
              };

              writeFileAtomicSync(attemptHistoryPath, JSON.stringify(history, null, 2));
              console.log(`[Recovery] Cleared attempt_history.json at: ${dir} (reset ${stuckIds.size} stuck entries)`);
            } catch (historyErr) {
              console.warn(`[Recovery] Could not parse attempt_history at ${dir}:`, historyErr);
            }
          }
        }

        // Stop file watcher if it was watching this task
        fileWatcher.unwatch(taskId, project.id).catch((err) => {
          console.error('[TASK_RECOVER_STUCK] Failed to unwatch:', err);
        });

        // Auto-restart the task if requested
        let autoRestarted = false;
        if (autoRestart) {
          // Clear stale tracking state before restarting
          taskStateManager.prepareForRestart(taskId, project.id);
          // Check git status before auto-restarting
          const gitStatusForRestart = checkGitStatus(project.path);
          if (!gitStatusForRestart.isGitRepo || !gitStatusForRestart.hasCommits) {
            console.warn('[Recovery] Git check failed, cannot auto-restart task');
            // Recovery succeeded but we can't restart without git
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: `Task recovered but cannot restart: ${gitStatusForRestart.error || 'Git repository with commits required.'}`,
                autoRestarted: false
              }
            };
          }

          // Check authentication before auto-restarting
          // Ensure profile manager is initialized to prevent race condition
          const initResult = await ensureProfileManagerInitialized();
          if (!initResult.success) {
            // Recovery succeeded but we can't restart without profile manager
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: `Task recovered but cannot restart: ${initResult.error}`,
                autoRestarted: false
              }
            };
          }
          const profileManager = initResult.profileManager;
          if (!profileManager.hasValidAuth() && !hasAnyProviderAccount()) {
            console.warn('[Recovery] Auth check failed, cannot auto-restart task');
            // Recovery succeeded but we can't restart without auth
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: 'Task recovered but cannot restart: authentication required. Please add an account in Settings > Accounts.',
                autoRestarted: false
              }
            };
          }

          try {
            // Cancel any pending fallback timer from previous process exit
            // This prevents the stale timer from incorrectly stopping the restarted task
            cancelFallbackTimer(taskId, project.id);

            // Move the XState actor out of human_review/error before restarting.
            // Otherwise the first CODING_STARTED event from the new process is ignored,
            // and the UI can snap back to human review even though a restart was requested.
            newStatus = 'human_review';
            newReviewReason = 'stopped';
            const planHasSubtasksForRestart = hasPlanSubtasksInAnyPath(planPathsToUpdate);
            const taskForRestart: Task = {
              ...task,
              status: newStatus,
              reviewReason: newReviewReason,
              executionProgress: { phase: 'stopped', phaseProgress: 0, overallProgress: 0 },
            };
            const currentXStateForRestart = taskStateManager.getCurrentState(taskId, project.id);
            const restartForcePlanningIteration = shouldForceStandardPlanningIterationOnStart(
              taskForRestart,
              currentXStateForRestart,
              planPathsToUpdate,
            );
            const restartEvent = restartForcePlanningIteration
              ? { type: 'PLANNING_STARTED' } as TaskEvent
              : resolveAutocodeTaskStartEvent({
                  task: taskForRestart,
                  currentState: currentXStateForRestart,
                  planHasSubtasks: planHasSubtasksForRestart,
                });
            console.warn(
              `[Recovery] Runtime start event: ${restartEvent.type}`,
              '| forcePlanningIteration:',
              restartForcePlanningIteration,
            );
            taskStateManager.handleUiEvent(taskId, restartEvent as TaskEvent, taskForRestart, project);

            // Start the task execution
            // Start file watcher for this task
            // Use worktree path if it exists, since the backend writes implementation_plan.md there
            const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
            fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
              console.error(`[Recovery] Failed to watch spec dir for ${taskId}:`, err);
            });

            // Check if spec.md exists to determine whether to run spec creation or task execution
            // Check main project path for spec file (spec is created before worktree)
            // mainSpecDir is declared earlier in the handler scope
            const specFilePath = path.join(mainSpecDir, AUTOCODE_TASK_ARTIFACTS.specFile);
            const hasSpec = existsSync(specFilePath);
            const runtimePlan = createRuntimePlanForTask({
              taskId,
              task: taskForRestart,
              project,
              specDir: mainSpecDir,
              hasSpec,
              planHasSubtasks: planHasSubtasksForRestart,
              forcePlanning: restartForcePlanningIteration,
            });

            console.warn(
              `[Recovery] Starting ${getAutocodeAgentRuntimeModeLabel(runtimePlan.mode)} for: ${task.specId}`,
              '| forcePlanningIteration:',
              restartForcePlanningIteration,
            );
            const runtimeExecutionPhase = runtimePlan.mode === 'spec' || runtimePlan.mode === 'planning' ? 'planning' : 'coding';
            persistRuntimeStartedStatusAcrossPlanPaths(planPathsToUpdate, runtimeExecutionPhase, '[Recovery]', project.id);
            await startAutocodeAgentRuntime(runtimePlan, runtimeAdapter);

            newStatus = 'in_progress';
            newReviewReason = undefined;

            if (plan) {
              plan = applyRuntimeStartedPlanStatus(
                plan,
                runtimeExecutionPhase,
                new Date().toISOString(),
              );
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  saveImplementationPlanToFilesSync(pathToUpdate, plan as ShardableImplementationPlan);
                  console.log(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`, writeError);
                }
              }
              projectStore.invalidateTasksCache(project.id);
            }

            autoRestarted = true;
            console.warn(`[Recovery] Auto-restarted task ${taskId}`);
          } catch (restartError) {
            console.error('Failed to auto-restart task after recovery:', restartError);
            taskStateManager.handleUiEvent(
              taskId,
              { type: 'USER_STOPPED', hasPlan: hasPlanSubtasksInAnyPath(planPathsToUpdate) } as TaskEvent,
              task,
              project,
            );
            newStatus = 'human_review';
            newReviewReason = 'stopped';
            if (plan) {
              plan.status = 'human_review';
              plan.planStatus = 'review';
              plan.reviewReason = 'stopped';
              plan.xstateState = 'human_review';
              plan.executionPhase = 'stopped';
              plan.updated_at = new Date().toISOString();
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  saveImplementationPlanToFilesSync(pathToUpdate, plan as ShardableImplementationPlan);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to roll back restart status at ${pathToUpdate}:`, writeError);
                }
              }
              projectStore.invalidateTasksCache(project.id);
            }
            // Recovery succeeded, but restart did not. Leave the task restartable instead of running.
          }
        }

        // Notify renderer of status change
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            newStatus,
            project.id,
            newReviewReason
          );
        }

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    }
  );
}
