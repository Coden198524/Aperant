import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createOrGetWorktreeMock = vi.fn();
const spawnWorkerProcessMock = vi.fn();
const spawnProcessMock = vi.fn();
const invalidateTasksCacheMock = vi.fn();
const createStartedAutocodeAgentRuntimeMock = vi.fn((_input?: unknown) => ({
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
const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
const originalCliRuntimeRoutesEnv = {
  json: process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON,
  routes: process.env.AUTOCODE_CLI_RUNTIME_ROUTES,
};
const originalDirectProviderContinuationCapabilitiesEnv = {
  json: process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES_JSON,
  capabilities: process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES,
};
const originalDirectProviderFallbackCapabilitiesEnv = {
  json: process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES_JSON,
  capabilities: process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES,
};
const originalModelProviderRoutesEnv = {
  json: process.env.AUTOCODE_MODEL_PROVIDER_ROUTES_JSON,
  routes: process.env.AUTOCODE_MODEL_PROVIDER_ROUTES,
};

const originalProviderModelInvocationRoutesEnv = {
  json: process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES_JSON,
  routes: process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES,
};
const writeFileSyncMock = vi.fn();
const readSettingsFileMock = vi.fn(() => ({}));
const initializeClaudeProfileManagerMock = vi.fn(async (): Promise<{ hasValidAuth: () => boolean }> => ({ hasValidAuth: () => true }));

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
  const parseDirectCapabilities = (value: unknown) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map((item) => {
      const record = item as {
        id?: string;
        mode?: 'provider';
        condition?: {
          provider?: string;
          providerPrefix?: string;
          provider_prefix?: string;
          modelIdPrefix?: string;
          model_id_prefix?: string;
          transport?: string;
          providerTransport?: string;
          provider_transport?: string;
          transportPrefix?: string;
          transport_prefix?: string;
        };
        providerOptions?: Record<string, Record<string, unknown>>;
        continuationProviderOptions?: Record<string, Record<string, unknown>>;
        providerResponseIdFields?: string[];
      };
      return {
        id: record.id ?? 'configured-provider-continuation',
        mode: record.mode ?? 'provider',
        providerOptions: record.providerOptions,
        continuationProviderOptions: record.continuationProviderOptions,
        providerResponseIdFields: record.providerResponseIdFields,
        supports: ({ provider, modelId, transport }: { provider: unknown; modelId: string; transport?: unknown }) => {
          const condition = record.condition ?? {};
          const providerText = String(provider ?? '');
          const transportText = String(transport ?? provider ?? '');
          const providerPrefix = condition.providerPrefix ?? condition.provider_prefix;
          const modelIdPrefix = condition.modelIdPrefix ?? condition.model_id_prefix;
          const exactTransport = condition.transport ?? condition.providerTransport ?? condition.provider_transport;
          const transportPrefix = condition.transportPrefix ?? condition.transport_prefix;
          if (condition.provider && providerText !== condition.provider) return false;
          if (providerPrefix && !providerText.startsWith(providerPrefix)) return false;
          if (modelIdPrefix && !modelId.startsWith(modelIdPrefix)) return false;
          if (exactTransport && transportText !== exactTransport && providerText !== exactTransport) return false;
          if (transportPrefix && !transportText.startsWith(transportPrefix) && !providerText.startsWith(transportPrefix)) return false;
          return true;
        },
      };
    });
  };
  const parseFallbackCapabilities = (value: unknown) => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    return items.map((item) => {
      const record = item as {
        id?: string;
        condition?: {
          provider?: string;
          providerPrefix?: string;
          provider_prefix?: string;
          modelIdPrefix?: string;
          model_id_prefix?: string;
          transport?: string;
          providerTransport?: string;
          provider_transport?: string;
          transportIncludes?: string;
          transport_includes?: string;
          providerTransportIncludes?: string;
          provider_transport_includes?: string;
        };
        fallbackInvocationMethod?: 'call' | 'chat' | 'responses' | 'chatModel';
        fallback_invocation_method?: 'call' | 'chat' | 'responses' | 'chatModel';
        fallbackProviderTransport?: string;
        fallback_provider_transport?: string;
        errorMatchers?: Array<{ messageIncludes?: string[]; message_includes?: string[] }>;
        error_matchers?: Array<{ messageIncludes?: string[]; message_includes?: string[] }>;
        resetProviderPersistence?: boolean;
        reset_provider_persistence?: boolean;
      };
      const fallbackInvocationMethod = record.fallbackInvocationMethod ?? record.fallback_invocation_method ?? 'chatModel';
      const fallbackProviderTransport = record.fallbackProviderTransport ?? record.fallback_provider_transport;
      const errorMatchers = (record.errorMatchers ?? record.error_matchers ?? [])
        .map((matcher) => ({ messageIncludes: matcher.messageIncludes ?? matcher.message_includes ?? [] }))
        .filter((matcher) => matcher.messageIncludes.length > 0);
      return {
        id: record.id ?? 'configured-provider-fallback',
        fallbackInvocationMethod,
        ...(fallbackProviderTransport ? { fallbackProviderTransport } : {}),
        errorMatchers,
        resetProviderPersistence: record.resetProviderPersistence ?? record.reset_provider_persistence ?? true,
        supports: ({ provider, modelId, transport }: { provider: unknown; modelId: string; transport?: unknown }) => {
          const condition = record.condition ?? {};
          const providerText = String(provider ?? '');
          const transportText = String(transport ?? provider ?? '');
          const providerPrefix = condition.providerPrefix ?? condition.provider_prefix;
          const modelIdPrefix = condition.modelIdPrefix ?? condition.model_id_prefix;
          const exactTransport = condition.transport ?? condition.providerTransport ?? condition.provider_transport;
          const transportIncludes = condition.transportIncludes ?? condition.transport_includes ?? condition.providerTransportIncludes ?? condition.provider_transport_includes;
          if (condition.provider && providerText !== condition.provider) return false;
          if (providerPrefix && !providerText.startsWith(providerPrefix)) return false;
          if (modelIdPrefix && !modelId.startsWith(modelIdPrefix)) return false;
          if (exactTransport && transportText !== exactTransport && providerText !== exactTransport) return false;
          if (transportIncludes && !transportText.includes(transportIncludes) && !providerText.includes(transportIncludes)) return false;
          return true;
        },
      };
    });
  };
  const openaiDirectCapability = {
    id: 'responses-previous-response',
    mode: 'provider' as const,
    providerOptions: { openai: { store: true } },
    continuationProviderOptions: { openai: { store: true, previousResponseId: '{providerResponseId}' } },
    providerResponseIdFields: ['openai.responseId'],
    supports: ({ provider, transport }: { provider: unknown; modelId: string; transport?: unknown }) => {
      const candidates = [provider, transport].map((value) => String(value ?? '').toLowerCase());
      return candidates.some((value) => value === 'openai.responses' || value === 'openai-responses' || value === 'responses');
    },
  };
  const buildDirectRuntime = (input: { capability: typeof openaiDirectCapability; providerResponseId?: string }) => ({
    capabilityId: input.capability.id,
    mode: input.capability.mode,
    providerOptions: input.capability.providerOptions,
    continuationProviderOptions: input.capability.continuationProviderOptions,
    providerResponseIdFields: input.capability.providerResponseIdFields,
    ...(input.providerResponseId ? { providerResponseId: input.providerResponseId } : {}),
  });
  return {
    ...actual,
    buildAutocodeDirectProviderContinuationRuntime: buildDirectRuntime,
    buildAutocodeDirectProviderFallbackRuntime: (input: { capability: { id: string; fallbackInvocationMethod: string; fallbackProviderTransport?: string; errorMatchers: Array<{ messageIncludes: string[] }>; resetProviderPersistence: boolean } }) => ({
      capabilityId: input.capability.id,
      fallbackInvocationMethod: input.capability.fallbackInvocationMethod,
      ...(input.capability.fallbackProviderTransport ? { fallbackProviderTransport: input.capability.fallbackProviderTransport } : {}),
      errorMatchers: input.capability.errorMatchers,
      resetProviderPersistence: input.capability.resetProviderPersistence,
    }),
    parseAutocodeDirectProviderContinuationCapabilities: parseDirectCapabilities,
    parseAutocodeDirectProviderFallbackCapabilities: parseFallbackCapabilities,
    resolveAutocodeDirectProviderContinuationCapability: (input: { provider: unknown; modelId: string; transport?: unknown; capabilities?: Array<{ supports: (input: { provider: unknown; modelId: string; transport?: unknown }) => boolean }> }) =>
      input.capabilities?.find((capability) => capability.supports(input)) ??
      (openaiDirectCapability.supports(input) ? openaiDirectCapability : null),
    resolveAutocodeDirectProviderFallbackCapability: (input: { provider: unknown; modelId: string; transport?: unknown; capabilities?: Array<{ supports: (input: { provider: unknown; modelId: string; transport?: unknown }) => boolean }> }) =>
      input.capabilities?.find((capability) => capability.supports(input)) ?? null,
    createStartedAutocodeAgentRuntime: (input: unknown) =>
      createStartedAutocodeAgentRuntimeMock(input),
    resolveAutocodeCliRuntimeRoute: (input: Parameters<typeof actual.resolveAutocodeCliRuntimeRoute>[0]) =>
      actual.resolveAutocodeCliRuntimeRoute(input),
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
            'Continue fixing the button.',
          ].join('\n'),
        }];
      }
      return actual.buildAutocodeDirectTaskExecutionMessages(input as never);
    },
  };
});

vi.mock('../claude-profile-manager', () => ({
  initializeClaudeProfileManager: initializeClaudeProfileManagerMock,
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
    invalidateTasksCache: (...args: unknown[]) => invalidateTasksCacheMock(...args),
  },
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: readSettingsFileMock,
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
    delete process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON;
    delete process.env.AUTOCODE_CLI_RUNTIME_ROUTES;
    delete process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES_JSON;
    delete process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES;
    delete process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES_JSON;
    delete process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES;
    delete process.env.AUTOCODE_MODEL_PROVIDER_ROUTES_JSON;
    delete process.env.AUTOCODE_MODEL_PROVIDER_ROUTES;
    delete process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES_JSON;
    delete process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES;
    vi.clearAllMocks();
    readSettingsFileMock.mockReset();
    readSettingsFileMock.mockReturnValue({});
    writeFileSyncMock.mockReset();
    spawnProcessMock.mockReset();
    invalidateTasksCacheMock.mockReset();
    createStartedAutocodeAgentRuntimeMock.mockClear();
    initializeClaudeProfileManagerMock.mockReset();
    initializeClaudeProfileManagerMock.mockResolvedValue({ hasValidAuth: () => true });
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
      workers: 5,
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
    expect(executorConfig.session.workflowMode).toBe('balanced');
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
    const refreshListener = vi.fn();
    manager.on('tasks-refresh', refreshListener);

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
    expect(invalidateTasksCacheMock).toHaveBeenCalledWith('project-1');
    expect(refreshListener).toHaveBeenCalledWith('001-task', 'project-1');
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

  it('uses configured model provider routes when resolving Direct task provider preference', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{
        id: 'compatible-1',
        provider: 'openai-compatible',
        name: 'Compatible Endpoint',
        authType: 'api-key',
        billingModel: 'pay-per-use',
        apiKey: 'sk-compatible',
        createdAt: 0,
        updatedAt: 0,
      }],
      globalPriorityOrder: ['compatible-1'],
      autocodeModelProviderRoutes: [
        { provider: 'openai-compatible', modelIdPrefix: 'future-' },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'compatible-1',
      resolvedProvider: 'openai-compatible',
      resolvedModelId: 'future-large',
      apiKey: 'sk-compatible',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'future-large' })
    );

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(authResolver.resolveAuthFromQueue).toHaveBeenCalledWith(
      'future-large',
      expect.any(Array),
      expect.objectContaining({
        executionMode: 'agentic',
        requestedProvider: 'openai-compatible',
        modelProviderRoutes: expect.arrayContaining([
          expect.objectContaining({
            provider: 'openai-compatible',
            modelIdPrefix: ['future-'],
          }),
        ]),
      }),
    );
    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.provider).toBe('openai-compatible');
    expect(executorConfig.session.modelId).toBe('future-large');
  });

  it('emits early auth errors with project scope for every task start path', async () => {
    initializeClaudeProfileManagerMock.mockResolvedValue({ hasValidAuth: () => false });
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();
    const errorListener = vi.fn();
    manager.on('error', errorListener);

    await manager.startSpecCreation('001-task', 'E:/repo', 'Task description', undefined, undefined, undefined, 'project-1');
    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', {}, 'project-1');
    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', {}, 'project-1');
    await manager.startQAProcess('001-task', 'E:/repo', '001-task', 'project-1');

    expect(errorListener).toHaveBeenCalledTimes(4);
    for (const call of errorListener.mock.calls) {
      expect(call).toEqual([
        '001-task',
        'Authentication required. Please add an account in Settings > Accounts before starting tasks.',
        'project-1',
      ]);
    }
    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(spawnProcessMock).not.toHaveBeenCalled();
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
        return 'Continue fixing the button.';
      }
      if (filePath.endsWith('change_requests.jsonl')) {
        return JSON.stringify({ feedback: 'Continue fixing the button.' });
      }
      return JSON.stringify({ workflowMode: 'off', model: 'gpt-5.3-codex' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.sessionId).toBe('direct-session-1');
    expect(executorConfig.session.previousResponseId).toBeUndefined();
    expect(executorConfig.session.responsePersistence).toBe(true);
    expect(executorConfig.session.providerResponsePersistence).toMatchObject({
      capabilityId: 'responses-previous-response',
      providerResponseId: 'resp_prev',
      continuationProviderOptions: {
        openai: { previousResponseId: '{providerResponseId}' },
      },
    });
    expect(executorConfig.session.providerResponseIdFields).toContain('openai.responseId');
    expect(executorConfig.session.directProviderContinuation).toBe(true);
    expect(executorConfig.session.initialMessages[0].content).toContain('Provider continuation');
    expect(executorConfig.session.initialMessages[0].content).toContain('Continue fixing the button.');
    expect(executorConfig.session.initialMessages[0].content).not.toContain('Prior Direct Session Summary');
  });

  it('continues direct tasks through configured provider-native persistence', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
      autocodeDirectProviderContinuationCapabilities: [
        {
          id: 'future-response-state',
          mode: 'provider',
          condition: {
            provider: 'future-ai',
            modelIdPrefix: 'future-',
          },
          providerOptions: {
            future: { store: true },
          },
          continuationProviderOptions: {
            future: {
              store: true,
              previousStateId: '{providerResponseId}',
            },
          },
          providerResponseIdFields: ['future.stateId'],
        },
      ],
      autocodeDirectProviderFallbackCapabilities: [
        {
          id: 'future-state-fallback',
          condition: {
            provider: 'future-ai',
          },
          fallbackInvocationMethod: 'chat',
          fallbackProviderTransport: '{provider}.chat',
          errorMatchers: [
            { messageIncludes: ['state id', 'not found'] },
          ],
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
    });
    resolveAutocodeDirectSessionStateMock.mockReturnValue({
      version: 1,
      sessionId: 'direct-session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      provider: 'future-ai',
      modelId: 'future-large',
      providerResponseId: 'state_prev',
      latestSummary: 'Old direct summary.',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'future-large' })
    );

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.responsePersistence).toBe(true);
    expect(executorConfig.session.providerResponsePersistence).toMatchObject({
      capabilityId: 'future-response-state',
      providerResponseId: 'state_prev',
      providerResponseIdFields: ['future.stateId'],
      continuationProviderOptions: {
        future: { previousStateId: '{providerResponseId}' },
      },
    });
    expect(executorConfig.session.providerFallback).toMatchObject({
      capabilityId: 'future-state-fallback',
      fallbackInvocationMethod: 'chat',
      fallbackProviderTransport: '{provider}.chat',
    });
    expect(executorConfig.session.directProviderContinuation).toBe(true);
  });

  it('continues direct tasks through environment-defined provider-native persistence', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES = JSON.stringify([
      {
        id: 'env-future-response-state',
        mode: 'provider',
        condition: {
          providerPrefix: 'future-',
          modelIdPrefix: 'future-',
        },
        providerOptions: {
          future: { store: true },
        },
        continuationProviderOptions: {
          future: {
            store: true,
            previousStateId: '{providerResponseId}',
          },
        },
        providerResponseIdFields: ['future.stateId'],
      },
    ]);
    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
    });
    resolveAutocodeDirectSessionStateMock.mockReturnValue({
      version: 1,
      sessionId: 'direct-session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      provider: 'future-ai',
      modelId: 'future-large',
      providerResponseId: 'state_prev',
      latestSummary: 'Old direct summary.',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'future-large' })
    );

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.responsePersistence).toBe(true);
    expect(executorConfig.session.providerResponsePersistence).toMatchObject({
      capabilityId: 'env-future-response-state',
      providerResponseId: 'state_prev',
      providerResponseIdFields: ['future.stateId'],
      continuationProviderOptions: {
        future: { previousStateId: '{providerResponseId}' },
      },
    });
    expect(executorConfig.session.directProviderContinuation).toBe(true);
  });
  it('matches direct provider persistence by inferred provider transport', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'openai-1', provider: 'openai' }],
      globalPriorityOrder: ['openai-1'],
      autocodeDirectProviderContinuationCapabilities: [
        {
          id: 'configured-openai-responses-state',
          mode: 'provider',
          condition: {
            providerTransport: 'openai.responses',
          },
          providerOptions: {
            openai: { store: true },
          },
          continuationProviderOptions: {
            openai: {
              store: true,
              previousResponseId: '{providerResponseId}',
            },
          },
          providerResponseIdFields: ['openai.responseId'],
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'openai-1',
      resolvedProvider: 'openai',
      resolvedModelId: 'gpt-5.3-codex',
      apiKey: 'openai-key',
      source: 'api-key',
    });
    resolveAutocodeDirectSessionStateMock.mockReturnValue({
      version: 1,
      sessionId: 'direct-session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      provider: 'openai',
      modelId: 'gpt-5.3-codex',
      providerResponseId: 'resp_prev',
      latestSummary: 'Old direct summary.',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'gpt-5.3-codex' })
    );

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.providerResponsePersistence).toMatchObject({
      capabilityId: 'configured-openai-responses-state',
      providerResponseId: 'resp_prev',
    });
    expect(executorConfig.session.directProviderContinuation).toBe(true);
  });


  it('matches direct provider persistence through configured provider model invocation routes', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    const invocationRoute = {
      provider: 'openai',
      modelIdPrefix: 'future-resp-',
      method: 'responses' as const,
    };
    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'openai-1', provider: 'openai' }],
      globalPriorityOrder: ['openai-1'],
      autocodeProviderModelInvocationRoutes: [invocationRoute],
      autocodeDirectProviderContinuationCapabilities: [
        {
          id: 'configured-future-openai-responses-state',
          mode: 'provider',
          condition: {
            providerTransport: 'openai.responses',
          },
          providerOptions: {
            openai: { store: true },
          },
          continuationProviderOptions: {
            openai: {
              store: true,
              previousResponseId: '{providerResponseId}',
            },
          },
          providerResponseIdFields: ['openai.responseId'],
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'openai-1',
      resolvedProvider: 'openai',
      resolvedModelId: 'future-resp-large',
      apiKey: 'openai-key',
      source: 'api-key',
    });
    resolveAutocodeDirectSessionStateMock.mockReturnValue({
      version: 1,
      sessionId: 'direct-session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      provider: 'openai',
      modelId: 'future-resp-large',
      providerResponseId: 'resp_prev',
      latestSummary: 'Old direct summary.',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      JSON.stringify({ workflowMode: 'off', model: 'future-resp-large' })
    );

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.providerModelInvocationRoutes).toEqual([invocationRoute]);
    expect(executorConfig.session.providerTransport).toBe('openai.responses');
    expect(executorConfig.session.providerResponsePersistence).toMatchObject({
      capabilityId: 'configured-future-openai-responses-state',
      providerResponseId: 'resp_prev',
    });
    expect(executorConfig.session.directProviderContinuation).toBe(true);
  });

  it('binds direct execution to current direct metadata before stale pending nodes', async () => {
    const fs = await import('fs');

    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-new","summary_file":"direct_summary.md"}} -->',
          '',
          '- [ ] direct. Direct execution',
          '  - [ ] direct-cr-old Direct Request Changes',
          '    - Older pending Direct iteration that should not steal the runtime binding.',
          '  - [/] direct-cr-new Direct Request Changes',
          '    - Current Direct iteration from direct_execution metadata.',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'sonnet' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).toHaveBeenCalled();
    const executorConfig = spawnWorkerProcessMock.mock.calls[0][1];
    expect(executorConfig.session.subtaskId).toBe('direct-cr-new');
  });

  it('routes Direct CLI runtime from settings-defined model routes', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'deepseek-1', provider: 'deepseek' }],
      globalPriorityOrder: ['deepseek-1'],
      autocodeCliRuntimeRoutes: [
        {
          id: 'deepseek-direct-cli',
          displayName: 'DeepSeek CLI',
          cli: 'deepseek',
          condition: {
            provider: 'deepseek',
            modelIdPrefix: 'deepseek-',
          },
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'deepseek-1',
      resolvedProvider: 'deepseek',
      resolvedModelId: 'deepseek-v4-flash',
      apiKey: 'deepseek-key',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'deepseek-v4-flash' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'deepseek',
      model: 'deepseek-v4-flash',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });
  it('routes Direct CLI runtime from task metadata-defined routes', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({
        workflowMode: 'off',
        model: 'future-large',
        autocodeCliRuntimeRoutes: [
          {
            id: 'metadata-future-direct-cli',
            displayName: 'Metadata Future CLI',
            cli: 'future-code',
            taskRunStrategy: {
              args: ['run', '--json'],
              modelFlag: '--model',
              promptStdinArg: '--stdin',
            },
            condition: {
              provider: 'future-ai',
              modelIdPrefix: 'future-',
            },
          },
        ],
      });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'future-code',
      directCliRuntimeRouteId: 'metadata-future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Metadata Future CLI',
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      model: 'future-large',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });

  it('routes Direct CLI runtime through configured external CLI identifiers', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
      autocodeCliRuntimeRoutes: [
        {
          id: 'future-code-direct-cli',
          displayName: 'Future Code',
          cli: 'future-code',
          taskRunStrategy: {
            args: ['run', '--json'],
            modelFlag: '--model',
            promptStdinArg: '--stdin',
          },
          condition: {
            provider: 'future-ai',
            modelIdPrefix: 'future-',
          },
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'future-large' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'future-code',
      customCommand: undefined,
      directCliRuntimeRouteId: 'future-code-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future Code',
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      model: 'future-large',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });
  it('starts configured future Direct CLI routes without built-in provider auth mapping', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    initializeClaudeProfileManagerMock.mockResolvedValue({ hasValidAuth: () => false });
    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [],
      autocodeModelProviderRoutes: [
        { provider: 'future-ai', modelIdPrefix: 'future-' },
      ],
      autocodeCliRuntimeRoutes: [
        {
          id: 'future-code-direct-cli',
          displayName: 'Future Code',
          cli: 'future-code',
          taskRunStrategy: {
            args: ['run', '--json'],
            modelFlag: '--model',
            promptStdinArg: '--stdin',
          },
          condition: {
            provider: 'future-ai',
            modelIdPrefix: 'future-',
          },
        },
      ],
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'future-large' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(authResolver.resolveAuthFromQueue).not.toHaveBeenCalled();
    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'future-code',
      directCliRuntimeRouteId: 'future-code-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future Code',
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      model: 'future-large',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });
  it('routes Direct CLI runtime through configured custom command templates', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
      autocodeCliRuntimeRoutes: [
        {
          id: 'future-direct-cli',
          displayName: 'Future CLI',
          cli: 'custom',
          customCommand: 'future-code --provider {provider} --model {modelId} run',
          permissionBypassArgs: ['--future-allow'],
          taskRunStrategy: {
            args: ['run', '--json'],
            modelFlag: '--model',
            promptStdinArg: '--stdin',
          },
          jsonEventParser: {
            type: 'future-json',
            displayName: 'Future JSON',
            commandNames: ['future-code'],
            sessionIdFields: ['conversation_id'],
            messageFields: ['message'],
          },
          continuationStrategy: {
            type: 'append-continuation-flag',
            commandNames: ['future-code'],
            continuationFlag: '--continue',
            sessionIdSource: 'latest',
          },
          condition: {
            provider: 'future-ai',
            modelIdPrefix: 'future-',
          },
        },
      ],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'future-large' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'custom',
      customCommand: 'future-code --provider future-ai --model future-large run',
      directCliContinuationStrategy: expect.objectContaining({
        type: 'append-continuation-flag',
        commandNames: ['future-code'],
        continuationFlag: '--continue',
      }),
      directCliJsonEventParser: expect.objectContaining({
        type: 'future-json',
        commandNames: ['future-code'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
      }),
      directCliRuntimeRouteId: 'future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future CLI',
      directCliPermissionBypassArgs: ['--future-allow'],
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      model: 'future-large',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });
  it('routes Direct CLI runtime from environment-defined provider routes', async () => {
    const fs = await import('fs');
    const settings = await import('../settings-utils');
    const authResolver = await import('../ai/auth/resolver');

    process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON = JSON.stringify([
      {
        id: 'env-future-direct-cli',
        displayName: 'Env Future CLI',
        cli: 'future-code',
        taskRunStrategy: {
          args: ['run', '--json'],
          modelFlag: '--model',
          promptStdinArg: '--stdin',
        },
        condition: {
          providerPrefix: 'future-',
          modelIdPrefix: 'future-',
        },
      },
    ]);
    (settings.readSettingsFile as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      providerAccounts: [{ id: 'future-1', provider: 'future-ai' }],
      globalPriorityOrder: ['future-1'],
    });
    (authResolver.resolveAuthFromQueue as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      accountId: 'future-1',
      resolvedProvider: 'future-ai',
      resolvedModelId: 'future-large',
      apiKey: 'future-key',
      source: 'api-key',
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) =>
      filePath.endsWith('task_metadata.json') || filePath.endsWith('implementation_plan.md')
    );
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
      if (filePath.endsWith('implementation_plan.md')) {
        return [
          '# Implementation Plan',
          'Feature: Direct task',
          'Workflow: direct',
          'Status: coding',
          'Execution Phase: coding',
          '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
          '',
          '- [/] direct. Direct execution',
          '  - [/] direct-implementation Direct model execution',
          '',
        ].join('\n');
      }
      return JSON.stringify({ workflowMode: 'off', model: 'future-large' });
    });

    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager();

    await manager.startDirectTaskExecution('001-task', 'E:/repo', '001-task', { useWorktree: false }, 'project-1');

    expect(spawnWorkerProcessMock).not.toHaveBeenCalled();
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'future-code',
      directCliRuntimeRouteId: 'env-future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Env Future CLI',
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      model: 'future-large',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
  });
  it('passes catalog-routed CLI runtime workspace claims', async () => {
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
    expect(createStartedAutocodeAgentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'codex',
      model: 'gpt-5.5',
    }));
    expect(spawnProcessMock).toHaveBeenCalled();
    const workspaceClaim = spawnProcessMock.mock.calls[0][6];
    expect(workspaceClaim.fileIntents).toEqual(['src/board.ts']);
  });
});

afterAll(() => {
  if (originalCliRuntimeRoutesEnv.json === undefined) {
    delete process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON;
  } else {
    process.env.AUTOCODE_CLI_RUNTIME_ROUTES_JSON = originalCliRuntimeRoutesEnv.json;
  }
  if (originalCliRuntimeRoutesEnv.routes === undefined) {
    delete process.env.AUTOCODE_CLI_RUNTIME_ROUTES;
  } else {
    process.env.AUTOCODE_CLI_RUNTIME_ROUTES = originalCliRuntimeRoutesEnv.routes;
  }
  if (originalDirectProviderContinuationCapabilitiesEnv.json === undefined) {
    delete process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES_JSON;
  } else {
    process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES_JSON = originalDirectProviderContinuationCapabilitiesEnv.json;
  }
  if (originalDirectProviderContinuationCapabilitiesEnv.capabilities === undefined) {
    delete process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES;
  } else {
    process.env.AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES = originalDirectProviderContinuationCapabilitiesEnv.capabilities;
  }
  if (originalDirectProviderFallbackCapabilitiesEnv.json === undefined) {
    delete process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES_JSON;
  } else {
    process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES_JSON = originalDirectProviderFallbackCapabilitiesEnv.json;
  }
  if (originalDirectProviderFallbackCapabilitiesEnv.capabilities === undefined) {
    delete process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES;
  } else {
    process.env.AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES = originalDirectProviderFallbackCapabilitiesEnv.capabilities;
  }
  if (originalModelProviderRoutesEnv.json === undefined) {
    delete process.env.AUTOCODE_MODEL_PROVIDER_ROUTES_JSON;
  } else {
    process.env.AUTOCODE_MODEL_PROVIDER_ROUTES_JSON = originalModelProviderRoutesEnv.json;
  }
  if (originalModelProviderRoutesEnv.routes === undefined) {
    delete process.env.AUTOCODE_MODEL_PROVIDER_ROUTES;
  } else {
    process.env.AUTOCODE_MODEL_PROVIDER_ROUTES = originalModelProviderRoutesEnv.routes;
  }
  if (originalProviderModelInvocationRoutesEnv.json === undefined) {
    delete process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES_JSON;
  } else {
    process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES_JSON = originalProviderModelInvocationRoutesEnv.json;
  }
  if (originalProviderModelInvocationRoutesEnv.routes === undefined) {
    delete process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES;
  } else {
    process.env.AUTOCODE_PROVIDER_MODEL_INVOCATION_ROUTES = originalProviderModelInvocationRoutesEnv.routes;
  }
  emitSpy.mockRestore();
});
