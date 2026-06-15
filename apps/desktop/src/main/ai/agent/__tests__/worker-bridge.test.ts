import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import type { AgentExecutorConfig, WorkerMessage } from '../types';
import type { SessionResult } from '../../session/types';
import type { Memory } from '../../memory/types';
import { estimateTokens } from '../../memory/retrieval/context-packer';

// =============================================================================
// Mocks
// =============================================================================

// Track created workers
const createdWorkers: EventEmitter[] = [];
const mockMemoryServiceSearch = vi.hoisted(() => vi.fn());
const mockMemoryServiceStore = vi.hoisted(() => vi.fn());

vi.mock('worker_threads', () => {
  const { EventEmitter: EE } = require('events') as typeof import('events');

  class MockWorkerImpl extends EE {
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);
    workerData: unknown;
    constructor(_path: string, opts?: { workerData?: unknown }) {
      super();
      this.workerData = opts?.workerData;
      createdWorkers.push(this);
    }
  }

  return { Worker: MockWorkerImpl };
});

function getWorker(): EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  const w = createdWorkers[createdWorkers.length - 1];
  if (!w) throw new Error('No worker created');
  return w as EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
}

vi.mock('electron', () => ({
  default: { app: { isPackaged: false } },
  app: { isPackaged: false },
}));

vi.mock('url', () => ({
  fileURLToPath: (url: string) => url.replace('file://', ''),
}));

// Mock ProgressTracker
const mockProcessEvent = vi.fn();
const mockForcePhase = vi.fn();
vi.mock('../../session/progress-tracker', () => ({
  ProgressTracker: class {
    state = {
      currentPhase: 'initializing' as const,
      currentSubtask: null,
      currentMessage: 'Starting...',
      completedPhases: [],
    };
    processEvent = mockProcessEvent;
    forcePhase = mockForcePhase;
  },
}));

vi.mock('../../../ipc-handlers/context/memory-service-factory', () => ({
  getMemoryService: vi.fn(() => ({
    search: mockMemoryServiceSearch,
    store: mockMemoryServiceStore,
  })),
}));

// Import after mocks
import { WorkerBridge } from '../worker-bridge';

// =============================================================================
// Helpers
// =============================================================================

function createConfig(overrides: Partial<AgentExecutorConfig> = {}): AgentExecutorConfig {
  return {
    taskId: 'task-123',
    projectId: 'proj-456',
    processType: 'task-execution',
    session: {
      agentType: 'coder',
      systemPrompt: 'test',
      initialMessages: [{ role: 'user', content: 'hello' }],
      maxSteps: 10,
      specDir: '/specs',
      projectDir: '/project',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      toolContext: { cwd: '/project', projectDir: '/project', specDir: '/specs' },
    },
    ...overrides,
  };
}

function createSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 5,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 3000,
    toolCallCount: 3,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    type: 'gotcha',
    content: 'Use refreshToken() before API calls',
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'sess-1',
    provenanceSessionIds: [],
    projectId: 'proj-456',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('WorkerBridge', () => {
  let bridge: WorkerBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMemoryServiceSearch.mockReset();
    mockMemoryServiceStore.mockReset();
    createdWorkers.length = 0;
    bridge = new WorkerBridge();
  });

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  describe('spawn', () => {
    it('creates a worker and sets isActive to true', () => {
      bridge.spawn(createConfig());
      expect(bridge.isActive).toBe(true);
      expect(createdWorkers.length).toBe(1);
    });

    it('throws if worker already active', () => {
      bridge.spawn(createConfig());
      expect(() => bridge.spawn(createConfig())).toThrow('already has an active worker');
    });
  });

  // ---------------------------------------------------------------------------
  // Message relay
  // ---------------------------------------------------------------------------

  describe('message relay', () => {
    it('emits log events from worker log messages', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'log', taskId: 'task-123', data: 'hello', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'hello', 'proj-456');
    });

    it('emits error events from worker error messages', () => {
      const handler = vi.fn();
      bridge.on('error', handler);
      bridge.spawn(createConfig());

      const msg: WorkerMessage = { type: 'error', taskId: 'task-123', data: 'fail', projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', 'fail', 'proj-456');
    });

    it('emits execution-progress events from worker progress messages', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const progressData = { phase: 'building' as const, phaseProgress: 50, overallProgress: 25 };
      const msg: WorkerMessage = { type: 'execution-progress', taskId: 'task-123', data: progressData as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', {
        ...progressData,
        sequenceNumber: 1,
      }, 'proj-456');
    });

    it('syncs the progress tracker from authoritative execution-progress messages', () => {
      bridge.spawn(createConfig());

      const msg: WorkerMessage = {
        type: 'execution-progress',
        taskId: 'task-123',
        data: {
          phase: 'qa_review' as never,
          phaseProgress: 50,
          overallProgress: 80,
          message: 'Running QA review...',
          currentSubtask: 'qa-1',
        },
        projectId: 'proj-456',
      };
      getWorker().emit('message', msg);

      expect(mockForcePhase).toHaveBeenCalledWith('qa_review', 'Running QA review...', 'qa-1');
    });

    it('feeds stream-events to progress tracker and emits progress', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      const streamEvent = { type: 'tool-call' as const, toolName: 'bash', args: {} };
      const msg: WorkerMessage = { type: 'stream-event', taskId: 'task-123', data: streamEvent as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(mockProcessEvent).toHaveBeenCalledWith(streamEvent);
      expect(handler).toHaveBeenCalled();
    });

    it('assigns increasing sequence numbers across progress sources', () => {
      const handler = vi.fn();
      bridge.on('execution-progress', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'execution-progress',
        taskId: 'task-123',
        data: { phase: 'planning', phaseProgress: 10, overallProgress: 5 },
        projectId: 'proj-456'
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: { type: 'tool-call', toolName: 'Edit', toolCallId: 'call-1', args: {} },
        projectId: 'proj-456'
      } satisfies WorkerMessage);

      expect(handler.mock.calls[0]?.[1]?.sequenceNumber).toBe(1);
      expect(handler.mock.calls[1]?.[1]?.sequenceNumber).toBe(2);
    });

    it('does not mirror text-delta model output into runtime logs', () => {
      const handler = vi.fn();
      bridge.on('log', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: { type: 'text-delta', text: 'some ' } as never,
      } satisfies WorkerMessage);
      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: { type: 'text-delta', text: 'output' } as never,
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: { type: 'tool-call', toolName: 'Read', toolCallId: 'call-1', args: {} } as never,
      } satisfies WorkerMessage);

      expect(handler).not.toHaveBeenCalledWith('task-123', 'some output', undefined);
    });

    it('emits task-log-stream immediately for text-delta events', () => {
      const handler = vi.fn();
      bridge.on('task-log-stream', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        projectId: 'proj-456',
        phase: 'coding',
        subtaskId: 'subtask-1',
        sessionNumber: 2,
        data: { type: 'text-delta', text: 'token' } as never,
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'text',
          content: 'token',
          phase: 'coding',
          subtask_id: 'subtask-1',
          session: 2,
          source: 'sdk',
        }),
        'proj-456'
      );
    });

    it('repairs Chinese mojibake before emitting live model output', () => {
      const handler = vi.fn();
      bridge.on('task-log-stream', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        projectId: 'proj-456',
        phase: 'planning',
        data: { type: 'text-delta', text: '璇存槑浜у搧鐩爣' } as never,
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'text',
          content: '说明产品目标',
          phase: 'planning',
          source: 'sdk',
        }),
        'proj-456'
      );
    });

    it('emits task-log-stream for tool-call events', () => {
      const handler = vi.fn();
      bridge.on('task-log-stream', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        projectId: 'proj-456',
        phase: 'coding',
        data: {
          type: 'tool-call',
          toolName: 'Bash',
          toolCallId: 'call-1',
          args: { command: 'npm test' },
        } as never,
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'tool_start',
          content: '[Bash] npm test',
          phase: 'coding',
          tool: {
            name: 'Bash',
            input: 'npm test',
          },
          source: 'sdk',
        }),
        'proj-456'
      );
    });

    it('emits task-token-usage for usage-update stream events', () => {
      const handler = vi.fn();
      bridge.on('task-token-usage', handler);
      bridge.spawn(createConfig());

      const streamEvent = {
        type: 'usage-update' as const,
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
      };
      const msg: WorkerMessage = { type: 'stream-event', taskId: 'task-123', data: streamEvent as never, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(handler).toHaveBeenCalledWith('task-123', streamEvent.usage, 'proj-456');
    });

    it('compacts memory search results before posting them back to the worker', async () => {
      const longMemory = makeMemory({
        content: `MEMORY_HEAD ${'verbose memory detail '.repeat(120)} MEMORY_TAIL`,
        tags: [
          'auth',
          'auth',
          ...Array.from({ length: 20 }, (_, index) => `tag-${index}-${'x'.repeat(80)}`),
        ],
        relatedFiles: Array.from(
          { length: 20 },
          (_, index) => `src/very/deep/path/${index}/${'file-name-segment-'.repeat(18)}tail-${index}.ts`,
        ),
        relatedModules: Array.from(
          { length: 16 },
          (_, index) => `module-${index}-${'nested-'.repeat(20)}tail`,
        ),
        citationText: `CITATION_HEAD ${'citation detail '.repeat(80)} CITATION_TAIL`,
        contextPrefix: `PREFIX_HEAD ${'context detail '.repeat(80)} PREFIX_TAIL`,
      });
      mockMemoryServiceSearch.mockResolvedValueOnce([longMemory]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-1',
        filters: { query: 'auth memory', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-1',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { type?: string }).type === 'memory:search-result',
      )?.[0] as { memories: Memory[] };
      const memory = response.memories[0];
      expect(memory.content.length).toBeLessThanOrEqual(900);
      expect(estimateTokens(memory.content)).toBeLessThanOrEqual(225);
      expect(memory.content).toContain('MEMORY_HEAD');
      expect(memory.content).toContain('MEMORY_TAIL');
      expect(memory.content).toContain('memory response middle omitted before IPC');
      expect(memory.tags).toHaveLength(12);
      expect(new Set(memory.tags).size).toBe(memory.tags.length);
      expect(memory.tags.every((tag) => tag.length <= 64)).toBe(true);
      expect(memory.relatedFiles).toHaveLength(12);
      expect(memory.relatedFiles.every((file) => file.length <= 180)).toBe(true);
      expect(memory.relatedFiles.every((file) => !file.includes('[omitted]'))).toBe(true);
      expect(memory.relatedFiles[0]).toContain('tail-0.ts');
      expect(memory.relatedModules).toHaveLength(10);
      expect(memory.relatedModules.every((module) => module.length <= 96)).toBe(true);
      expect(memory.citationText?.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(memory.citationText ?? '')).toBeLessThanOrEqual(75);
      expect(memory.citationText).toContain('CITATION_HEAD');
      expect(memory.citationText).toContain('CITATION_TAIL');
      expect(memory.contextPrefix?.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(memory.contextPrefix ?? '')).toBeLessThanOrEqual(75);
      expect(memory.contextPrefix).toContain('PREFIX_HEAD');
      expect(memory.contextPrefix).toContain('PREFIX_TAIL');
    });

    it('keeps localized memory search responses within token budgets before IPC', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          content: [
            '记忆开头',
            '这是一段很长的本地化记忆内容，会比英文更快消耗 token。'.repeat(80),
            '记忆尾部必须保留',
          ].join(' '),
          relatedFiles: [
            `src/${'深层目录/'.repeat(80)}localized-tail-preserved.ts`,
          ],
          citationText: [
            '引用开头',
            '本地化引用细节。'.repeat(60),
            '引用尾部',
          ].join(' '),
          contextPrefix: [
            '前缀开头',
            '本地化上下文前缀。'.repeat(60),
            '前缀尾部',
          ].join(' '),
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-localized',
        filters: { query: '中文记忆', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-localized',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-localized',
      )?.[0] as { memories: Memory[] };
      const memory = response.memories[0];

      expect(memory.content.length).toBeLessThanOrEqual(900);
      expect(estimateTokens(memory.content)).toBeLessThanOrEqual(225);
      expect(memory.content).toContain('记忆开头');
      expect(memory.content).toContain('记忆尾部必须保留');
      expect(memory.content).toContain('memory response middle omitted before IPC');
      expect(memory.relatedFiles[0]).toContain('localized-tail-preserved.ts');
      expect(memory.relatedFiles[0]).not.toContain('[omitted]');
      expect(estimateTokens(memory.citationText ?? '')).toBeLessThanOrEqual(75);
      expect(memory.citationText).toContain('引用开头');
      expect(memory.citationText).toContain('引用尾部');
      expect(estimateTokens(memory.contextPrefix ?? '')).toBeLessThanOrEqual(75);
      expect(memory.contextPrefix).toContain('前缀开头');
      expect(memory.contextPrefix).toContain('前缀尾部');
    });

    it('accumulates request counts across provider sessions in one worker', () => {
      const handler = vi.fn();
      bridge.on('task-token-usage', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            stepsExecuted: 2,
            sessionId: 'session-a',
          },
        } as never,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'task-token-usage',
        taskId: 'task-123',
        data: {
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50,
          stepsExecuted: 1,
          sessionId: 'session-b',
        },
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenLastCalledWith('task-123', {
        promptTokens: 160,
        completionTokens: 40,
        totalTokens: 200,
        stepsExecuted: 3,
        sessionId: 'session-b',
      }, 'proj-456');
    });

    it('adds resumed session usage to the historical baseline only once', () => {
      const handler = vi.fn();
      bridge.on('task-token-usage', handler);
      bridge.spawn(createConfig(), {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        stepsExecuted: 10,
        sessionId: 'old-session',
      });

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            stepsExecuted: 1,
            sessionId: 'new-session',
          },
        } as never,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: {
            promptTokens: 150,
            completionTokens: 80,
            totalTokens: 230,
            stepsExecuted: 2,
            sessionId: 'new-session',
          },
        } as never,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenLastCalledWith('task-123', {
        promptTokens: 1150,
        completionTokens: 580,
        totalTokens: 1730,
        stepsExecuted: 12,
        sessionId: 'new-session',
      }, 'proj-456');
    });
  });

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  describe('result handling', () => {
    it('maps completed outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'completed' });
      const msg: WorkerMessage = { type: 'result', taskId: 'task-123', data: result, projectId: 'proj-456' };
      getWorker().emit('message', msg);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('maps max_steps outcome to exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'max_steps' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', undefined);
    });

    it('maps error outcome to exit code 1', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.on('error', vi.fn()); // Prevent unhandled error throw
      bridge.on('log', vi.fn());
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', undefined);
    });

    it('emits error event when result has an error', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'error', error: { message: 'boom', code: 'unknown', retryable: false } });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'boom', undefined);
    });

    it('logs summary before exit', () => {
      const logHandler = vi.fn();
      bridge.on('log', logHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult();
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(logHandler).toHaveBeenCalledWith(
        'task-123',
        expect.stringContaining('Session complete'),
        undefined,
      );
    });

    it('emits final task-token-usage from session result', () => {
      const usageHandler = vi.fn();
      bridge.on('task-token-usage', usageHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({
        usage: { promptTokens: 250, completionTokens: 80, totalTokens: 330 }
      });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result, projectId: 'proj-456' });

      expect(usageHandler).toHaveBeenCalledWith('task-123', {
        ...result.usage,
        stepsExecuted: result.stepsExecuted,
      }, 'proj-456');
    });

    it('does not regress token usage when final result usage is zero', () => {
      const usageHandler = vi.fn();
      bridge.on('error', vi.fn());
      bridge.on('task-token-usage', usageHandler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: { promptTokens: 2462, completionTokens: 53, totalTokens: 2515 },
        },
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      const result = createSessionResult({
        outcome: 'error',
        stepsExecuted: 9,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        error: { message: 'failed', code: 'generic_error', retryable: false },
      });

      getWorker().emit('message', {
        type: 'result',
        taskId: 'task-123',
        data: result,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(usageHandler).toHaveBeenLastCalledWith('task-123', {
        promptTokens: 2462,
        completionTokens: 53,
        totalTokens: 2515,
        stepsExecuted: 9,
      }, 'proj-456');
    });
  });

  // ---------------------------------------------------------------------------
  // Worker crash handling
  // ---------------------------------------------------------------------------

  describe('crash handling', () => {
    it('emits error and cleans up on worker error event', () => {
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.spawn(createConfig());

      getWorker().emit('error', new Error('Worker crashed'));

      expect(errorHandler).toHaveBeenCalledWith('task-123', 'Worker crashed', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('emits exit on worker exit event (non-zero code)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      getWorker().emit('exit', 1);

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', 'proj-456');
      expect(bridge.isActive).toBe(false);
    });

    it('does not emit exit if worker reference already cleaned up (result already handled)', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      // Simulate result handling first (which cleans up)
      const worker = getWorker();
      const result = createSessionResult();
      worker.emit('message', { type: 'result', taskId: 'task-123', data: result });
      exitHandler.mockClear();

      // Then worker exits - should not double-emit
      worker.emit('exit', 0);
      expect(exitHandler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Termination
  // ---------------------------------------------------------------------------

  describe('terminate', () => {
    it('posts abort message and terminates worker', async () => {
      bridge.spawn(createConfig());
      const worker = getWorker();

      await bridge.terminate();

      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'abort' });
      expect(worker.terminate).toHaveBeenCalled();
      expect(bridge.isActive).toBe(false);
    });

    it('handles termination when no worker is active', async () => {
      await expect(bridge.terminate()).resolves.toBeUndefined();
    });

    it('handles postMessage failure on dead worker', async () => {
      bridge.spawn(createConfig());
      getWorker().postMessage.mockImplementation(() => {
        throw new Error('Worker already dead');
      });

      await expect(bridge.terminate()).resolves.toBeUndefined();
    });
  });
});
