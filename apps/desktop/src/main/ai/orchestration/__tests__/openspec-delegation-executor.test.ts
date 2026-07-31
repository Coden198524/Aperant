import type { LanguageModel, Tool as AITool } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  failSessionForOpenSpecDelegation,
  OpenSpecDelegationExecutor,
} from '../openspec-delegation-executor';
import type { RunnerOptions } from '../../session/runner';
import type { SessionConfig, SessionResult } from '../../session/types';
import type { ToolRegistry } from '../../tools/registry';
import type { ToolContext } from '../../tools/types';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: 'D:\\workspace',
    projectDir: 'D:\\workspace',
    specDir: 'D:\\workspace',
    allowedPathRoots: ['D:\\workspace', 'D:\\store\\openspec'],
    allowedWritePaths: ['D:\\store\\openspec'],
    commandEnv: {
      PATH: 'D:\\pinned-openspec-shim',
    },
    openSpecBashPolicy: {
      allowedPathRoots: ['D:\\workspace', 'D:\\store\\openspec'],
      allowedWritePaths: ['D:\\store\\openspec'],
      storeId: 'trusted-store',
    },
    securityProfile: {
      baseCommands: new Set<string>(),
      stackCommands: new Set<string>(),
      scriptCommands: new Set<string>(),
      customCommands: new Set<string>(),
      customScripts: { shellScripts: [] },
      getAllAllowedCommands: () => new Set<string>(),
    },
    ...overrides,
  };
}

function completedResult(text = 'Sync complete'): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 3,
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    messages: [
      { role: 'user', content: 'delegated request' },
      { role: 'assistant', content: text },
    ],
    toolCallCount: 2,
    durationMs: 25,
  };
}

describe('OpenSpecDelegationExecutor', () => {
  it('keeps the official prompt exact and localizes only the delegated request', async () => {
    const officialSyncPrompt = 'OFFICIAL SYNC\r\n  exact whitespace  \n';
    const delegatedRequest =
      "Use Skill tool to invoke openspec-sync-specs for change 'change-a'.\r\n";
    const model = { modelId: 'same-provider-model' } as unknown as LanguageModel;
    const abortController = new AbortController();
    const parentDelegation = vi.fn();
    const baseToolContext = createToolContext({
      abortSignal: abortController.signal,
      runOpenSpecDelegation: parentDelegation,
    });
    const childTools = {
      Read: { type: 'tool' },
      Write: { type: 'tool' },
      Task: { type: 'tool' },
      SpawnSubagent: { type: 'tool' },
    } as unknown as Record<string, AITool>;
    const registry = {
      getToolsForAgent: vi.fn().mockReturnValue(childTools),
    } as unknown as ToolRegistry;
    const runSession = vi.fn(
      async (
        _config: SessionConfig,
        _options?: RunnerOptions,
      ): Promise<SessionResult> =>
        completedResult('delegated sync finished'),
    );
    const onProviderFailureFallback = vi.fn(
      async (): Promise<SessionResult> => completedResult('CLI sync finished'),
    );

    const executor = new OpenSpecDelegationExecutor({
      model,
      registry,
      baseToolContext,
      syncSystemPrompt: officialSyncPrompt,
      language: 'zh-CN',
      maxSteps: 91,
      thinkingLevel: 'high',
      provider: 'anthropic',
      providerTransport: 'anthropic.messages',
      contextWindowLimit: 200_000,
      abortSignal: abortController.signal,
      onProviderFailureFallback,
      runSession,
    });

    const result = await executor.run({
      action: 'sync',
      prompt: delegatedRequest,
      description: 'Sync specs before Archive',
    });

    expect(result).toBe('delegated sync finished');
    expect(runSession).toHaveBeenCalledOnce();
    const [childSession, runnerOptions] = runSession.mock.calls[0];
    expect(childSession.agentType).toBe('openspec');
    expect(childSession.model).toBe(model);
    expect(childSession.provider).toBe('anthropic');
    expect(childSession.providerTransport).toBe('anthropic.messages');
    expect(childSession.systemPrompt).toBe(officialSyncPrompt);
    expect(childSession.initialMessages).toHaveLength(1);
    expect(childSession.initialMessages[0]?.role).toBe('user');
    expect(
      childSession.initialMessages[0]?.content.startsWith(delegatedRequest),
    ).toBe(true);
    expect(childSession.initialMessages[0]?.content).toContain(
      '## OUTPUT LANGUAGE REQUIREMENT',
    );
    expect(childSession.initialMessages[0]?.content).toContain(
      'Use Simplified Chinese for all user-facing prose',
    );
    expect(childSession.initialMessages[0]?.content).toContain(
      '## OPENSPEC AUTOMATIC DECISION REQUIREMENT',
    );
    expect(childSession.initialMessages[0]?.content).toContain(
      '本次 Spec Action 已启用无人值守自动决策。',
    );
    expect(childSession.initialMessages[0]?.content).toContain(
      '不要暂停或等待人工输入',
    );
    expect(childSession.maxSteps).toBe(91);
    expect(childSession.responsePersistence).toBeUndefined();
    expect(childSession.previousResponseId).toBeUndefined();
    expect(childSession.abortSignal).toBe(abortController.signal);
    expect(childSession.toolContext.allowedPathRoots).toEqual(
      baseToolContext.allowedPathRoots,
    );
    expect(childSession.toolContext.allowedWritePaths).toEqual(
      baseToolContext.allowedWritePaths,
    );
    expect(childSession.toolContext.openSpecBashPolicy).toEqual(
      baseToolContext.openSpecBashPolicy,
    );
    expect(childSession.toolContext.commandEnv).toEqual(
      baseToolContext.commandEnv,
    );
    expect(childSession.toolContext.runOpenSpecDelegation).toBeUndefined();
    expect(registry.getToolsForAgent).toHaveBeenCalledWith(
      'openspec',
      childSession.toolContext,
    );
    expect(runnerOptions?.tools).toHaveProperty('Read');
    expect(runnerOptions?.tools).toHaveProperty('Write');
    expect(runnerOptions?.tools).not.toHaveProperty('Task');
    expect(runnerOptions?.tools).not.toHaveProperty('SpawnSubagent');
    expect(runnerOptions?.memoryContext).toBeUndefined();
    expect(runnerOptions?.onProviderFailureFallback).toBeTypeOf('function');
    const delegatedFallback = runnerOptions?.onProviderFailureFallback;
    if (!delegatedFallback) {
      throw new Error('Expected the delegated provider fallback to be configured.');
    }

    const sessionError = {
      code: 'temporarily_unavailable',
      message: 'API overloaded',
      retryable: true,
    };
    const fallbackResult = await delegatedFallback({
      originalError: new Error('API overloaded'),
      sessionError,
      outcome: 'error',
    });
    expect(fallbackResult?.messages.at(-1)?.content).toBe('CLI sync finished');
    const localizedDelegatedRequest = childSession.initialMessages[0]?.content;
    expect(onProviderFailureFallback).toHaveBeenCalledWith({
      action: 'sync',
      systemPrompt: officialSyncPrompt,
      userMessage: localizedDelegatedRequest,
      readOnly: false,
      sessionError,
    });
  });

  it('removes mutating tools when the inherited OpenSpec action is read-only', async () => {
    const registry = {
      getToolsForAgent: vi.fn().mockReturnValue({
        Read: { type: 'tool' },
        Write: { type: 'tool' },
        Edit: { type: 'tool' },
        Task: { type: 'tool' },
      }),
    } as unknown as ToolRegistry;
    const runSession = vi.fn(
      async (
        _config: SessionConfig,
        _options?: RunnerOptions,
      ): Promise<SessionResult> =>
        completedResult(),
    );
    const executor = new OpenSpecDelegationExecutor({
      model: { modelId: 'model' } as unknown as LanguageModel,
      registry,
      baseToolContext: createToolContext({ readOnlySession: true }),
      syncSystemPrompt: 'OFFICIAL SYNC',
      maxSteps: 10,
      runSession,
    });

    await executor.run({
      action: 'sync',
      prompt: 'openspec-sync-specs',
    });

    const runnerOptions = runSession.mock.calls[0][1];
    expect(runnerOptions?.tools).toHaveProperty('Read');
    expect(runnerOptions?.tools).not.toHaveProperty('Write');
    expect(runnerOptions?.tools).not.toHaveProperty('Edit');
    expect(runnerOptions?.tools).not.toHaveProperty('Task');
  });

  it('fails closed when the isolated child session does not complete', async () => {
    const runSession = vi.fn(
      async (): Promise<SessionResult> => ({
        ...completedResult(),
        outcome: 'error',
        error: {
          code: 'tool_execution_error',
          message: 'sync write failed',
          retryable: false,
        },
      }),
    );
    const executor = new OpenSpecDelegationExecutor({
      model: { modelId: 'model' } as unknown as LanguageModel,
      registry: {
        getToolsForAgent: vi.fn().mockReturnValue({}),
      } as unknown as ToolRegistry,
      baseToolContext: createToolContext(),
      syncSystemPrompt: 'OFFICIAL SYNC',
      maxSteps: 10,
      runSession,
    });

    await expect(executor.run({
      action: 'sync',
      prompt: 'openspec-sync-specs',
    })).rejects.toThrow(
      'OpenSpec Sync delegation ended with outcome "error": sync write failed',
    );
  });

  it('forces the parent Archive result to fail if it ignores a child error', () => {
    const parentResult = completedResult('Archive reported success');
    const result = failSessionForOpenSpecDelegation(
      parentResult,
      new Error('Sync child failed'),
    );

    expect(result.outcome).toBe('error');
    expect(result.error).toEqual({
      code: 'openspec_delegation_failed',
      message: 'Sync child failed',
      retryable: false,
    });
    expect(result.messages).toBe(parentResult.messages);
    expect(result.usage).toBe(parentResult.usage);
  });
});
