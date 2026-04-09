import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
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
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
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
      startQAProcess: vi.fn(),
      killTask: vi.fn(),
      isRunning: vi.fn(() => false),
    };

    const { registerTaskExecutionHandlers } = await import('../execution-handlers');
    registerTaskExecutionHandlers(
      mockAgentManager as never,
      () => mockMainWindow as BrowserWindow,
    );
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
        autoBuildPath: '.auto-claude',
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
      'Git repository required. Please run "git init" in your project directory. Aperant uses git worktrees for isolated builds.',
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
      autoBuildPath: '.auto-claude',
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
        autoBuildPath: '.auto-claude',
        settings: {},
      },
    });

    const updateStatusHandler = handleHandlers[IPC_CHANNELS.TASK_UPDATE_STATUS];
    const result = await updateStatusHandler({}, '001-fast-task', 'backlog', { projectId: 'project-fast' });

    expect(findTaskAndProject).toHaveBeenCalledWith('001-fast-task', 'project-fast');
    expect(result).toEqual({ success: true });
  });

  it('uses PLAN_APPROVED and restarts coding (not QA) for plan_review Request Changes', async () => {
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
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.auto-claude',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('plan_review');
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.json')) {
        return JSON.stringify({
          phases: [{ subtasks: [{ status: 'pending' }] }]
        });
      }
      return '';
    });

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-plan-review', false, 'need changes');

    expect(result).toEqual({ success: true });
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-plan-review',
      { type: 'PLAN_APPROVED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
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
        autoBuildPath: '.auto-claude',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('error');
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.json')) {
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

  it('keeps QA fix flow for regular human review Request Changes', async () => {
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
        reviewReason: 'completed',
        subtasks: [{ id: '1', title: 'Subtask 1', description: 'desc', status: 'completed', files: [] }],
        logs: [],
        metadata: {},
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.auto-claude',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue('human_review');
    (fs.existsSync as Mock).mockReturnValue(true);

    const reviewHandler = handleHandlers[IPC_CHANNELS.TASK_REVIEW];
    const result = await reviewHandler({}, '001-qa-review', false, 'fix please');

    expect(result).toEqual({ success: true });
    expect(mockAgentManager.startQAProcess).toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-qa-review',
      { type: 'USER_RESUMED' },
      expect.any(Object),
      expect.any(Object)
    );
  });
});
