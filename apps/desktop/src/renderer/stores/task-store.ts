import { create } from 'zustand';
import { arrayMove } from '@dnd-kit/sortable';
import type { Task, TaskStatus, SubtaskStatus, ImplementationPlan, Subtask, TaskMetadata, ExecutionProgress, ExecutionPhase, ReviewReason, TaskDraft, ImageAttachment, TaskOrderState, TokenUsage, TaskStartOptions, ProjectDocumentType } from '../../shared/types';
import { wouldPhaseRegress } from '../../shared/constants/phase-protocol';
import { debugLog, debugWarn } from '../../shared/utils/debug-logger';
import { useProjectStore } from './project-store';

/** Default max parallel tasks when no project setting is configured */
export const DEFAULT_MAX_PARALLEL_TASKS = 3;


/** Maximum log entries stored per task to prevent renderer OOM */
export const MAX_LOG_ENTRIES = 5000;

interface TaskState {
  tasks: Task[];
  selectedTaskId: string | null;
  isLoading: boolean;
  error: string | null;
  taskOrder: TaskOrderState | null;  // Per-column task ordering for kanban board

  // Actions
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (taskId: string, updates: Partial<Task>, projectId?: string) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus, reviewReason?: ReviewReason, projectId?: string) => void;
  updateTaskFromPlan: (taskId: string, plan: ImplementationPlan, projectId?: string) => void;
  updateExecutionProgress: (taskId: string, progress: Partial<ExecutionProgress>, projectId?: string) => void;
  updateTaskTokenUsage: (taskId: string, usage: TokenUsage, projectId?: string) => void;
  appendLog: (taskId: string, log: string, projectId?: string) => void;
  batchAppendLogs: (taskId: string, logs: string[], projectId?: string) => void;
  selectTask: (taskId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearTasks: () => void;
  // Task order actions for kanban drag-and-drop reordering
  setTaskOrder: (order: TaskOrderState) => void;
  reorderTasksInColumn: (status: TaskStatus, activeId: string, overId: string) => void;
  moveTaskToColumnTop: (taskId: string, targetStatus: TaskStatus, sourceStatus?: TaskStatus) => void;
  loadTaskOrder: (projectId: string) => void;
  saveTaskOrder: (projectId: string) => boolean;
  clearTaskOrder: (projectId: string) => void;

  // Task status change listeners (for queue auto-promotion)
  registerTaskStatusChangeListener: (listener: (taskId: string, oldStatus: TaskStatus | undefined, newStatus: TaskStatus, projectId?: string) => void) => () => void;

  // Selectors
  getSelectedTask: () => Task | undefined;
  getTasksByStatus: (status: TaskStatus) => Task[];
}

/**
 * Helper to find task index by id or specId.
 * Returns -1 if not found.
 */
function matchesTaskId(task: Task, taskId: string, projectId?: string): boolean {
  if (projectId && task.projectId !== projectId) {
    return false;
  }
  return task.id === taskId || task.specId === taskId;
}

function findTaskInStore(tasks: Task[], taskId: string, projectId?: string): Task | undefined {
  return tasks.find((task) => matchesTaskId(task, taskId, projectId));
}

function findTaskIndex(tasks: Task[], taskId: string, projectId?: string): number {
  return tasks.findIndex((task) => matchesTaskId(task, taskId, projectId));
}

function resolveTaskProjectId(taskId: string, projectId?: string): string | undefined {
  if (projectId) {
    return projectId;
  }
  return findTaskInStore(useTaskStore.getState().tasks, taskId)?.projectId;
}

function getTaskActivityKey(taskId: string, projectId?: string): string {
  return projectId ? `${projectId}::${taskId}` : taskId;
}

/**
 * Task status change listeners for queue auto-promotion
 * Stored outside the store to avoid triggering re-renders
 */
const taskStatusChangeListeners = new Set<(taskId: string, oldStatus: TaskStatus | undefined, newStatus: TaskStatus, projectId?: string) => void>();
const taskLoadSequencesByProject = new Map<string, number>();
const taskCacheByProject = new Map<string, { tasks: Task[]; timestamp: number }>();
const RENDERER_TASK_CACHE_TTL_MS = 30_000;

export interface LoadTasksOptions {
  forceRefresh?: boolean;
  preferCache?: boolean;
  backgroundRefresh?: boolean;
  deferRemoteMs?: number;
}

function getCachedTasks(projectId: string): Task[] | null {
  const cached = taskCacheByProject.get(projectId);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.timestamp > RENDERER_TASK_CACHE_TTL_MS) {
    taskCacheByProject.delete(projectId);
    return null;
  }

  return cached.tasks;
}

function cacheTasks(projectId: string, tasks: Task[]): void {
  taskCacheByProject.set(projectId, {
    tasks,
    timestamp: Date.now(),
  });
}

function invalidateTaskCache(projectId?: string): void {
  if (projectId) {
    taskCacheByProject.delete(projectId);
    return;
  }
  taskCacheByProject.clear();
}

function cacheTaskGroups(tasks: Task[]): void {
  const tasksByProject = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.projectId) {
      continue;
    }
    const projectTasks = tasksByProject.get(task.projectId) ?? [];
    projectTasks.push(task);
    tasksByProject.set(task.projectId, projectTasks);
  }

  for (const [projectId, projectTasks] of tasksByProject) {
    cacheTasks(projectId, projectTasks);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getVisibleTaskProjectId(): string | null {
  const { activeProjectId, selectedProjectId } = useProjectStore.getState();
  return activeProjectId || selectedProjectId || null;
}

function isVisibleTaskProject(projectId: string): boolean {
  const visibleProjectId = getVisibleTaskProjectId();
  return !visibleProjectId || visibleProjectId === projectId;
}

function nextTaskLoadSequence(projectId: string): number {
  const sequence = (taskLoadSequencesByProject.get(projectId) ?? 0) + 1;
  taskLoadSequencesByProject.set(projectId, sequence);
  return sequence;
}

function shouldApplyTaskLoad(projectId: string, sequence: number): boolean {
  return taskLoadSequencesByProject.get(projectId) === sequence && isVisibleTaskProject(projectId);
}

/**
 * Track last activity timestamp per task for stuck detection.
 * If we've received activity (execution progress, status update) within a threshold,
 * the task is considered active even if the process check fails.
 * This prevents race conditions where stuck detection fires before process is registered.
 */
const taskLastActivity = new Map<string, number>();
const STUCK_ACTIVITY_THRESHOLD_MS = 60_000; // 60 seconds - matches catastrophic stuck check interval

/**
 * Record activity for a task (call this when we receive execution progress or status updates)
 */
export function recordTaskActivity(taskId: string, projectId?: string): void {
  taskLastActivity.set(getTaskActivityKey(taskId, resolveTaskProjectId(taskId, projectId)), Date.now());
}

/**
 * Check if a task has had recent activity within the threshold.
 * Used by stuck detection to avoid false positives.
 */
export function hasRecentActivity(taskId: string, projectId?: string): boolean {
  const resolvedProjectId = resolveTaskProjectId(taskId, projectId);
  const lastActivity = taskLastActivity.get(getTaskActivityKey(taskId, resolvedProjectId));
  if (!lastActivity) return false;
  return Date.now() - lastActivity < STUCK_ACTIVITY_THRESHOLD_MS;
}

/**
 * Clear activity tracking for a task (call when task completes or is deleted)
 */
export function clearTaskActivity(taskId: string, projectId?: string): void {
  const resolvedProjectId = resolveTaskProjectId(taskId, projectId);
  taskLastActivity.delete(getTaskActivityKey(taskId, resolvedProjectId));
  taskLastActivity.delete(taskId);
}

/**
 * Notify all registered listeners when a task status changes
 */
function notifyTaskStatusChange(taskId: string, oldStatus: TaskStatus | undefined, newStatus: TaskStatus, projectId?: string): void {
  for (const listener of taskStatusChangeListeners) {
    try {
      listener(taskId, oldStatus, newStatus, projectId);
    } catch (error) {
      console.error('[TaskStore] Error in task status change listener:', error);
    }
  }
}

/**
 * Helper to update a single task efficiently.
 * Uses slice instead of map to avoid iterating all tasks.
 */
function updateTaskAtIndex(tasks: Task[], index: number, updater: (task: Task) => Task): Task[] {
  if (index < 0 || index >= tasks.length) return tasks;

  const updatedTask = updater(tasks[index]);

  // If the task reference didn't change, return original array
  if (updatedTask === tasks[index]) {
    return tasks;
  }

  // Create new array with only the changed task replaced
  const newTasks = [...tasks];
  newTasks[index] = updatedTask;

  return newTasks;
}

function isAllowedPhaseRegression(currentPhase: ExecutionPhase, nextPhase: ExecutionPhase): boolean {
  return currentPhase === 'qa_fixing' && nextPhase === 'qa_review';
}

function isInactiveOrTerminalExecutionPhase(phase: ExecutionPhase | undefined): boolean {
  return !phase || phase === 'idle' || phase === 'complete' || phase === 'failed' || phase === 'stopped';
}

function mergeTokenUsageForTask(
  previous: TokenUsage | undefined,
  incoming: TokenUsage,
): TokenUsage {
  if (!previous) {
    return incoming;
  }

  if (previous.estimated === true && incoming.estimated !== true) {
    return {
      ...incoming,
      stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
    };
  }

  const preferIncomingTokens = !incoming.estimated || previous.estimated === true;

  return {
    promptTokens: preferIncomingTokens
      ? Math.max(previous.promptTokens ?? 0, incoming.promptTokens ?? 0)
      : previous.promptTokens,
    completionTokens: preferIncomingTokens
      ? Math.max(previous.completionTokens ?? 0, incoming.completionTokens ?? 0)
      : previous.completionTokens,
    totalTokens: preferIncomingTokens
      ? Math.max(previous.totalTokens ?? 0, incoming.totalTokens ?? 0)
      : previous.totalTokens,
    thinkingTokens: Math.max(previous.thinkingTokens ?? 0, incoming.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, incoming.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(previous.cacheCreationTokens ?? 0, incoming.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
    estimated: previous.estimated === true && incoming.estimated === true ? true : undefined,
  };
}

/**
 * Validates implementation plan data structure before processing.
 * Returns true if valid, false if invalid/incomplete.
 */
function validatePlanData(plan: ImplementationPlan): boolean {
  // Validate plan has phases array
  if (!plan.phases || !Array.isArray(plan.phases)) {
    console.warn('[validatePlanData] Invalid plan: missing or invalid phases array');
    return false;
  }

  // Validate each phase has subtasks array
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i];
    if (!phase || !phase.subtasks || !Array.isArray(phase.subtasks)) {
      console.warn(`[validatePlanData] Invalid phase ${i}: missing or invalid subtasks array`);
      return false;
    }

    // Validate each subtask has at minimum a description
    for (let j = 0; j < phase.subtasks.length; j++) {
      const subtask = phase.subtasks[j];
      if (!subtask || typeof subtask !== 'object') {
        console.warn(`[validatePlanData] Invalid subtask at phase ${i}, index ${j}: not an object`);
        return false;
      }

      // Title is the primary display field.
      // Accept 'description' and 'name' as fallbacks since AI planners vary in field naming.
      const displayText = subtask.title || subtask.description || (subtask as unknown as { name?: string }).name;
      if (!displayText || typeof displayText !== 'string' || displayText.trim() === '') {
        console.warn(`[validatePlanData] Invalid subtask at phase ${i}, index ${j}: missing title and description`);
        return false;
      }
    }
  }

  return true;
}

function getPlanSubtaskCompletionSummary(subtask: ImplementationPlan['phases'][number]['subtasks'][number]): string | undefined {
  if (subtask.status !== 'completed') {
    return undefined;
  }

  const raw = subtask as typeof subtask & {
    completionSummary?: unknown;
    completed_summary?: unknown;
    actual_output?: unknown;
  };
  const value = raw.completion_summary ?? raw.completionSummary ?? raw.completed_summary ?? raw.notes ?? raw.actual_output;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasCodingActivityInSubtasks(subtasks: Subtask[]): boolean {
  return subtasks.some((subtask) => subtask.status !== 'pending');
}

function promoteExecutionPhaseFromPlan(
  task: Task,
  subtasks: Subtask[],
): ExecutionProgress | undefined {
  if (task.status !== 'in_progress') {
    return task.executionProgress;
  }

  const currentPhase = task.executionProgress?.phase;
  const shouldPromoteToCoding = (currentPhase === undefined || currentPhase === 'planning' || isInactiveOrTerminalExecutionPhase(currentPhase))
    && hasCodingActivityInSubtasks(subtasks);

  if (!shouldPromoteToCoding) {
    return task.executionProgress;
  }

  const activeSubtask = subtasks.find((subtask) => subtask.status === 'in_progress');

  const shouldCarryProgress = currentPhase === 'planning' || currentPhase === 'coding';
  return {
    phase: 'coding',
    phaseProgress: shouldCarryProgress ? task.executionProgress?.phaseProgress ?? 0 : 0,
    overallProgress: shouldCarryProgress ? task.executionProgress?.overallProgress ?? 0 : 0,
    currentSubtask: activeSubtask?.title ?? task.executionProgress?.currentSubtask,
    message: task.executionProgress?.message,
    startedAt: task.executionProgress?.startedAt,
    sequenceNumber: task.executionProgress?.sequenceNumber,
    completedPhases: task.executionProgress?.completedPhases,
  };
}

function isActivePlanStatus(plan: ImplementationPlan): boolean {
  const statusValues = [
    plan.status,
    plan.planStatus,
    (plan as ImplementationPlan & { executionPhase?: string }).executionPhase,
    plan.xstateState,
  ].filter((value): value is string => typeof value === 'string');

  return statusValues.some((value) =>
    value === 'in_progress' ||
    value === 'planning' ||
    value === 'coding' ||
    value === 'qa_review' ||
    value === 'qa_fixing'
  );
}

function getActiveExecutionPhaseFromPlan(plan: ImplementationPlan): ExecutionPhase | undefined {
  const phaseValues = [
    (plan as ImplementationPlan & { executionPhase?: string }).executionPhase,
    plan.xstateState,
  ];

  for (const value of phaseValues) {
    if (
      value === 'planning' ||
      value === 'coding' ||
      value === 'qa_review' ||
      value === 'qa_fixing'
    ) {
      return value;
    }
  }

  return undefined;
}

function isCompletedTerminalTask(task: Task): boolean {
  return task.status === 'done' ||
    task.status === 'pr_created' ||
    (task.status === 'human_review' && task.reviewReason === 'completed');
}

function getPlanReviewStateFromPlan(plan: ImplementationPlan): {
  status: TaskStatus;
  reviewReason: ReviewReason;
  executionProgress: ExecutionProgress;
} | undefined {
  if (plan.status !== 'human_review' || plan.reviewReason !== 'plan_review') {
    return undefined;
  }

  return {
    status: 'human_review',
    reviewReason: 'plan_review',
    executionProgress: {
      phase: 'planning',
      phaseProgress: 100,
      overallProgress: 100,
    },
  };
}

function buildExecutionProgressForPlanPhase(
  task: Task,
  phase: ExecutionPhase,
): ExecutionProgress {
  const samePhase = task.executionProgress?.phase === phase;
  return {
    phase,
    phaseProgress: samePhase ? task.executionProgress?.phaseProgress ?? 0 : 0,
    overallProgress: samePhase ? task.executionProgress?.overallProgress ?? 0 : 0,
    currentSubtask: phase === 'coding' ? task.executionProgress?.currentSubtask : undefined,
    message: task.executionProgress?.message,
    startedAt: task.executionProgress?.startedAt,
    sequenceNumber: task.executionProgress?.sequenceNumber,
    completedPhases: task.executionProgress?.completedPhases,
  };
}

function getTerminalTaskStateFromPlan(plan: ImplementationPlan): {
  status: TaskStatus;
  reviewReason?: ReviewReason;
  executionProgress: ExecutionProgress;
} | undefined {
  if (plan.status === 'done') {
    return {
      status: 'done',
      executionProgress: { phase: 'complete', phaseProgress: 100, overallProgress: 100 },
    };
  }
  if (plan.status === 'pr_created') {
    return {
      status: 'pr_created',
      executionProgress: { phase: 'complete', phaseProgress: 100, overallProgress: 100 },
    };
  }
  if (plan.status === 'error') {
    return {
      status: 'error',
      executionProgress: { phase: 'failed', phaseProgress: 0, overallProgress: 0 },
    };
  }
  if (
    plan.status === 'human_review' &&
    (
      plan.reviewReason === 'completed' ||
      plan.reviewReason === 'errors' ||
      plan.reviewReason === 'qa_rejected'
    )
  ) {
    return {
      status: 'human_review',
      reviewReason: plan.reviewReason,
      executionProgress: plan.reviewReason === 'completed'
        ? { phase: 'complete', phaseProgress: 100, overallProgress: 100 }
        : { phase: 'failed', phaseProgress: 0, overallProgress: 0 },
    };
  }
  return undefined;
}

function getExecutionProgressForStatus(
  status: TaskStatus,
  reviewReason?: ReviewReason,
  current?: ExecutionProgress,
): ExecutionProgress | undefined {
  if (status === 'backlog') {
    return { phase: 'idle', phaseProgress: 0, overallProgress: 0 };
  }
  if (status === 'in_progress' && isInactiveOrTerminalExecutionPhase(current?.phase)) {
    return { phase: 'planning', phaseProgress: 0, overallProgress: 0 };
  }
  if (status === 'human_review' && reviewReason === 'stopped') {
    return { phase: 'stopped', phaseProgress: 0, overallProgress: 0 };
  }
  if (
    status === 'done' ||
    status === 'pr_created' ||
    (status === 'human_review' && reviewReason === 'completed')
  ) {
    return { phase: 'complete', phaseProgress: 100, overallProgress: 100 };
  }
  if (
    status === 'error' ||
    (status === 'human_review' && (reviewReason === 'errors' || reviewReason === 'qa_rejected'))
  ) {
    return { phase: 'failed', phaseProgress: 0, overallProgress: 0 };
  }
  if (status === 'human_review') {
    return { phase: 'idle', phaseProgress: 0, overallProgress: 0 };
  }
  return current;
}

function shouldPromoteTaskStatusFromPlan(task: Task, plan: ImplementationPlan): boolean {
  return (task.status === 'backlog' || task.status === 'queue') && isActivePlanStatus(plan);
}

function shouldReopenCompletedTaskFromActivePlan(task: Task, activePlanPhase: ExecutionPhase | undefined): boolean {
  return isCompletedTerminalTask(task) && activePlanPhase !== undefined;
}

function taskTimestamp(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
}

function isInactiveIncomingStatus(status: TaskStatus): boolean {
  return status === 'backlog' || status === 'queue';
}

function hasActiveExecutionProgress(task: Task): boolean {
  const phase = task.executionProgress?.phase;
  return Boolean(phase && phase !== 'idle' && phase !== 'complete' && phase !== 'failed' && phase !== 'stopped');
}

function isLocallyActiveTask(task: Task): boolean {
  return task.status === 'in_progress' || task.status === 'ai_review' || hasActiveExecutionProgress(task);
}

function taskHasNonPendingSubtasks(task: Task): boolean {
  return task.subtasks.some((subtask) => subtask.status !== 'pending');
}

function shouldPreserveLocalActiveTask(previousTask: Task | undefined, incomingTask: Task): previousTask is Task {
  if (!previousTask || !isLocallyActiveTask(previousTask) || !isInactiveIncomingStatus(incomingTask.status)) {
    return false;
  }

  const previousUpdatedAt = taskTimestamp(previousTask.updatedAt);
  const incomingUpdatedAt = taskTimestamp(incomingTask.updatedAt);
  const localHasRecentActivity =
    hasRecentActivity(previousTask.id, previousTask.projectId) ||
    hasRecentActivity(previousTask.specId, previousTask.projectId);

  return localHasRecentActivity || previousUpdatedAt >= incomingUpdatedAt;
}

function mergeTaskWithLocalState(incomingTask: Task, previousTask?: Task): Task {
  let mergedTask: Task = previousTask?.tokenUsage
    ? {
        ...incomingTask,
        tokenUsage: incomingTask.tokenUsage
          ? mergeTokenUsageForTask(previousTask.tokenUsage, incomingTask.tokenUsage)
          : previousTask.tokenUsage
      }
    : incomingTask;

  if (!shouldPreserveLocalActiveTask(previousTask, incomingTask)) {
    return mergedTask;
  }

  const previousHasSubtaskActivity = taskHasNonPendingSubtasks(previousTask);
  const incomingHasSubtaskActivity = taskHasNonPendingSubtasks(incomingTask);
  const previousLogs = previousTask.logs ?? [];
  const incomingLogs = incomingTask.logs ?? [];

  mergedTask = {
    ...mergedTask,
    status: previousTask.status,
    reviewReason: previousTask.reviewReason,
    executionProgress: previousTask.executionProgress ?? mergedTask.executionProgress,
    updatedAt: previousTask.updatedAt,
    subtasks: previousHasSubtaskActivity && !incomingHasSubtaskActivity
      ? previousTask.subtasks
      : mergedTask.subtasks,
    logs: previousLogs.length > incomingLogs.length
      ? previousLogs
      : mergedTask.logs,
  };

  debugWarn('[TaskStore.setTasks] Preserved active local task over stale inactive refresh:', {
    taskId: incomingTask.id,
    projectId: incomingTask.projectId,
    incomingStatus: incomingTask.status,
    preservedStatus: previousTask.status,
    preservedPhase: previousTask.executionProgress?.phase,
  });

  return mergedTask;
}

function appendMissingActiveLocalTasks(incomingTasks: Task[], projectId: string, previousTasks: Task[]): Task[] {
  const incomingIds = new Set<string>();
  for (const task of incomingTasks) {
    incomingIds.add(`${task.projectId}:${task.id}`);
    incomingIds.add(`${task.projectId}:${task.specId}`);
  }

  const preservedTasks = previousTasks.filter((task) => {
    if (task.projectId !== projectId || !isLocallyActiveTask(task)) {
      return false;
    }
    return !incomingIds.has(`${task.projectId}:${task.id}`) &&
      !incomingIds.has(`${task.projectId}:${task.specId}`);
  });

  if (preservedTasks.length > 0) {
    debugWarn('[TaskStore.loadTasks] Preserved active local task(s) missing from refresh:', {
      projectId,
      taskIds: preservedTasks.map((task) => task.id),
    });
  }

  return preservedTasks.length > 0 ? [...incomingTasks, ...preservedTasks] : incomingTasks;
}

// localStorage key prefix for task order persistence
const TASK_ORDER_KEY_PREFIX = 'task-order-state';

/**
 * Get the localStorage key for a project's task order
 */
function getTaskOrderKey(projectId: string): string {
  return `${TASK_ORDER_KEY_PREFIX}-${projectId}`;
}

function isTaskAlreadyMissingError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return normalized.includes('not found') || normalized.includes('already removed');
}

function removeTaskFromLocalState(taskId: string, projectId?: string): void {
  useTaskStore.setState((state) => {
    const nextTasks = state.tasks.filter((task) => !matchesTaskId(task, taskId, projectId));
    const selectedTask = state.tasks.find((t) => t.id === state.selectedTaskId);
    const shouldClearSelection = selectedTask
      ? matchesTaskId(selectedTask, taskId, projectId)
      : false;

    return {
      tasks: nextTasks,
      ...(shouldClearSelection ? { selectedTaskId: null } : {})
    };
  });
}

/**
 * Create an empty task order state with all status columns
 */
function createEmptyTaskOrder(): TaskOrderState {
  return {
    backlog: [],
    queue: [],
    in_progress: [],
    ai_review: [],
    human_review: [],
    done: [],
    pr_created: [],
    error: []
  };
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  isLoading: false,
  error: null,
  taskOrder: null,

  setTasks: (tasks) => {
    const previousTasks = get().tasks;
    const previousTaskMap = new Map<string, Task>();
    for (const task of previousTasks) {
      previousTaskMap.set(`${task.projectId}:${task.id}`, task);
      previousTaskMap.set(`${task.projectId}:${task.specId}`, task);
    }

    const mergedTasks = tasks.map((task) => {
      const previousTask =
        previousTaskMap.get(`${task.projectId}:${task.id}`) ??
        previousTaskMap.get(`${task.projectId}:${task.specId}`);

      return mergeTaskWithLocalState(task, previousTask);
    });

    cacheTaskGroups(mergedTasks);

    debugLog('[TaskStore.setTasks] Hydrating tasks:', {
      count: mergedTasks.length,
      taskIds: mergedTasks.map(t => ({
        id: t.id,
        status: t.status,
        logCount: t.logs?.length || 0,
        hasExecutionProgress: !!t.executionProgress,
        phase: t.executionProgress?.phase
      }))
    });

    // Log detailed info for each task with logs
    mergedTasks.forEach(task => {
      if (task.logs && task.logs.length > 0) {
        debugLog(`[TaskStore.setTasks] Task ${task.id} has ${task.logs.length} logs:`, {
          firstLogPreview: task.logs[0]?.substring(0, 100),
          lastLogPreview: task.logs[task.logs.length - 1]?.substring(0, 100)
        });
      }
    });

    return set({ tasks: mergedTasks });
  },

  addTask: (task) =>
    set((state) => {
      // Determine which column the task belongs to based on its status
      const status = task.status || 'backlog';

      // Update task order if it exists - new tasks go to top of their column
      let taskOrder = state.taskOrder;
      if (taskOrder) {
        const newTaskOrder = { ...taskOrder };

        // Add task ID to the top of the appropriate column
        if (newTaskOrder[status]) {
          // Ensure the task isn't already in the array (safety check)
          newTaskOrder[status] = newTaskOrder[status].filter(id => id !== task.id);
          // Add to top (index 0)
          newTaskOrder[status] = [task.id, ...newTaskOrder[status]];
        } else {
          // Initialize column order array if it doesn't exist
          newTaskOrder[status] = [task.id];
        }

        taskOrder = newTaskOrder;
      }

      invalidateTaskCache(task.projectId);

      return {
        tasks: [...state.tasks, task],
        taskOrder
      };
    }),

  updateTask: (taskId, updates, projectId) =>
    set((state) => {
      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) return state;

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => ({ ...t, ...updates }))
      };
    }),

  updateTaskStatus: (taskId, status, reviewReason, projectId) => {
    // Capture old status before update
    const state = get();
    const index = findTaskIndex(state.tasks, taskId, projectId);
    if (index === -1) {
      debugLog('[updateTaskStatus] Task not found:', taskId);
      return;
    }
    const oldTask = state.tasks[index];
    const oldStatus = oldTask.status;
    const resolvedProjectId = oldTask.projectId;
    // Record activity for stuck detection - status changes prove the task is alive.
    recordTaskActivity(taskId, resolvedProjectId);
    invalidateTaskCache(resolvedProjectId);

    const needsInProgressRefresh = status === 'in_progress' && isInactiveOrTerminalExecutionPhase(oldTask.executionProgress?.phase);

    // Skip if status AND reviewReason are the same, unless the stored progress is stale for an active restart.
    if (oldStatus === status && oldTask.reviewReason === reviewReason && !needsInProgressRefresh) {
      debugLog('[updateTaskStatus] Status and reviewReason unchanged, skipping:', { taskId, status, reviewReason });
      return;
    }

    debugLog('[updateTaskStatus] START:', {
      taskId,
      oldStatus,
      newStatus: status,
      allInProgress: state.tasks.filter(t => t.status === 'in_progress' && !t.metadata?.archivedAt).map(t => t.id)
    });

    // Perform the state update
    set((state) => {
      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => {
          // Determine execution progress based on status transition
          let executionProgress = t.executionProgress;

          // Track status transition for debugging flip-flop issues
          const previousStatus = t.status;
          const statusChanged = previousStatus !== status;

          executionProgress = getExecutionProgressForStatus(status, reviewReason, t.executionProgress);

          // Log status transitions to help diagnose flip-flop issues
          debugLog('[updateTaskStatus] Status transition:', {
            taskId,
            previousStatus,
            newStatus: status,
            statusChanged,
            currentPhase: t.executionProgress?.phase,
            newPhase: executionProgress?.phase
          });

          return { ...t, status, reviewReason, executionProgress, updatedAt: new Date() };
        })
      };
    });

    // Notify listeners after state update (schedule after current tick)
    queueMicrotask(() => {
      notifyTaskStatusChange(taskId, oldStatus, status, resolvedProjectId);
    });
  },

  updateTaskFromPlan: (taskId, plan, projectId) =>
    set((state) => {
      // FIX (PR Review): Gate debug logging to prevent production console clutter
      debugLog('[updateTaskFromPlan] called with plan:', {
        taskId,
        feature: plan.feature,
        phases: plan.phases?.length || 0,
        totalSubtasks: plan.phases?.reduce((acc, p) => acc + (p.subtasks?.length || 0), 0) || 0
        // Note: planData removed to avoid verbose output in logs
      });

      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) {
        debugLog('[updateTaskFromPlan] Task not found:', taskId);
        return state;
      }
      invalidateTaskCache(state.tasks[index].projectId);

      // Validate plan data before processing
      if (!validatePlanData(plan)) {
        console.error('[updateTaskFromPlan] Invalid plan data, skipping update:', {
          taskId,
          plan
        });
        return state;
      }

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => {
          const subtasks: Subtask[] = plan.phases.flatMap((phase) =>
            phase.subtasks.map((subtask) => {
              // Ensure all required fields have valid values to prevent UI issues
              // Use crypto.randomUUID() for stronger randomness when available
              const id = subtask.id || (typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `subtask-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
              const title = subtask.title;
              const description = subtask.description;
              const status = (subtask.status as SubtaskStatus) || 'pending';
              const durationMs = subtask.duration_ms ?? subtask.durationMs;

              return {
                id,
                title,
                description,
                completionSummary: getPlanSubtaskCompletionSummary(subtask),
                ...(subtask.started_at ? { startedAt: subtask.started_at } : {}),
                ...(subtask.active_started_at ? { activeStartedAt: subtask.active_started_at } : {}),
                ...(subtask.completed_at ? { completedAt: subtask.completed_at } : {}),
                ...(subtask.updated_at ? { updatedAt: subtask.updated_at } : {}),
                ...(typeof durationMs === 'number' ? { durationMs } : {}),
                status,
                files: [
                  ...(subtask.files_to_create ?? []),
                  ...(subtask.files_to_modify ?? []),
                  ...(subtask.pattern_files ?? []),
                ],
                ...(subtask.depends_on && subtask.depends_on.length > 0 ? { dependsOn: subtask.depends_on } : {}),
                ...(subtask.work_package === true ? { workPackage: true } : {}),
                ...(subtask.upstream_task_ids && subtask.upstream_task_ids.length > 0 ? { upstreamTaskIds: subtask.upstream_task_ids } : {}),
                ...(subtask.upstream_source ? { upstreamSource: subtask.upstream_source } : {}),
                verification: subtask.verification as Subtask['verification']
              };
            })
          );

          debugLog('[updateTaskFromPlan] Created subtasks:', {
            taskId,
            subtaskCount: subtasks.length,
            subtasks: subtasks.map(s => ({
              id: s.id,
              title: s.title,
              status: s.status
            }))
          });

          // Diagnostic: always log when non-pending subtask statuses arrive.
          // Helps trace whether real-time plan updates reach the store correctly.
          const completedCount = subtasks.filter(s => s.status === 'completed').length;
          if (completedCount > 0) {
            debugWarn(`[updateTaskFromPlan] Task ${taskId}: ${completedCount}/${subtasks.length} subtasks completed`);
          }

          // NOTE: We do not generally update status or title from plan anymore.
          // XState is the source of truth for active transitions - it emits TASK_STATUS_CHANGE.
          // The task metadata/spec title is the source of truth for the user-facing title.
          // Plan updates only update subtasks/execution fields, with narrow fallbacks for
          // missed IPC: active plan can promote backlog/queue or reopen completed
          // review, terminal plan can clear a
          // stale blue/running state after Direct/CLI completion.
          const activePlanPhase = getActiveExecutionPhaseFromPlan(plan);
          const planReviewState = getPlanReviewStateFromPlan(plan);
          const shouldReopenCompletedTask = shouldReopenCompletedTaskFromActivePlan(t, activePlanPhase);
          const terminalState = shouldReopenCompletedTask || planReviewState
            ? undefined
            : getTerminalTaskStateFromPlan(plan);
          const shouldPromoteStatus = shouldReopenCompletedTask || shouldPromoteTaskStatusFromPlan(t, plan);
          const nextStatus = planReviewState?.status ?? terminalState?.status ?? (shouldPromoteStatus ? 'in_progress' : t.status);
          const nextReviewReason = planReviewState?.reviewReason ?? (terminalState
            ? terminalState.reviewReason
            : nextStatus === t.status && !shouldReopenCompletedTask
              ? t.reviewReason
              : undefined);
          const executionProgressTask = shouldPromoteStatus
            ? {
                ...t,
                status: nextStatus as TaskStatus,
                reviewReason: nextReviewReason,
                executionProgress: shouldReopenCompletedTask ? undefined : t.executionProgress,
              }
            : t;
          const planExplicitlyRestartedPlanning = nextStatus === 'in_progress' && activePlanPhase === 'planning';
          let executionProgress = planReviewState?.executionProgress ?? terminalState?.executionProgress ?? (planExplicitlyRestartedPlanning
            ? buildExecutionProgressForPlanPhase(executionProgressTask, 'planning')
            : promoteExecutionPhaseFromPlan(executionProgressTask, subtasks));

          if (shouldPromoteStatus && (!executionProgress || executionProgress.phase === 'idle')) {
            executionProgress = {
              phase: activePlanPhase ?? 'planning',
              phaseProgress: shouldReopenCompletedTask ? 0 : (t.executionProgress?.phaseProgress ?? 0),
              overallProgress: shouldReopenCompletedTask ? 0 : (t.executionProgress?.overallProgress ?? 0),
              currentSubtask: shouldReopenCompletedTask ? undefined : t.executionProgress?.currentSubtask,
              message: shouldReopenCompletedTask ? undefined : t.executionProgress?.message,
              startedAt: shouldReopenCompletedTask ? undefined : t.executionProgress?.startedAt,
              sequenceNumber: shouldReopenCompletedTask ? undefined : t.executionProgress?.sequenceNumber,
              completedPhases: shouldReopenCompletedTask ? undefined : t.executionProgress?.completedPhases,
            };
          }

          return {
            ...t,
            status: nextStatus,
            reviewReason: nextReviewReason,
            subtasks,
            ...(executionProgress ? { executionProgress } : {}),
            updatedAt: new Date()
          };
        })
      };
    }),

  updateExecutionProgress: (taskId, progress, projectId) => {
    set((state) => {
      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) return state;
      recordTaskActivity(taskId, state.tasks[index].projectId);
      invalidateTaskCache(state.tasks[index].projectId);

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => {
          const existingProgress = t.executionProgress || {
            phase: 'idle' as ExecutionPhase,
            phaseProgress: 0,
            overallProgress: 0,
            sequenceNumber: 0
          };

          const incomingSeq = progress.sequenceNumber ?? 0;
          const currentSeq = existingProgress.sequenceNumber ?? 0;
          if (incomingSeq > 0 && currentSeq > 0 && incomingSeq < currentSeq) {
            // FIX (ACS-55): Log when updates are dropped due to sequence numbers
            // This helps debug phase transition issues
            console.warn('[updateExecutionProgress] Dropping out-of-order update:', {
              taskId,
              incomingSeq,
              currentSeq,
              incomingPhase: progress.phase,
              currentPhase: existingProgress.phase
            });
            return t; // Skip out-of-order update
          }

          const currentPhase = existingProgress.phase;
          const nextPhase = progress.phase;
          const allowPhaseRegression = progress.allowPhaseRegression === true;
          if (
            t.status === 'human_review' &&
            t.reviewReason === 'stopped' &&
            nextPhase &&
            nextPhase !== 'stopped' &&
            nextPhase !== 'idle'
          ) {
            console.warn('[updateExecutionProgress] Dropping active phase update for stopped task:', {
              taskId,
              nextPhase,
              status: t.status,
              reviewReason: t.reviewReason
            });
            return t;
          }
          const isTerminalTaskState =
            t.status === 'done' ||
            t.status === 'pr_created' ||
            t.status === 'error' ||
            (t.status === 'human_review' &&
              (t.reviewReason === 'completed' || t.reviewReason === 'errors' || t.reviewReason === 'qa_rejected'));
          if (
            isTerminalTaskState &&
            (currentPhase === 'complete' || currentPhase === 'failed') &&
            nextPhase &&
            nextPhase !== currentPhase &&
            !allowPhaseRegression
          ) {
            console.warn('[updateExecutionProgress] Dropping non-terminal update after terminal task state:', {
              taskId,
              currentPhase,
              nextPhase,
              status: t.status,
              reviewReason: t.reviewReason
            });
            return t;
          }
          if (
            currentPhase &&
            nextPhase &&
            currentPhase !== nextPhase &&
            incomingSeq === 0 &&
            wouldPhaseRegress(currentPhase, nextPhase) &&
            !isAllowedPhaseRegression(currentPhase, nextPhase) &&
            !allowPhaseRegression
          ) {
            console.warn('[updateExecutionProgress] Dropping regressive phase update without sequence number:', {
              taskId,
              currentPhase,
              nextPhase
            });
            return t;
          }

          // Only update updatedAt on phase transitions (not on every progress tick)
          // This prevents unnecessary re-renders from the memo comparator
          const phaseChanged = progress.phase && progress.phase !== existingProgress.phase;
          const {
            allowPhaseRegression: _allowPhaseRegression,
            ...progressFields
          } = progress;

          return {
            ...t,
            executionProgress: {
              ...existingProgress,
              ...progressFields
            },
            // Only set updatedAt on phase changes to reduce re-renders
            ...(phaseChanged ? { updatedAt: new Date() } : {})
          };
        })
      };
    });
  },

  updateTaskTokenUsage: (taskId, usage, projectId) => {
    debugLog(`[TaskStore.updateTaskTokenUsage] Called for ${taskId}:`, usage);

    set((state) => {
      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) {
        debugWarn(`[TaskStore.updateTaskTokenUsage] Task not found: ${taskId}`);
        return state;
      }
      recordTaskActivity(taskId, state.tasks[index].projectId);

      const previousUsage = state.tasks[index].tokenUsage;
      const mergedUsage = mergeTokenUsageForTask(previousUsage, usage);

      debugLog(`[TaskStore.updateTaskTokenUsage] Merging for ${taskId}:`, {
        previous: previousUsage,
        incoming: usage,
        merged: mergedUsage
      });

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => ({
          ...t,
          tokenUsage: mergedUsage
        }))
      };
    });
  },

  appendLog: (taskId, log, projectId) =>
    set((state) => {
      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) {
        debugWarn('[TaskStore.appendLog] Task not found:', taskId);
        return state;
      }

      const currentLogCount = state.tasks[index].logs?.length || 0;
      debugLog('[TaskStore.appendLog] Appending log:', {
        taskId,
        currentLogCount,
        newLogCount: currentLogCount + 1,
        logPreview: log.substring(0, 100)
      });

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => ({
          ...t,
          logs: [...(t.logs || []), log].slice(-MAX_LOG_ENTRIES)
        }))
      };
    }),

  // Batch append multiple logs at once (single state update instead of N updates)
  batchAppendLogs: (taskId, logs, projectId) => {
    // Record activity for stuck detection - log output proves the task is alive
    return set((state) => {
      if (logs.length === 0) {
        debugLog('[TaskStore.batchAppendLogs] No logs to append for task:', taskId);
        return state;
      }
      const index = findTaskIndex(state.tasks, taskId, projectId);
      if (index === -1) {
        debugWarn('[TaskStore.batchAppendLogs] Task not found:', taskId);
        return state;
      }
      recordTaskActivity(taskId, state.tasks[index].projectId);

      const currentLogCount = state.tasks[index].logs?.length || 0;
      const newLogCount = currentLogCount + logs.length;
      debugLog('[TaskStore.batchAppendLogs] Batch appending logs:', {
        taskId,
        currentLogCount,
        newLogsCount: logs.length,
        newLogCount,
        firstLogPreview: logs[0]?.substring(0, 100)
      });

      return {
        tasks: updateTaskAtIndex(state.tasks, index, (t) => ({
          ...t,
          logs: [...(t.logs || []), ...logs].slice(-MAX_LOG_ENTRIES)
        }))
      };
    });
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  clearTasks: () => set({ tasks: [], selectedTaskId: null, taskOrder: null }),

  // Task order actions for kanban drag-and-drop reordering
  setTaskOrder: (order) => set({ taskOrder: order }),

  reorderTasksInColumn: (status, activeId, overId) => {
    set((state) => {
      if (!state.taskOrder) return state;

      const columnOrder = state.taskOrder[status];
      if (!columnOrder) return state;

      const oldIndex = columnOrder.indexOf(activeId);
      const newIndex = columnOrder.indexOf(overId);

      // Both tasks must be in the column order array
      if (oldIndex === -1 || newIndex === -1) return state;

      return {
        taskOrder: {
          ...state.taskOrder,
          [status]: arrayMove(columnOrder, oldIndex, newIndex)
        }
      };
    });
  },

  moveTaskToColumnTop: (taskId, targetStatus, sourceStatus) => {
    set((state) => {
      if (!state.taskOrder) return state;

      // Create a copy of the task order to modify
      const newTaskOrder = { ...state.taskOrder };

      // Remove from source column if provided
      if (sourceStatus && newTaskOrder[sourceStatus]) {
        newTaskOrder[sourceStatus] = newTaskOrder[sourceStatus].filter(id => id !== taskId);
      }

      // Add to top of target column
      if (newTaskOrder[targetStatus]) {
        // Remove from target column first (in case it already exists there)
        newTaskOrder[targetStatus] = newTaskOrder[targetStatus].filter(id => id !== taskId);
        // Add to top (index 0)
        newTaskOrder[targetStatus] = [taskId, ...newTaskOrder[targetStatus]];
      } else {
        // Initialize column order array if it doesn't exist
        newTaskOrder[targetStatus] = [taskId];
      }

      return { taskOrder: newTaskOrder };
    });
  },

  loadTaskOrder: (projectId) => {
    try {
      const key = getTaskOrderKey(projectId);
      debugLog('[TaskStore.loadTaskOrder] Loading task order:', { projectId, key });
      const stored = localStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Validate structure before assigning - type assertion is compile-time only
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          debugWarn('[TaskStore.loadTaskOrder] Invalid task order data in localStorage, resetting to empty');
          set({ taskOrder: createEmptyTaskOrder() });
          return;
        }

        // Helper to validate column values are string arrays
        const isValidColumnArray = (val: unknown): val is string[] =>
          Array.isArray(val) && val.every(item => typeof item === 'string');

        // Merge with empty order to handle partial data and validate each column
        const emptyOrder = createEmptyTaskOrder();
        const validatedOrder: TaskOrderState = {
          backlog: isValidColumnArray(parsed.backlog) ? parsed.backlog : emptyOrder.backlog,
          queue: isValidColumnArray(parsed.queue) ? parsed.queue : emptyOrder.queue,
          in_progress: isValidColumnArray(parsed.in_progress) ? parsed.in_progress : emptyOrder.in_progress,
          ai_review: isValidColumnArray(parsed.ai_review) ? parsed.ai_review : emptyOrder.ai_review,
          human_review: isValidColumnArray(parsed.human_review) ? parsed.human_review : emptyOrder.human_review,
          done: isValidColumnArray(parsed.done) ? parsed.done : emptyOrder.done,
          pr_created: isValidColumnArray(parsed.pr_created) ? parsed.pr_created : emptyOrder.pr_created,
          error: isValidColumnArray(parsed.error) ? parsed.error : emptyOrder.error
        };

        debugLog('[TaskStore.loadTaskOrder] Loaded task order:', {
          projectId,
          columnCounts: Object.entries(validatedOrder).map(([col, ids]) => ({ col, count: ids.length }))
        });
        set({ taskOrder: validatedOrder });
      } else {
        debugLog('[TaskStore.loadTaskOrder] No stored task order found, using empty order');
        set({ taskOrder: createEmptyTaskOrder() });
      }
    } catch (error) {
      debugWarn('[TaskStore.loadTaskOrder] Failed to load task order:', error);
      set({ taskOrder: createEmptyTaskOrder() });
    }
  },

  saveTaskOrder: (projectId) => {
    try {
      const state = get();
      if (!state.taskOrder) {
        // Nothing to save - return false to indicate no save occurred
        return false;
      }

      const key = getTaskOrderKey(projectId);
      localStorage.setItem(key, JSON.stringify(state.taskOrder));
      return true;
    } catch (error) {
      console.error('Failed to save task order:', error);
      return false;
    }
  },

  clearTaskOrder: (projectId) => {
    try {
      const key = getTaskOrderKey(projectId);
      localStorage.removeItem(key);
      set({ taskOrder: null });
    } catch (error) {
      console.error('Failed to clear task order:', error);
    }
  },

  getSelectedTask: () => {
    const state = get();
    return state.tasks.find((t) => t.id === state.selectedTaskId);
  },

  getTasksByStatus: (status) => {
    const state = get();
    return state.tasks.filter((t) => t.status === status);
  },

  registerTaskStatusChangeListener: (listener) => {
    taskStatusChangeListeners.add(listener);
    // Return cleanup function to unregister
    return () => {
      taskStatusChangeListeners.delete(listener);
    };
  }
}));

/**
 * Load tasks for a project
 * @param projectId - The project ID to load tasks for
 * @param options - Optional parameters
 * @param options.forceRefresh - If true, invalidates server-side cache before fetching (for refresh button)
 * @param options.preferCache - If true, paints a fresh renderer cache before fetching
 * @param options.backgroundRefresh - If true with a cache hit, refreshes without showing a loading state
 * @param options.deferRemoteMs - Optional delay before IPC, allowing project tab UI to render first
 */
export async function loadTasks(projectId: string, options?: LoadTasksOptions): Promise<void> {
  const store = useTaskStore.getState();
  const loadSequence = nextTaskLoadSequence(projectId);
  const forceRefresh = options?.forceRefresh === true;
  const cachedTasks = !forceRefresh && options?.preferCache ? getCachedTasks(projectId) : null;
  const canApplyInitialState = shouldApplyTaskLoad(projectId, loadSequence);
  const shouldShowLoading = !cachedTasks || !options?.backgroundRefresh;

  if (forceRefresh) {
    taskCacheByProject.delete(projectId);
  }

  if (canApplyInitialState) {
    store.setError(null);

    if (cachedTasks) {
      store.setTasks(cachedTasks);
      if (!shouldShowLoading) {
        store.setLoading(false);
      }
    } else if (options?.preferCache) {
      store.clearTasks();
    }

    if (shouldShowLoading) {
      store.setLoading(true);
    }
  }

  if (cachedTasks && !options?.backgroundRefresh) {
    debugLog('[TaskStore.loadTasks] Served tasks from renderer cache:', {
      projectId,
      taskCount: cachedTasks.length
    });
    return;
  }

  debugLog('[TaskStore.loadTasks] Loading tasks for project:', {
    projectId,
    forceRefresh,
    preferCache: options?.preferCache || false,
    backgroundRefresh: options?.backgroundRefresh || false,
    deferRemoteMs: options?.deferRemoteMs || 0,
    currentTaskCount: store.tasks.length
  });

  try {
    if (options?.deferRemoteMs && options.deferRemoteMs > 0 && !forceRefresh) {
      await delay(options.deferRemoteMs);
      if (!shouldApplyTaskLoad(projectId, loadSequence)) {
        debugLog('[TaskStore.loadTasks] Skipping deferred task load for non-visible project:', {
          projectId,
          loadSequence,
          visibleProjectId: getVisibleTaskProjectId(),
        });
        return;
      }
    }

    const ipcOptions = forceRefresh ? { forceRefresh: true } : undefined;
    const result = await window.electronAPI.getTasks(projectId, ipcOptions);

    debugLog('[TaskStore.loadTasks] Received result from IPC:', {
      success: result.success,
      dataPresent: !!result.data,
      taskCount: result.data?.length || 0,
      error: result.error
    });

    if (!shouldApplyTaskLoad(projectId, loadSequence)) {
      debugLog('[TaskStore.loadTasks] Ignoring stale or non-visible task load result:', {
        projectId,
        loadSequence,
        visibleProjectId: getVisibleTaskProjectId(),
        latestSequence: taskLoadSequencesByProject.get(projectId)
      });
      return;
    }

    if (result.success && result.data) {
      const tasksForStore = appendMissingActiveLocalTasks(
        result.data,
        projectId,
        useTaskStore.getState().tasks,
      );
      debugLog('[TaskStore.loadTasks] Tasks loaded successfully:', {
        count: tasksForStore.length,
        tasksWithLogs: tasksForStore.filter(t => t.logs && t.logs.length > 0).length,
        totalLogCount: tasksForStore.reduce((sum, t) => sum + (t.logs?.length || 0), 0)
      });
      store.setTasks(tasksForStore);
    } else {
      debugWarn('[TaskStore.loadTasks] Failed to load tasks:', result.error);
      store.setError(result.error || 'Failed to load tasks');
    }
  } catch (error) {
    if (shouldApplyTaskLoad(projectId, loadSequence)) {
      debugWarn('[TaskStore.loadTasks] Exception while loading tasks:', error);
      store.setError(error instanceof Error ? error.message : 'Unknown error');
    }
  } finally {
    if (shouldApplyTaskLoad(projectId, loadSequence)) {
      store.setLoading(false);
    }
  }
}

/**
 * Create a new task
 */
export async function createTask(
  projectId: string,
  title: string,
  description: string,
  metadata?: TaskMetadata
): Promise<Task | null> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.createTask(projectId, title, description, metadata);
    if (result.success && result.data) {
      store.addTask(result.data);
      return result.data;
    } else {
      store.setError(result.error || 'Failed to create task');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Create a project documentation task.
 */
export async function createProjectDocumentationTask(
  projectId: string,
  options: { documentType?: ProjectDocumentType; outputDir?: string; language?: string } = {}
): Promise<Task | null> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.createProjectDocumentationTask(projectId, options);
    if (result.success && result.data) {
      store.addTask(result.data);
      return result.data;
    }

    store.setError(result.error || 'Failed to create project documentation task');
    return null;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Start a task
 */
export function startTask(taskId: string, options?: TaskStartOptions): void {
  const store = useTaskStore.getState();
  const task = findTaskInStore(store.tasks, taskId, options?.projectId);
  const projectId = options?.projectId ?? task?.projectId;

  if (task && projectId) {
    invalidateTaskCache(projectId);
    if (task.status !== 'in_progress') {
      store.updateTaskStatus(taskId, 'in_progress', undefined, projectId);
    }

    const currentPhase = task.executionProgress?.phase;
    if (!currentPhase || currentPhase === 'idle' || currentPhase === 'complete' || currentPhase === 'failed') {
      store.updateExecutionProgress(
        taskId,
        {
          phase: 'planning',
          phaseProgress: 0,
          overallProgress: 0,
        },
        projectId,
      );
    }
  }

  window.electronAPI.startTask(
    taskId,
    projectId ? { ...options, projectId } : options
  );
}

/**
 * Stop a task
 */
export function stopTask(taskId: string, projectId?: string): void {
  const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
  window.electronAPI.stopTask(taskId, projectId ?? task?.projectId);
}

/**
 * Submit review for a task
 */
export async function submitReview(
  taskId: string,
  approved: boolean,
  feedback?: string,
  images?: ImageAttachment[],
  projectId?: string
): Promise<boolean> {
  try {
    const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
    const resolvedProjectId = projectId ?? task?.projectId;
    const result = await window.electronAPI.submitReview(taskId, approved, feedback, images, resolvedProjectId);
    if (result.success) {
      if (resolvedProjectId) {
        await loadTasks(resolvedProjectId, { forceRefresh: true });
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Result type for persistTaskStatus with worktree info
 */
export interface PersistStatusResult {
  success: boolean;
  worktreeExists?: boolean;
  worktreePath?: string;
  error?: string;
}

/**
 * Update task status and persist to file
 * Returns additional info if a worktree exists and needs cleanup confirmation
 */
export async function persistTaskStatus(
  taskId: string,
  status: TaskStatus,
  options?: { forceCleanup?: boolean; keepWorktree?: boolean; projectId?: string }
): Promise<PersistStatusResult> {
  const store = useTaskStore.getState();
  const task = findTaskInStore(store.tasks, taskId, options?.projectId);
  const projectId = options?.projectId ?? task?.projectId;

  try {
    // Persist to file first (don't optimistically update for 'done' status)
    const result = await window.electronAPI.updateTaskStatus(
      taskId,
      status,
      projectId ? { ...options, projectId } : options
    );

    if (!result.success) {
      // Check if this is a worktree exists case
      if (result.worktreeExists) {
        debugLog('[persistTaskStatus] Worktree exists, confirmation needed');
        return {
          success: false,
          worktreeExists: true,
          worktreePath: result.worktreePath,
          error: result.error
        };
      }
      console.error('Failed to persist task status:', result.error);
      return { success: false, error: result.error };
    }

    // Only update local state after backend confirms success
    store.updateTaskStatus(taskId, status, undefined, projectId);
    return { success: true };
  } catch (error) {
    console.error('Error persisting task status:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Force complete a task by cleaning up its worktree
 * Used when user confirms they want to delete the worktree and mark as done
 * Returns full result including error details for better UX
 */
export async function forceCompleteTask(taskId: string, projectId?: string): Promise<PersistStatusResult> {
  return persistTaskStatus(taskId, 'done', projectId ? { forceCleanup: true, projectId } : { forceCleanup: true });
}

/**
 * Check if the in_progress queue is at capacity.
 * @param excludeTaskId - Task ID to exclude from the count (e.g., when restarting a stuck task already in in_progress)
 */
export function isQueueAtCapacity(excludeTaskId?: string, projectId?: string): boolean {
  const resolvedProjectId = projectId ?? (excludeTaskId ? resolveTaskProjectId(excludeTaskId) : undefined);
  const projectStore = useProjectStore.getState();
  const project = resolvedProjectId
    ? projectStore.projects.find((entry) => entry.id === resolvedProjectId)
    : projectStore.getActiveProject() ?? projectStore.getSelectedProject();
  const maxParallelTasks = project?.settings?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
  const currentTasks = useTaskStore.getState().tasks;
  const inProgressCount = currentTasks.filter((t) =>
    t.status === 'in_progress' &&
    !t.metadata?.archivedAt &&
    (!resolvedProjectId || t.projectId === resolvedProjectId) &&
    (!excludeTaskId || (t.id !== excludeTaskId && t.specId !== excludeTaskId))
  ).length;
  return inProgressCount >= maxParallelTasks;
}

export interface StartTaskOrQueueResult {
  /** Whether the task was started ('started') or redirected to queue ('queued') */
  action: 'started' | 'queued';
  success: boolean;
  error?: string;
}

function shouldRecoverBeforeRestart(task: Task | undefined): boolean {
  return task?.status === 'error' ||
    (task?.status === 'human_review' &&
      (task.reviewReason === 'stopped' || task.reviewReason === 'errors'));
}

/**
 * Start a task or queue it if parallel task capacity is full.
 * If the task is already in_progress (stuck restart), it is excluded from the
 * capacity count so restarting is always allowed.
 * Returns a result so callers can provide user-facing feedback.
 *
 * For ordinary starts, success indicates the IPC start command was dispatched.
 * For stopped/error restarts, success reflects the recover-and-restart IPC result.
 */
export async function startTaskOrQueue(taskId: string, projectId?: string): Promise<StartTaskOrQueueResult> {
  const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
  const resolvedProjectId = projectId ?? task?.projectId;
  // Exclude this task from the capacity check when it's already in_progress (stuck restart)
  const excludeId = task?.status === 'in_progress' ? taskId : undefined;

  if (isQueueAtCapacity(excludeId, resolvedProjectId)) {
    const result = await persistTaskStatus(
      taskId,
      'queue',
      resolvedProjectId ? { projectId: resolvedProjectId } : undefined
    );
    if (!result.success) {
      console.error('[Queue] Failed to queue task:', taskId, result.error);
      return { action: 'queued', success: false, error: result.error };
    }
    return { action: 'queued', success: true };
  }

  if (shouldRecoverBeforeRestart(task)) {
    const result = await recoverStuckTask(
      taskId,
      {
        autoRestart: true,
        ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      },
    );
    return result.success
      ? { action: 'started', success: true }
      : { action: 'started', success: false, error: result.message };
  }

  startTask(taskId, resolvedProjectId ? { projectId: resolvedProjectId } : undefined);
  return { action: 'started', success: true };
}

/**
 * Update task title/description/metadata and persist to file
 */
export async function persistUpdateTask(
  taskId: string,
  updates: { title?: string; description?: string; metadata?: Partial<TaskMetadata> },
  projectId?: string
): Promise<boolean> {
  const store = useTaskStore.getState();
  const task = findTaskInStore(store.tasks, taskId, projectId);
  const resolvedProjectId = projectId ?? task?.projectId;

  try {
    // Call the IPC to persist changes to spec files
    const result = await window.electronAPI.updateTask(taskId, updates, resolvedProjectId);

    if (result.success && result.data) {
      // Update local state with the returned task data
      store.updateTask(taskId, {
        title: result.data.title,
        description: result.data.description,
        metadata: result.data.metadata,
        updatedAt: new Date()
      }, resolvedProjectId);
      return true;
    }

    console.error('Failed to persist task update:', result.error);
    return false;
  } catch (error) {
    console.error('Error persisting task update:', error);
    return false;
  }
}

/**
 * Delete a subtask from a task's implementation plan and update local state.
 */
export async function deleteSubtask(
  taskId: string,
  subtaskId: string,
  projectId?: string
): Promise<{ success: boolean; error?: string }> {
  const store = useTaskStore.getState();
  const task = findTaskInStore(store.tasks, taskId, projectId);
  const resolvedProjectId = projectId ?? task?.projectId;

  try {
    const result = await window.electronAPI.deleteSubtask(taskId, subtaskId, resolvedProjectId);

    if (result.success && result.data) {
      store.updateTask(taskId, {
        title: result.data.title,
        description: result.data.description,
        status: result.data.status,
        reviewReason: result.data.reviewReason,
        subtasks: result.data.subtasks,
        executionProgress: result.data.executionProgress,
        updatedAt: new Date()
      }, resolvedProjectId);
      return { success: true };
    }

    return {
      success: false,
      error: result.error || 'Failed to delete subtask'
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Check if a task has an active running process
 */
export async function checkTaskRunning(taskId: string, projectId?: string): Promise<boolean> {
  try {
    const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
    const result = await window.electronAPI.checkTaskRunning(taskId, projectId ?? task?.projectId);
    return result.success && result.data === true;
  } catch (error) {
    console.error('Error checking task running status:', error);
    return false;
  }
}

/**
 * Recover a stuck task (status shows in_progress but no process running)
 * @param taskId - The task ID to recover
 * @param options - Recovery options (autoRestart defaults to true)
 */
export async function recoverStuckTask(
  taskId: string,
  options: { targetStatus?: TaskStatus; autoRestart?: boolean; projectId?: string } = { autoRestart: true }
): Promise<{ success: boolean; message: string; autoRestarted?: boolean }> {
  try {
    const task = findTaskInStore(useTaskStore.getState().tasks, taskId, options.projectId);
    const projectId = options.projectId ?? task?.projectId;
    const result = await window.electronAPI.recoverStuckTask(
      taskId,
      projectId ? { ...options, projectId } : options
    );

    if (result.success && result.data) {
      if (projectId) {
        await loadTasks(projectId, { forceRefresh: true });
      }
      const autoRestartExpected = options.autoRestart !== false;
      if (autoRestartExpected && result.data.autoRestarted === false) {
        return {
          success: false,
          message: result.data.message,
          autoRestarted: false
        };
      }
      return {
        success: true,
        message: result.data.message,
        autoRestarted: result.data.autoRestarted
      };
    }

    return {
      success: false,
      message: result.error || 'Failed to recover task'
    };
  } catch (error) {
    console.error('Error recovering stuck task:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Delete a task and its spec directory
 */
export async function deleteTask(
  taskId: string,
  projectId?: string
): Promise<{ success: boolean; error?: string }> {
  const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
  const resolvedProjectId = projectId ?? task?.projectId;

  try {
    const result = await window.electronAPI.deleteTask(taskId, resolvedProjectId);
    const missingOnBackend = isTaskAlreadyMissingError(result.error);

    if (result.success || missingOnBackend) {
      clearTaskActivity(taskId, resolvedProjectId);
      removeTaskFromLocalState(taskId, resolvedProjectId);
      return { success: true };
    }

    return {
      success: false,
      error: result.error || 'Failed to delete task'
    };
  } catch (error) {
    console.error('Error deleting task:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Delete multiple tasks
 * Permanently removes tasks from the project
 */
export async function deleteTasks(
  taskIds: string[],
  projectId?: string
): Promise<{ success: boolean; error?: string; failedIds?: string[] }> {
  const failedIds: string[] = [];
  const deletedScopes: Array<{ taskId: string; projectId?: string }> = [];

  try {
    // Delete tasks one by one (API only supports single delete)
    for (const taskId of taskIds) {
      const task = findTaskInStore(useTaskStore.getState().tasks, taskId, projectId);
      const resolvedProjectId = projectId ?? task?.projectId;
      const result = await window.electronAPI.deleteTask(taskId, resolvedProjectId);
      if (!result.success && !isTaskAlreadyMissingError(result.error)) {
        failedIds.push(taskId);
      } else {
        deletedScopes.push({ taskId, projectId: resolvedProjectId });
      }
    }

    // Remove successfully deleted tasks from local state
    deletedScopes.forEach(({ taskId, projectId }) => clearTaskActivity(taskId, projectId));
    useTaskStore.setState((state) => {
      const nextTasks = state.tasks.filter((task) =>
        !deletedScopes.some((scope) => matchesTaskId(task, scope.taskId, scope.projectId))
      );
      const selectedTask = state.tasks.find((t) => t.id === state.selectedTaskId);
      const shouldClearSelection = selectedTask
        ? deletedScopes.some((scope) => matchesTaskId(selectedTask, scope.taskId, scope.projectId))
        : false;
      return {
        tasks: nextTasks,
        ...(shouldClearSelection ? { selectedTaskId: null } : {})
      };
    });

    if (failedIds.length > 0) {
      return {
        success: false,
        error: `Failed to delete ${failedIds.length} task(s)`,
        failedIds
      };
    }

    return { success: true };
  } catch (error) {
    console.error('Error deleting tasks:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Archive tasks
 * Marks tasks as archived by adding archivedAt timestamp to metadata
 */
export async function archiveTasks(
  projectId: string,
  taskIds: string[],
  version?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await window.electronAPI.archiveTasks(projectId, taskIds, version);

    if (result.success) {
      // Reload tasks to update the UI (archived tasks will be filtered out by default)
      await loadTasks(projectId);
      return { success: true };
    }

    return {
      success: false,
      error: result.error || 'Failed to archive tasks'
    };
  } catch (error) {
    console.error('Error archiving tasks:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ============================================
// Task Creation Draft Management
// ============================================

const DRAFT_KEY_PREFIX = 'task-creation-draft';

/**
 * Get the localStorage key for a project's draft
 */
function getDraftKey(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}-${projectId}`;
}

/**
 * Save a task creation draft to localStorage
 * Note: For large images, we only store thumbnails in the draft to avoid localStorage limits
 */
export function saveDraft(draft: TaskDraft): void {
  try {
    const key = getDraftKey(draft.projectId);
    // Create a copy with thumbnails only to avoid localStorage size limits
    const draftToStore = {
      ...draft,
      images: draft.images.map(img => ({
        ...img,
        data: undefined // Don't store full image data in localStorage
      })),
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(key, JSON.stringify(draftToStore));
  } catch (error) {
    console.error('Failed to save draft:', error);
  }
}

/**
 * Load a task creation draft from localStorage
 */
export function loadDraft(projectId: string): TaskDraft | null {
  try {
    const key = getDraftKey(projectId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;

    const draft = JSON.parse(stored);
    // Convert savedAt back to Date
    draft.savedAt = new Date(draft.savedAt);
    return draft as TaskDraft;
  } catch (error) {
    console.error('Failed to load draft:', error);
    return null;
  }
}

/**
 * Clear a task creation draft from localStorage
 */
export function clearDraft(projectId: string): void {
  try {
    const key = getDraftKey(projectId);
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to clear draft:', error);
  }
}

/**
 * Check if a draft exists for a project
 */
export function hasDraft(projectId: string): boolean {
  const key = getDraftKey(projectId);
  return localStorage.getItem(key) !== null;
}

/**
 * Check if a draft has any meaningful content (title, description, or images)
 */
export function isDraftEmpty(draft: TaskDraft | null): boolean {
  if (!draft) return true;
  return (
    !draft.title.trim() &&
    !draft.description.trim() &&
    draft.images.length === 0 &&
    !draft.category &&
    !draft.priority &&
    !draft.complexity &&
    !draft.impact &&
    (!draft.developmentMode || draft.developmentMode === 'standard')
  );
}

// ============================================
// GitHub Issue Linking Helpers
// ============================================

/**
 * Find a task by GitHub issue number
 * Used to check if a task already exists for a GitHub issue
 */
export function getTaskByGitHubIssue(issueNumber: number): Task | undefined {
  const store = useTaskStore.getState();
  return store.tasks.find(t => t.metadata?.githubIssueNumber === issueNumber);
}

// ============================================
// Task State Detection Helpers
// ============================================

/**
 * Check if a task is in human_review but has no completed subtasks.
 * This indicates the task crashed/exited before implementation completed
 * and should be resumed rather than reviewed.
 */
export function isIncompleteHumanReview(task: Task): boolean {
  if (task.status !== 'human_review') return false;

  // Any task with a known reviewReason was placed in human_review intentionally - not a crash.
  // Only tasks with NO reviewReason (or an unknown one) should be checked for incomplete subtasks.
  if (task.reviewReason) return false;

  // If no subtasks defined, task hasn't been planned yet (shouldn't be in human_review)
  if (!task.subtasks || task.subtasks.length === 0) return true;

  // Check if any subtasks are completed
  const completedSubtasks = task.subtasks.filter(s => s.status === 'completed').length;

  // If 0 completed subtasks, this task crashed before implementation
  return completedSubtasks === 0;
}

/**
 * Get the count of completed subtasks for a task
 */
export function getCompletedSubtaskCount(task: Task): number {
  if (!task.subtasks || task.subtasks.length === 0) return 0;
  return task.subtasks.filter(s => s.status === 'completed').length;
}

/**
 * Get task progress info
 */
export function getTaskProgress(task: Task): { completed: number; total: number; percentage: number } {
  const total = task.subtasks?.length || 0;
  const completed = task.subtasks?.filter(s => s.status === 'completed').length || 0;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, percentage };
}
