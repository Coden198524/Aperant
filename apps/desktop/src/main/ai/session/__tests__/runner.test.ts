import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SessionConfig, SessionResult, StreamEvent } from '../types';

// =============================================================================
// Mock AI SDK
// =============================================================================

// Create controllable mock for streamText
const mockStreamText = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
}));

// Import after mocking
import { runAgentSession } from '../runner';
import type { RunnerOptions } from '../runner';

// =============================================================================
// Helpers
// =============================================================================

function createMockConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agentType: 'coder',
    model: {} as SessionConfig['model'],
    systemPrompt: 'You are a helpful assistant.',
    initialMessages: [{ role: 'user', content: 'Hello' }],
    toolContext: {} as SessionConfig['toolContext'],
    maxSteps: 10,
    specDir: '/specs/001',
    projectDir: '/project',
    ...overrides,
  };
}

/**
 * Create a mock streamText result that yields the given parts.
 */
function createMockStreamResult(
  parts: Array<Record<string, unknown>>,
  options?: { text?: string; totalUsage?: Record<string, number> | null; providerMetadata?: Record<string, unknown> },
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
    text: Promise.resolve(options?.text ?? ''),
    totalUsage: Promise.resolve(
      options?.totalUsage === null
        ? undefined
        : options?.totalUsage ?? { inputTokens: 100, outputTokens: 50 },
    ),
    providerMetadata: Promise.resolve(options?.providerMetadata),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic completion
  // ===========================================================================

  it('should return completed result for simple session', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'Hello world' },
          {
            type: 'finish-step',
            usage: { inputTokens: 50, outputTokens: 25 },
          },
        ],
        { text: 'Hello world', totalUsage: { inputTokens: 50, outputTokens: 25 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('completed');
    expect(result.stepsExecuted).toBe(1);
    expect(result.usage.promptTokens).toBe(50);
    expect(result.usage.completionTokens).toBe(25);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.messages).toHaveLength(2); // initial + assistant response
  });

  // ===========================================================================
  // Max steps outcome
  // ===========================================================================

  it('should return max_steps when steps reach maxSteps', async () => {
    const steps = Array.from({ length: 10 }, (_) => ({
      type: 'finish-step',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    mockStreamText.mockReturnValue(
      createMockStreamResult(steps, {
        text: 'done',
        totalUsage: { inputTokens: 100, outputTokens: 50 },
      }),
    );

    const result = await runAgentSession(createMockConfig({ maxSteps: 10 }));
    expect(result.outcome).toBe('max_steps');
    expect(result.stepsExecuted).toBe(10);
  });

  // ===========================================================================
  // Multi-step with tool calls
  // ===========================================================================

  it('should track tool calls across multiple steps', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'tool-call', toolName: 'Bash', toolCallId: 'c1', input: { command: 'ls' } },
          { type: 'tool-result', toolCallId: 'c1', toolName: 'Bash', input: { command: 'ls' }, output: 'file.ts' },
          {
            type: 'finish-step',
            usage: { promptTokens: 50, completionTokens: 25 },
          },
          { type: 'tool-call', toolName: 'Read', toolCallId: 'c2', input: { file_path: 'file.ts' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'Read', input: { file_path: 'file.ts' }, output: 'content' },
          {
            type: 'finish-step',
            usage: { promptTokens: 50, completionTokens: 25 },
          },
        ],
        { text: 'Done', totalUsage: { inputTokens: 100, outputTokens: 50 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('completed');
    expect(result.stepsExecuted).toBe(2);
    expect(result.toolCallCount).toBe(2);
  });

  // ===========================================================================
  // Event callback
  // ===========================================================================

  it('should forward events to onEvent callback', async () => {
    const events: StreamEvent[] = [];

    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'hi' },
          {
            type: 'finish-step',
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
        { text: 'hi', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ),
    );

    await runAgentSession(createMockConfig(), {
      onEvent: (e) => events.push(e),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(events.some((e) => e.type === 'step-finish')).toBe(true);
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  it('should classify rate limit errors', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('429 Too Many Requests');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('rate_limited');
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('rate_limited');
    expect(result.stepsExecuted).toBe(0);
  });

  it('should classify generic errors', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('Network error');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('error');
    expect(result.error!.code).toBe('generic_error');
  });

  it('normalizes snake_case total usage from compatible providers', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'Done' },
          { type: 'finish-step', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
        { text: 'Done', totalUsage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.usage.promptTokens).toBe(120);
    expect(result.usage.completionTokens).toBe(30);
    expect(result.usage.totalTokens).toBe(150);
  });

  it('estimates token usage when the provider returns no usage', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'Generated source code content.' },
          { type: 'tool-call', toolName: 'Write', toolCallId: 'c1', input: { file_path: 'src/main.ts', content: 'x'.repeat(200) } },
          { type: 'tool-result', toolName: 'Write', toolCallId: 'c1', output: 'Successfully wrote file' },
          { type: 'finish-step', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
        { text: 'Generated source code content.', totalUsage: null },
      ),
    );

    const result = await runAgentSession(createMockConfig({
      systemPrompt: 'System prompt text.',
      initialMessages: [{ role: 'user', content: 'Create a file.' }],
    }));

    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.usage.estimated).toBe(true);
  });

  it('injects context-window warning once when prompt usage approaches the limit', async () => {
    let warningPrompt: { system?: string } | undefined;
    let repeatedPrompt: { system?: string } | undefined;

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        yield { type: 'finish-step', usage: { inputTokens: 810, outputTokens: 5 } };
        warningPrompt = await args.prepareStep({ stepNumber: 2 });
        repeatedPrompt = await args.prepareStep({ stepNumber: 3 });
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 810, outputTokens: 5 }),
    }));

    const result = await runAgentSession(createMockConfig({ contextWindowLimit: 1000, maxSteps: 10 }));

    expect(result.outcome).toBe('completed');
    expect(warningPrompt?.system).toContain('Context window is near limit');
    expect(warningPrompt?.system).toContain('Finish the current task and commit progress');
    expect(repeatedPrompt).toEqual({});
  });

  it('returns context_window when prompt usage exceeds the hard continuation threshold', async () => {
    let abortObserved = false;

    mockStreamText.mockImplementation((args: {
      abortSignal: AbortSignal;
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        yield { type: 'finish-step', usage: { inputTokens: 890, outputTokens: 5 } };
        await args.prepareStep({ stepNumber: 2 });
        abortObserved = args.abortSignal.aborted;
        throw new DOMException('aborted', 'AbortError');
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 890, outputTokens: 5 }),
    }));

    const result = await runAgentSession(createMockConfig({ contextWindowLimit: 1000, maxSteps: 10 }));

    expect(abortObserved).toBe(true);
    expect(result.outcome).toBe('context_window');
    expect(result.stepsExecuted).toBe(1);
    expect(result.usage.promptTokens).toBe(890);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('tracks completed subtasks from update_subtask_status tool results', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          {
            type: 'tool-call',
            toolName: 'mcp__autocode__update_subtask_status',
            toolCallId: 'status-1',
            input: { subtask_id: '2.2', status: 'completed' },
          },
          {
            type: 'tool-result',
            toolName: 'mcp__autocode__update_subtask_status',
            toolCallId: 'status-1',
            input: { subtask_id: '2.2', status: 'completed' },
            output: "Successfully updated subtask '2.2' to status 'completed'",
          },
          { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        { text: 'Done', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.completedSubtaskIds).toEqual(['2.2']);
  });

  it('tracks completed subtasks from output-only tool events', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          {
            type: 'tool-input-available',
            toolName: 'mcp__autocode__update_subtask_status',
            toolCallId: 'status-1',
            input: { subtask_id: '3.3', status: 'completed' },
          },
          {
            type: 'tool-output-available',
            toolCallId: 'status-1',
            output: "Successfully updated subtask '3.3' to status 'completed'",
          },
          { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        { text: 'Done', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.completedSubtaskIds).toEqual(['3.3']);
  });

  it('should treat stream error parts as fatal session errors', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [
          {
            type: 'error',
            error: Object.assign(new Error('openai_error'), { statusCode: 404 }),
          },
        ],
        { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } },
      ),
    );

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('error');
    expect(result.error!.code).toBe('model_not_found');
  });

  it('should inject correction after malformed Write input and fail on repeat', async () => {
    let injectedSystem = '';
    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-error',
          toolName: 'Write',
          toolCallId: 'c1',
          input: '{"file_path": "e:/work/project/.autocode/specs/001/spec.md"',
          error: 'invalid input for tool write: json parsing failed',
        };

        const retryPrompt = await args.prepareStep({ stepNumber: 2 });
        injectedSystem = retryPrompt.system ?? '';

        yield {
          type: 'tool-error',
          toolName: 'Write',
          toolCallId: 'c2',
          input: '{"file_path": "e:/work/project/.autocode/specs/001/spec.md"',
          error: 'tool \'write\' received invalid input type: string. expected object.',
        };
      })(),
      text: Promise.resolve(''),
      totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 10 }),
    }));

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('error');
    expect(result.error!.message).toContain('tool \'write\' input json failed');
    expect(injectedSystem).toContain('WRITE TOOL INPUT CORRECTION');
    expect(injectedSystem).toContain('e:/work/project/.autocode/specs/001/spec.md');
  });

  it('should count matching malformed Write tool-call and tool-error as one failure', async () => {
    let injectedSystem = '';
    const malformedInput = '{"file_path": "e:/work/test/aitest/.autocode/worktrees/tasks/004-web/tank-battle.js".';

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          toolName: 'Write',
          toolCallId: 'tooluse_y7NkGn3FNrOFfzuIqHaAZ3',
          input: malformedInput,
          invalid: true,
        };
        yield {
          type: 'tool-error',
          toolName: 'Write',
          toolCallId: 'tooluse_y7NkGn3FNrOFfzuIqHaAZ3',
          input: malformedInput,
          error: 'invalid input for tool write: json parsing failed',
        };

        const retryPrompt = await args.prepareStep({ stepNumber: 2 });
        injectedSystem = retryPrompt.system ?? '';

        yield { type: 'text-delta', id: 'text-1', text: 'retrying with a compact Write call' };
        yield {
          type: 'finish-step',
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      })(),
      text: Promise.resolve('retrying with a compact Write call'),
      totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 10 }),
    }));

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('completed');
    expect(injectedSystem).toContain('WRITE TOOL INPUT CORRECTION');
    expect(injectedSystem).toContain('e:/work/test/aitest/.autocode/worktrees/tasks/004-web/tank-battle.js');
  });

  // ===========================================================================
  // Auth retry
  // ===========================================================================

  it('should retry on auth failure when onAuthRefresh succeeds', async () => {
    let callCount = 0;
    mockStreamText.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('401 Unauthorized');
      }
      return createMockStreamResult(
        [
          { type: 'text-delta', id: 'text-1', delta: 'ok' },
          {
            type: 'finish-step',
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
        { text: 'ok', totalUsage: { inputTokens: 10, outputTokens: 5 } },
      );
    });

    const onAuthRefresh = vi.fn().mockResolvedValue('new-token');

    const result = await runAgentSession(createMockConfig(), { onAuthRefresh });

    expect(onAuthRefresh).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('completed');
  });

  it('should return auth_failure when onAuthRefresh returns null', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('401 Unauthorized');
    });

    const result = await runAgentSession(createMockConfig(), {
      onAuthRefresh: vi.fn().mockResolvedValue(null),
    });

    expect(result.outcome).toBe('auth_failure');
  });

  it('should return auth_failure when no onAuthRefresh provided', async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error('401 Unauthorized');
    });

    const result = await runAgentSession(createMockConfig());

    expect(result.outcome).toBe('auth_failure');
  });

  // ===========================================================================
  // Cancellation
  // ===========================================================================

  it('should return cancelled when abortSignal fires during stream', async () => {
    const controller = new AbortController();

    mockStreamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', delta: 'start' };
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      })(),
      text: Promise.resolve(''),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    });

    const result = await runAgentSession(
      createMockConfig({ abortSignal: controller.signal }),
    );

    expect(result.outcome).toBe('cancelled');
  });

  // ===========================================================================
  // streamText configuration
  // ===========================================================================

  it('should pass tools and system prompt to streamText', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    const tools = { Bash: {} as any };
    await runAgentSession(createMockConfig({ systemPrompt: 'Be helpful' }), { tools });

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBe('Be helpful');
    expect(callArgs.tools).toBe(tools);
  });

  it('caps active memory injections per session', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue({
        type: 'gotcha_injection',
        content: 'MEMORY ALERT - compact reminder',
        memoryIds: ['memory-1'],
      }),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
    };

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        for (const stepNumber of [6, 12, 18, 24, 30]) {
          await args.prepareStep({ stepNumber });
        }
        yield { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } };
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    }));

    await runAgentSession(createMockConfig({ maxSteps: 40 }), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.requestStepInjection).toHaveBeenCalledTimes(3);
    expect(proxy.requestStepInjection).toHaveBeenNthCalledWith(1, 6, expect.any(Object));
    expect(proxy.requestStepInjection).toHaveBeenNthCalledWith(2, 12, expect.any(Object));
    expect(proxy.requestStepInjection).toHaveBeenNthCalledWith(3, 18, expect.any(Object));
    expect(proxy.onStepComplete).toHaveBeenCalledTimes(5);
  });

  it('skips active memory injection during warmup and interval windows', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue({
        type: 'gotcha_injection',
        content: 'MEMORY ALERT - compact reminder',
        memoryIds: ['memory-1'],
      }),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
    };

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        for (const stepNumber of [1, 5, 6, 11, 12]) {
          await args.prepareStep({ stepNumber });
        }
        yield { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } };
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    }));

    await runAgentSession(createMockConfig({ maxSteps: 15 }), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.requestStepInjection).toHaveBeenCalledTimes(2);
    expect(proxy.requestStepInjection).toHaveBeenNthCalledWith(1, 6, expect.any(Object));
    expect(proxy.requestStepInjection).toHaveBeenNthCalledWith(2, 12, expect.any(Object));
    expect(proxy.onStepComplete).toHaveBeenCalledTimes(5);
  });

  it('skips active memory injection when context-window usage is tight', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue({
        type: 'gotcha_injection',
        content: 'MEMORY ALERT - compact reminder',
        memoryIds: ['memory-1'],
      }),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
    };

    let stepPrompt: { system?: string } | undefined;
    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        yield { type: 'finish-step', usage: { inputTokens: 600, outputTokens: 5 } };
        stepPrompt = await args.prepareStep({ stepNumber: 6 });
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 600, outputTokens: 5 }),
    }));

    await runAgentSession(createMockConfig({ contextWindowLimit: 1000, maxSteps: 10 }), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.requestStepInjection).not.toHaveBeenCalled();
    expect(proxy.onStepComplete).toHaveBeenCalledWith(6);
    expect(stepPrompt).toEqual({});
  });

  it('reports step prompt token usage to the memory observer', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue(null),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
      onTokenUsage: vi.fn(),
    };

    mockStreamText.mockReturnValue(
      createMockStreamResult(
        [{ type: 'finish-step', usage: { inputTokens: 18_500, outputTokens: 25 } }],
        { text: 'done', totalUsage: { inputTokens: 18_500, outputTokens: 25 } },
      ),
    );

    await runAgentSession(createMockConfig({ contextWindowLimit: 24_000 }), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.onTokenUsage).toHaveBeenCalledWith(18_500, 1, 24_000);
  });

  it('batches memory reasoning deltas until step finish', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue(null),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
    };

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        await args.prepareStep({ stepNumber: 1 });
        yield { type: 'reasoning-delta', delta: 'First thought.' };
        yield { type: 'reasoning-delta', delta: 'Second thought.' };
        yield { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } };
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    }));

    await runAgentSession(createMockConfig(), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.onReasoning).toHaveBeenCalledTimes(1);
    expect(proxy.onReasoning).toHaveBeenCalledWith('First thought. Second thought.', 1);
  });

  it('flushes buffered memory reasoning before requesting step injection', async () => {
    const proxy = {
      requestStepInjection: vi.fn().mockResolvedValue(null),
      onStepComplete: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onReasoning: vi.fn(),
    };

    mockStreamText.mockImplementation((args: {
      prepareStep: (input: { stepNumber: number }) => Promise<{ system?: string }>;
    }) => ({
      fullStream: (async function* () {
        await args.prepareStep({ stepNumber: 1 });
        yield {
          type: 'reasoning-delta',
          delta: 'Correction: previous path is generated; inspect the source template instead.',
        };
        await args.prepareStep({ stepNumber: 6 });
        yield { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 5 } };
      })(),
      text: Promise.resolve('done'),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    }));

    await runAgentSession(createMockConfig({ maxSteps: 8 }), {
      memoryContext: {
        proxy: proxy as unknown as NonNullable<RunnerOptions['memoryContext']>['proxy'],
      },
    });

    expect(proxy.onReasoning).toHaveBeenCalledTimes(1);
    expect(proxy.onReasoning).toHaveBeenCalledWith(
      'Correction: previous path is generated; inspect the source template instead.',
      1,
    );
    expect(proxy.requestStepInjection).toHaveBeenCalledTimes(1);
    expect(proxy.onReasoning.mock.invocationCallOrder[0]).toBeLessThan(
      proxy.requestStepInjection.mock.invocationCallOrder[0],
    );
  });

  it('should repair double-encoded Write tool JSON when content is present', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig());

    const callArgs = mockStreamText.mock.calls[0][0];
    const repair = callArgs.experimental_repairToolCall;
    const repaired = await repair({
      toolCall: {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'Write',
        input: JSON.stringify(JSON.stringify({
          file_path: 'E:\\Work\\Project\\.autocode\\specs\\001\\spec.md',
          content: '# Spec\n',
        })),
      },
    });

    expect(JSON.parse(repaired.input)).toEqual({
      file_path: 'E:/Work/Project/.autocode/specs/001/spec.md',
      content: '# Spec\n',
    });
  });

  it('should use default maxSteps of 160 when not specified', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    const config = createMockConfig();
    // @ts-expect-error - testing undefined maxSteps behavior
    delete config.maxSteps;

    await runAgentSession(config);

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.stopWhen).toEqual({ type: 'stepCount', count: 160 });
  });

  it('should cap default output tokens below the previous 32768 limit', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({ agentType: 'coder', phase: 'coding' }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(12000);
  });

  it('should use a lower output cap for QA sessions', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({ agentType: 'qa_reviewer', phase: 'qa' }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(8000);
  });

  it('should cap direct_task output tokens for compact one-shot sessions', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({ agentType: 'direct_task', phase: 'coding' }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(32000);
  });

  it('should keep system prompt for openai-compatible chat models even when model id is codex', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({
      systemPrompt: 'Spec prompt',
      model: {
        modelId: 'gpt-5.3-codex',
        provider: 'openai-compatible.chat',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBe('Spec prompt');
    expect(callArgs.providerOptions?.openai).toBeUndefined();
  });

  it('should use instructions and store=false for openai responses transport', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({
      systemPrompt: 'Spec prompt',
      model: {
        modelId: 'gpt-5.3-codex',
        provider: 'openai.responses',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBeUndefined();
    expect(callArgs.providerOptions?.openai).toMatchObject({
      instructions: 'Spec prompt',
      store: false,
    });
  });

  it('should use instructions and store=false for hyphenated openai-responses provider ids', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({
      systemPrompt: 'Spec prompt',
      model: {
        modelId: 'gpt-5.3-codex',
        provider: 'openai-responses',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBeUndefined();
    expect(callArgs.providerOptions?.openai).toMatchObject({
      instructions: 'Spec prompt',
      store: false,
    });
  });

  it('should use instructions and store=false for generic openai provider ids with responses models', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({
      systemPrompt: 'Spec prompt',
      model: {
        modelId: 'gpt-5.4',
        provider: 'openai',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.system).toBeUndefined();
    expect(callArgs.providerOptions?.openai).toMatchObject({
      instructions: 'Spec prompt',
      store: false,
    });
  });

  it('should allow disabling responses persistence for one-shot sessions', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], { text: '', totalUsage: { inputTokens: 0, outputTokens: 0 } }),
    );

    await runAgentSession(createMockConfig({
      systemPrompt: 'Spec prompt',
      responsePersistence: false,
      model: {
        modelId: 'gpt-5.3-codex',
        provider: 'openai.responses',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.providerOptions?.openai).toMatchObject({
      instructions: 'Spec prompt',
      store: false,
    });
  });

  it('should continue openai responses sessions with previousResponseId', async () => {
    mockStreamText.mockReturnValue(
      createMockStreamResult([], {
        text: 'continued',
        totalUsage: { inputTokens: 10, outputTokens: 5 },
        providerMetadata: { openai: { responseId: 'resp_next' } },
      }),
    );

    const result = await runAgentSession(createMockConfig({
      sessionId: 'direct-session-1',
      systemPrompt: 'Direct prompt',
      responsePersistence: false,
      previousResponseId: 'resp_prev',
      model: {
        modelId: 'gpt-5.3-codex',
        provider: 'openai.responses',
      } as SessionConfig['model'],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.providerOptions?.openai).toMatchObject({
      instructions: 'Direct prompt',
      store: true,
      previousResponseId: 'resp_prev',
    });
    expect(result.usage.sessionId).toBe('direct-session-1');
    expect(result.providerResponseId).toBe('resp_next');
  });
});
