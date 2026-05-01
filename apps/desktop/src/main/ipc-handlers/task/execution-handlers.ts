import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, ImageAttachment, Task, Project } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { spawnSync, execFileSync } from 'child_process';
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
import { cancelFallbackTimer } from '../agent-events-handlers';
import { readSettingsFile } from '../../settings-utils';
import type { ProviderAccount } from '../../../shared/types/provider-account';

const TASK_STOP_STARTUP_GRACE_MS = 5000;

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
 * When a task runs in a worktree, implementation_plan.json is written there,
 * not in the main project's spec directory.
 */
function getSpecDirForWatcher(projectPath: string, specsBaseDir: string, specId: string): string {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    const worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
    if (existsSync(path.join(worktreeSpecDir, 'implementation_plan.json'))) {
      return worktreeSpecDir;
    }
  }
  return path.join(projectPath, specsBaseDir, specId);
}

/**
 * Check whether implementation_plan.json contains at least one subtask.
 */
function hasPlanSubtasks(planFilePath: string): boolean {
  const planContent = safeReadFileSync(planFilePath);
  if (!planContent) {
    return false;
  }

  try {
    const plan = JSON.parse(planContent);
    return checkSubtasksCompletion(plan).totalCount > 0;
  } catch {
    return false;
  }
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

  return IMPLEMENTATION_FAILURE_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildHumanInputContent(feedback: string, imageReferences: string): string {
  return (
    `# Human Input\n\n` +
    `The user reviewed the previous implementation and reported issues that require another coding pass.\n\n` +
    `## Requested Fixes\n\n` +
    `${feedback || 'No feedback provided'}${imageReferences}\n\n` +
    `## Instructions\n\n` +
    `- Fix the reported implementation issues.\n` +
    `- Re-run the relevant build/test/validation steps.\n` +
    `- Update implementation_plan.json as you make progress.\n`
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

function reopenCompletedPlanForFollowupFix(planPath: string, feedback: string): boolean {
  const planContent = safeReadFileSync(planPath);
  if (!planContent) {
    return false;
  }

  try {
    const plan = JSON.parse(planContent) as {
      phases?: Array<{
        phase?: number;
        name?: string;
        type?: string;
        subtasks?: Array<Record<string, unknown>>;
      }>;
      updated_at?: string;
    };

    if (!Array.isArray(plan.phases)) {
      plan.phases = [];
    }

    let targetPhase = plan.phases[plan.phases.length - 1];
    if (!targetPhase) {
      targetPhase = {
        phase: 1,
        name: '后续修复',
        type: 'implementation',
        subtasks: [],
      };
      plan.phases.push(targetPhase);
    }

    if (!Array.isArray(targetPhase.subtasks)) {
      targetPhase.subtasks = [];
    }

    const phaseNumber = typeof targetPhase.phase === 'number'
      ? targetPhase.phase
      : plan.phases.length;

    const nextSubtaskIndex = targetPhase.subtasks.length + 1;
    const subtaskId = `${phaseNumber}.${nextSubtaskIndex}`;
    const description = feedback.trim() || '请根据最新人工审核反馈完成修复并验证结果。';
    const summary = buildFollowupSummary(description);
    const title = summary
      ? `处理评审反馈：${summary}`
      : `处理评审反馈 #${nextSubtaskIndex}`;

    targetPhase.subtasks.push({
      id: subtaskId,
      title,
      description: `根据人工审核反馈修复问题，并完成必要验证。\n\n评审反馈：\n${description}`,
      status: 'pending',
      files: [],
    });

    plan.updated_at = new Date().toISOString();
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    return true;
  } catch (error) {
    console.error('[reopenCompletedPlanForFollowupFix] Failed to update plan:', error);
    return false;
  }
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  const startTaskExecutionFromCurrentPlan = async (
    taskId: string,
    task: Task,
    project: Project,
    logPrefix: string
  ): Promise<void> => {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const specDir = path.join(project.path, specsBaseDir, task.specId);
    const planPath = getPlanPath(project, task);

    const resetResult = await resetStuckSubtasks(planPath, project.id);
    if (resetResult.success && resetResult.resetCount > 0) {
      console.warn(`${logPrefix} Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
    }

    const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
    fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
      console.error(`${logPrefix} Failed to watch spec dir for ${taskId}:`, err);
    });

    const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
    const hasSpec = existsSync(specFilePath);
    const planHasSubtasks = hasPlanSubtasks(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
    const needsSpecCreation = !hasSpec;
    const needsImplementation = hasSpec && !planHasSubtasks;
    const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

    console.warn(
      `${logPrefix} hasSpec:`,
      hasSpec,
      'planHasSubtasks:',
      planHasSubtasks,
      'needsSpecCreation:',
      needsSpecCreation,
      'needsImplementation:',
      needsImplementation
    );

    if (needsSpecCreation) {
      const taskDescription = task.description || task.title;
      console.warn(`${logPrefix} Starting spec creation for:`, task.specId);
      agentManager.startSpecCreation(taskId, project.path, taskDescription, specDir, task.metadata, baseBranch, project.id);
      return;
    }

    console.warn(`${logPrefix} Starting task execution for:`, task.specId);
    agentManager.startTaskExecution(
      taskId,
      project.path,
      task.specId,
      {
        parallel: false,
        workers: 1,
        baseBranch,
        useWorktree: task.metadata?.useWorktree,
        useLocalBranch: task.metadata?.useLocalBranch,
        pushNewBranches: task.metadata?.pushNewBranches
      },
      project.id
    );
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
      cancelFallbackTimer(taskId);

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

      // Clear stale tracking state from any previous execution so that:
      // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
      // - lastSequenceByTask doesn't drop events from the new process
      taskStateManager.prepareForRestart(taskId);

      // Check if implementation_plan.json has valid subtasks BEFORE XState handling.
      // This is more reliable than task.subtasks.length which may not be loaded yet.
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );
      const planFilePath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      let planHasSubtasks = false;
      const planContent = safeReadFileSync(planFilePath);
      if (planContent) {
        try {
          const plan = JSON.parse(planContent);
          planHasSubtasks = checkSubtasksCompletion(plan).totalCount > 0;
        } catch {
          // Invalid/corrupt plan file - treat as no subtasks
        }
      }

      // Immediately mark as started so the UI moves the card to In Progress.
      // Use XState actor state as source of truth (if actor exists), with task data as fallback.
      // - plan_review: User approved the plan, send PLAN_APPROVED to transition to coding
      // - human_review/error: User resuming, send USER_RESUMED
      // - backlog/other: Fresh start, send PLANNING_STARTED
      const currentXState = taskStateManager.getCurrentState(taskId);
      console.warn('[TASK_START] Current XState:', currentXState, '| Task status:', task.status, task.reviewReason);

      if (currentXState === 'plan_review') {
        // XState says plan_review - send PLAN_APPROVED
        console.warn('[TASK_START] XState: plan_review -> coding via PLAN_APPROVED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
      } else if (currentXState === 'human_review' && !planHasSubtasks) {
        // Human-review task with no generated plan/subtasks should restart planning.
        // This is common for stopped/interrupted tasks that entered review without a valid plan.
        console.warn('[TASK_START] XState: human_review with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (currentXState === 'error' && !planHasSubtasks) {
        // FIX (#1562): Task crashed during planning (no subtasks yet).
        // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
        console.warn('[TASK_START] XState: error with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (currentXState === 'human_review' || currentXState === 'error') {
        // XState says human_review or error - send USER_RESUMED
        console.warn('[TASK_START] XState:', currentXState, '-> coding via USER_RESUMED');
        taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
      } else if (currentXState) {
        // XState actor exists but in another state (coding, planning, etc.)
        // This shouldn't happen normally, but handle gracefully
        console.warn('[TASK_START] XState in unexpected state:', currentXState, '- sending PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (task.status === 'human_review' && task.reviewReason === 'plan_review') {
        // No XState actor - fallback to task data (e.g., after app restart)
        console.warn('[TASK_START] No XState actor, task data: plan_review -> coding via PLAN_APPROVED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
      } else if (task.status === 'human_review' && !planHasSubtasks) {
        // No XState actor and no subtasks: restart planning instead of resuming coding.
        console.warn('[TASK_START] No XState actor, human_review with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (task.status === 'error' && !planHasSubtasks) {
        // FIX (#1562): No XState actor, task crashed during planning (no subtasks).
        // Uses planHasSubtasks from implementation_plan.json (more reliable than task.subtasks.length).
        console.warn('[TASK_START] No XState actor, error with no plan subtasks -> planning via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      } else if (task.status === 'human_review' || task.status === 'error') {
        // No XState actor - fallback to task data for resuming
        console.warn('[TASK_START] No XState actor, task data:', task.status, '-> coding via USER_RESUMED');
        taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
      } else {
        // Fresh start - PLANNING_STARTED transitions from backlog to planning
        console.warn('[TASK_START] Fresh start via PLANNING_STARTED');
        taskStateManager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
      }

      // Reset any stuck subtasks before starting execution
      // This handles recovery from previous rate limits or crashes
      const planPath = getPlanPath(project, task);
      const resetResult = await resetStuckSubtasks(planPath, project.id);
      if (resetResult.success && resetResult.resetCount > 0) {
        console.warn(`[TASK_START] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
      }

      // Start file watcher for this task
      // Use worktree path if it exists, since the backend writes implementation_plan.json there
      const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
      fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
        console.error(`[TASK_START] Failed to watch spec dir for ${taskId}:`, err);
      });

      // Check if spec.md exists (indicates spec creation was already done or in progress)
      // Check main project path for spec file (spec is created before worktree)
      const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
      const hasSpec = existsSync(specFilePath);

      // Check if this task needs spec creation first (no spec file = not yet created)
      // OR if it has a spec but no implementation plan subtasks (spec created, needs planning/building)
      const needsSpecCreation = !hasSpec;
      // FIX (#1562): Check actual plan file for subtasks, not just task.subtasks.length.
      // When a task crashes during planning, it may have spec.md but an empty/missing
      // implementation_plan.json. Previously, this path would call startTaskExecution
      // (run.py) which expects subtasks to exist. Now we check the actual plan file.
      const needsImplementation = hasSpec && !planHasSubtasks;

      console.warn('[TASK_START] hasSpec:', hasSpec, 'planHasSubtasks:', planHasSubtasks, 'needsSpecCreation:', needsSpecCreation, 'needsImplementation:', needsImplementation);

      // Get base branch: task-level override takes precedence over project settings
      const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

      if (needsSpecCreation) {
        // No spec file - need to run spec_runner.py to create the spec
        const taskDescription = task.description || task.title;
        console.warn('[TASK_START] Starting spec creation for:', task.specId, 'in:', specDir, 'baseBranch:', baseBranch);

        // Start spec creation process - pass the existing spec directory
        // so spec_runner uses it instead of creating a new one
        // Also pass baseBranch so worktrees are created from the correct branch
        agentManager.startSpecCreation(taskId, project.path, taskDescription, specDir, task.metadata, baseBranch, project.id);
      } else if (needsImplementation) {
        // Spec exists but no valid subtasks in implementation plan
        // FIX (#1562): Use startTaskExecution (run.py) which will create the planner
        // agent session to generate the implementation plan. run.py handles the case
        // where implementation_plan.json is missing or has no subtasks - the planner
        // agent will generate the plan before the coder starts.
        console.warn('[TASK_START] Starting task execution (no valid subtasks in plan) for:', task.specId);
        agentManager.startTaskExecution(
          taskId,
          project.path,
          task.specId,
          {
            parallel: false,  // Sequential for planning phase
            workers: 1,
            baseBranch,
            useWorktree: task.metadata?.useWorktree,
            useLocalBranch: task.metadata?.useLocalBranch,
            pushNewBranches: task.metadata?.pushNewBranches
          },
          project.id
        );
      } else {
        // Task has subtasks, start normal execution
        // Note: Parallel execution is handled internally by the agent, not via CLI flags
        console.warn('[TASK_START] Starting task execution (has subtasks) for:', task.specId);

        agentManager.startTaskExecution(
          taskId,
          project.path,
          task.specId,
          {
            parallel: false,
            workers: 1,
            baseBranch,
            useWorktree: task.metadata?.useWorktree,
            useLocalBranch: task.metadata?.useLocalBranch,
            pushNewBranches: task.metadata?.pushNewBranches
          },
          project.id
        );
      }
    }
  );

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string, projectId?: string) => {
    const runtimeMs = typeof agentManager.getTaskRuntimeMs === 'function'
      ? agentManager.getTaskRuntimeMs(taskId)
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

    agentManager.killTask(taskId);

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
    taskStateManager.prepareForRestart(taskId);
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

      if (approved) {
        // Write approval to QA report
        const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
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

        taskStateManager.handleUiEvent(
          taskId,
          { type: 'MARK_DONE' },
          task,
          project
        );
      } else {
        const currentXState = taskStateManager.getCurrentState(taskId);
        const isPlanReview = currentXState === 'plan_review'
          || task.reviewReason === 'plan_review'
          || (task.status === 'human_review' && task.executionProgress?.phase === 'planning');
        const isErrorRecovery = currentXState === 'error' || task.reviewReason === 'errors';
        const needsImplementationRestart = task.status === 'human_review'
          && !isPlanReview
          && !isErrorRecovery;

        // For error recovery, restart normal execution instead of QA fixing.
        // QA fixer requires completed implementation context and can dead-end error recovery.
        if (isErrorRecovery) {
          const specsBaseDir = getSpecsDir(project.autoBuildPath);
          const specDirForState = path.join(project.path, specsBaseDir, task.specId);
          const planHasSubtasks = hasPlanSubtasks(path.join(specDirForState, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));

          taskStateManager.prepareForRestart(taskId);

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
          const cleanResult = spawnSync(getToolPath('git'), ['clean', '-fd', '-e', '.autocode'], {
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
        // The QA process runs in the worktree where the build and implementation_plan.json are
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

      if (isPlanReview) {
          const humanInputContent = buildHumanInputContent(
            feedback || 'Address the reported plan review issues and regenerate the implementation plan.',
            imageReferences
          );

          const humanInputPaths = new Set<string>([
            path.join(targetSpecDir, 'HUMAN_INPUT.md'),
            path.join(specDir, 'HUMAN_INPUT.md'),
          ]);

          for (const humanInputPath of humanInputPaths) {
            try {
              writeFileSync(humanInputPath, humanInputContent, 'utf-8');
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to write HUMAN_INPUT.md for plan review:', error);
              return { success: false, error: 'Failed to write human input file' };
            }
          }

          const planPaths = new Set<string>([
            path.join(targetSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
            path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
          ]);

          for (const planPath of planPaths) {
            try {
              if (existsSync(planPath)) {
                unlinkSync(planPath);
                console.warn('[TASK_REVIEW] Removed implementation plan to force replanning:', planPath);
              }
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to remove implementation plan for replanning:', error);
              return { success: false, error: 'Failed to reset implementation plan for replanning' };
            }
          }

          taskStateManager.prepareForRestart(taskId);
          taskStateManager.handleUiEvent(
            taskId,
            { type: 'PLANNING_STARTED' },
            task,
            project
          );
          projectStore.invalidateTasksCache(project.id);

          try {
            await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]');
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
          if (!feedbackRequiresImplementationRestart(feedback || '')) {
            console.warn('[TASK_REVIEW] Human review rejected - creating follow-up coding subtask.');
          }
          const humanInputContent = buildHumanInputContent(feedback || 'No feedback provided', imageReferences);
          const humanInputPaths = new Set<string>([
            path.join(targetSpecDir, 'HUMAN_INPUT.md'),
            path.join(specDir, 'HUMAN_INPUT.md'),
          ]);

          for (const humanInputPath of humanInputPaths) {
            try {
              writeFileSync(humanInputPath, humanInputContent, 'utf-8');
            } catch (error) {
              console.error('[TASK_REVIEW] Failed to write HUMAN_INPUT.md:', error);
              return { success: false, error: 'Failed to write human input file' };
            }
          }

          const reopenedWorktreePlan = reopenCompletedPlanForFollowupFix(
            path.join(targetSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
            feedback || 'Address the reported human review issues.'
          );
          let reopenedSourcePlan = false;
          if (targetSpecDir !== specDir) {
            reopenedSourcePlan = reopenCompletedPlanForFollowupFix(
              path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
              feedback || 'Address the reported human review issues.'
            );
          }
          const reopenedAnyPlan = reopenedWorktreePlan || reopenedSourcePlan;

          if (!reopenedAnyPlan) {
            console.warn('[TASK_REVIEW] Completed plan was not reopened; restart may skip coding');
          }

          taskStateManager.prepareForRestart(taskId);
          taskStateManager.handleUiEvent(
            taskId,
            { type: 'USER_RESUMED' },
            task,
            project
          );
          projectStore.invalidateTasksCache(project.id);

          try {
            await startTaskExecutionFromCurrentPlan(taskId, task, project, '[TASK_REVIEW]');
          } catch (error) {
            console.error('[TASK_REVIEW] Failed to restart execution after implementation feedback:', error);
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to restart task execution'
            };
          }

          return { success: true };
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
        taskStateManager.prepareForRestart(taskId);

        // Restart QA process - use worktree path if it exists, otherwise main project
        // The QA process needs to run where the implementation_plan.json with completed subtasks is
        const qaProjectPath = hasWorktree ? worktreePath : project.path;
        console.warn('[TASK_REVIEW] Starting QA process with projectPath:', qaProjectPath);
        agentManager.startQAProcess(taskId, qaProjectPath, task.specId, project.id);

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
              // Get the branch name before removing the worktree
              // Use shared utility to validate detected branch matches expected pattern
              // This prevents deleting wrong branch when worktree is corrupted/orphaned
              const { branch, usingFallback: usingFallbackBranch } = detectWorktreeBranch(
                worktreePath,
                task.specId,
                { timeout: 30000, logPrefix: '[TASK_UPDATE_STATUS]' }
              );

              // Remove the worktree
              execFileSync(getToolPath('git'), ['worktree', 'remove', '--force', worktreePath], {
                cwd: project.path,
                encoding: 'utf-8',
                timeout: 30000,
                env: getIsolatedGitEnv()
              });
              console.warn(`[TASK_UPDATE_STATUS] Worktree removed: ${worktreePath}`);

              // Delete the branch (ignore errors if branch doesn't exist)
              try {
                execFileSync(getToolPath('git'), ['branch', '-D', branch], {
                  cwd: project.path,
                  encoding: 'utf-8',
                  timeout: 30000,
                  env: getIsolatedGitEnv()
                });
                console.warn(`[TASK_UPDATE_STATUS] Branch deleted: ${branch}`);
              } catch (branchDeleteError) {
                // Branch may not exist or may be the current branch
                if (usingFallbackBranch) {
                  // More concerning - fallback pattern didn't match actual branch
                  console.warn(`[TASK_UPDATE_STATUS] Could not delete branch ${branch} using fallback pattern. Actual branch may still exist and need manual cleanup.`, branchDeleteError);
                } else {
                  console.warn(
                    `[TASK_UPDATE_STATUS] Could not delete branch ${branch} (may not exist or be checked out elsewhere)`,
                    branchDeleteError
                  );
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
        const specFilePath = path.join(specDirForValidation, AUTO_BUILD_PATHS.SPEC_FILE);

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

        if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
          console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`);
          return {
            success: false,
            error: "Cannot move to human review - no spec has been created yet. The task must complete processing before review."
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
        if (status !== 'in_progress' && agentManager.isRunning(taskId)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          agentManager.killTask(taskId);
        }

        // Auto-start task when status changes to 'in_progress' and no process is running
        if (status === 'in_progress' && !agentManager.isRunning(taskId)) {
          // Clear stale tracking state before starting a new process
          taskStateManager.prepareForRestart(taskId);
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
          cancelFallbackTimer(taskId);

          // Reset any stuck subtasks before starting execution
          // This handles recovery from previous rate limits or crashes
          const resetResult = await resetStuckSubtasks(planPath, project.id);
          if (resetResult.success && resetResult.resetCount > 0) {
            console.warn(`[TASK_UPDATE_STATUS] Reset ${resetResult.resetCount} stuck subtask(s) before starting`);
          }

          // Start file watcher for this task
          // Use worktree path if it exists, since the backend writes implementation_plan.json there
          const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
          fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
            console.error(`[TASK_UPDATE_STATUS] Failed to watch spec dir for ${taskId}:`, err);
          });

          // Check if spec.md exists
          const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
          const hasSpec = existsSync(specFilePath);
          const needsSpecCreation = !hasSpec;
          // FIX (#1562): Check actual plan file for subtasks, not just task.subtasks.length
          const updatePlanFilePath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
          let updatePlanHasSubtasks = false;
          const updatePlanContent = safeReadFileSync(updatePlanFilePath);
          if (updatePlanContent) {
            try {
              const plan = JSON.parse(updatePlanContent);
              updatePlanHasSubtasks = checkSubtasksCompletion(plan).totalCount > 0;
            } catch {
              // Invalid/corrupt plan file - treat as no subtasks
            }
          }
          const needsImplementation = hasSpec && !updatePlanHasSubtasks;

          console.warn('[TASK_UPDATE_STATUS] hasSpec:', hasSpec, 'needsSpecCreation:', needsSpecCreation, 'needsImplementation:', needsImplementation);

          // Get base branch: task-level override takes precedence over project settings
          const baseBranchForUpdate = task.metadata?.baseBranch || project.settings?.mainBranch;

          if (needsSpecCreation) {
            // No spec file - need to run spec_runner.py to create the spec
            const taskDescription = task.description || task.title;
            console.warn('[TASK_UPDATE_STATUS] Starting spec creation for:', task.specId);
            agentManager.startSpecCreation(taskId, project.path, taskDescription, specDir, task.metadata, baseBranchForUpdate, project.id);
          } else if (needsImplementation) {
            // Spec exists but no subtasks - run run.py to create implementation plan and execute
            console.warn('[TASK_UPDATE_STATUS] Starting task execution (no subtasks) for:', task.specId);
            agentManager.startTaskExecution(
              taskId,
              project.path,
              task.specId,
              {
                parallel: false,
                workers: 1,
                baseBranch: baseBranchForUpdate,
                useWorktree: task.metadata?.useWorktree,
                useLocalBranch: task.metadata?.useLocalBranch,
                pushNewBranches: task.metadata?.pushNewBranches
              },
              project.id
            );
          } else {
            // Task has subtasks, start normal execution
            // Note: Parallel execution is handled internally by the agent
            console.warn('[TASK_UPDATE_STATUS] Starting task execution (has subtasks) for:', task.specId);
            agentManager.startTaskExecution(
              taskId,
              project.path,
              task.specId,
              {
                parallel: false,
                workers: 1,
                baseBranch: baseBranchForUpdate,
                useWorktree: task.metadata?.useWorktree,
                useLocalBranch: task.metadata?.useLocalBranch,
                pushNewBranches: task.metadata?.pushNewBranches
              },
              project.id
            );
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
      const isRunning = agentManager.isRunning(taskId);
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
      const isActuallyRunning = agentManager.isRunning(taskId);

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

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      // This is critical: task might exist in worktree, and getTasks() prefers worktree version.
      // If we write to main project but task is in worktree, the worktree's old status takes precedence on refresh.
      const specDir = task.specsPath || path.join(
        project.path,
        getSpecsDir(project.autoBuildPath),
        task.specId
      );

      // Update implementation_plan.json
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      console.log(`[Recovery] Writing to plan file at: ${planPath} (task location: ${task.location || 'main'})`);

      // Also update the OTHER location if task exists in both main and worktree
      // This ensures consistency regardless of which version getTasks() prefers
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;

      // Collect all plan file paths that need updating
      const planPathsToUpdate: string[] = [planPath];
      if (mainSpecDir !== specDir && existsSync(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      if (worktreeSpecDir && worktreeSpecDir !== specDir && existsSync(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      console.log(`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`, planPathsToUpdate);

      try {
        // Read the plan to analyze subtask progress
        // Using safe read to avoid TOCTOU race conditions
        let plan: Record<string, unknown> | null = null;
        const planContent = safeReadFileSync(planPath);
        if (planContent) {
          try {
            plan = JSON.parse(planContent);
          } catch (parseError) {
            console.error('[Recovery] Failed to parse plan file as JSON:', parseError);
            return {
              success: false,
              error: 'Plan file contains invalid JSON. The file may be corrupted.'
            };
          }
        }

        // Determine the target status intelligently based on subtask progress
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks
        let newStatus: TaskStatus = targetStatus || 'backlog';

        if (!targetStatus && plan?.phases && Array.isArray(plan.phases)) {
          // Analyze subtask statuses to determine appropriate recovery status
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review (ai_review or human_review based on source)
              // For recovery, human_review is safer as it requires manual verification
              newStatus = 'human_review';
            } else if (completedCount > 0) {
              // Some subtasks completed, some still pending - task is in progress
              newStatus = 'in_progress';
            }
            // else: no subtasks completed, stay with 'backlog'
          }
        }

        if (plan) {
          // Update status
          plan.status = newStatus;
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
          if (newStatus === 'human_review' || newStatus === 'done') {
            plan.executionPhase = 'complete';
          } else if (newStatus === 'backlog') {
            plan.executionPhase = 'idle';
          } else if (newStatus === 'in_progress') {
            plan.executionPhase = 'coding';
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
            plan.executionPhase = 'complete';
            plan.xstateState = 'human_review';

            // Write to ALL plan file locations to ensure consistency
            const planContent = JSON.stringify(plan, null, 2);
            let writeSucceededForComplete = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                writeFileAtomicSync(pathToUpdate, planContent);
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
          taskStateManager.prepareForRestart(taskId);
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
            cancelFallbackTimer(taskId);

            // Set status to in_progress for the restart
            newStatus = 'in_progress';

            // Update plan status for restart - write to ALL locations
            if (plan) {
              plan.status = 'in_progress';
              plan.planStatus = 'in_progress';
              const restartPlanContent = JSON.stringify(plan, null, 2);
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  writeFileAtomicSync(pathToUpdate, restartPlanContent);
                  console.log(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`, writeError);
                  // Continue with restart attempt even if file write fails
                  // The plan status will be updated by the agent when it starts
                }
              }

              // CRITICAL: Invalidate cache AFTER file writes complete
              // This ensures getTasks() returns fresh data reflecting the restart status
              projectStore.invalidateTasksCache(project.id);
            }

            // Start the task execution
            // Start file watcher for this task
            // Use worktree path if it exists, since the backend writes implementation_plan.json there
            const watchSpecDir = getSpecDirForWatcher(project.path, specsBaseDir, task.specId);
            fileWatcher.watch(taskId, watchSpecDir, project.id).catch((err) => {
              console.error(`[Recovery] Failed to watch spec dir for ${taskId}:`, err);
            });

            // Check if spec.md exists to determine whether to run spec creation or task execution
            // Check main project path for spec file (spec is created before worktree)
            // mainSpecDir is declared earlier in the handler scope
            const specFilePath = path.join(mainSpecDir, AUTO_BUILD_PATHS.SPEC_FILE);
            const hasSpec = existsSync(specFilePath);
            const needsSpecCreation = !hasSpec;

            // Get base branch: task-level override takes precedence over project settings
            const baseBranchForRecovery = task.metadata?.baseBranch || project.settings?.mainBranch;

            if (needsSpecCreation) {
              // No spec file - need to run spec_runner.py to create the spec
              const taskDescription = task.description || task.title;
              console.warn(`[Recovery] Starting spec creation for: ${task.specId}`);
              agentManager.startSpecCreation(taskId, project.path, taskDescription, mainSpecDir, task.metadata, baseBranchForRecovery, project.id);
            } else {
              // Spec exists - run task execution
              console.warn(`[Recovery] Starting task execution for: ${task.specId}`);
              agentManager.startTaskExecution(
                taskId,
                project.path,
                task.specId,
                {
                  parallel: false,
                  workers: 1,
                  baseBranch: baseBranchForRecovery,
                  useWorktree: task.metadata?.useWorktree,
                  useLocalBranch: task.metadata?.useLocalBranch,
                  pushNewBranches: task.metadata?.pushNewBranches
                },
                project.id
              );
            }

            autoRestarted = true;
            console.warn(`[Recovery] Auto-restarted task ${taskId}`);
          } catch (restartError) {
            console.error('Failed to auto-restart task after recovery:', restartError);
            // Recovery succeeded but restart failed - still report success
          }
        }

        // Notify renderer of status change
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            newStatus,
            project.id
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
