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
          sourceType: 'openspec',
          openSpecChangeDir: 'openspec/changes/change-001-plan-review',
          openSpecProposalPath: 'openspec/changes/change-001-plan-review/proposal.md',
          openSpecDesignPath: 'openspec/changes/change-001-plan-review/design.md',
          openSpecTasksPath: 'openspec/changes/change-001-plan-review/tasks.md',
          openSpecSpecDeltaPaths: ['openspec/changes/change-001-plan-review/specs/game/spec.md'],
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
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('review-feedback.md'),
      expect.stringContaining('upstream OpenSpec artifacts'),
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
    const { writeFileSync, readFileSync } = await import('fs');
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

  it('restarts coding for completed review feedback that contains build failures', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { writeFileSync, readFileSync } = await import('fs');
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
    const { writeFileSync } = await import('fs');

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
    const { readFileSync } = await import('fs');
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
