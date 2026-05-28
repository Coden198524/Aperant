import { createActor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { BrowserWindow } from 'electron';
import type { TaskEventPayload } from './agent/task-event-schema';
import type { Project, Task, TaskStatus, ReviewReason, ExecutionPhase } from '../shared/types';
import { taskMachine, XSTATE_TO_PHASE, mapStateToLegacy, type TaskEvent } from '../shared/state-machines';
import { IPC_CHANNELS } from '../shared/constants';
import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';
import { safeSendToRenderer } from './ipc-handlers/utils';
import { getPlanPath, persistPlanStatusAndReasonSync } from './ipc-handlers/task/plan-file-utils';
import { findTaskWorktree } from './worktree-paths';
import { getSpecsDir } from '../shared/constants';
import { existsSync } from 'fs';
import path from 'path';

type TaskActor = ActorRefFrom<typeof taskMachine>;

interface TaskContextEntry {
  task: Task;
  project: Project;
}

const TERMINAL_EVENTS = new Set<string>([
  'QA_PASSED',
  'PLANNING_COMPLETE',
  'PLANNING_FAILED',
  'CODING_FAILED',
  'QA_MAX_ITERATIONS',
  'QA_AGENT_ERROR',
  'ALL_SUBTASKS_DONE'
]);

export class TaskStateManager {
  private actors = new Map<string, TaskActor>();
  private lastSequenceByTask = new Map<string, number>();
  private lastStateByTask = new Map<string, string>();
  private taskContextById = new Map<string, TaskContextEntry>();
  private terminalEventSeen = new Set<string>();
  private getMainWindow: (() => BrowserWindow | null) | null = null;

  configure(getMainWindow: () => BrowserWindow | null): void {
    this.getMainWindow = getMainWindow;
  }

  handleTaskEvent(taskId: string, event: TaskEventPayload, task: Task, project: Project): boolean {
    const lastSeq = this.lastSequenceByTask.get(taskId);
    console.debug(`[TaskStateManager] handleTaskEvent: ${event.type} seq=${event.sequence}, lastSeq=${lastSeq}`);

    if (!this.isNewSequence(taskId, event.sequence)) {
      console.debug(`[TaskStateManager] Event ${event.type} DROPPED - sequence ${event.sequence} not newer than ${lastSeq}`);
      return false;
    }
    this.setTaskContext(taskId, task, project);
    this.lastSequenceByTask.set(taskId, event.sequence);

    if (TERMINAL_EVENTS.has(event.type)) {
      this.terminalEventSeen.add(taskId);
    }

    const actor = this.getOrCreateActor(taskId);
    const stateBefore = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] Sending ${event.type} to actor in state: ${stateBefore}`);
    actor.send(event as TaskEvent);
    const stateAfter = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] After ${event.type}: state ${stateBefore} -> ${stateAfter}`);
    return true;
  }

  handleProcessExited(
    taskId: string,
    exitCode: number | null,
    task?: Task,
    project?: Project
  ): void {
    if (task && project) {
      this.setTaskContext(taskId, task, project);
    }
    if (this.terminalEventSeen.has(taskId)) {
      return;
    }
    const actor = this.getOrCreateActor(taskId);
    // Only mark as unexpected if the process exited with a non-zero code.
    // A code-0 exit is normal (e.g., spec creation finished, plan created, waiting for review).
    // Sending unexpected:true for code-0 exits incorrectly transitions plan_review → error.
    const isUnexpected = exitCode !== 0;
    actor.send({
      type: 'PROCESS_EXITED',
      exitCode: exitCode ?? -1,
      unexpected: isUnexpected
    } satisfies TaskEvent);
  }

  handleUiEvent(taskId: string, event: TaskEvent, task: Task, project: Project): void {
    console.debug(`[TaskStateManager] handleUiEvent: ${event.type} for task ${taskId}`);
    this.setTaskContext(taskId, task, project);
    const actor = this.getOrCreateActor(taskId);
    const stateBefore = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] Sending UI event ${event.type} to actor in state: ${stateBefore}`);
    actor.send(event);
    const stateAfter = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] After UI event ${event.type}: state ${stateBefore} -> ${stateAfter}`);
  }

  handleManualStatusChange(taskId: string, status: TaskStatus, task: Task, project: Project): boolean {
    const currentState = this.getCurrentState(taskId);
    const isTerminalDoneLike = (
      currentState === 'done' ||
      currentState === 'pr_created' ||
      (!currentState && (task.status === 'done' || task.status === 'pr_created'))
    );
    const canMarkDoneFromCurrentState = (
      currentState === 'human_review' ||
      currentState === 'error' ||
      currentState === 'pr_created' ||
      (!currentState && (task.status === 'human_review' || task.status === 'error' || task.status === 'pr_created'))
    );

    switch (status) {
      case 'done':
        // Merge completion can arrive while the actor is still restored as an active state
        // (for example after a stale in-progress snapshot). In that case MARK_DONE would be
        // ignored, so force the actor into the terminal done snapshot instead.
        if (currentState === 'done' || (!currentState && task.status === 'done')) {
          return true;
        }
        if (!canMarkDoneFromCurrentState) {
          this.reinitializeActorForTask(taskId, {
            ...task,
            status: 'done',
            reviewReason: undefined,
          }, project);
          return true;
        }
        this.handleUiEvent(taskId, { type: 'MARK_DONE' }, task, project);
        return true;
      case 'pr_created':
        this.handleUiEvent(
          taskId,
          { type: 'PR_CREATED', prUrl: task.metadata?.prUrl ?? '' },
          task,
          project
        );
        return true;
      case 'in_progress': {
        // Re-open tasks that were already completed/PR-created.
        // In terminal states, USER_RESUMED cannot transition, so recreate actor from target status.
        if (isTerminalDoneLike) {
          this.reinitializeActorForTask(taskId, {
            ...task,
            status: 'in_progress',
            reviewReason: undefined,
          }, project);
          return true;
        }

        // Use XState as source of truth for determining correct event
        if (currentState === 'plan_review') {
          this.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
        } else if (currentState === 'human_review' || currentState === 'error') {
          this.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
        } else if (!currentState && task.reviewReason === 'plan_review') {
          // Fallback: No actor exists (e.g., after app restart), use task data
          this.handleUiEvent(taskId, { type: 'PLAN_APPROVED' }, task, project);
        } else {
          this.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
        }
        return true;
      }
      case 'backlog':
        // Re-open completed tasks back to backlog by rebuilding actor from backlog snapshot.
        if (isTerminalDoneLike) {
          this.reinitializeActorForTask(taskId, {
            ...task,
            status: 'backlog',
            reviewReason: undefined,
          }, project);
          return true;
        }
        this.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan: false }, task, project);
        return true;
      case 'human_review':
        // Manual move to human_review should always sync actor snapshot.
        // This supports dragging completed tasks back to review before Request Changes.
        this.reinitializeActorForTask(taskId, {
          ...task,
          status: 'human_review',
          reviewReason: task.reviewReason ?? 'completed',
        }, project);
        return true;
      default:
        return false;
    }
  }

  setLastSequence(taskId: string, sequence: number): void {
    this.lastSequenceByTask.set(taskId, sequence);
  }

  getLastSequence(taskId: string): number | undefined {
    return this.lastSequenceByTask.get(taskId);
  }

  /**
   * Get the current XState state for a task.
   * Returns undefined if no actor exists for the task.
   */
  getCurrentState(taskId: string): string | undefined {
    const actor = this.actors.get(taskId);
    if (!actor) {
      return undefined;
    }
    return String(actor.getSnapshot().value);
  }

  /**
   * Check if the task is currently in plan_review state.
   * Used by TASK_START to determine correct event to send.
   */
  isInPlanReview(taskId: string): boolean {
    return this.getCurrentState(taskId) === 'plan_review';
  }

  /**
   * Reset tracking state for a task that is about to be restarted.
   * Clears terminalEventSeen (so process exits aren't swallowed) and
   * lastSequenceByTask (so events from the new process aren't dropped
   * as duplicates). Does NOT stop or remove the XState actor, since
   * the caller may still need to send events to it.
   */
  prepareForRestart(taskId: string): void {
    this.terminalEventSeen.delete(taskId);
    this.lastSequenceByTask.delete(taskId);
  }

  clearTask(taskId: string): void {
    this.lastSequenceByTask.delete(taskId);
    this.lastStateByTask.delete(taskId);
    this.terminalEventSeen.delete(taskId);
    this.taskContextById.delete(taskId);
    const actor = this.actors.get(taskId);
    if (actor) {
      actor.stop();
      this.actors.delete(taskId);
    }
  }

  /**
   * Clear all task state. Called by TASK_LIST handler when forceRefresh is true.
   * This ensures actors are recreated with fresh task data when the user
   * triggers a manual refresh from the UI.
   *
   * Note: lastSequenceByTask is preserved to prevent duplicate event processing
   * if backend events arrive during the refresh window. Sequence numbers are
   * specific to task execution sessions and should remain valid across UI refreshes.
   */
  clearAllTasks(): void {
    for (const [_taskId, actor] of this.actors) {
      actor.stop();
    }
    this.actors.clear();
    // Preserve lastSequenceByTask to prevent duplicate event processing during refresh
    // Only clear state that needs to be rebuilt from fresh task data
    this.lastStateByTask.clear();
    this.terminalEventSeen.clear();
    this.taskContextById.clear();
    console.log('[TaskStateManager] Cleared task actors and state for refresh (preserved sequence tracking)');
  }

  private setTaskContext(taskId: string, task: Task, project: Project): void {
    this.taskContextById.set(taskId, { task, project });
  }

  private reinitializeActorForTask(taskId: string, task: Task, project: Project): void {
    this.clearTask(taskId);
    this.setTaskContext(taskId, task, project);
    this.getOrCreateActor(taskId);
  }

  private getOrCreateActor(taskId: string): TaskActor {
    const existing = this.actors.get(taskId);
    if (existing) {
      console.debug(`[TaskStateManager] Using existing actor for ${taskId}, current state:`, String(existing.getSnapshot().value));
      return existing;
    }

    const contextEntry = this.taskContextById.get(taskId);
    const snapshot = contextEntry
      ? this.buildSnapshotFromTask(contextEntry.task)
      : undefined;

    if (contextEntry) {
      console.debug(`[TaskStateManager] Creating new actor for ${taskId} from task:`, {
        status: contextEntry.task.status,
        reviewReason: contextEntry.task.reviewReason,
        phase: contextEntry.task.executionProgress?.phase,
        initialState: snapshot ? String(snapshot.value) : 'default (backlog)'
      });
    } else {
      console.debug(`[TaskStateManager] Creating new actor for ${taskId} with default state (no context entry)`);
    }

    const actor = snapshot
      ? createActor(taskMachine, { snapshot })
      : createActor(taskMachine);
    actor.subscribe((snapshot) => {
      const stateValue = String(snapshot.value);
      const lastState = this.lastStateByTask.get(taskId);

      console.debug(`[TaskStateManager] XState transition for ${taskId}:`, {
        from: lastState,
        to: stateValue,
        contextReviewReason: snapshot.context.reviewReason
      });

      if (lastState === stateValue) {
        return;
      }
      this.lastStateByTask.set(taskId, stateValue);

      const contextEntry = this.taskContextById.get(taskId);
      if (!contextEntry) {
        console.debug(`[TaskStateManager] No context for task ${taskId} during state transition to ${stateValue} - skipping emit (may occur after clearTask during event processing)`);
        return;
      }
      const { task, project } = contextEntry;
      const { status, reviewReason } = mapStateToLegacy(
        stateValue,
        snapshot.context.reviewReason
      );

      // Map XState state to execution phase for persistence
      const executionPhase = this.mapStateToExecutionPhase(stateValue);

      console.debug(`[TaskStateManager] Emitting status for ${taskId}:`, {
        status,
        reviewReason,
        xstateState: stateValue,
        executionPhase,
        projectId: project.id
      });

      this.persistStatus(task, project, status, reviewReason, stateValue, executionPhase);
      this.emitStatus(taskId, status, reviewReason, project.id);
    });

    actor.start();
    this.actors.set(taskId, actor);
    return actor;
  }

  private persistStatus(
    task: Task,
    project: Project,
    status: TaskStatus,
    reviewReason?: ReviewReason,
    xstateState?: string,
    executionPhase?: string
  ): void {
    const mainPlanPath = getPlanPath(project, task);
    persistPlanStatusAndReasonSync(mainPlanPath, status, reviewReason, project.id, xstateState, executionPhase);

    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (!worktreePath) return;

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const worktreePlanPath = path.join(
      worktreePath,
      specsBaseDir,
      task.specId,
      AUTOCODE_TASK_ARTIFACTS.implementationPlan
    );
    if (existsSync(worktreePlanPath)) {
      persistPlanStatusAndReasonSync(worktreePlanPath, status, reviewReason, project.id, xstateState, executionPhase);
    }
  }

  /**
   * Map XState state to execution phase string
   */
  private mapStateToExecutionPhase(xstateState: string): ExecutionPhase {
    return XSTATE_TO_PHASE[xstateState] || 'idle';
  }

  private emitStatus(
    taskId: string,
    status: TaskStatus,
    reviewReason: ReviewReason | undefined,
    projectId?: string
  ): void {
    if (!this.getMainWindow) {
      console.warn(`[TaskStateManager] emitStatus: No main window, cannot emit status ${status} for ${taskId}`);
      return;
    }
    console.debug(`[TaskStateManager] emitStatus: Sending TASK_STATUS_CHANGE for ${taskId}:`, { status, reviewReason, projectId });
    safeSendToRenderer(
      this.getMainWindow,
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      taskId,
      status,
      projectId,
      reviewReason
    );

    // Also emit execution progress to update the phase in the UI
    // XState transitions (planning → coding → qa_review) need to update the phase badge
    const actor = this.actors.get(taskId);
    if (actor) {
      const xstateState = String(actor.getSnapshot().value);
      const executionPhase = this.mapStateToExecutionPhase(xstateState);

      // Only emit if we have a meaningful phase (not idle)
      if (executionPhase && executionPhase !== 'idle') {
        console.debug(`[TaskStateManager] emitStatus: Also sending TASK_EXECUTION_PROGRESS for ${taskId}:`, { phase: executionPhase });
        safeSendToRenderer(
          this.getMainWindow,
          IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
          taskId,
          {
            phase: executionPhase,
            phaseProgress: 0,
            overallProgress: 0,
          },
          projectId
        );
      }
    }
  }

  private isNewSequence(taskId: string, sequence: number): boolean {
    const last = this.lastSequenceByTask.get(taskId);
    // Use >= to accept the first event when sequence equals last (e.g., both are 0)
    // This handles the case where we reload lastSequence from plan file and the next
    // event has the same sequence number (which shouldn't happen, but we should be lenient)
    return last === undefined || sequence >= last;
  }

  private buildSnapshotFromTask(task: Task) {
    const status = task.status;
    const reviewReason = task.reviewReason;
    const executionPhase = task.executionProgress?.phase;
    let stateValue: string = 'backlog';
    let contextReviewReason: ReviewReason | undefined;

    switch (status) {
      case 'in_progress':
        // Use executionProgress.phase to determine if we're in planning or coding
        // This is important because both phases have status 'in_progress'
        if (executionPhase === 'planning') {
          stateValue = 'planning';
        } else if (executionPhase === 'qa_review') {
          stateValue = 'qa_review';
        } else if (executionPhase === 'qa_fixing') {
          stateValue = 'qa_fixing';
        } else {
          // Default to coding for 'coding', 'complete', or unknown phases
          stateValue = 'coding';
        }
        break;
      case 'ai_review':
        stateValue = 'qa_review';
        break;
      case 'human_review':
        stateValue = reviewReason === 'plan_review' ? 'plan_review' : 'human_review';
        contextReviewReason = reviewReason;
        break;
      case 'pr_created':
        stateValue = 'pr_created';
        break;
      case 'done':
        stateValue = 'done';
        break;
      case 'error':
        stateValue = 'error';
        contextReviewReason = reviewReason ?? 'errors';
        break;
      default:
        stateValue = 'backlog';
        break;
    }

    return taskMachine.resolveState({
      value: stateValue,
      context: {
        reviewReason: contextReviewReason
      }
    });
  }
}

export const taskStateManager = new TaskStateManager();
