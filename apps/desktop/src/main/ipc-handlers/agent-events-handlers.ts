import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import path from "path";
import { existsSync } from "fs";
import { AUTOCODE_TASK_ARTIFACTS, loadAutocodeImplementationPlanSync } from "@autocode/core";
import { IPC_CHANNELS, TASK_REFRESH_SENTINEL, getSpecsDir } from "../../shared/constants";
import type {
  SDKRateLimitInfo,
  AuthFailureInfo,
  ImplementationPlan,
  TaskLogStreamChunk,
  TokenUsage,
} from "../../shared/types";
import { XSTATE_SETTLED_STATES, XSTATE_ACTIVE_STATES, XSTATE_TO_PHASE, mapStateToLegacy } from "../../shared/state-machines";
import { AgentManager } from "../agent";
import type { ProcessType, ExecutionProgressData } from "../agent";
import { titleGenerator } from "../title-generator";
import { fileWatcher } from "../file-watcher";
import { notificationService } from "../notification-service";
import { persistPlanLastEventSync, getPlanPath, persistPlanPhaseSync, persistPlanStatusAndReasonSync, persistPlanTokenUsageSync, hasPlanWithSubtasks, syncPlanPhasesToMainSync } from "./task/plan-file-utils";
import { findTaskWorktree } from "../worktree-paths";
import { findTaskAndProject } from "./task/shared";
import { safeSendToRenderer } from "./utils";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { taskStateManager } from "../task-state-manager";

// Timeout for fallback safety net to check if task is still stuck after process exit
const STUCK_TASK_FALLBACK_TIMEOUT_MS = 500;

// Map to store active fallback timers so they can be cancelled on task restart
const fallbackTimers = new Map<string, NodeJS.Timeout>();

function getTaskEventScopeKey(taskId: string, projectId?: string): string {
  return projectId ? `${projectId}::${taskId}` : taskId;
}

function getMatchingTaskEventScopeKeys(taskId: string, projectId?: string): string[] {
  if (projectId) {
    return [getTaskEventScopeKey(taskId, projectId)];
  }
  const suffix = `::${taskId}`;
  return [...new Set([
    taskId,
    ...[...fallbackTimers.keys()].filter((key) => key === taskId || key.endsWith(suffix)),
  ])];
}

/**
 * Register all agent-events-related IPC handlers
 */
export function registerAgenteventsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  taskStateManager.configure(getMainWindow);

  // ============================================
  // Debug: Renderer 鈫?Main log bridge
  // ============================================
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, message: string) => {
    console.log(`[RENDERER] ${message}`);
  });

  // ============================================
  // Agent Manager Events 鈫?Renderer
  // ============================================

  agentManager.on("log", (taskId: string, log: string, projectId?: string) => {
    // Use projectId from event when available; fall back to the active execution context
    // for backward compatibility with older emitters.
    if (!projectId) {
      projectId = agentManager.resolveTaskProjectId(taskId);
    }
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOG, taskId, log, projectId);
  });

  agentManager.on("error", (taskId: string, error: string, projectId?: string) => {
    // Use projectId from event when available; fall back to the active execution context
    // for backward compatibility with older emitters.
    if (!projectId) {
      projectId = agentManager.resolveTaskProjectId(taskId);
    }
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, projectId);
  });

  agentManager.on("task-log-stream", (taskId: string, chunk: TaskLogStreamChunk, projectId?: string) => {
    const { task } = findTaskAndProject(taskId, projectId);
    const specId = task?.specId || taskId;

    safeSendToRenderer(
      getMainWindow,
      IPC_CHANNELS.TASK_LOGS_STREAM,
      specId,
      chunk,
      projectId
    );
  });

  agentManager.on("tasks-refresh", (_taskId: string, projectId?: string) => {
    safeSendToRenderer(
      getMainWindow,
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      TASK_REFRESH_SENTINEL,
      'backlog',
      projectId,
    );
  });

  // Handle SDK rate limit events from agent manager
  agentManager.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Handle SDK rate limit events from title generator
  titleGenerator.on("sdk-rate-limit", (rateLimitInfo: SDKRateLimitInfo) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Handle auth failure events (401 errors requiring re-authentication)
  agentManager.on("auth-failure", (taskId: string, authFailure: {
    profileId?: string;
    failureType?: 'missing' | 'invalid' | 'expired' | 'unknown';
    message?: string;
    originalError?: string;
  }) => {
    console.warn(`[AgentEvents] Auth failure detected for task ${taskId}:`, authFailure);

    // Get profile name for display
    const profileManager = getClaudeProfileManager();
    const profile = authFailure.profileId
      ? profileManager.getProfile(authFailure.profileId)
      : profileManager.getActiveProfile();

    const authFailureInfo: AuthFailureInfo = {
      profileId: authFailure.profileId || profile?.id || 'unknown',
      profileName: profile?.name,
      failureType: authFailure.failureType || 'unknown',
      message: authFailure.message || 'Authentication failed. Please re-authenticate.',
      originalError: authFailure.originalError,
      taskId,
      detectedAt: new Date(),
    };

    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_AUTH_FAILURE, authFailureInfo);
  });

  agentManager.on("exit", (taskId: string, code: number | null, processType: ProcessType, projectId?: string) => {
    // Use projectId from event to scope the lookup (prevents cross-project contamination)
    const { task: exitTask, project: exitProject } = findTaskAndProject(taskId, projectId);
    const exitProjectId = exitProject?.id || projectId;
    const eventScopeKey = getTaskEventScopeKey(taskId, exitProjectId);

    // Skip handleProcessExited for successful spec-creation exits 鈥?the spec 鈫?build
    // transition (line 132+) will start a new agent, and calling handleProcessExited
    // here would mark the task as stuck (no terminal event seen for spec creation).
    const isSpecToBuildTransition = processType === 'spec-creation' && code === 0;
    if (!isSpecToBuildTransition) {
      taskStateManager.handleProcessExited(taskId, code, exitTask, exitProject);
    }

    // Fallback safety net: If XState failed to transition the task out of an active state,
    // force it to human_review after a short delay. This prevents tasks from getting stuck
    // when the process exits without XState properly handling it.
    // Skip for spec鈫抌uild transitions: a new process starts immediately, and the timer
    // would incorrectly force USER_STOPPED on the newly started execution process.
    // We check XState's current state directly to avoid stale cache issues from projectStore.
    // Store timer reference so it can be cancelled if task restarts within the window.
    if (isSpecToBuildTransition) {
      // Cancel any existing timer and skip setting a new one
      cancelFallbackTimer(taskId, exitProjectId);
    }
    const timer = !isSpecToBuildTransition ? setTimeout(() => {
      const currentState = taskStateManager.getCurrentState(taskId, exitProjectId);

      if (currentState && XSTATE_ACTIVE_STATES.has(currentState)) {
        const { task: checkTask, project: checkProject } = findTaskAndProject(taskId, projectId);
        if (checkTask && checkProject) {
          if (code === 0) {
            // Clean exit (code 0) means the task completed successfully but the terminal
            // event was lost in transit. Treat as completed, not stopped.
            const directModeFallback = checkTask.metadata?.workflowMode === 'off' ||
              checkTask.metadata?.developmentMode === 'direct';
            console.warn(
              `[agent-events-handlers] Task ${taskId} still in XState ${currentState} ` +
              `${STUCK_TASK_FALLBACK_TIMEOUT_MS}ms after clean exit (code 0), forcing ${directModeFallback ? 'DIRECT_COMPLETED' : 'QA_PASSED'}`
            );
            if (directModeFallback) {
              taskStateManager.handleUiEvent(taskId, {
                type: 'DIRECT_COMPLETED',
                outcome: 'completed',
                filesChanged: 0,
                quality: { fallback: true },
              }, checkTask, checkProject);
            } else {
              taskStateManager.handleUiEvent(taskId, {
                type: 'QA_PASSED', iteration: 0, testsRun: {}
              }, checkTask, checkProject);
            }
          } else {
            // Non-zero exit code 鈥?task was stopped or crashed
            const hasPlan = hasPlanWithSubtasks(checkProject, checkTask);
            console.warn(
              `[agent-events-handlers] Task ${taskId} still in XState ${currentState} ` +
              `${STUCK_TASK_FALLBACK_TIMEOUT_MS}ms after exit (code ${code}), forcing USER_STOPPED (hasPlan: ${hasPlan})`
            );
            taskStateManager.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan }, checkTask, checkProject);
          }
        }
      }
      // Clean up timer reference after it fires
      fallbackTimers.delete(eventScopeKey);
    }, STUCK_TASK_FALLBACK_TIMEOUT_MS) : null;

    // Store timer reference for potential cancellation
    if (timer) {
      fallbackTimers.set(eventScopeKey, timer);
    }

    // Send final plan state to renderer BEFORE unwatching
    // This ensures the renderer has the final subtask data (fixes 0/0 subtask bug)
    // Always prefer the worktree plan 鈥?it has the most current subtask data
    // from agent execution. The file watcher may have been watching main project.
    let finalPlan = fileWatcher.getCurrentPlan(taskId, exitProjectId);
    if (exitTask && exitProject) {
      const worktreePath = findTaskWorktree(exitProject.path, exitTask.specId);
      if (worktreePath) {
        const specsBaseDir = getSpecsDir(exitProject.autoBuildPath);
        const worktreePlanPath = path.join(
          worktreePath,
          specsBaseDir,
          exitTask.specId,
          AUTOCODE_TASK_ARTIFACTS.implementationPlan
        );
        try {
          const parsed = loadAutocodeImplementationPlanSync(worktreePlanPath) as ImplementationPlan | null;
          if (parsed) {
            finalPlan = parsed;
          }
        } catch {
          // Worktree plan file not readable - keep fileWatcher plan
        }
      }
    }
    if (finalPlan) {
      safeSendToRenderer(
        getMainWindow,
        IPC_CHANNELS.TASK_PROGRESS,
        taskId,
        finalPlan,
        exitProjectId
      );
    }

    // Sync subtask data from worktree plan to main project's plan file.
    // The agent writes subtask statuses to the worktree; the main plan's phases
    // may be stale. Syncing ensures getTasks() dedup (which prefers main) sees correct data.
    if (finalPlan?.phases && exitTask && exitProject) {
      syncPlanPhasesToMainSync(getPlanPath(exitProject, exitTask), finalPlan.phases, exitProjectId);
    }

    fileWatcher.unwatch(taskId, exitProjectId).catch((err) => {
      console.error(`[agent-events-handlers] Failed to unwatch for ${taskId}:`, err);
    });

    if (processType === "spec-creation") {
      console.warn(`[Task ${taskId}] Spec creation completed with code ${code}`);
      // When spec creation succeeds, automatically transition to task execution (build phase)
      if (code === 0) {
        const { task: specTask, project: specProject } = findTaskAndProject(taskId, projectId);
        if (specTask && specProject) {
          const specsBaseDir = getSpecsDir(specProject.autoBuildPath);
          const specDir = path.join(specProject.path, specsBaseDir, specTask.specId);
          const specFilePath = path.join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
          const planPath = getPlanPath(specProject, specTask);
          const requireReviewBeforeCoding = specTask.metadata?.requireReviewBeforeCoding === true;
          if (requireReviewBeforeCoding) {
            const specExists = existsSync(specFilePath);
            const planFileExists = existsSync(planPath);
            let parsedPlan: ImplementationPlan | null = finalPlan ?? null;

            if (!parsedPlan && planFileExists) {
              try {
                parsedPlan = loadAutocodeImplementationPlanSync(planPath) as ImplementationPlan | null;
              } catch {
                parsedPlan = null;
              }
            }

            const subtaskCount = parsedPlan?.phases?.flatMap((phase) => phase.subtasks || []).length || 0;
            if (specExists && parsedPlan && subtaskCount > 0) {
              console.warn(`[Task ${taskId}] Plan review required before coding - waiting for manual approval`);
              taskStateManager.handleUiEvent(
                taskId,
                {
                  type: 'PLANNING_COMPLETE',
                  hasSubtasks: true,
                  subtaskCount,
                  requireReviewBeforeCoding: true
                },
                specTask,
                specProject
              );
              return;
            }

            const missingArtifacts: string[] = [];
            if (!specExists) {
              missingArtifacts.push(AUTOCODE_TASK_ARTIFACTS.specFile);
            }
            if (!planFileExists || !parsedPlan) {
              missingArtifacts.push(AUTOCODE_TASK_ARTIFACTS.implementationPlan);
            } else if (subtaskCount === 0) {
              missingArtifacts.push("subtasks");
            }

            const error = `Plan review unavailable: ${missingArtifacts.join(", ")} was not generated.`;
            console.warn(`[Task ${taskId}] ${error}`);
            safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, specProject.id);
            taskStateManager.handleUiEvent(
              taskId,
              {
                type: 'PLANNING_FAILED',
                error,
                recoverable: true
              },
              specTask,
              specProject
            );
            return;
          }

          if (existsSync(specFilePath)) {
            console.warn(`[Task ${taskId}] Spec created successfully 鈥?starting task execution`);
            // Re-watch the spec directory for the build phase
            fileWatcher.watch(taskId, specDir, specProject.id).catch((err) => {
              console.error(`[agent-events-handlers] Failed to re-watch spec dir for ${taskId}:`, err);
            });
            const baseBranch = specTask.metadata?.baseBranch || specProject.settings?.mainBranch;
            agentManager.startTaskExecution(
              taskId,
              specProject.path,
              specTask.specId,
              {
                baseBranch,
                useWorktree: specTask.metadata?.useWorktree,
                useLocalBranch: specTask.metadata?.useLocalBranch,
                pushNewBranches: specTask.metadata?.pushNewBranches,
              },
              specProject.id
            );
          } else {
            console.warn(`[Task ${taskId}] Spec creation succeeded but spec.md not found 鈥?not starting execution`);
          }
        }
      }
      return;
    }

    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return;

    const taskTitle = task.title || task.specId;
    if (code === 0) {
      notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);
    } else {
      notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
    }
  });

  agentManager.on("task-event", (taskId: string, event, projectId?: string) => {
    console.debug(`[agent-events-handlers] Received task-event for ${taskId}:`, event.type, event);

    if (taskStateManager.getLastSequence(taskId, projectId) === undefined) {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (task && project) {
        try {
          const planPath = getPlanPath(project, task);
          const plan = loadAutocodeImplementationPlanSync(planPath) as { lastEvent?: { sequence?: unknown } } | null;
          const lastSeq = plan?.lastEvent?.sequence;
          if (typeof lastSeq === "number" && lastSeq >= 0) {
            taskStateManager.setLastSequence(taskId, lastSeq, project.id);
          }
        } catch {
          // Ignore missing/invalid plan files
        }
      }
    }

    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) {
      console.debug(`[agent-events-handlers] No task/project found for ${taskId}`);
      return;
    }

    console.debug(`[agent-events-handlers] Task state before handleTaskEvent:`, {
      status: task.status,
      reviewReason: task.reviewReason,
      phase: task.executionProgress?.phase
    });

    const accepted = taskStateManager.handleTaskEvent(taskId, event, task, project);
    console.debug(`[agent-events-handlers] Event ${event.type} accepted: ${accepted}`);
    if (!accepted) {
      return;
    }

    const mainPlanPath = getPlanPath(project, task);
    persistPlanLastEventSync(mainPlanPath, event);

    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (worktreePath) {
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const worktreePlanPath = path.join(
        worktreePath,
        specsBaseDir,
        task.specId,
        AUTOCODE_TASK_ARTIFACTS.implementationPlan
      );
      if (existsSync(worktreePlanPath)) {
        persistPlanLastEventSync(worktreePlanPath, event);
      }
    }
  });

  agentManager.on("task-token-usage", (taskId: string, usage: TokenUsage, projectId?: string) => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    const taskProjectId = project?.id || projectId;

    safeSendToRenderer(
      getMainWindow,
      IPC_CHANNELS.TASK_TOKEN_USAGE,
      taskId,
      usage,
      taskProjectId
    );

    if (!task || !project) {
      return;
    }

    const mainPlanPath = getPlanPath(project, task);
    persistPlanTokenUsageSync(mainPlanPath, usage, project.id);

    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (worktreePath) {
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const worktreePlanPath = path.join(
        worktreePath,
        specsBaseDir,
        task.specId,
        AUTOCODE_TASK_ARTIFACTS.implementationPlan
      );
      if (existsSync(worktreePlanPath)) {
        persistPlanTokenUsageSync(worktreePlanPath, usage, project.id);
      }
    }
  });

  agentManager.on("execution-progress", (taskId: string, progress: ExecutionProgressData, projectId?: string) => {
    // Use projectId from event to scope the lookup (prevents cross-project contamination)
    const { task, project } = findTaskAndProject(taskId, projectId);
    const taskProjectId = project?.id || projectId;

    // Check if XState has already established a terminal/review state for this task.
    // XState is the source of truth for status. When XState is in a terminal state
    // (e.g., plan_review after PLANNING_COMPLETE), execution-progress events from the
    // agent process are stale and must not overwrite XState's persisted status.
    //
    // Example: When requireReviewBeforeCoding=true, the process exits with code 1 after
    // PLANNING_COMPLETE. The exit handler emits execution-progress with phase='failed',
    // which would incorrectly overwrite status='human_review' with status='error' via
    // persistPlanPhaseSync.
    const currentXState = taskStateManager.getCurrentState(taskId, taskProjectId);
    const xstateInTerminalState = currentXState && XSTATE_SETTLED_STATES.has(currentXState);

    // Persist phase to plan file for restoration on app refresh
    // Must persist to BOTH main project and worktree (if exists) since task may be loaded from either
    if (task && project && progress.phase && !xstateInTerminalState) {
      const mainPlanPath = getPlanPath(project, task);
      persistPlanPhaseSync(mainPlanPath, progress.phase, project.id);

      // Also persist to worktree if task has one
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const worktreeSpecDir = path.join(worktreePath, specsBaseDir, task.specId);
        const worktreePlanPath = path.join(
          worktreeSpecDir,
          AUTOCODE_TASK_ARTIFACTS.implementationPlan
        );
        if (existsSync(worktreePlanPath)) {
          persistPlanPhaseSync(worktreePlanPath, progress.phase, project.id);
        }

        // Re-watch the worktree path if the file watcher is still watching the main project path.
        // This handles the case where the task started before the worktree existed:
        // the initial watch fell back to the main project spec dir, but now the worktree
        // is available and implementation_plan.md is being written there.
        const currentWatchDir = fileWatcher.getWatchedSpecDir(taskId, project.id);
        if (currentWatchDir && currentWatchDir !== worktreeSpecDir && existsSync(worktreePlanPath)) {
          console.warn(`[agent-events-handlers] Re-watching worktree path for ${taskId}: ${worktreeSpecDir}`);
          fileWatcher.watch(taskId, worktreeSpecDir, project.id).catch((err) => {
            console.error(`[agent-events-handlers] Failed to re-watch worktree for ${taskId}:`, err);
          });
        }
      }
    } else if (xstateInTerminalState && progress.phase) {
      console.debug(`[agent-events-handlers] Skipping persistPlanPhaseSync for ${taskId}: XState in '${currentXState}', not overwriting with phase '${progress.phase}'`);
    }

    // Skip sending execution-progress to renderer when XState has settled,
    // UNLESS this is a final phase update (complete/failed) AND the task is still in_progress.
    // This prevents UI flicker where a failed phase arrives after the status has already changed to human_review.
    const isFinalPhaseUpdate = progress.phase === 'complete' || progress.phase === 'failed';
    if (xstateInTerminalState) {
      if (!isFinalPhaseUpdate) {
        console.debug(`[agent-events-handlers] Skipping execution-progress to renderer for ${taskId}: XState in '${currentXState}', ignoring phase '${progress.phase}'`);
        return;
      }
      // For final phase updates, only send if task is still in_progress to prevent flicker
      const { task } = findTaskAndProject(taskId, taskProjectId);
      if (task && task.status !== 'in_progress') {
        console.debug(`[agent-events-handlers] Skipping final phase '${progress.phase}' for ${taskId}: task status is '${task.status}', not 'in_progress'`);
        return;
      }
    }
    safeSendToRenderer(
      getMainWindow,
      IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
      taskId,
      progress,
      taskProjectId
    );
  });

  // ============================================
  // File Watcher Events 鈫?Renderer
  // ============================================

  fileWatcher.on("progress", (taskId: string, plan: ImplementationPlan, projectId?: string) => {
    // File watcher events don't carry projectId 鈥?fall back to lookup
    const { task, project } = findTaskAndProject(taskId, projectId);
    const resolvedProjectId = project?.id ?? projectId;

    // Diagnostic: log subtask status summary for debugging status-not-updating issues.
    // Only log when there are non-pending statuses (reduces noise).
    if (plan.phases?.length) {
      const statusCounts: Record<string, number> = {};
      for (const phase of plan.phases) {
        for (const st of phase.subtasks ?? []) {
          const s = st.status || 'pending';
          statusCounts[s] = (statusCounts[s] || 0) + 1;
        }
      }
      const hasNonPending = Object.keys(statusCounts).some(k => k !== 'pending');
      if (hasNonPending) {
        console.warn(
          `[FileWatcher鈫扲enderer] Task ${taskId} subtask statuses:`,
          statusCounts,
          `| projectId: ${resolvedProjectId ?? 'UNKNOWN'}`,
        );
      }
    }

    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_PROGRESS, taskId, plan, resolvedProjectId);

    // Re-stamp XState status fields if the backend overwrote the plan file without them.
    // The planner agent writes implementation_plan.md via the Write tool, which replaces
    // the entire file and strips the frontend's status/xstateState/executionPhase fields.
    // This causes tasks to snap back to backlog on refresh.
    const planWithStatus = plan as { xstateState?: string; executionPhase?: string; status?: string };
    const currentXState = taskStateManager.getCurrentState(taskId, resolvedProjectId);
    if (currentXState && !planWithStatus.xstateState && task && project) {
      console.debug(`[agent-events-handlers] Re-stamping XState status on plan file for ${taskId} (state: ${currentXState})`);
      const mainPlanPath = getPlanPath(project, task);
      const { status, reviewReason } = mapStateToLegacy(currentXState);
      const phase = XSTATE_TO_PHASE[currentXState] || 'idle';
      persistPlanStatusAndReasonSync(mainPlanPath, status, reviewReason, project.id, currentXState, phase);

      // Also re-stamp worktree copy if it exists
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const worktreePlanPath = path.join(
          worktreePath,
          specsBaseDir,
          task.specId,
          AUTOCODE_TASK_ARTIFACTS.implementationPlan
        );
        if (existsSync(worktreePlanPath)) {
          persistPlanStatusAndReasonSync(worktreePlanPath, status, reviewReason, project.id, currentXState, phase);
        }
      }
    }
  });

  fileWatcher.on("error", (taskId: string, error: string, projectId?: string) => {
    // File watcher events don't carry projectId 鈥?fall back to lookup
    const { project } = findTaskAndProject(taskId, projectId);
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, project?.id ?? projectId);
  });
}

/**
 * Cancel any pending fallback timer for a task.
 * Should be called when a task is restarted to prevent the stale timer
 * from incorrectly stopping the new process.
 */
export function cancelFallbackTimer(taskId: string, projectId?: string): void {
  for (const scopeKey of getMatchingTaskEventScopeKeys(taskId, projectId)) {
    const timer = fallbackTimers.get(scopeKey);
    if (timer) {
      clearTimeout(timer);
      fallbackTimers.delete(scopeKey);
      console.debug(`[agent-events-handlers] Cancelled fallback timer for task ${taskId}`, { projectId });
    }
  }
}
