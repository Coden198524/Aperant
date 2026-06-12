import path from 'path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { AUTO_BUILD_PATHS, IPC_CHANNELS } from '../../../../shared/constants';
import type { Project, Task } from '../../../../shared/types';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'E:/tmp/autocode-test'),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(),
  },
}));

vi.mock('../../../utils/roadmap-utils', () => ({
  updateRoadmapFeatureOutcome: vi.fn(),
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    getProjects: vi.fn(() => []),
    getTasks: vi.fn(),
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../../../title-generator', () => ({
  titleGenerator: {
    generateTitle: vi.fn(),
  },
}));

vi.mock('../../shared/spec-id', () => ({
  buildSpecId: vi.fn(() => '001-task'),
}));

vi.mock('../shared', () => ({
  findTaskAndProject: vi.fn(),
}));

vi.mock('../../../utils/spec-path-helpers', () => ({
  findAllSpecPaths: vi.fn(),
  isValidTaskId: vi.fn(() => true),
}));

vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null),
  isPathWithinBase: vi.fn(() => true),
}));

vi.mock('../../../utils/worktree-cleanup', () => ({
  cleanupWorktree: vi.fn(),
}));

vi.mock('../../../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git'),
}));

vi.mock('../../../utils/git-isolation', () => ({
  getIsolatedGitEnv: vi.fn(() => ({})),
}));

vi.mock('../../../task-state-manager', () => ({
  taskStateManager: {
    clearAllTasks: vi.fn(),
    clearTask: vi.fn(),
  },
}));

vi.mock('../../../sentry', () => ({
  safeBreadcrumb: vi.fn(),
}));

vi.mock('../../../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({})),
}));

vi.mock('../plan-file-utils', () => ({
  updatePlanFile: vi.fn(),
}));

describe('registerTaskCRUDHandlers', () => {
  let handleHandlers: Record<string, Function>;
  let mockAgentManager: {
    isRunning: ReturnType<typeof vi.fn>;
  };

  const project = {
    id: 'project-1',
    path: 'E:/Work/TestProject',
    autoBuildPath: '.autocode',
  } as Project;

  const task = {
    id: '001-test-task',
    specId: '001-test-task',
    projectId: project.id,
    title: 'Test task',
    description: 'Test description',
    status: 'backlog',
    subtasks: [
      { id: 'subtask-1', title: 'Keep', description: 'Keep', status: 'pending', files: [] },
      { id: 'subtask-2', title: 'Delete', description: 'Delete', status: 'pending', files: [] },
    ],
    logs: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as Task;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    handleHandlers = {};
    mockAgentManager = {
      isRunning: vi.fn(() => false),
    };

    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handleHandlers[channel] = handler;
    });

    const { registerTaskCRUDHandlers } = await import('../crud-handlers');
    registerTaskCRUDHandlers(mockAgentManager as never);
  });

  it('deletes a subtask from all implementation plans', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { findAllSpecPaths } = await import('../../../utils/spec-path-helpers');
    const { updatePlanFile } = await import('../plan-file-utils');
    const { projectStore } = await import('../../../project-store');

    const mainSpecPath = path.join(project.path, '.autocode', 'specs', task.specId);
    const worktreeSpecPath = path.join(
      project.path,
      '..',
      'worktrees',
      task.specId,
      '.autocode',
      'specs',
      task.specId
    );
    const mainPlanPath = path.join(mainSpecPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const worktreePlanPath = path.join(worktreeSpecPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const plans = new Map<string, Record<string, unknown>>([
      [
        mainPlanPath,
        {
          phases: [
            {
              subtasks: [
                { id: 'subtask-1', title: 'Keep' },
                { id: 'subtask-2', title: 'Delete' },
              ],
            },
          ],
        },
      ],
      [
        worktreePlanPath,
        {
          phases: [
            {
              chunks: [
                { id: 'subtask-2', title: 'Delete legacy chunk' },
                { id: 'subtask-3', title: 'Keep legacy chunk' },
              ],
            },
          ],
        },
      ],
    ]);
    const updatedTask = {
      ...task,
      subtasks: [{ id: 'subtask-1', title: 'Keep', description: 'Keep', status: 'pending', files: [] }],
    } as Task;

    (findTaskAndProject as Mock).mockReturnValue({ task, project });
    (findAllSpecPaths as Mock).mockReturnValue([mainSpecPath, worktreeSpecPath]);
    (updatePlanFile as Mock).mockImplementation(
      async (planPath: string, updater: (plan: Record<string, unknown>) => Record<string, unknown>) => {
        const plan = plans.get(planPath);
        if (!plan) return null;
        const updatedPlan = updater(plan);
        plans.set(planPath, updatedPlan);
        return updatedPlan;
      }
    );
    (projectStore.getTasks as Mock).mockReturnValue([updatedTask]);

    const deleteSubtaskHandler = handleHandlers[IPC_CHANNELS.TASK_DELETE_SUBTASK];
    const result = await deleteSubtaskHandler({}, task.id, 'subtask-2', project.id);

    expect(findTaskAndProject).toHaveBeenCalledWith(task.id, project.id);
    expect(findAllSpecPaths).toHaveBeenCalledWith(
      project.path,
      '.autocode/specs',
      task.specId,
      '[TASK_DELETE_SUBTASK]'
    );
    expect(updatePlanFile).toHaveBeenCalledTimes(2);
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith(project.id);
    expect(result).toEqual({ success: true, data: updatedTask });
    expect((plans.get(mainPlanPath)?.phases as Array<{ subtasks: Array<{ id: string }> }>)[0].subtasks)
      .toEqual([{ id: 'subtask-1', title: 'Keep' }]);
    expect((plans.get(worktreePlanPath)?.phases as Array<{ chunks: Array<{ id: string }> }>)[0].chunks)
      .toEqual([{ id: 'subtask-3', title: 'Keep legacy chunk' }]);
  });

  it('rejects subtask deletion while the task is running', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { updatePlanFile } = await import('../plan-file-utils');

    (findTaskAndProject as Mock).mockReturnValue({
      task: { ...task, status: 'in_progress' },
      project,
    });

    const deleteSubtaskHandler = handleHandlers[IPC_CHANNELS.TASK_DELETE_SUBTASK];
    const result = await deleteSubtaskHandler({}, task.id, 'subtask-2', project.id);

    expect(result).toEqual({
      success: false,
      error: 'Cannot delete subtasks while the task is running',
    });
    expect(updatePlanFile).not.toHaveBeenCalled();
  });

  it('passes the app language to generated task titles', async () => {
    const { projectStore } = await import('../../../project-store');
    const { titleGenerator } = await import('../../../title-generator');
    const { readSettingsFile } = await import('../../../settings-utils');
    const tempProjectPath = mkdtempSync(path.join(tmpdir(), 'autocode-title-'));
    const tempProject = { ...project, path: tempProjectPath };

    try {
      (projectStore.getProject as Mock).mockReturnValue(tempProject);
      (readSettingsFile as Mock).mockReturnValue({ language: 'zh-CN' });
      (titleGenerator.generateTitle as Mock).mockResolvedValue('实现网页游戏');

      const createHandler = handleHandlers[IPC_CHANNELS.TASK_CREATE];
      const result = await createHandler({}, project.id, '', '实现一个网页版俄罗斯方块游戏', {
        developmentMode: 'standard',
      });

      expect(result.success).toBe(true);
      expect(result.data.title).toBe('实现网页游戏');
      expect(titleGenerator.generateTitle).toHaveBeenCalledWith(
        '实现一个网页版俄罗斯方块游戏',
        { language: 'zh-CN' },
      );
    } finally {
      rmSync(tempProjectPath, { recursive: true, force: true });
    }
  });

  it('normalizes runtime concurrency when a direct task is edited to standard mode', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { updatePlanFile } = await import('../plan-file-utils');
    const tempProjectPath = mkdtempSync(path.join(tmpdir(), 'autocode-crud-'));
    const tempProject = { ...project, path: tempProjectPath };
    const specDir = path.join(tempProjectPath, '.autocode', 'specs', task.specId);
    const metadataPath = path.join(specDir, 'task_metadata.json');
    const staleMetadata = {
      sourceType: 'manual' as const,
      developmentMode: 'direct' as const,
      workflowMode: 'off' as const,
      runtimeConcurrency: {
        mode: 'serial' as const,
        workers: 1,
        unit: 'work_item' as const,
        conflictPolicy: 'lock-and-queue' as const,
      },
    };

    try {
      mkdirSync(specDir, { recursive: true });
      writeFileSync(metadataPath, JSON.stringify(staleMetadata, null, 2), 'utf-8');
      (findTaskAndProject as Mock).mockReturnValue({
        task: { ...task, metadata: staleMetadata },
        project: tempProject,
      });
      (updatePlanFile as Mock).mockResolvedValue({});

      const updateHandler = handleHandlers[IPC_CHANNELS.TASK_UPDATE];
      const result = await updateHandler({}, task.id, {
        metadata: {
          developmentMode: 'standard',
          workflowMode: 'balanced',
          sourceType: 'manual',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data.metadata.runtimeConcurrency).toEqual({
        mode: 'concurrent',
        workers: 2,
        unit: 'work_item',
        conflictPolicy: 'lock-and-queue',
      });
      expect(JSON.parse(readFileSync(metadataPath, 'utf-8')).runtimeConcurrency).toEqual({
        mode: 'concurrent',
        workers: 2,
        unit: 'work_item',
        conflictPolicy: 'lock-and-queue',
      });
    } finally {
      rmSync(tempProjectPath, { recursive: true, force: true });
    }
  });
});
