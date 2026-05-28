/**
 * Plan File Utilities
 *
 * Provides thread-safe operations for reading and writing implementation_plan.md files.
 * Uses an in-memory lock to serialize updates and prevent race conditions when multiple
 * IPC handlers try to update the same plan file concurrently.
 *
 * IMPORTANT LIMITATION:
 * The synchronous function `persistPlanStatusSync` does NOT participate in the locking
 * mechanism. It bypasses the async lock entirely, which means:
 * - It can race with concurrent async operations (persistPlanStatus, updatePlanFile, etc.)
 * - It should ONLY be used when you are certain no async operations are pending on the same file
 * - Prefer using the async `persistPlanStatus` whenever possible
 *
 * If you need synchronous behavior, ensure that:
 * 1. No async plan operations are in flight for the same file path
 * 2. The calling context truly cannot use async/await (e.g., synchronous event handlers)
 */

import path from 'path';
import { readFileSync, mkdirSync } from 'fs';
import {
  applyAutocodePlanPhase,
  applyAutocodePlanStatus,
  applyAutocodePlanStatusAndReason,
  applyAutocodePlanTokenUsage,
  canSyncAutocodePlanPhases,
  countAutocodePlanSubtasks,
  createMinimalAutocodePlan,
  mapAutocodeTaskStatusToPlanStatus,
  resetAutocodeStuckSubtasksInPlan,
  AUTOCODE_TASK_ARTIFACTS,
  type MutableAutocodePlan,
} from '@autocode/core';
import { getSpecsDir } from '../../../shared/constants';
import type { TaskStatus, Project, Task, TokenUsage } from '../../../shared/types';
import { projectStore } from '../../project-store';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { safeParseJson } from '../../utils/json-repair';
import {
  loadImplementationPlanFromFilesSync,
  saveImplementationPlanToFilesSync,
} from '../../ai/schema/plan-shards';

// In-memory locks for plan file operations
// Key: plan file path, Value: Promise chain for serializing operations
const planLocks = new Map<string, Promise<void>>();

/**
 * Serialize operations on a specific plan file to prevent race conditions.
 * Each operation waits for the previous one to complete before starting.
 */
async function withPlanLock<T>(planPath: string, operation: () => Promise<T>): Promise<T> {
  // Get or create the lock chain for this file
  const currentLock = planLocks.get(planPath) || Promise.resolve();

  // Create a new promise that will resolve after our operation completes
  let resolve: (() => void) | undefined;
  const newLock = new Promise<void>((r) => { resolve = r; });
  planLocks.set(planPath, newLock);

  try {
    // Wait for any previous operation to complete
    await currentLock;
    // Execute our operation
    return await operation();
  } finally {
    // Release the lock
    resolve?.();
    // Clean up if this was the last operation
    if (planLocks.get(planPath) === newLock) {
      planLocks.delete(planPath);
    }
  }
}

/**
 * Check if an error is a "file not found" error
 */
function isFileNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Get the plan file path for a task
 */
export function getPlanPath(project: Project, task: Task): string {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(project.path, specsBaseDir, task.specId);
  return path.join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
}

/**
 * Map UI TaskStatus to Python-compatible planStatus
 */
export function mapStatusToPlanStatus(status: TaskStatus): string {
  return mapAutocodeTaskStatusToPlanStatus(status);
}

/**
 * Persist task status to implementation_plan.md file.
 * This is thread-safe and prevents race conditions when multiple handlers update the same file.
 *
 * @param planPath - Path to the implementation_plan.md file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false if plan file doesn't exist
 */
export async function persistPlanStatus(planPath: string, status: TaskStatus, projectId?: string): Promise<boolean> {
  return withPlanLock(planPath, async () => {
    try {
      console.warn(`[plan-file-utils] Reading implementation_plan.md to update status to: ${status}`, { planPath });
      // Read file directly without existence check to avoid TOCTOU race condition
      const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
      if (!plan) {
        console.warn(`[plan-file-utils] Unreadable Markdown plan in ${planPath} - status not persisted`);
        return false;
      }

      applyAutocodePlanStatus(plan as MutableAutocodePlan, status);

      saveImplementationPlanToFilesSync(planPath, plan);
      console.warn(`[plan-file-utils] Successfully persisted status: ${status} to implementation_plan.md`);

      // Invalidate tasks cache since status changed
      if (projectId) {
        projectStore.invalidateTasksCache(projectId);
      }

      return true;
    } catch (err) {
      // File not found is expected - return false
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.md not found at ${planPath} - status not persisted`);
        return false;
      }
      console.warn(`[plan-file-utils] Could not persist status to ${planPath}:`, err);
      return false;
    }
  });
}

/**
 * Persist task status synchronously (for use in event handlers where async isn't practical).
 *
 * WARNING: This function bypasses the async locking mechanism entirely!
 *
 * This means it can race with concurrent async operations (persistPlanStatus, updatePlanFile,
 * createPlanIfNotExists) that may be in flight for the same file. Using this function while
 * async operations are pending can result in:
 * - Lost updates (this write may overwrite changes from an async operation, or vice versa)
 * - Corrupted plan content (if writes interleave at the filesystem level)
 * - Inconsistent state between what was written and what the async operation expected to read
 *
 * ONLY use this function when ALL of the following conditions are met:
 * 1. You are in a synchronous context that cannot use async/await (e.g., certain event handlers)
 * 2. You are certain no async plan operations are pending or in-flight for this file path
 * 3. No other code will initiate async plan operations until this function returns
 *
 * When possible, prefer using the async `persistPlanStatus` function instead, which properly
 * participates in the locking mechanism and prevents race conditions.
 *
 * @param planPath - Path to the implementation_plan.md file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false otherwise
 */
export function persistPlanStatusSync(planPath: string, status: TaskStatus, projectId?: string): boolean {
  try {
    // Read file directly without existence check to avoid TOCTOU race condition
    const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
    if (!plan) {
      console.warn(`[plan-file-utils] Unreadable Markdown plan in ${planPath} - sync status not persisted`);
      return false;
    }

    applyAutocodePlanStatus(plan as MutableAutocodePlan, status);

    saveImplementationPlanToFilesSync(planPath, plan);

    // Invalidate tasks cache since status changed
    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    // File not found is expected - return false
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist status to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist lastEvent metadata synchronously.
 *
 * WARNING: This bypasses async locking. Use only in sync event handlers where
 * async isn't practical. Prefer updatePlanFile when possible.
 */
export function persistPlanLastEventSync(planPath: string, event: TaskEventPayload): boolean {
  try {
    const plan = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
    if (!plan) {
      console.warn(`[plan-file-utils] Unreadable Markdown plan in ${planPath} - lastEvent not persisted`);
      return false;
    }

    plan.lastEvent = {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp
    };
    plan.updated_at = new Date().toISOString();

    saveImplementationPlanToFilesSync(planPath, plan);
    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist lastEvent to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist task status, reviewReason, XState state, and execution phase synchronously.
 * The xstateState and executionPhase are used to restore the exact machine state on reload,
 * distinguishing between e.g. 'planning' vs 'coding' when both have status 'in_progress'.
 *
 * If the plan file doesn't exist, creates a minimal plan with the status fields.
 * This ensures XState state is persisted even during early phases like spec creation.
 */
export function persistPlanStatusAndReasonSync(
  planPath: string,
  status: TaskStatus,
  reviewReason?: string,
  projectId?: string,
  xstateState?: string,
  executionPhase?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    const existing = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
    if (existing) {
      plan = existing;
    } else {
      // File doesn't exist - create a minimal plan with just status fields
      // The spec runner will populate the full plan later
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = createMinimalAutocodePlan(
        { title: '', description: '', createdAt: new Date().toISOString() },
        status
      ) as Record<string, unknown>;
      console.log(`[plan-file-utils] Creating minimal plan for XState persistence: ${planPath}`);
    }

    applyAutocodePlanStatusAndReason(plan as MutableAutocodePlan, status, {
      reviewReason,
      xstateState,
      executionPhase,
    });

    saveImplementationPlanToFilesSync(planPath, plan);

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist status/reason to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist execution phase to the plan file synchronously.
 * This is called when execution progress updates to ensure the phase
 * is persisted for restoration on app refresh.
 */
export function persistPlanPhaseSync(
  planPath: string,
  phase: string,
  projectId?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    const existing = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
    if (existing) {
      plan = existing;
    } else {
      // File doesn't exist - create minimal plan
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = createMinimalAutocodePlan(
        { title: '', description: '', createdAt: new Date().toISOString() },
        'backlog'
      ) as Record<string, unknown>;
    }

    applyAutocodePlanPhase(plan as MutableAutocodePlan, phase);

    saveImplementationPlanToFilesSync(planPath, plan);

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist phase to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist token usage to the plan file synchronously for refresh-time restoration.
 */
export function persistPlanTokenUsageSync(
  planPath: string,
  usage: TokenUsage,
  projectId?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    const existing = loadImplementationPlanFromFilesSync(planPath) as Record<string, unknown> | null;
    if (existing) {
      plan = existing;
    } else {
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = createMinimalAutocodePlan(
        { title: '', description: '', createdAt: new Date().toISOString() },
        'backlog'
      ) as Record<string, unknown>;
    }

    applyAutocodePlanTokenUsage(plan as MutableAutocodePlan, usage);

    saveImplementationPlanToFilesSync(planPath, plan);

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist token usage to ${planPath}:`, err);
    return false;
  }
}

/**
 * Read and update the plan file atomically.
 *
 * @param planPath - Path to the implementation_plan.md file
 * @param updater - Function that receives the current plan and returns the updated plan
 * @returns The updated plan, or null if the file doesn't exist
 */
export async function updatePlanFile<T extends Record<string, unknown>>(
  planPath: string,
  updater: (plan: T) => T
): Promise<T | null> {
  return withPlanLock(planPath, async () => {
    try {
      console.warn(`[plan-file-utils] Reading implementation_plan.md for update`, { planPath });
      // Read file directly without existence check to avoid TOCTOU race condition
      const plan = loadImplementationPlanFromFilesSync(planPath) as T | null;
      if (!plan) {
        console.warn(`[plan-file-utils] Unreadable Markdown plan in ${planPath} - update skipped`);
        return null;
      }

      const updatedPlan = updater(plan);
      // Add updated_at timestamp - use type assertion since T extends Record<string, unknown>
      (updatedPlan as Record<string, unknown>).updated_at = new Date().toISOString();

      saveImplementationPlanToFilesSync(planPath, updatedPlan);
      console.warn(`[plan-file-utils] Successfully updated implementation_plan.md`);
      return updatedPlan;
    } catch (err) {
      // File not found is expected - return null
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.md not found at ${planPath} - update skipped`);
        return null;
      }
      console.warn(`[plan-file-utils] Could not update plan at ${planPath}:`, err);
      return null;
    }
  });
}

/**
 * Create a new plan file if it doesn't exist.
 *
 * @param planPath - Path to the implementation_plan.md file
 * @param task - The task to create the plan for
 * @param status - Initial status for the plan
 * @param xstateState - Optional XState machine state for restoration
 */
export async function createPlanIfNotExists(
  planPath: string,
  task: Task,
  status: TaskStatus,
  xstateState?: string
): Promise<void> {
  return withPlanLock(planPath, async () => {
    // Try to read the file first - if it exists, do nothing
    try {
      readFileSync(planPath, 'utf-8');
      return; // File exists, nothing to do
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err; // Re-throw unexpected errors
      }
      // File doesn't exist, continue to create it
    }

    const plan = createMinimalAutocodePlan(
      {
        title: task.title,
        description: task.description || '',
        createdAt: task.createdAt.toISOString(),
      },
      status,
      new Date().toISOString(),
      xstateState,
    );

    // Ensure directory exists - use try/catch pattern
    const planDir = path.dirname(planPath);
    try {
      mkdirSync(planDir, { recursive: true });
    } catch (err) {
      // Directory might already exist or be created concurrently - that's fine
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    saveImplementationPlanToFilesSync(planPath, plan);
  });
}

/**
 * Reset all stuck subtasks (in_progress or failed) to pending state.
 * This enables automatic recovery when tasks are interrupted by rate limits or errors.
 * Thread-safe with withPlanLock.
 *
 * @param planPath - Path to the implementation_plan.md file
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns Object with success flag and count of reset subtasks
 */
export async function resetStuckSubtasks(planPath: string, projectId?: string): Promise<{ success: boolean; resetCount: number }> {
  return withPlanLock(planPath, async () => {
    try {
      console.log(`[plan-file-utils] Reading implementation_plan.md to reset stuck subtasks`, { planPath });

      // Read file directly without existence check to avoid TOCTOU race condition
      const plan = loadImplementationPlanFromFilesSync(planPath);
      if (!plan) {
        console.warn(`[plan-file-utils] Unreadable Markdown plan in ${planPath} - subtask reset skipped`);
        return { success: false, resetCount: 0 };
      }

      const { resetCount } = resetAutocodeStuckSubtasksInPlan(plan as MutableAutocodePlan);

      // Only write if we actually reset something
      if (resetCount > 0) {
        plan.updated_at = new Date().toISOString();
        saveImplementationPlanToFilesSync(planPath, plan);
        console.log(`[plan-file-utils] Successfully reset ${resetCount} stuck subtask(s) in implementation_plan.md`);

        // Invalidate tasks cache since subtask status changed
        if (projectId) {
          projectStore.invalidateTasksCache(projectId);
        }
      } else {
        console.log(`[plan-file-utils] No stuck subtasks found to reset`);
      }

      return { success: true, resetCount };
    } catch (err) {
      // File not found is expected - return success with 0 count
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.md not found at ${planPath} - no subtasks to reset`);
        return { success: false, resetCount: 0 };
      }
      console.warn(`[plan-file-utils] Could not reset stuck subtasks at ${planPath}:`, err);
      return { success: false, resetCount: 0 };
    }
  });
}

/**
 * Update task_metadata.json to add PR URL.
 * This is a simple JSON file update (no locking needed as it's rarely updated concurrently).
 *
 * @param metadataPath - Path to the task_metadata.json file
 * @param prUrl - The PR URL to add to metadata
 * @returns true if metadata was updated, false if file doesn't exist or failed
 */
export function updateTaskMetadataReviewRequest(
  metadataPath: string,
  updates: { prUrl?: string; gitblitTicketId?: number },
): boolean {
  try {
    let metadata: Record<string, unknown> = {};

    // Try to read existing metadata
    try {
      const content = readFileSync(metadataPath, 'utf-8');
      metadata = safeParseJson<Record<string, unknown>>(content) || {};
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err;
      }
      // File doesn't exist, will create new one
    }

    if (updates.prUrl !== undefined) {
      metadata.prUrl = updates.prUrl;
    }
    if (updates.gitblitTicketId !== undefined) {
      metadata.gitblitTicketId = updates.gitblitTicketId;
    }

    // Ensure parent directory exists before writing
    mkdirSync(path.dirname(metadataPath), { recursive: true });

    // Write back
    writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not update metadata at ${metadataPath}:`, err);
    return false;
  }
}

export function updateTaskMetadataPrUrl(metadataPath: string, prUrl: string): boolean {
  return updateTaskMetadataReviewRequest(metadataPath, { prUrl });
}

/**
 * Sync phases (subtask data) from a source plan to the main project's plan file.
 * This ensures that subtask completion statuses written by the agent in the worktree
 * are reflected in the main project plan, which is the source of truth for getTasks().
 *
 * Preserves all existing fields in the main plan (status, reviewReason, xstateState, etc.)
 * and only updates the phases array and updated_at timestamp.
 */
export function syncPlanPhasesToMainSync(
  mainPlanPath: string,
  phases: unknown[],
  projectId?: string
): boolean {
  try {
    const plan = loadImplementationPlanFromFilesSync(mainPlanPath);
    if (!plan) {
      console.warn(`[plan-file-utils] Unreadable Markdown plan in ${mainPlanPath} - phase sync skipped`);
      return false;
    }

    if (!canSyncAutocodePlanPhases(plan.phases, phases)) {
      const existingSubtaskCount = countAutocodePlanSubtasks(plan.phases);
      console.warn(
        `[plan-file-utils] Skipping empty phase sync to ${mainPlanPath}: existing plan has ${existingSubtaskCount} subtask(s)`
      );
      return false;
    }

    plan.phases = phases as never;
    plan.updated_at = new Date().toISOString();

    saveImplementationPlanToFilesSync(mainPlanPath, plan);

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not sync phases to ${mainPlanPath}:`, err);
    return false;
  }
}

/**
 * Check if a task has a valid implementation plan with subtasks.
 * A plan is considered valid if it has at least one subtask across all phases.
 *
 * @param project - The project containing the task
 * @param task - The task to check
 * @returns true if the task has a valid plan with subtasks, false otherwise
 */
export function hasPlanWithSubtasks(project: Project, task: Task): boolean {
  try {
    const planPath = getPlanPath(project, task);
    const plan = loadImplementationPlanFromFilesSync(planPath);
    if (!plan) return false;
    // A plan exists if it has phases with subtasks (totalCount > 0)
    return countAutocodePlanSubtasks(plan.phases) > 0;
  } catch {
    // File doesn't exist or is malformed
    return false;
  }
}
