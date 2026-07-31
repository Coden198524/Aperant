import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import {
  isOpenSpecArtifactRefreshRequiredError,
  type Project,
  type Task,
} from '../../shared/types';
import { registerOpenSpecHandlers } from './openspec-handlers';

const serviceMocks = vi.hoisted(() => ({
  runtimeStore: {
    read: vi.fn(),
  },
  getSnapshot: vi.fn(),
  selectChange: vi.fn(),
  runAction: vi.fn(),
  cancelAction: vi.fn(),
  resumeAction: vi.fn(),
  answerInteraction: vi.fn(),
  readArtifact: vi.fn(),
  getArtifactDiff: vi.fn(),
  validate: vi.fn(),
  listChanges: vi.fn(),
  getHistory: vi.fn(),
  readRunLog: vi.fn(),
  getPlanningReview: vi.fn(),
  acknowledgePlanningReview: vi.fn(),
  retryPlanningReview: vi.fn(),
  preflightProject: vi.fn(),
}));

const persistenceMocks = vi.hoisted(() => ({
  persistOpenSpecTaskStatus: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../openspec/openspec-service', () => ({
  OpenSpecService: vi.fn(function OpenSpecService() {
    return serviceMocks;
  }),
}));

vi.mock('./task/shared', () => ({
  findTaskAndProject: vi.fn(),
}));

vi.mock('../project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../openspec/openspec-task-status-persistence', () => persistenceMocks);

function specTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'spec-task',
    specId: 'spec-task',
    projectId: 'project-a',
    title: 'Spec task',
    description: 'Use OpenSpec.',
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
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-a',
    name: 'Project A',
    path: 'C:\\projects\\a',
    autoBuildPath: '.autocode',
    settings: {},
    ...overrides,
  } as Project;
}

describe('OpenSpec IPC handlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
    (ipcMain.handle as Mock).mockImplementation(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers[channel] = handler;
      },
    );
    registerOpenSpecHandlers({} as never, () => null);
  });

  it('resolves the authoritative task and project before running an Action', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    const currentTask = specTask();
    const currentProject = project();
    (findTaskAndProject as Mock).mockReturnValue({
      task: currentTask,
      project: currentProject,
    });
    serviceMocks.runAction.mockResolvedValue({ runId: 'run-a' });
    const input = {
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'continue' as const,
      changeName: 'change-a',
    };

    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_RUN_ACTION]({}, input))
      .resolves.toEqual({ runId: 'run-a' });
    expect(findTaskAndProject).toHaveBeenCalledWith(
      currentTask.id,
      currentProject.id,
    );
    expect(serviceMocks.runAction).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      input,
    );
  });

  it('rejects Standard tasks and cross-project task records before service access', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    (findTaskAndProject as Mock).mockReturnValue({
      task: specTask({
        metadata: {
          developmentMode: 'standard',
          workflowMode: 'balanced',
        },
      }),
      project: project(),
    });
    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT](
      {},
      'spec-task',
      'project-a',
    )).rejects.toThrow(/only available for Spec/);

    (findTaskAndProject as Mock).mockReturnValue({
      task: specTask({ projectId: 'project-b' }),
      project: project({ id: 'project-a' }),
    });
    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT](
      {},
      'spec-task',
      'project-a',
    )).rejects.toThrow(/does not belong/);
    expect(serviceMocks.getSnapshot).not.toHaveBeenCalled();
  });

  it('rejects malformed renderer IDs before lookup', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    (findTaskAndProject as Mock).mockReturnValue({
      task: specTask(),
      project: project(),
    });

    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT](
      {},
      `spec-task\0escape`,
      'project-a',
    )).rejects.toThrow(/Task ID is invalid/);
    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_CANCEL_ACTION](
      {},
      'spec-task',
      '',
      'project-a',
    )).rejects.toThrow(/Run ID is invalid/);
    expect(findTaskAndProject).not.toHaveBeenCalledWith(
      expect.stringContaining('\0'),
      expect.anything(),
    );
    expect(serviceMocks.cancelAction).not.toHaveBeenCalled();
  });

  it('validates the expected artifact change before task lookup or service access', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    const invalidInputs = [
      {
        taskId: 'spec-task',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      },
      {
        taskId: 'spec-task',
        expectedChangeName: '../change-a',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      },
      {
        taskId: 'spec-task',
        expectedChangeName: ' change-a ',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      },
    ];

    for (const input of invalidInputs) {
      for (const channel of [
        IPC_CHANNELS.OPEN_SPEC_READ_ARTIFACT,
        IPC_CHANNELS.OPEN_SPEC_GET_ARTIFACT_DIFF,
      ]) {
        let thrown: unknown;
        try {
          await handlers[channel]({}, input);
        } catch (error) {
          thrown = error;
        }
        expect(isOpenSpecArtifactRefreshRequiredError(thrown)).toBe(true);
      }
    }

    expect(findTaskAndProject).not.toHaveBeenCalled();
    expect(serviceMocks.readArtifact).not.toHaveBeenCalled();
    expect(serviceMocks.getArtifactDiff).not.toHaveBeenCalled();
  });

  it('passes the validated expected change through artifact IPC handlers', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    const currentTask = specTask();
    const currentProject = project();
    (findTaskAndProject as Mock).mockReturnValue({
      task: currentTask,
      project: currentProject,
    });
    const input = {
      taskId: currentTask.id,
      projectId: currentProject.id,
      expectedChangeName: 'change-a',
      artifactId: 'proposal',
      relativePath: 'proposal.md',
    };
    serviceMocks.readArtifact.mockResolvedValue({ artifactId: 'proposal' });
    serviceMocks.getArtifactDiff.mockResolvedValue({ artifactId: 'proposal' });

    await handlers[IPC_CHANNELS.OPEN_SPEC_READ_ARTIFACT]({}, input);
    await handlers[IPC_CHANNELS.OPEN_SPEC_GET_ARTIFACT_DIFF]({}, input);

    expect(serviceMocks.readArtifact).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      input,
    );
    expect(serviceMocks.getArtifactDiff).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      input,
    );
  });

  it('preflights only a project resolved from the main-process project store', async () => {
    const { projectStore } = await import('../project-store');
    const currentProject = project();
    (projectStore.getProject as Mock).mockReturnValue(currentProject);
    serviceMocks.preflightProject.mockResolvedValue({ valid: true });

    await handlers[IPC_CHANNELS.OPEN_SPEC_PREFLIGHT]({}, {
      projectId: currentProject.id,
      rootKind: 'project',
      schemaName: 'spec-driven',
    });
    expect(serviceMocks.preflightProject).toHaveBeenCalledWith(
      currentProject,
      {
        projectId: currentProject.id,
        rootKind: 'project',
        schemaName: 'spec-driven',
      },
    );

    (projectStore.getProject as Mock).mockReturnValue(undefined);
    await expect(handlers[IPC_CHANNELS.OPEN_SPEC_PREFLIGHT]({}, {
      projectId: 'missing-project',
    })).rejects.toThrow(/Project was not found/);
  });

  it('scopes planning review reads and acknowledgements to the resolved Spec task', async () => {
    const { findTaskAndProject } = await import('./task/shared');
    const currentTask = specTask();
    const currentProject = project();
    (findTaskAndProject as Mock).mockReturnValue({
      task: currentTask,
      project: currentProject,
    });
    const input = {
      taskId: currentTask.id,
      projectId: currentProject.id,
      runId: 'run-a',
    };
    serviceMocks.getPlanningReview.mockResolvedValue({ runId: 'run-a' });
    serviceMocks.acknowledgePlanningReview.mockResolvedValue(null);

    await handlers[IPC_CHANNELS.OPEN_SPEC_GET_PLANNING_REVIEW]({}, input);
    await handlers[IPC_CHANNELS.OPEN_SPEC_ACKNOWLEDGE_PLANNING_REVIEW](
      {},
      input,
    );

    expect(serviceMocks.getPlanningReview).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      input,
    );
    expect(serviceMocks.acknowledgePlanningReview).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      input,
    );
  });

  it('persists OpenSpec lifecycle state before publishing a Kanban status event', async () => {
    const { OpenSpecService } = await import('../openspec/openspec-service');
    const currentTask = specTask({ status: 'human_review' });
    const currentProject = project();
    const runtime = {
      taskStatus: 'done',
      workflowStage: 'archived',
      executionPhase: 'complete',
      activeAction: null,
    };
    serviceMocks.runtimeStore.read.mockReturnValue(runtime);
    const publishTaskStatus = (OpenSpecService as Mock).mock.calls.at(-1)?.[2] as (
      task: Task,
      project: Project,
      status: Task['status'],
    ) => void;

    publishTaskStatus(currentTask, currentProject, 'done');

    expect(persistenceMocks.persistOpenSpecTaskStatus).toHaveBeenCalledWith(
      currentTask,
      currentProject,
      'done',
      undefined,
      runtime,
    );
  });
});
