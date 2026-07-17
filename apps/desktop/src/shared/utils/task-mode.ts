/**
 * task-mode - Single source of truth for Direct vs Standard development mode.
 *
 * "Direct" development mode (developmentMode === 'direct', equivalently
 * workflowMode === 'off') runs a task as one model session with no planning /
 * work-package / QA orchestration. This is distinct from the workspace
 * isolation axis (`useWorktree`), which also uses the word "direct".
 *
 * The predicate used to be reimplemented in at least four places with slightly
 * different logic (metadata-only, metadata + plan, workflow-only). That caused
 * the renderer and the main process to disagree about whether a task is Direct.
 * All callers should use the helpers exported here instead.
 */
import { resolveAutocodeTaskDevelopmentModeValue } from '@autocode/core/tasks/task-development-mode';
import type { TaskDevelopmentMode, TaskMetadata, TaskWorkflowMode } from '../types';

/** Minimal metadata shape needed to resolve the development mode. */
export type TaskDevelopmentModeMetadataLike =
  | Pick<TaskMetadata, 'developmentMode' | 'workflowMode'>
  | null
  | undefined;

/**
 * Minimal plan shape carrying Direct-mode markers. Implementation plans are a
 * main/ai type, so we accept a loose structural type usable from any process.
 */
export type DirectModePlanLike =
  | {
      workflow_type?: unknown;
      direct_execution?: { enabled?: unknown } | null;
    }
  | null
  | undefined;

/**
 * Resolve the effective development mode from task metadata. Delegates to the
 * canonical `@autocode/core` resolver so desktop and core stay consistent:
 * an explicit `developmentMode` wins, otherwise `workflowMode === 'off'` maps
 * to `'direct'`, otherwise `defaultMode` (default `'standard'`).
 */
export function resolveTaskDevelopmentMode(
  metadata: TaskDevelopmentModeMetadataLike,
  defaultMode: TaskDevelopmentMode = 'standard',
): TaskDevelopmentMode {
  return resolveAutocodeTaskDevelopmentModeValue(
    (metadata ?? undefined) as Parameters<typeof resolveAutocodeTaskDevelopmentModeValue>[0],
    defaultMode,
  );
}

/** Map a development mode to the workflow mode persisted in metadata. */
export function workflowModeForDevelopmentMode(mode: TaskDevelopmentMode): TaskWorkflowMode {
  return mode === 'direct' ? 'off' : 'balanced';
}

/** True when the task metadata resolves to Direct development mode. */
export function isDirectDevelopmentMetadata(metadata: TaskDevelopmentModeMetadataLike): boolean {
  return resolveTaskDevelopmentMode(metadata) === 'direct';
}

/** True when an implementation plan carries Direct-mode execution markers. */
export function isDirectDevelopmentPlan(plan: DirectModePlanLike): boolean {
  if (!plan) {
    return false;
  }
  if (plan.workflow_type === 'direct') {
    return true;
  }
  return plan.direct_execution != null && plan.direct_execution.enabled === true;
}

/**
 * Canonical Direct-mode predicate. A task is Direct when its metadata resolves
 * to Direct OR its plan carries Direct execution markers. Callers that only
 * have one of the two may pass just that argument.
 */
export function isDirectDevelopmentTask(
  task?: { metadata?: TaskDevelopmentModeMetadataLike } | null,
  plan?: DirectModePlanLike,
): boolean {
  return isDirectDevelopmentMetadata(task?.metadata) || isDirectDevelopmentPlan(plan);
}
