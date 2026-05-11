import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrGetWorktreeMock = vi.fn();
const spawnWorkerProcessMock = vi.fn();
const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'master\n'),
  execFileSync: vi.fn((_command: string, args: string[]) => {
    const joined = args.join(' ');
    if (joined === 'rev-parse --verify main' || joined === 'rev-parse --verify origin/main') {
      throw new Error('ref not found');
    }
    if (joined === 'rev-parse --verify master' || joined === 'rev-parse --verify origin/master') {
      return 'hash\n';
    }
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') {
      throw new Error('origin HEAD not set');
    }
    if (joined === 'branch --show-current') {
      return 'master\n';
    }
    return '';
  }),
}));

vi.mock('../claude-profile-manager', () => ({
  initializeClaudeProfileManager: vi.fn(async () => ({ hasValidAuth: () => true })),
  getClaudeProfileManager: vi.fn(() => ({
    getActiveProfile: vi.fn(() => null),
  })),
}));

vi.mock('../claude-profile/operation-registry', () => ({
  getOperationRegistry: vi.fn(() => ({
    registerOperation: vi.fn(),
  })),
}));

vi.mock('../project-store', () => ({
  projectStore: {
    getProjects: vi.fn(() => [
      {
        id: 'project-1',
        path: 'E:/repo',
        autoBuildPath: '.autocode',
        settings: {},
      },
    ]),
  },
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({})),
}));

vi.mock('../ai/auth/resolver', () => ({
  resolveAuth: vi.fn(async () => ({ apiKey: 'test-key' })),
  resolveAuthFromQueue: vi.fn(),
}));

vi.mock('../ai/security/security-profile', () => ({
  getSecurityProfile: vi.fn(() => ({
    baseCommands: new Set<string>(),
    stackCommands: new Set<string>(),
    scriptCommands: new Set<string>(),
    customCommands: new Set<string>(),
    customScripts: { shellScripts: [] },
  })),
}));

vi.mock('../ai/prompts/prompt-loader', () => ({
  tryLoadPrompt: vi.fn(() => null),
}));

vi.mock('../ai/worktree', () => ({
  createOrGetWorktree: (...args: unknown[]) => createOrGetWorktreeMock(...args),
}));

vi.mock('../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null),
}));

vi.mock('./agent-process', () => ({
  AgentProcessManager: vi.fn().mockImplementation(function MockAgentProcessManager() {
    return {
      spawnWorkerProcess: spawnWorkerProcessMock,
      killProcess: vi.fn(),
      killAllProcesses: vi.fn(async () => undefined),
      getCombinedEnv: vi.fn(() => ({})),
    };
  }),
}));

vi.mock('./agent-queue', () => ({
  AgentQueueManager: vi.fn().mockImplementation(function MockAgentQueueManager() {
    return {
      startRoadmapGeneration: vi.fn(),
      startIdeationGeneration: vi.fn(),
      stopIdeation: vi.fn(() => true),
      isIdeationRunning: vi.fn(() => false),
      stopRoadmap: vi.fn(() => true),
      isRoadmapRunning: vi.fn(() => false),
    };
  }),
}));

describe('AgentManager worktree execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOrGetWorktreeMock.mockResolvedValue({
      worktreePath: 'E:/repo/.autocode/worktrees/tasks/001-task',
      branch: 'autocode/001-task',
    });
  });

  it('uses the current project workspace by default without creating a worktree branch', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', {}, 'project-1');

    expect(createOrGetWorktreeMock).not.toHaveBeenCalled();
    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.projectDir).toBe('E:/repo');
    expect(executorConfig.session.toolContext.cwd).toBe('E:/repo');
  });

  it('auto-detects master as the worktree base branch when worktree isolation is explicitly enabled', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: true }, 'project-1');

    expect(createOrGetWorktreeMock).toHaveBeenCalledWith(
      'E:/repo',
      '001-task',
      'master',
      false,
      true,
      '.autocode',
    );
    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.projectDir).toBe('E:/repo/.autocode/worktrees/tasks/001-task');
    expect(executorConfig.session.toolContext.cwd).toBe('E:/repo/.autocode/worktrees/tasks/001-task');
  });

  it('stops execution when explicitly requested worktree creation fails', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();
    const errorListener = vi.fn();
    const taskEventListener = vi.fn();
    manager.on('error', errorListener);
    manager.on('task-event', taskEventListener);
    createOrGetWorktreeMock.mockRejectedValue(new Error('worktree add failed'));

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: true }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(errorListener).toHaveBeenCalledWith(
      '001-task',
      expect.stringContaining('Execution was stopped to avoid writing changes to the main project branch'),
      'project-1',
    );
    expect(taskEventListener).toHaveBeenCalledWith(
      '001-task',
      expect.objectContaining({
        type: 'CODING_FAILED',
        subtaskId: 'worktree-setup',
        error: 'worktree add failed',
      }),
      'project-1',
    );
  });

  it('still supports explicit direct mode when worktree isolation is disabled', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(createOrGetWorktreeMock).not.toHaveBeenCalled();
    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.projectDir).toBe('E:/repo');
    expect(executorConfig.session.toolContext.cwd).toBe('E:/repo');
  });
});

afterAll(() => {
  emitSpy.mockRestore();
});
