import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project, Task } from '../../shared/types';
import { loadImplementationPlanFromFilesSync } from '../ai/schema/plan-shards';
import { getPlanPath } from '../ipc-handlers/task/plan-file-utils';
import {
  __openSpecTaskStatusPersistenceTestUtils,
  persistOpenSpecTaskStatus,
} from './openspec-task-status-persistence';

describe('OpenSpec task status persistence', () => {
  const temporaryRoots: string[] = [];
  const resolveLifecycle =
    __openSpecTaskStatusPersistenceTestUtils.persistedOpenSpecLifecycle;

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists archive completion as a stable completed task', () => {
    expect(resolveLifecycle(
      'done',
      undefined,
      {
        activeAction: null,
        executionPhase: 'complete',
        workflowStage: 'archived',
      },
    )).toEqual({
      xstateState: 'done',
      executionPhase: 'complete',
    });
  });

  it('keeps planning review and implementation lifecycle states distinct', () => {
    expect(resolveLifecycle(
      'human_review',
      'plan_review',
      {
        activeAction: null,
        executionPhase: 'planning',
        workflowStage: 'planning',
      },
    )).toEqual({
      xstateState: 'plan_review',
      executionPhase: 'planning',
    });
    expect(resolveLifecycle(
      'in_progress',
      undefined,
      {
        activeAction: 'apply',
        executionPhase: 'apply',
        workflowStage: 'implementation',
      },
    )).toEqual({
      xstateState: 'coding',
      executionPhase: 'coding',
    });
  });

  it('writes archive completion into the plan restored by the project loader', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-plan-'));
    temporaryRoots.push(projectRoot);
    const task = {
      id: 'archived-task',
      specId: 'archived-task',
      projectId: 'project-a',
      title: 'Archived task',
      description: 'Archive persistence test.',
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata: {
        developmentMode: 'spec',
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          schemaName: 'spec-driven',
        },
      },
      createdAt: new Date('2026-07-31T00:00:00.000Z'),
      updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'project-a',
      name: 'Project A',
      path: projectRoot,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;

    expect(persistOpenSpecTaskStatus(
      task,
      project,
      'done',
      undefined,
      {
        activeAction: null,
        executionPhase: 'complete',
        workflowStage: 'archived',
      },
    )).toBe(true);

    expect(loadImplementationPlanFromFilesSync(
      getPlanPath(project, task),
    )).toMatchObject({
      status: 'done',
      planStatus: 'completed',
      xstateState: 'done',
      executionPhase: 'complete',
    });
  });
});
