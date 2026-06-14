import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrGetWorktreeMock = vi.fn();
const spawnWorkerProcessMock = vi.fn();
const spawnProcessMock = vi.fn();
const createStartedAutocodeAgentRuntimeMock = vi.fn(() => ({
  request: {
    runner: {
      process: {
        cwd: 'E:/repo',
        command: 'codex',
        args: ['exec', 'run'],
        shellCommand: 'codex exec run',
      },
    },
  },
}));
const resolveAutocodeDirectSessionStateMock = vi.fn((..._args: unknown[]): unknown => null);
const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

const writeFileSyncMock = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  };
});

vi.mock('child_process', () => ({
  execFile: vi.fn((_command: string, _args: string[], optionsOrCallback?: unknown, callback?: unknown) => {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (typeof cb === 'function') {
      cb(null, '', '');
    }
  }),
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
    if (joined === 'rev-parse HEAD') {
      return 'baseline1234567890abcdef\n';
    }
    return '';
  }),
}));

vi.mock('@autocode/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@autocode/core')>();
  return {
    ...actual,
    createStartedAutocodeAgentRuntime: (_input: unknown) =>
      createStartedAutocodeAgentRuntimeMock(),
    resolveAutocodeDirectSessionState: (...args: unknown[]) =>
      resolveAutocodeDirectSessionStateMock(...args),
    buildAutocodeDirectTaskExecutionMessages: (input: {
      directSessionState?: { providerResponseId?: string } | null;
      directContinuationMode?: 'provider' | 'summary';
    }) => {
      if (input.directSessionState && input.directContinuationMode) {
        return [{
          role: 'user',
          content: [
            `Provider continuation: ${input.directSessionState.providerResponseId ?? 'summary'}`,
            '继续修复按钮无反应的问题。',
          ].join('\n'),
        }];
      }
      return actual.buildAutocodeDirectTaskExecutionMessages(input as never);
    },
  };
});

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
      spawnProcess: spawnProcessMock,
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
    writeFileSyncMock.mockReset();
    spawnProcessMock.mockReset();
    createStartedAutocodeAgentRuntimeMock.mockClear();
    resolveAutocodeDirectSessionStateMock.mockReset();
    resolveAutocodeDirectSessionStateMock.mockReturnValue(null);
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
    expect(executorConfig.session.runtimeConcurrency).toEqual({
      mode: 'concurrent',
      workers: 2,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
  });

  it('keeps spec creation initial messages compact without duplicating project docs', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();
    const longTaskDescription = [
      'Opening spec task rule: keep app-owned structured files as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large spec creation context ${index}: ${'project documentation noise '.repeat(6)}`,
      ),
      'Closing spec task rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    await manager.startSpecCreation('001-task', 'E:/repo', longTaskDescription, undefined, undefined, undefined, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    const content = executorConfig.session.initialMessages[0].content;
    expect(content).toContain('Opening spec task rule: keep app-owned structured files as JSON.');
    expect(content).toContain('task description middle omitted for initial session budget');
    expect(content).toContain('Closing spec task rule: convert only model-readable prose references to Markdown.');
    expect(content).not.toContain('Large spec creation context 160');
    expect(content).not.toContain('Project Documentation Reference');
    expect(content).toContain('Project directory: E:/repo');
  });

  it('captures the baseline commit when running in the current project workspace', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(createOrGetWorktreeMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('task_metadata.json'),
      expect.stringContaining('directWorkspaceBaselineCommit'),
      'utf-8',
    );
    const writtenMetadata = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string);
    expect(writtenMetadata.directWorkspaceBaselineCommit).toBe('baseline1234567890abcdef');
    expect(writtenMetadata.directWorkspaceBaselineBranch).toBe('master');
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
      false,
      '.autocode',
      false,
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

  it('routes workflow off tasks to a direct single-session agent', async () => {
    const fs = await import('fs');
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'sonnet', thinkingLevel: 'high' })
    );
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', {}, 'project-1');

    expect(createOrGetWorktreeMock).not.toHaveBeenCalled();
    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.agentType).toBe('direct_task');
    expect(executorConfig.session.workflowMode).toBe('off');
    expect(executorConfig.session.phase).toBe('coding');
    expect(executorConfig.session.maxSteps).toBe(60);
    expect(executorConfig.session.thinkingLevel).toBe('high');
    expect(executorConfig.session.responsePersistence).toBe(false);
    expect(executorConfig.session.mcpOptions).toMatchObject({
      context7Enabled: false,
      memoryEnabled: false,
      linearEnabled: false,
      yunxiaoEnabled: false,
    });
    expect(executorConfig.session.projectDir).toBe('E:/repo');
  });

  it('continues direct tasks with an openai previous response id instead of full context', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'openai-1', provider: 'openai' }],
      globalPriorityOrder: ['openai-1'],
      language: 'zh-CN',
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'openai-1',
      resolvedProvider: 'openai.responses',
      resolvedModelId: 'gpt-5.3-codex',
      apiKey: 'test-key',
    });
    resolveAutocodeDirectSessionStateMock.mockReturnValue({
      version: 1,
      sessionId: 'direct-session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      provider: 'openai.responses',
      modelId: 'gpt-5.3-codex',
      providerResponseId: 'resp_prev',
      latestSummary: 'Old direct summary that should not be resent for provider continuation.',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') ||
      filePath.endsWith('HUMAN_INPUT.md') ||
      filePath.endsWith('change_requests.jsonl')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('HUMAN_INPUT.md')) {
        return '继续修复按钮无反应的问题。';
      }
      if (filePath.endsWith('change_requests.jsonl')) {
        return JSON.stringify({ feedback: '继续修复按钮无反应的问题。' });
      }
      return JSON.stringify({ workflowMode: 'off', model: 'gpt-5.3-codex' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.sessionId).toBe('direct-session-1');
    expect(executorConfig.session.previousResponseId).toBe('resp_prev');
    expect(executorConfig.session.responsePersistence).toBe(true);
    expect(executorConfig.session.directProviderContinuation).toBe(true);
    expect(executorConfig.session.initialMessages[0].content).toContain('Provider continuation');
    expect(executorConfig.session.initialMessages[0].content).toContain('继续修复按钮无反应的问题。');
    expect(executorConfig.session.initialMessages[0].content).not.toContain('Prior Direct Session Summary');
  });

  it('passes the task spec directory to Codex CLI workspace claims', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'codex-1', provider: 'openai' }],
      globalPriorityOrder: ['codex-1'],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'codex-1',
      resolvedProvider: 'openai',
      resolvedModelId: 'gpt-5.5',
      source: 'codex-oauth',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          '',
          '- [ ] 1. Build UI',
          '  - [ ] 1.1 Add board',
          '    - _Files: src/board.ts_',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'balanced', model: 'gpt-5.5' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(spawnProcessMock).toHaveBeenCalled();
    const workspaceClaim = spawnProcessMock.mock.calls[0][6];
    expect(workspaceClaim.fileIntents).toEqual(['src/board.ts']);
  });
});

afterAll(() => {
  emitSpy.mockRestore();
});
