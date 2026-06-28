import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../../shared/constants';

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  execFileSync: vi.fn(),
}));

vi.mock('../shared', () => ({
  findTaskAndProject: vi.fn(),
}));

vi.mock('../../../project-initializer', () => ({
  checkGitStatus: vi.fn(),
}));

vi.mock('../../../claude-profile-manager', () => ({
  initializeClaudeProfileManager: vi.fn(),
}));

vi.mock('../../../task-state-manager', () => ({
  taskStateManager: {
    configure: vi.fn(),
    prepareForRestart: vi.fn(),
    getCurrentState: vi.fn(() => null),
    handleUiEvent: vi.fn(),
    handleManualStatusChange: vi.fn(() => true),
  },
}));

vi.mock('../plan-file-utils', () => ({
  getPlanPath: vi.fn(() => 'plan-path'),
  persistPlanStatus: vi.fn(),
  createPlanIfNotExists: vi.fn(),
  resetStuckSubtasks: vi.fn(async () => ({ success: true, resetCount: 0 })),
  hasPlanWithSubtasks: vi.fn(() => false),
}));

vi.mock('../../../file-watcher', () => ({
  fileWatcher: {
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    getCurrentPlan: vi.fn(),
    getWatchedSpecDir: vi.fn(),
  },
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProject: vi.fn(),
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../../../utils/git-isolation', () => ({
  getIsolatedGitEnv: vi.fn(() => ({})),
  detectWorktreeBranch: vi.fn(() => ({ branch: 'task-branch', usingFallback: false })),
}));

vi.mock('../../agent-events-handlers', () => ({
  cancelFallbackTimer: vi.fn(),
}));

vi.mock('../../../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({})),
}));

vi.mock('../../../utils/atomic-file', () => ({
  writeFileAtomicSync: vi.fn(),
}));

vi.mock('../../../ai/schema/plan-shards', () => ({
  loadImplementationPlanFromFilesSync: vi.fn(),
  saveImplementationPlanToFilesSync: vi.fn(),
}));

vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null),
}));

vi.mock('../../../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git'),
}));

describe('registerTaskExecutionHandlers', () => {
  let onHandlers: Record<string, Function>;
  let handleHandlers: Record<string, Function>;
  let mockMainWindow: Partial<BrowserWindow>;
  let mockAgentManager: {
    startSpecCreation: ReturnType<typeof vi.fn>;
    startTaskExecution: ReturnType<typeof vi.fn>;
    startDirectTaskExecution: ReturnType<typeof vi.fn>;
    startQAProcess: ReturnType<typeof vi.fn>;
    killTask: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers = {};
    handleHandlers = {};

    (ipcMain.on as Mock).mockImplementation((channel: string, handler: Function) => {
      onHandlers[channel] = handler;
    });
    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: Function) => {
      handleHandlers[channel] = handler;
    });

    mockMainWindow = {
      webContents: {
        send: vi.fn(),
      } as unknown as BrowserWindow['webContents'],
    };

    mockAgentManager = {
      startSpecCreation: vi.fn(),
      startTaskExecution: vi.fn(),
      startDirectTaskExecution: vi.fn(),
      startQAProcess: vi.fn(),
      killTask: vi.fn(),
      isRunning: vi.fn(() => false),
    };

    const { registerTaskExecutionHandlers } = await import('../execution-handlers');
    registerTaskExecutionHandlers(
      mockAgentManager as never,
      () => mockMainWindow as BrowserWindow,
    );

    const planShards = await import('../../../ai/schema/plan-shards');
    const fs = await import('fs');
    (fs.existsSync as Mock).mockImplementation(() => false);
    (fs.readFileSync as Mock).mockImplementation(() => '');
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockImplementation((planPath: string) => {
      try {
        const content = (fs.readFileSync as Mock)(planPath);
        return content ? JSON.parse(content as string) : null;
      } catch {
        return null;
      }
    });
    const atomicFile = await import('../../../utils/atomic-file');
    (planShards.saveImplementationPlanToFilesSync as Mock).mockImplementation((planPath: string, plan: unknown) => {
      (atomicFile.writeFileAtomicSync as Mock)(planPath, JSON.stringify(plan, null, 2));
    });
    const worktreePaths = await import('../../../worktree-paths');
    (worktreePaths.findTaskWorktree as Mock).mockImplementation(() => null);
  });

  it('configures the task state manager for status broadcasts from task execution handlers', async () => {
    const { taskStateManager } = await import('../../../task-state-manager');

    expect(taskStateManager.configure).toHaveBeenCalledWith(expect.any(Function));
  });

  it('scopes TASK_START lookups and task errors by requested projectId', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (findTaskAndProject as Mock).mockReturnValue({ task: undefined, project: undefined });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-fast-task', { projectId: 'project-fast' });

    expect(findTaskAndProject).toHaveBeenCalledWith('001-fast-task', 'project-fast');
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_ERROR,
      '001-fast-task',
      'Task or project not found',
      'project-fast',
    );
  });

  it('emits TASK_START validation errors with the resolved projectId', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-fast-task',
        specId: '001-fast-task',
        projectId: 'project-fast',
        title: 'Fast task',
        description: 'desc',
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata: { workflowMode: 'fast' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: false,
      hasCommits: false,
      error: 'not a git repo',
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-fast-task', { projectId: 'project-fast' });

    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_ERROR,
      '001-fast-task',
      'Git repository required. Please run "git init" in your project directory. Autocode uses git worktrees for isolated builds.',
      'project-fast',
    );
  });

  it('scopes TASK_STOP state transitions by requested projectId', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');

    const task = {
      id: '001-fast-task',
      specId: '001-fast-task',
      projectId: 'project-fast',
      title: 'Fast task',
      description: 'desc',
      status: 'in_progress',
      subtasks: [],
      logs: [],
      metadata: { workflowMode: 'fast' },
    };
    const project = {
      id: 'project-fast',
      path: 'E:/Work/FastProject',
      autoBuildPath: '.autocode',
      settings: {},
    };

    (findTaskAndProject as Mock).mockReturnValue({ task, project });

    const stopHandler = onHandlers[IPC_CHANNELS.TASK_STOP];
    stopHandler({}, '001-fast-task', 'project-fast');

    expect(findTaskAndProject).toHaveBeenCalledWith('001-fast-task', 'project-fast');
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-fast-task',
      { type: 'USER_STOPPED', hasPlan: false },
      task,
      project,
    );
  });

  it('scopes TASK_UPDATE_STATUS lookups by requested projectId', async () => {
    const { findTaskAndProject } = await import('../shared');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-fast-task',
        specId: '001-fast-task',
        projectId: 'project-fast',
        title: 'Fast task',
        description: 'desc',
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata: { workflowMode: 'fast' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });

    const updateStatusHandler = handleHandlers[IPC_CHANNELS.TASK_UPDATE_STATUS];
    const result = await updateStatusHandler({}, '001-fast-task', 'backlog', { projectId: 'project-fast' });

    expect(findTaskAndProject).toHaveBeenCalledWith('001-fast-task', 'project-fast');
    expect(result).toEqual({ success: true });
  });

  it('restarts planning and regenerates plan for plan_review Request Changes without hiding the current plan', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const fs = await import('fs');
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-plan-review',
        specId: '001-plan-review',
        projectId: 'project-fast',
        title: 'Plan review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'plan_review',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'pending', files: [] }],
        logs: [],
        metadata: {
          sourceType: 'manual',
          developmentMode: 'standard',
          workflowMode: 'balanced',
        },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('plan_review');
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [{ subtasks: [{ status: 'pending' }] }]
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-plan-review', false, 'need changes');

    expect(result).toEqual({ success: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('need changes'),
      'utf-8'
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('"feedback":"need changes"'),
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Do not create a new task'),
      'utf-8'
    );
    expect((fs.writeFileSync as Mock).mock.calls.some(([filePath]) =>
      String(filePath).includes('CHANGE_REQUESTS.md')
    )).toBe(false);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Autocode Standard flow'),
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Standard Iteration Protocol'),
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Flow/runtime documents involved: HUMAN_INPUT.md, change_requests.jsonl, spec.md, requirements.md, tasks.md, implementation_plan.md, qa_report.md'),
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Do not edit implementation_plan.md directly'),
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('keep one canonical checklist item'),
      'utf-8'
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('"mode":"standard-planning"'),
      'utf-8'
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('"commitPolicy"'),
      'utf-8'
    );
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-plan-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalledWith(
      '001-plan-review',
      'E:/Work/FastProject',
      '001-plan-review',
      expect.objectContaining({ forcePlanning: true }),
      'project-fast',
    );
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('applies a local Standard change patch when stale progress still says planning', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { findTaskWorktree } = await import('../../../worktree-paths');
    const { appendFileSync, existsSync, readFileSync, writeFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskWorktree as Mock).mockReturnValue(null);
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-standard-requirements-review',
        specId: '001-standard-requirements-review',
        projectId: 'project-fast',
        title: 'Standard review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        executionProgress: { phase: 'planning', phaseProgress: 100, overallProgress: 100 },
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: { developmentMode: 'standard', workflowMode: 'balanced' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue(undefined);
    (existsSync as Mock).mockReturnValue(true);
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              id: '1',
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Existing work', description: 'done', status: 'completed', files: [] },
              ],
            },
          ],
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler(
      {},
      '001-standard-requirements-review',
      false,
      'Add a new requirement: interrupted skills must roll back cooldown and notify UI.',
    );

    expect(result).toEqual({ success: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Impact analysis: requirements, implementation'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('requirements.md'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('commit-ready'),
      'utf-8',
    );
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('interrupted skills'),
      'utf-8',
    );
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('"flowDocuments"'),
      'utf-8',
    );
    expect((writeFileSync as Mock).mock.calls.some(([filePath]) =>
      String(filePath).includes('CHANGE_REQUESTS.md')
    )).toBe(false);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('spec.md'),
      expect.stringContaining('CR ID: cr-'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('requirements.md'),
      expect.stringContaining('interrupted skills'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('tasks.md'),
      expect.stringContaining('Change request cr-'),
      'utf-8',
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('interrupted skills'),
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('"executionPhase": "coding"'),
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-requirements-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object),
    );
    const humanInputWrites = (writeFileSync as Mock).mock.calls
      .filter(([filePath]) => String(filePath).includes('HUMAN_INPUT.md'))
      .map(([, content]) => String(content));
    const finalHumanInput = humanInputWrites[humanInputWrites.length - 1];
    expect(finalHumanInput).toContain('planning artifacts were patched locally');
    expect(finalHumanInput).toContain('Continue coding from the pending change-request work item');
    expect(finalHumanInput).not.toContain('Do not implement code in this planning pass');
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).not.toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('uses PLANNING_STARTED for errors without subtasks and restarts execution (not QA)', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const fs = await import('fs');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-error-review',
        specId: '001-error-review',
        projectId: 'project-fast',
        title: 'Error review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'errors',
        subtasks: [],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('error');
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({ phases: [{ subtasks: [] }] });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-error-review', false, 'retry');

    expect(result).toEqual({ success: true });
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-error-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('uses PLANNING_STARTED for human_review stopped tasks without subtasks on TASK_START', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const fs = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-stopped-no-plan',
        specId: '001-stopped-no-plan',
        projectId: 'project-fast',
        title: 'Stopped task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'stopped',
        subtasks: [],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('');

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-stopped-no-plan', { projectId: 'project-fast' });

    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-stopped-no-plan',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('uses worktree plan subtasks on TASK_START when the main plan is still empty', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { findTaskWorktree } = await import('../../../worktree-paths');
    const fs = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-worktree-plan',
        specId: '001-worktree-plan',
        projectId: 'project-fast',
        title: 'Worktree plan task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'stopped',
        subtasks: [],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (findTaskWorktree as Mock).mockReturnValue('E:/Work/FastProject/.autocode/worktrees/tasks/001-worktree-plan');
    (fs.existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('spec.md') || filePath.includes('implementation_plan.md')
    );
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      if (normalizedPath.includes('.autocode/worktrees/tasks/001-worktree-plan')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              subtasks: [{ id: '1.1', status: 'pending' }],
            },
          ],
        });
      }
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({ phases: [] });
      }
      return '';
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-worktree-plan', { projectId: 'project-fast' });

    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-worktree-plan',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
  });

  it('starts direct execution for workflow off tasks without spec creation', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const fs = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-direct',
        specId: '001-direct',
        projectId: 'project-fast',
        title: 'Direct task',
        description: 'do it directly',
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata: { workflowMode: 'off' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue(null);
    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('');

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-direct', { projectId: 'project-fast' });

    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-direct',
      {
        type: 'CODING_STARTED',
        subtaskId: 'direct-implementation',
        subtaskDescription: 'Direct model execution',
      },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startDirectTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(mockAgentManager.startTaskExecution).not.toHaveBeenCalled();
  });

  it('restarts direct Request Changes as a direct continuation without Standard planning artifacts', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { appendFileSync, existsSync, writeFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-direct-review',
        specId: '001-direct-review',
        projectId: 'project-fast',
        title: 'Direct review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: 'direct-implementation', title: 'Direct model execution', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: { workflowMode: 'off', developmentMode: 'direct' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-direct-review', false, 'Keep the original context and fix the start button.');

    expect(result).toEqual({ success: true });
    const humanInputWrites = (writeFileSync as Mock).mock.calls
      .filter(([filePath]) => String(filePath).includes('HUMAN_INPUT.md'))
      .map(([, content]) => String(content));
    expect(humanInputWrites.length).toBeGreaterThan(0);
    expect(humanInputWrites[0]).toContain('Direct Iteration Protocol');
    expect(humanInputWrites[0]).toContain('direct_session.json');
    expect(humanInputWrites[0]).toContain('Continue the existing Direct task session');
    expect(humanInputWrites[0]).not.toContain('Standard Iteration Protocol');
    expect(humanInputWrites[0]).not.toContain('implementation_plan.md');
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('"mode":"direct-implementation"'),
      'utf-8'
    );
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('change_requests.jsonl'),
      expect.stringContaining('direct_session.json'),
      'utf-8'
    );
    expect(writeFileAtomicSync).not.toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-direct-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startDirectTaskExecution).toHaveBeenCalledWith(
      '001-direct-review',
      'E:/Work/FastProject',
      '001-direct-review',
      {},
      'project-fast',
    );
    expect(mockAgentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('approves direct review without writing QA artifacts', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { writeFileSync } = await import('fs');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-direct-approve',
        specId: '001-direct-approve',
        projectId: 'project-fast',
        title: 'Direct approve task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: 'direct-implementation', title: 'Direct model execution', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: { workflowMode: 'off', developmentMode: 'direct' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-direct-approve', true);

    expect(result).toEqual({ success: true });
    expect((writeFileSync as Mock).mock.calls.some(([filePath]) =>
      String(filePath).includes('qa_report.md')
    )).toBe(false);
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-direct-approve',
      { type: 'MARK_DONE' },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('restarts coding for qa_rejected human review Request Changes', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const fs = await import('fs');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-qa-review',
        specId: '001-qa-review',
        projectId: 'project-fast',
        title: 'QA review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'qa_rejected',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (fs.existsSync as Mock).mockReturnValue(true);

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-qa-review', false, 'fix please');

    expect(result).toEqual({ success: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('fix please'),
      'utf-8'
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-qa-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('restarts coding for completed human review even without build-failure keywords', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, writeFileSync, readFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-completed-review',
        specId: '001-completed-review',
        projectId: 'project-fast',
        title: 'Completed review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Complete work', description: 'done', status: 'completed', files: [] }
              ]
            }
          ]
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-completed-review', false, 'Please balance the combat values again.');

    expect(result).toEqual({ success: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('combat values'),
      'utf-8'
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('Please balance the combat values again')
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-completed-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('applies a local Standard change patch for legacy balanced metadata that needs new subtasks', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, readFileSync, writeFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-standard-review',
        specId: '001-standard-review',
        projectId: 'project-fast',
        title: 'Standard review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: { workflowMode: 'balanced' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              id: '1',
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Existing work', description: 'done', status: 'completed', files: [] },
              ],
            },
          ],
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-standard-review', false, 'Add another tuning pass with separate verification.');

    expect(result).toEqual({ success: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('update tasks.md with concrete pending subtasks'),
      'utf-8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('tasks.md'),
      expect.stringContaining('Add another tuning pass'),
      'utf-8'
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('Add another tuning pass'),
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('"status": "in_progress"'),
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).not.toBe(true);
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts coding for completed review feedback that contains build failures', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, writeFileSync, readFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-build-failure-review',
        specId: '001-build-failure-review',
        projectId: 'project-fast',
        title: 'Completed task with build failure',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: { developmentMode: 'standard', workflowMode: 'balanced' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Complete work', description: 'done', status: 'completed', files: [] }
              ]
            }
          ]
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-build-failure-review', false, 'npm run build failed with TypeScript error TS2322');

    expect(result).toEqual({ success: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('TS2322'),
      'utf-8'
    );
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('TypeScript error TS2322')
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-build-failure-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts coding for human_review with missing reviewReason', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, writeFileSync } = await import('fs');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-missing-reason',
        specId: '001-missing-reason',
        projectId: 'project-fast',
        title: 'Missing reviewReason task',
        description: 'desc',
        status: 'human_review',
        reviewReason: undefined,
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-missing-reason', false, 'Continue optimizing the value tuning experience.');

    expect(result).toEqual({ success: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('value tuning'),
      'utf-8'
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-missing-reason',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('still appends a new follow-up subtask when plan already has pending subtasks', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, readFileSync } = await import('fs');
    const { writeFileAtomicSync } = await import('../../../utils/atomic-file');

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-pending-followup',
        specId: '001-pending-followup',
        projectId: 'project-fast',
        title: 'Pending follow-up task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
                { id: '1.2', title: 'Pending follow-up', description: 'pending', status: 'pending', files: [] }
              ]
            }
          ]
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-pending-followup', false, '缁х画浼樺寲浣撻獙');

    expect(result).toEqual({ success: true });
    expect(writeFileAtomicSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.stringContaining('"id": "1.3"')
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('saves follow-up subtasks through plan helpers on Request Changes', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync } = await import('fs');
    const planShards = await import('../../../ai/schema/plan-shards');

    const existingPlan = {
      phases: [
        {
          id: '1',
          phase: 1,
          name: 'Implementation',
          type: 'implementation',
          subtasks: [
            { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
          ],
        },
      ],
    };

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-split-followup',
        specId: '001-split-followup',
        projectId: 'project-fast',
        title: 'Split follow-up task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'completed',
        subtasks: [{ id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (existsSync as Mock).mockReturnValue(true);
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockReturnValue(existingPlan);

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-split-followup', false, 'Continue polishing UI details');

    expect(result).toEqual({ success: true });
    expect(planShards.saveImplementationPlanToFilesSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            subtasks: expect.arrayContaining([
              expect.objectContaining({ id: '1.1' }),
              expect.objectContaining({
                id: '1.2',
                status: 'pending',
                description: expect.stringContaining('Continue polishing UI details'),
              }),
            ]),
          }),
        ],
      }),
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });
});
