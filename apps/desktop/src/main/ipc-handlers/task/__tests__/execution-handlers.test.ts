import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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
    clearTask: vi.fn(),
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
  let runningTaskKeys: Set<string>;
  const getScopedTaskKey = (taskId: string, projectId?: string): string =>
    projectId ? `${projectId}::${taskId}` : taskId;
  let mockAgentManager: {
    startSpecCreation: ReturnType<typeof vi.fn>;
    startTaskExecution: ReturnType<typeof vi.fn>;
    startDirectTaskExecution: ReturnType<typeof vi.fn>;
    startQAProcess: ReturnType<typeof vi.fn>;
    killTask: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

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

    runningTaskKeys = new Set();
    mockAgentManager = {
      startSpecCreation: vi.fn((taskId: string, _projectPath: string, _taskDescription: string, _specDir?: string, _metadata?: unknown, _baseBranch?: string, projectId?: string) => {
        runningTaskKeys.add(getScopedTaskKey(taskId, projectId));
        return Promise.resolve();
      }),
      startTaskExecution: vi.fn((taskId: string, _projectPath: string, _specId: string, _options?: unknown, projectId?: string) => {
        runningTaskKeys.add(getScopedTaskKey(taskId, projectId));
        return Promise.resolve();
      }),
      startDirectTaskExecution: vi.fn((taskId: string, _projectPath: string, _specId: string, _options?: unknown, projectId?: string) => {
        runningTaskKeys.add(getScopedTaskKey(taskId, projectId));
        return Promise.resolve();
      }),
      startQAProcess: vi.fn(),
      killTask: vi.fn((taskId: string, projectId?: string) => {
        runningTaskKeys.delete(getScopedTaskKey(taskId, projectId));
      }),
      isRunning: vi.fn((taskId: string, projectId?: string) => runningTaskKeys.has(getScopedTaskKey(taskId, projectId))),
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

  it('keeps fully completed human review tasks completed on TASK_START without launching runtime', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, readFileSync } = await import('fs');
    const planShards = await import('../../../ai/schema/plan-shards');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-complete-review',
        specId: '001-complete-review',
        projectId: 'project-fast',
        title: 'Complete task',
        description: 'desc',
        status: 'human_review',
        reviewReason: undefined,
        subtasks: [
          { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
        ],
        logs: [],
        metadata: { workflowMode: 'standard' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (existsSync as Mock).mockImplementation((filePath: string) => filePath.includes('implementation_plan.md'));
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          status: 'human_review',
          planStatus: 'review',
          xstateState: 'human_review',
          executionPhase: 'complete',
          updated_at: '2026-07-08T00:00:00.000Z',
          phases: [
            {
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
              ],
            },
          ],
        });
      }
      return '';
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-complete-review', { projectId: 'project-fast' });

    expect(taskStateManager.prepareForRestart).not.toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).not.toHaveBeenCalled();
    expect(mockAgentManager.startTaskExecution).not.toHaveBeenCalled();
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(mockAgentManager.startDirectTaskExecution).not.toHaveBeenCalled();
    expect(planShards.saveImplementationPlanToFilesSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.objectContaining({
        status: 'human_review',
        reviewReason: 'completed',
        executionPhase: 'complete',
      }),
    );
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '001-complete-review',
      'human_review',
      'project-fast',
      'completed',
    );
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
      '001-complete-review',
      { phase: 'complete', phaseProgress: 100, overallProgress: 100 },
      'project-fast',
    );
  });
  it('does not treat qa rejected human review tasks as completed on TASK_START', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, readFileSync } = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-qa-rejected-complete',
        specId: '001-qa-rejected-complete',
        projectId: 'project-fast',
        title: 'QA rejected task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'qa_rejected',
        subtasks: [
          { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
        ],
        logs: [],
        metadata: { workflowMode: 'standard' },
      },
      project: {
        id: 'project-fast',
        path: 'E:/Work/FastProject',
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('implementation_plan.md') || filePath.includes('spec.md')
    );
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          status: 'human_review',
          reviewReason: 'qa_rejected',
          planStatus: 'review',
          xstateState: 'human_review',
          executionPhase: 'complete',
          updated_at: '2026-07-08T00:00:00.000Z',
          phases: [
            {
              phase: 1,
              name: 'Implementation',
              type: 'implementation',
              subtasks: [
                { id: '1.1', title: 'Done work', description: 'done', status: 'completed', files: [] },
              ],
            },
          ],
        });
      }
      return '';
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-qa-rejected-complete', { projectId: 'project-fast' });

    expect(taskStateManager.prepareForRestart).toHaveBeenCalledWith('001-qa-rejected-complete', 'project-fast');
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockMainWindow.webContents?.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '001-qa-rejected-complete',
      'human_review',
      'project-fast',
      'completed',
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
      expect.stringContaining('Autocode Standard iteration flow incrementally'),
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

  it('restarts incremental Standard planning when stale progress still says planning', async () => {
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
      expect.stringContaining('Impact analysis: requirements, design, tasks, validation'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('First run an incremental task-iteration planning pass'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Update tasks.md by editing represented subtasks in place'),
      'utf-8',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('Do not implement code in this planning pass'),
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
    expect((writeFileSync as Mock).mock.calls.some(([filePath]) =>
      String(filePath).endsWith('spec.md') ||
      String(filePath).endsWith('requirements.md') ||
      String(filePath).endsWith('tasks.md')
    )).toBe(false);
    const atomicPlanWrites = (writeFileAtomicSync as Mock).mock.calls
      .filter(([filePath]) => String(filePath).includes('implementation_plan.md'))
      .map(([, content]) => String(content));
    expect(atomicPlanWrites.join('\n')).toContain('"executionPhase": "planning"');
    expect(atomicPlanWrites.join('\n')).not.toContain('interrupted skills');
    expect(atomicPlanWrites.join('\n')).not.toContain('"executionPhase": "coding"');
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-requirements-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object),
    );
    const humanInputWrites = (writeFileSync as Mock).mock.calls
      .filter(([filePath]) => String(filePath).includes('HUMAN_INPUT.md'))
      .map(([, content]) => String(content));
    const finalHumanInput = humanInputWrites[humanInputWrites.length - 1];
    expect(finalHumanInput).toContain('Use the Autocode Standard iteration flow incrementally');
    expect(finalHumanInput).toContain('Do not regenerate the entire task plan');
    expect(finalHumanInput).toContain('Do not implement code in this planning pass');
    expect(finalHumanInput).not.toContain('planning artifacts were patched locally');
    expect(finalHumanInput).not.toContain('Continue coding from the pending change-request work item');
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
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

  it('forces Standard Request Changes back through planning on TASK_START even when a pending workpackage exists', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { existsSync, readFileSync } = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-standard-cr-start',
        specId: '001-standard-cr-start',
        projectId: 'project-fast',
        title: 'Standard CR task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'stopped',
        subtasks: [{ id: 'CR20260708.1', title: 'Change request work', description: 'desc', status: 'pending', files: [] }],
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
    (existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('spec.md') ||
      filePath.includes('implementation_plan.md') ||
      filePath.includes('HUMAN_INPUT.md') ||
      filePath.includes('change_requests.jsonl')
    );
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              subtasks: [
                { id: 'CR20260708.1', title: 'Change request work', description: 'desc', status: 'pending', files: [] },
              ],
            },
          ],
        });
      }
      if (filePath.includes('HUMAN_INPUT.md')) {
        return 'The user requested a same-task Standard iteration. The planning artifacts were patched locally before this coding pass.';
      }
      if (filePath.includes('change_requests.jsonl')) {
        return JSON.stringify({ scope: 'planning', iteration: { mode: 'standard-planning' } });
      }
      return '';
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-standard-cr-start', { projectId: 'project-fast' });

    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-cr-start',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('does not force Standard Request Changes planning again when approving plan_review', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { existsSync, readFileSync } = await import('fs');

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-standard-cr-plan-review',
        specId: '001-standard-cr-plan-review',
        projectId: 'project-fast',
        title: 'Standard CR plan review task',
        description: 'desc',
        status: 'human_review',
        reviewReason: 'plan_review',
        subtasks: [{ id: '1.1', title: 'Revised work', description: 'desc', status: 'pending', files: [] }],
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
    (taskStateManager.getCurrentState as Mock).mockReturnValue('plan_review');
    (existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('spec.md') ||
      filePath.includes('implementation_plan.md') ||
      filePath.includes('HUMAN_INPUT.md') ||
      filePath.includes('change_requests.jsonl')
    );
    (readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [
            {
              phase: 1,
              subtasks: [
                { id: '1.1', title: 'Revised work', description: 'desc', status: 'pending', files: [] },
              ],
            },
          ],
        });
      }
      if (filePath.includes('HUMAN_INPUT.md')) {
        return 'Standard Iteration Protocol\nDo not implement code in this planning pass.';
      }
      if (filePath.includes('change_requests.jsonl')) {
        return JSON.stringify({ scope: 'planning', iteration: { mode: 'standard-planning' } });
      }
      return '';
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-standard-cr-plan-review', { projectId: 'project-fast' });

    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-cr-plan-review',
      { type: 'PLAN_APPROVED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).not.toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });
  it('syncs newer stopped main plan over stale worktree coding plan before TASK_START', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { findTaskWorktree } = await import('../../../worktree-paths');
    const { projectStore } = await import('../../../project-store');
    const fs = await import('fs');
    const planShards = await import('../../../ai/schema/plan-shards');

    const normalize = (filePath: string) => filePath.replace(/\\/g, '/');
    const taskId = '001-stale-worktree';
    const projectRoot = 'E:/Work/FastProject';
    const worktreeRoot = `${projectRoot}/.autocode/worktrees/tasks/${taskId}`;
    const mainPlanPath = `${projectRoot}/.autocode/specs/${taskId}/implementation_plan.md`;
    const worktreePlanPath = `${worktreeRoot}/.autocode/specs/${taskId}/implementation_plan.md`;
    const plansByPath = new Map<string, Record<string, unknown>>([
      [normalize(mainPlanPath), {
        status: 'human_review',
        planStatus: 'review',
        reviewReason: 'stopped',
        xstateState: 'human_review',
        executionPhase: 'stopped',
        updated_at: '2026-07-07T14:36:15.527Z',
        phases: [{ phase: 1, subtasks: [{ id: 'wp-10', status: 'pending' }] }],
      }],
      [normalize(worktreePlanPath), {
        status: 'in_progress',
        planStatus: 'in_progress',
        xstateState: 'coding',
        executionPhase: 'coding',
        updated_at: '2026-07-07T09:13:52.085Z',
        phases: [{ phase: 1, subtasks: [{ id: 'wp-10', status: 'pending' }] }],
      }],
    ]);

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskWorktree as Mock).mockReturnValue(worktreeRoot);
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: taskId,
        specId: taskId,
        projectId: 'project-fast',
        title: 'Stale worktree task',
        description: 'desc',
        status: 'in_progress',
        subtasks: [],
        logs: [],
        metadata: {},
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 },
      },
      project: {
        id: 'project-fast',
        path: projectRoot,
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue(null);
    (fs.existsSync as Mock).mockImplementation((filePath: string) => {
      const normalizedPath = normalize(filePath);
      return normalizedPath.endsWith('/implementation_plan.md') || normalizedPath.endsWith('/spec.md');
    });
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockImplementation((planPath: string) => {
      const plan = plansByPath.get(normalize(planPath));
      return plan ? JSON.parse(JSON.stringify(plan)) : null;
    });
    (planShards.saveImplementationPlanToFilesSync as Mock).mockImplementation((planPath: string, plan: Record<string, unknown>) => {
      plansByPath.set(normalize(planPath), JSON.parse(JSON.stringify(plan)));
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, taskId, { projectId: 'project-fast' });

    const savedWorktreePlan = (planShards.saveImplementationPlanToFilesSync as Mock).mock.calls
      .find(([filePath]) => normalize(String(filePath)) === normalize(worktreePlanPath))?.[1];
    expect(savedWorktreePlan).toMatchObject({
      status: 'human_review',
      planStatus: 'review',
      reviewReason: 'stopped',
      xstateState: 'human_review',
      executionPhase: 'stopped',
      updated_at: '2026-07-07T14:36:15.527Z',
    });
    expect(plansByPath.get(normalize(worktreePlanPath))).toMatchObject({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
    });
    expect(plansByPath.get(normalize(worktreePlanPath))?.reviewReason).toBeUndefined();
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-fast');
    expect(taskStateManager.clearTask).toHaveBeenCalledWith(taskId, 'project-fast');
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      taskId,
      { type: 'USER_RESUMED' },
      expect.objectContaining({
        status: 'human_review',
        reviewReason: 'stopped',
      }),
      expect.any(Object),
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
  });
  it('recovers coding work item logs across main and worktree plans before TASK_START', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { findTaskWorktree } = await import('../../../worktree-paths');
    const { projectStore } = await import('../../../project-store');
    const { resetStuckSubtasks } = await import('../plan-file-utils');
    const fs = await import('fs');
    const planShards = await import('../../../ai/schema/plan-shards');

    const normalize = (filePath: string) => filePath.replace(/\\/g, '/');
    const taskId = '003-task';
    const projectRoot = 'E:/Work/Test/aitest';
    const worktreeRoot = projectRoot + '/.autocode/worktrees/tasks/' + taskId;
    const mainPlanPath = projectRoot + '/.autocode/specs/' + taskId + '/implementation_plan.md';
    const worktreePlanPath = worktreeRoot + '/.autocode/specs/' + taskId + '/implementation_plan.md';
    const plansByPath = new Map<string, Record<string, unknown>>([
      [normalize(mainPlanPath), {
        status: 'in_progress',
        planStatus: 'in_progress',
        xstateState: 'coding',
        executionPhase: 'coding',
        phases: [{
          phase: 1,
          subtasks: [
            { id: 'wp-9', status: 'completed', completed_at: '2026-07-07T09:13:52.724Z' },
            { id: 'wp-25', status: 'pending' },
          ],
        }],
      }],
      [normalize(worktreePlanPath), {
        status: 'in_progress',
        planStatus: 'in_progress',
        xstateState: 'coding',
        executionPhase: 'coding',
        phases: [{
          phase: 1,
          subtasks: [
            { id: 'wp-9', status: 'in_progress', started_at: '2026-07-07T09:05:50.634Z' },
            { id: 'wp-25', status: 'in_progress', started_at: '2026-07-07T09:11:08.034Z' },
          ],
        }],
      }],
    ]);

    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (findTaskWorktree as Mock).mockReturnValue(worktreeRoot);
    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: taskId,
        specId: taskId,
        projectId: 'project-fast',
        title: 'Recover stale worktree plan',
        description: 'desc',
        status: 'in_progress',
        subtasks: [],
        logs: [],
        metadata: {},
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 },
      },
      project: {
        id: 'project-fast',
        path: projectRoot,
        autoBuildPath: '.autocode',
        settings: {},
      },
    });
    (taskStateManager.getCurrentState as Mock).mockReturnValue(null);
    (resetStuckSubtasks as Mock).mockResolvedValue({ success: true, resetCount: 1 });
    (fs.existsSync as Mock).mockImplementation((filePath: string) => {
      const normalizedPath = normalize(filePath);
      return normalizedPath.endsWith('/implementation_plan.md') ||
        normalizedPath.endsWith('/spec.md') ||
        normalizedPath.endsWith('/task_logs.jsonl');
    });
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (normalize(filePath).endsWith('/task_logs.jsonl')) {
        return JSON.stringify({
          record_type: 'entry',
          entry: {
            timestamp: '2026-07-07T09:13:52.724Z',
            type: 'success',
            content: 'Work item wp-9 completed.',
            phase: 'coding',
            subtask_id: 'wp-9',
          },
        });
      }
      return '';
    });
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockImplementation((planPath: string) => {
      const plan = plansByPath.get(normalize(planPath));
      return plan ? JSON.parse(JSON.stringify(plan)) : null;
    });
    (planShards.saveImplementationPlanToFilesSync as Mock).mockImplementation((planPath: string, plan: Record<string, unknown>) => {
      plansByPath.set(normalize(planPath), JSON.parse(JSON.stringify(plan)));
    });

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, taskId, { projectId: 'project-fast' });

    const recoveredWorktreePlan = plansByPath.get(normalize(worktreePlanPath));
    expect(recoveredWorktreePlan?.phases).toEqual([
      expect.objectContaining({
        subtasks: [
          expect.objectContaining({
            id: 'wp-9',
            status: 'completed',
            completed_at: '2026-07-07T09:13:52.724Z',
          }),
          expect.objectContaining({ id: 'wp-25', status: 'in_progress' }),
        ],
      }),
    ]);
    const resetCalls = (resetStuckSubtasks as Mock).mock.calls.map(([filePath, projectId]) => [
      normalize(String(filePath)),
      projectId,
    ]);
    expect(resetCalls).toContainEqual([normalize(mainPlanPath), 'project-fast']);
    expect(resetCalls).toContainEqual([normalize(worktreePlanPath), 'project-fast']);
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-fast');
    expect(taskStateManager.clearTask).toHaveBeenCalledWith(taskId, 'project-fast');
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
  });

  it('keeps recovered auto-restart in progress after the start call succeeds', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { existsSync } = await import('fs');
    const { resetStuckSubtasks } = await import('../plan-file-utils');
    const { initializeClaudeProfileManager } = await import('../../../claude-profile-manager');
    const { checkGitStatus } = await import('../../../project-initializer');
    const { taskStateManager } = await import('../../../task-state-manager');
    const planShards = await import('../../../ai/schema/plan-shards');

    const planByPath = new Map<string, Record<string, unknown>>();
    const initialPlan = {
      phases: [
        {
          phase: 1,
          name: 'Implementation',
          type: 'implementation',
          subtasks: [
            { id: 'wp-10', title: 'Running package', status: 'in_progress', files: [] },
            { id: 'wp-11', title: 'Pending package', status: 'pending', files: [] },
          ],
        },
      ],
    };

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-restart-no-process',
        specId: '001-restart-no-process',
        projectId: 'project-fast',
        title: 'Restart without process',
        description: 'desc',
        status: 'in_progress',
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
    (existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('implementation_plan.md') || filePath.includes('spec.md')
    );
    (initializeClaudeProfileManager as Mock).mockResolvedValue({
      hasValidAuth: () => true,
    });
    (checkGitStatus as Mock).mockReturnValue({
      isGitRepo: true,
      hasCommits: true,
    });
    (resetStuckSubtasks as Mock).mockResolvedValue({ success: true, resetCount: 1 });
    (mockAgentManager.isRunning as Mock).mockReturnValue(false);
    (mockAgentManager.startTaskExecution as Mock).mockResolvedValue(undefined);
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockImplementation((planPath: string) => {
      const saved = planByPath.get(planPath);
      return JSON.parse(JSON.stringify(saved ?? initialPlan));
    });
    (planShards.saveImplementationPlanToFilesSync as Mock).mockImplementation((planPath: string, plan: Record<string, unknown>) => {
      planByPath.set(planPath, JSON.parse(JSON.stringify(plan)));
    });

    const recoverHandler = handleHandlers[IPC_CHANNELS.TASK_RECOVER_STUCK];
    const result = await recoverHandler({}, '001-restart-no-process', {
      projectId: 'project-fast',
      autoRestart: true,
    });

    expect(result).toEqual({
      success: true,
      data: {
        taskId: '001-restart-no-process',
        recovered: true,
        newStatus: 'in_progress',
        message: 'Task recovered and restarted successfully',
        autoRestarted: true,
      },
    });
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-restart-no-process',
      { type: 'USER_RESUMED' },
      expect.objectContaining({ status: 'human_review', reviewReason: 'stopped' }),
      expect.objectContaining({ id: 'project-fast' }),
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(planShards.saveImplementationPlanToFilesSync).toHaveBeenLastCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.objectContaining({
        status: 'in_progress',
        planStatus: 'in_progress',
        xstateState: 'coding',
        executionPhase: 'coding',
      }),
    );
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '001-restart-no-process',
      'in_progress',
      'project-fast',
      undefined,
    );
  });

  it('keeps recovered stuck coding tasks in stopped review instead of backlog', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { existsSync } = await import('fs');
    const { resetStuckSubtasks } = await import('../plan-file-utils');
    const planShards = await import('../../../ai/schema/plan-shards');

    const incompletePlan = {
      phases: [
        {
          phase: 1,
          name: 'Implementation',
          type: 'implementation',
          subtasks: [
            { id: '1.1', title: 'Done', status: 'completed', files: [] },
            { id: '1.2', title: 'Interrupted', status: 'in_progress', files: [] },
          ],
        },
      ],
    };

    (findTaskAndProject as Mock).mockReturnValue({
      task: {
        id: '001-stuck-coding',
        specId: '001-stuck-coding',
        projectId: 'project-fast',
        title: 'Stuck coding task',
        description: 'desc',
        status: 'in_progress',
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
    (existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('implementation_plan.md')
    );
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockImplementation(() =>
      JSON.parse(JSON.stringify(incompletePlan))
    );
    (resetStuckSubtasks as Mock).mockResolvedValue({ success: true, resetCount: 1 });

    const recoverHandler = handleHandlers[IPC_CHANNELS.TASK_RECOVER_STUCK];
    const result = await recoverHandler({}, '001-stuck-coding', { projectId: 'project-fast' });

    expect(result).toEqual({
      success: true,
      data: {
        taskId: '001-stuck-coding',
        recovered: true,
        newStatus: 'human_review',
        message: 'Task recovered successfully and moved to human_review',
        autoRestarted: false,
      },
    });
    expect(planShards.saveImplementationPlanToFilesSync).toHaveBeenCalledWith(
      expect.stringContaining('implementation_plan.md'),
      expect.objectContaining({
        status: 'human_review',
        planStatus: 'review',
        reviewReason: 'stopped',
        xstateState: 'human_review',
        executionPhase: 'stopped',
      }),
    );
    expect(planShards.saveImplementationPlanToFilesSync).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'backlog' }),
    );
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '001-stuck-coding',
      'human_review',
      'project-fast',
      'stopped',
    );
  });


  it('does not roll TASK_START back just because runtime registration is delayed', async () => {
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
        id: '001-start-delayed-process',
        specId: '001-start-delayed-process',
        projectId: 'project-fast',
        title: 'Start with delayed process registration',
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
    (fs.existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('implementation_plan.md') || filePath.includes('spec.md')
    );
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [{ phase: 1, subtasks: [{ id: 'wp-1', status: 'pending' }] }],
        });
      }
      return '';
    });
    (mockAgentManager.startTaskExecution as Mock).mockResolvedValue(undefined);
    (mockAgentManager.isRunning as Mock).mockReturnValue(false);

    const startHandler = onHandlers[IPC_CHANNELS.TASK_START];
    await startHandler({}, '001-start-delayed-process', { projectId: 'project-fast' });

    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).not.toHaveBeenCalledWith(
      '001-start-delayed-process',
      expect.objectContaining({ type: 'USER_STOPPED' }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockMainWindow.webContents?.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_ERROR,
      '001-start-delayed-process',
      expect.any(String),
      'project-fast',
    );
  });

  it('does not roll TASK_UPDATE_STATUS auto-start back just because runtime registration is delayed', async () => {
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
        id: '001-update-delayed-process',
        specId: '001-update-delayed-process',
        projectId: 'project-fast',
        title: 'Update with delayed process registration',
        description: 'desc',
        status: 'backlog',
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
    (fs.existsSync as Mock).mockImplementation((filePath: string) =>
      filePath.includes('implementation_plan.md') || filePath.includes('spec.md')
    );
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('implementation_plan.md')) {
        return JSON.stringify({
          phases: [{ phase: 1, subtasks: [{ id: 'wp-1', status: 'pending' }] }],
        });
      }
      return '';
    });
    (mockAgentManager.startTaskExecution as Mock).mockResolvedValue(undefined);
    (mockAgentManager.isRunning as Mock).mockReturnValue(false);

    const updateStatusHandler = handleHandlers[IPC_CHANNELS.TASK_UPDATE_STATUS];
    const result = await updateStatusHandler({}, '001-update-delayed-process', 'in_progress', { projectId: 'project-fast' });

    expect(result).toEqual({ success: true });
    expect(taskStateManager.handleUiEvent).not.toHaveBeenCalledWith(
      '001-update-delayed-process',
      expect.objectContaining({ type: 'USER_STOPPED' }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockMainWindow.webContents?.send).toHaveBeenCalledWith(
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '001-update-delayed-process',
      'in_progress',
      'project-fast',
    );
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    const existingDirectChangeSubtaskId = 'direct-cr-20260601000000000';
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { appendFileSync, existsSync, writeFileSync } = await import('fs');
    const planShards = await import('../../../ai/schema/plan-shards');

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
    (planShards.loadImplementationPlanFromFilesSync as Mock).mockReturnValueOnce({
      feature: '001-direct-review',
      workflow_type: 'direct',
      phases: [
        {
          id: 'direct',
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            {
              id: 'direct-implementation',
              title: 'Direct model execution',
              description: 'desc',
              status: 'completed',
              files: [],
            },
            {
              id: existingDirectChangeSubtaskId,
              title: 'Old Direct Request Changes',
              description: 'old desc',
              status: 'completed',
              started_at: '2026-05-31T23:00:00.000Z',
              completed_at: '2026-05-31T23:10:00.000Z',
              completion_summary: 'Old completion summary',
              notes: 'Old completion notes',
              duration_ms: 600000,
              actual_output: 'Old output',
            },
          ],
        },
      ],
    });

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
    const savedPlan = (planShards.saveImplementationPlanToFilesSync as Mock).mock.calls[0][1];
    expect(savedPlan.workflow_type).toBe('direct');
    expect(savedPlan.status).toBe('in_progress');
    expect(savedPlan.direct_execution.current_subtask_id).toBe(existingDirectChangeSubtaskId);
    const restartedDirectSubtask = savedPlan.phases[0].subtasks.find((subtask: Record<string, unknown>) => subtask.id === existingDirectChangeSubtaskId);
    expect(restartedDirectSubtask).toMatchObject({
      id: existingDirectChangeSubtaskId,
      status: 'in_progress',
      title: expect.stringContaining('Direct Request Changes'),
      direct_iteration: true,
    });
    expect(restartedDirectSubtask.completed_at).toBeUndefined();
    expect(restartedDirectSubtask.completion_summary).toBeUndefined();
    expect(restartedDirectSubtask.notes).toBeUndefined();
    expect(restartedDirectSubtask.duration_ms).toBeUndefined();
    expect(restartedDirectSubtask.actual_output).toBeUndefined();
    expect(savedPlan.phases[0].subtasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'direct-implementation', status: 'completed' }),
        expect.objectContaining({
          id: existingDirectChangeSubtaskId,
          status: 'in_progress',
          title: expect.stringContaining('Direct Request Changes'),
          direct_iteration: true,
        }),
      ])
    );
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
      { directSubtaskId: existingDirectChangeSubtaskId },
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

  it('restarts planning for qa_rejected Standard Request Changes', async () => {
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
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-qa-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('restarts planning for completed Standard Request Changes even without build-failure keywords', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, writeFileSync, readFileSync } = await import('fs');

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
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('HUMAN_INPUT.md'),
      expect.stringContaining('incremental task-iteration planning pass'),
      'utf-8'
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-completed-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts planning instead of applying a local Standard change patch', async () => {
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
      expect.stringContaining('Update tasks.md by editing represented subtasks in place'),
      'utf-8'
    );
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-standard-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    const atomicPlanWrites = (writeFileAtomicSync as Mock).mock.calls
      .filter(([filePath]) => String(filePath).includes('implementation_plan.md'))
      .map(([, content]) => String(content));
    expect(atomicPlanWrites.join('\n')).toContain('"executionPhase": "planning"');
    expect(atomicPlanWrites.join('\n')).not.toContain('Add another tuning pass');
    expect(atomicPlanWrites.join('\n')).not.toContain('Change request');
    expect(atomicPlanWrites.join('\n')).not.toContain('"executionPhase": "coding"');
    expect(mockAgentManager.startSpecCreation).not.toHaveBeenCalled();
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts planning for completed Standard Request Changes that contain build failures', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, writeFileSync, readFileSync } = await import('fs');

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
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-build-failure-review',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts planning for Standard human_review Request Changes with missing reviewReason', async () => {
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
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts planning without appending follow-up subtasks when plan already has pending subtasks', async () => {
    const { findTaskAndProject } = await import('../shared');
    const { taskStateManager } = await import('../../../task-state-manager');
    const { existsSync, readFileSync } = await import('fs');

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
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-pending-followup',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });

  it('restarts planning without saving follow-up subtasks on Standard Request Changes', async () => {
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
    expect(taskStateManager.handleUiEvent).toHaveBeenCalledWith(
      '001-split-followup',
      { type: 'PLANNING_STARTED' },
      expect.any(Object),
      expect.any(Object)
    );
    expect(planShards.saveImplementationPlanToFilesSync).toHaveBeenCalled();
    const savedPlan = (planShards.saveImplementationPlanToFilesSync as Mock).mock.calls[0]?.[1] as any;
    expect(savedPlan.executionPhase).toBe('planning');
    expect(savedPlan.planStatus).toBe('planning');
    expect(savedPlan.phases[0].subtasks).toHaveLength(1);
    expect(JSON.stringify(savedPlan)).not.toContain('Continue polishing UI details');
    expect(JSON.stringify(savedPlan)).not.toContain('"id":"1.2"');
    expect(mockAgentManager.startTaskExecution).toHaveBeenCalled();
    const startOptions = mockAgentManager.startTaskExecution.mock.calls[0]?.[3];
    expect(startOptions?.forcePlanning).toBe(true);
    expect(mockAgentManager.startQAProcess).not.toHaveBeenCalled();
  });
});
