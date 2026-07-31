import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';

import { getSpecsDir } from '../../shared/constants';
import type {
  Project,
  ReviewReason,
  Task,
} from '../../shared/types';
import { findTaskWorktree } from '../worktree-paths';
import {
  getPlanPath,
  persistPlanStatusAndReasonSync,
} from '../ipc-handlers/task/plan-file-utils';
import type {
  OpenSpecRuntimeFile,
  OpenSpecWorkflowStage,
} from './openspec-runtime-store';

type OpenSpecStatusRuntime = Pick<
  OpenSpecRuntimeFile,
  'activeAction' | 'executionPhase'
> & {
  workflowStage?: OpenSpecWorkflowStage;
};

interface PersistedOpenSpecLifecycle {
  xstateState: string;
  executionPhase: string;
}

function persistedOpenSpecLifecycle(
  status: Task['status'],
  reviewReason: ReviewReason | undefined,
  runtime: OpenSpecStatusRuntime,
): PersistedOpenSpecLifecycle {
  if (status === 'done') {
    return { xstateState: 'done', executionPhase: 'complete' };
  }
  if (status === 'backlog') {
    return { xstateState: 'backlog', executionPhase: 'idle' };
  }
  if (status === 'error') {
    return { xstateState: 'error', executionPhase: 'failed' };
  }
  if (status === 'ai_review') {
    return { xstateState: 'ai_review', executionPhase: 'qa_review' };
  }
  if (status === 'human_review') {
    if (reviewReason === 'plan_review') {
      return { xstateState: 'plan_review', executionPhase: 'planning' };
    }
    if (reviewReason === 'stopped') {
      return { xstateState: 'human_review', executionPhase: 'stopped' };
    }
    if (reviewReason === 'errors') {
      return { xstateState: 'human_review', executionPhase: 'failed' };
    }
    return { xstateState: 'human_review', executionPhase: 'complete' };
  }

  if (runtime.workflowStage === 'planning') {
    return { xstateState: 'planning', executionPhase: 'planning' };
  }
  if (runtime.activeAction === 'verify') {
    return { xstateState: 'qa_review', executionPhase: 'qa_review' };
  }
  if (
    runtime.workflowStage === 'verified' ||
    runtime.workflowStage === 'archived'
  ) {
    return { xstateState: 'human_review', executionPhase: 'complete' };
  }
  return { xstateState: 'coding', executionPhase: 'coding' };
}

/**
 * Persist OpenSpec's authoritative lifecycle into the normal task plan files.
 *
 * OpenSpec keeps richer runtime state in openspec-runtime.json, while the
 * project loader restores Kanban tasks from implementation_plan.md. Keeping
 * both stores in sync prevents a completed archived task from returning to
 * Backlog after a cache refresh or application restart.
 */
export function persistOpenSpecTaskStatus(
  task: Task,
  project: Project,
  status: Task['status'],
  reviewReason: ReviewReason | undefined,
  runtime: OpenSpecStatusRuntime,
): boolean {
  const lifecycle = persistedOpenSpecLifecycle(
    status,
    reviewReason,
    runtime,
  );
  const mainPersisted = persistPlanStatusAndReasonSync(
    getPlanPath(project, task),
    status,
    reviewReason,
    project.id,
    lifecycle.xstateState,
    lifecycle.executionPhase,
  );

  const worktreePath = findTaskWorktree(project.path, task.specId);
  if (!worktreePath) return mainPersisted;

  const worktreePlanPath = join(
    worktreePath,
    getSpecsDir(project.autoBuildPath),
    task.specId,
    AUTOCODE_TASK_ARTIFACTS.implementationPlan,
  );
  if (!existsSync(worktreePlanPath)) return mainPersisted;

  const worktreePersisted = persistPlanStatusAndReasonSync(
    worktreePlanPath,
    status,
    reviewReason,
    project.id,
    lifecycle.xstateState,
    lifecycle.executionPhase,
  );
  return mainPersisted && worktreePersisted;
}

export const __openSpecTaskStatusPersistenceTestUtils = {
  persistedOpenSpecLifecycle,
};
