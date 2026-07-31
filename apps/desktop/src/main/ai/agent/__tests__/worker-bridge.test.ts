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
const mockMemoryServiceUpdateAccessCount = vi.hoisted(() => vi.fn());

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
    updateAccessCount: mockMemoryServiceUpdateAccessCount,
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
        methodology: `METHODOLOGY_HEAD ${'response methodology detail '.repeat(30)} METHODOLOGY_TAIL`,
        workUnitRef: {
          methodology: `WORK_UNIT_METHOD_HEAD ${'work unit methodology detail '.repeat(30)} WU_TAIL`,
          hierarchy: [
            'Spec 001',
            ' spec 001 ',
            ...Array.from(
              { length: 12 },
              (_, index) => `Task ${index} ${'hierarchy detail '.repeat(20)}tail-${index}`,
            ),
          ],
          label: `WORK_UNIT_LABEL_HEAD ${'work unit label detail '.repeat(60)} WORK_UNIT_LABEL_TAIL`,
        },
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
      expect(memory.methodology?.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(memory.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(memory.methodology).toContain('METHODOLOGY_HEAD');
      expect(memory.methodology).toContain('METHODOLOGY_TAIL');
      expect(memory.workUnitRef?.methodology.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(memory.workUnitRef?.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(memory.workUnitRef?.methodology).toContain('WORK_UNIT_METHOD_HEAD');
      expect(memory.workUnitRef?.methodology).toContain('WU_TAIL');
      expect(memory.workUnitRef?.hierarchy).toHaveLength(12);
      expect(memory.workUnitRef?.hierarchy[0]).toBe('Spec 001');
      expect(memory.workUnitRef?.hierarchy).not.toContain('spec 001');
      expect(memory.workUnitRef?.hierarchy.every((item) => item.length <= 80)).toBe(true);
      expect(memory.workUnitRef?.label.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(memory.workUnitRef?.label ?? '')).toBeLessThanOrEqual(75);
      expect(memory.workUnitRef?.label).toContain('WORK_UNIT_LABEL_HEAD');
      expect(memory.workUnitRef?.label).toContain('WORK_UNIT_LABEL_TAIL');
    });

    it('strips low-value memory search response content before posting to the worker', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          id: 'useful-memory',
          type: 'gotcha',
          content: [
            'npm run typecheck passed.',
            'Memory search unavailable; inspect focused files next.',
            'Prefer stable worker memory IPC request IDs when retrying searches.',
            'Memory noted locally, but could not be persisted.',
            'No issues found.',
            'Completed at: 2026-06-15T12:00:00.000Z',
          ].join('\n'),
        }),
        makeMemory({
          id: 'cost-memory',
          type: 'context_cost',
          content: [
            'High token usage per step: 24k tokens.',
            'Context token spike came from repeatedly sending full search results.',
          ].join('\n'),
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-strip-noise',
        filters: { query: 'worker memory ipc', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-strip-noise',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-strip-noise',
      )?.[0] as { memories: Memory[] };

      expect(response.memories[0].content).toBe(
        'Prefer stable worker memory IPC request IDs when retrying searches.',
      );
      expect(response.memories[0].content).not.toContain('typecheck passed');
      expect(response.memories[0].content).not.toContain('Memory search unavailable');
      expect(response.memories[0].content).not.toContain('could not be persisted');
      expect(response.memories[0].content).not.toContain('No issues found');
      expect(response.memories[0].content).not.toContain('Completed at');
      expect(response.memories[1].content).toContain('High token usage per step');
      expect(response.memories[1].content).toContain('24k tokens');
    });

    it('folds repeated memory search response text before posting to the worker', async () => {
      const repeatedContent = 'REPEATED_MEMORY_IPC_LOG: worker retried the same read with no new signal.';
      const repeatedCitation = 'REPEATED_CITATION_LOG: reranker reported the same score without new evidence.';
      const repeatedPrefix = 'REPEATED_PREFIX_LOG: context prefix repeated the same module breadcrumb.';

      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          id: 'repeated-ipc-memory',
          content: [
            'Memory IPC head: keep the useful search result visible.',
            ...Array.from({ length: 120 }, () => repeatedContent),
            'Memory IPC tail: inspect settings write permissions before broad searches.',
          ].join('\n'),
          citationText: [
            'Citation head.',
            ...Array.from({ length: 48 }, () => repeatedCitation),
            'Citation tail.',
          ].join('\n'),
          contextPrefix: [
            'Prefix head.',
            ...Array.from({ length: 48 }, () => repeatedPrefix),
            'Prefix tail.',
          ].join('\n'),
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-repeated-ipc',
        filters: { query: 'repeated ipc memory', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-repeated-ipc',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-repeated-ipc',
      )?.[0] as { memories: Memory[] };
      const memory = response.memories[0];

      expect(memory.content).toContain('Memory IPC head: keep the useful search result visible.');
      expect(memory.content).toContain('Memory IPC tail: inspect settings write permissions before broad searches.');
      expect(memory.content).toContain('119 repeated line(s) omitted for prompt budget');
      expect((memory.content.match(/REPEATED_MEMORY_IPC_LOG/g) ?? [])).toHaveLength(1);
      expect(memory.citationText).toContain('47 repeated line(s) omitted for prompt budget');
      expect((memory.citationText?.match(/REPEATED_CITATION_LOG/g) ?? [])).toHaveLength(1);
      expect(memory.contextPrefix).toContain('47 repeated line(s) omitted for prompt budget');
      expect((memory.contextPrefix?.match(/REPEATED_PREFIX_LOG/g) ?? [])).toHaveLength(1);
      expect(estimateTokens(memory.content)).toBeLessThanOrEqual(225);
      expect(estimateTokens(memory.citationText ?? '')).toBeLessThanOrEqual(75);
      expect(estimateTokens(memory.contextPrefix ?? '')).toBeLessThanOrEqual(75);
    });

    it('deduplicates case and whitespace variants in memory search metadata before IPC', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          tags: [' Auth ', 'auth', 'AUTH', 'testing', ' TESTING ', 'memory'],
          relatedFiles: ['src\\auth\\token.ts', './SRC/auth/token.ts/', 'src/auth/session.ts'],
          relatedModules: [' Agent/Memory ', 'agent/memory', 'AGENT/MEMORY', 'runtime', ' Runtime '],
          provenanceSessionIds: ['Session-A', 'session-a'],
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-metadata-dedupe',
        filters: { query: 'auth memory', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-metadata-dedupe',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-metadata-dedupe',
      )?.[0] as { memories: Memory[] };
      const memory = response.memories[0];

      expect(memory.tags).toEqual(['Auth', 'testing', 'memory']);
      expect(memory.relatedFiles).toEqual(['src/auth/token.ts', 'src/auth/session.ts']);
      expect(memory.relatedModules).toEqual(['Agent/Memory', 'runtime']);
      expect(memory.provenanceSessionIds).toEqual(['Session-A', 'session-a']);
    });

    it('deduplicates compacted memory relations before applying the IPC relation limit', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          relations: [
            ...Array.from({ length: 8 }, (_, index) => ({
              relationType: 'validates' as const,
              targetFilePath: index % 2 === 0 ? 'src\\auth\\token.ts' : './SRC/auth/token.ts/',
              confidence: index === 7 ? 0.98 : 0.4,
              autoExtracted: true,
            })),
            {
              relationType: 'required_with',
              targetFilePath: 'src/auth/session.ts',
              confidence: 0.85,
              autoExtracted: true,
            },
          ],
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-relation-dedupe',
        filters: { query: 'auth relation', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-relation-dedupe',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-relation-dedupe',
      )?.[0] as { memories: Memory[] };
      const memory = response.memories[0];

      expect(memory.relations?.map((relation) => relation.targetFilePath)).toEqual([
        'src/auth/token.ts',
        'src/auth/session.ts',
      ]);
      expect(memory.relations?.map((relation) => relation.relationType)).toEqual([
        'validates',
        'required_with',
      ]);
      expect(memory.relations?.[0].confidence).toBe(0.98);
    });

    it('deduplicates equivalent compacted memories before posting search results to the worker', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce([
        makeMemory({
          id: 'duplicate-low',
          content: 'Use the auth-retry helper before refreshing tokens!',
          confidence: 0.65,
          accessCount: 1,
          tags: ['auth'],
          relatedFiles: ['src/auth/legacy.ts'],
          relatedModules: ['auth/legacy'],
          provenanceSessionIds: ['low-session'],
          impactedNodeIds: ['node-low'],
          relations: [
            {
              relationType: 'validates',
              targetFilePath: 'src/auth/legacy.ts',
              confidence: 0.4,
              autoExtracted: true,
            },
          ],
        }),
        makeMemory({
          id: 'duplicate-high',
          content: ' use   the auth retry helper before refreshing tokens. ',
          confidence: 0.92,
          accessCount: 2,
          tags: ['runtime'],
          relatedFiles: ['src/auth/current.ts'],
          relatedModules: ['auth/runtime'],
          provenanceSessionIds: ['high-session'],
          impactedNodeIds: ['node-high'],
          relations: [
            {
              relationType: 'required_with',
              targetFilePath: 'src/auth/current.ts',
              confidence: 0.9,
              autoExtracted: true,
            },
          ],
        }),
        makeMemory({
          id: 'distinct',
          content: 'Mock the OAuth clock before testing refresh retries.',
          confidence: 0.7,
        }),
      ]);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-memory-dedupe',
        filters: { query: 'auth retry', projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-memory-dedupe',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-memory-dedupe',
      )?.[0] as { memories: Memory[] };

      expect(response.memories.map((memory) => memory.id)).toEqual(['duplicate-high', 'distinct']);
      expect(response.memories[0].content).toBe('use the auth retry helper before refreshing tokens.');
      expect(response.memories[0].tags).toEqual(['runtime', 'auth']);
      expect(response.memories[0].relatedFiles).toEqual(['src/auth/current.ts', 'src/auth/legacy.ts']);
      expect(response.memories[0].relatedModules).toEqual(['auth/runtime', 'auth/legacy']);
      expect(response.memories[0].provenanceSessionIds).toEqual(['high-session', 'low-session']);
      expect(response.memories[0].impactedNodeIds).toEqual(['node-high', 'node-low']);
      expect(response.memories[0].relations?.map((relation) => relation.targetFilePath)).toEqual([
        'src/auth/current.ts',
        'src/auth/legacy.ts',
      ]);
    });

    it('caps memory search responses before posting them back to the worker', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, index) =>
          makeMemory({
            id: `mem-${index}`,
            content: `Distinct memory result ${index} for IPC cap testing.`,
            confidence: 0.8,
          }),
        ),
      );
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-memory-cap',
        filters: { projectId: 'proj-456' },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-memory-cap',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-memory-cap',
      )?.[0] as { memories: Memory[] };

      expect(response.memories).toHaveLength(12);
      expect(response.memories.at(-1)?.id).toBe('mem-11');
    });

    it('respects smaller requested memory search limits at the IPC response boundary', async () => {
      mockMemoryServiceSearch.mockResolvedValueOnce(
        Array.from({ length: 8 }, (_, index) =>
          makeMemory({
            id: `limited-${index}`,
            content: `Limited memory result ${index}.`,
            confidence: 0.8,
          }),
        ),
      );
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:search',
        requestId: 'req-memory-small-limit',
        filters: { query: 'limited', projectId: 'proj-456', limit: 3 },
      });

      await vi.waitFor(() => {
        expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
          type: 'memory:search-result',
          requestId: 'req-memory-small-limit',
        }));
      });
      const response = worker.postMessage.mock.calls.find(
        ([message]) => (message as { requestId?: string }).requestId === 'req-memory-small-limit',
      )?.[0] as { memories: Memory[] };

      expect(response.memories.map((memory) => memory.id)).toEqual([
        'limited-0',
        'limited-1',
        'limited-2',
      ]);
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

    it('handles memory access updates from the worker', async () => {
      mockMemoryServiceUpdateAccessCount.mockResolvedValueOnce(undefined);
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:access',
        requestId: 'access-1',
        memoryId: 'mem-1',
      });

      await vi.waitFor(() => {
        expect(mockMemoryServiceUpdateAccessCount).toHaveBeenCalledWith('mem-1');
        expect(worker.postMessage).toHaveBeenCalledWith({
          type: 'memory:accessed',
          requestId: 'access-1',
        });
      });
    });

    it('stores context_cost memories learned from token usage observations', async () => {
      mockMemoryServiceStore.mockResolvedValue('stored-context-cost');
      bridge.spawn(createConfig());
      const worker = getWorker();

      worker.emit('message', {
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/session.ts' },
        stepNumber: 1,
      });
      worker.emit('message', {
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/session.ts' },
        stepNumber: 2,
      });
      worker.emit('message', {
        type: 'memory:token-usage',
        inputTokens: 24_000,
        contextWindowLimit: 30_000,
        stepNumber: 3,
      });
      worker.emit('message', {
        type: 'result',
        taskId: 'task-123',
        data: createSessionResult({ outcome: 'completed', stepsExecuted: 3 }),
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      await vi.waitFor(() => {
        expect(mockMemoryServiceStore).toHaveBeenCalledWith(expect.objectContaining({
          type: 'context_cost',
          source: 'observer_inferred',
          projectId: 'proj-456',
          sessionId: 'task-123',
          tags: expect.arrayContaining([
            'context_token_spike',
            'build',
            'context_cost',
            'token_usage',
          ]),
          relatedFiles: ['src/auth/session.ts'],
          relatedModules: ['auth'],
        }));
      });
      const storedEntry = mockMemoryServiceStore.mock.calls[0][0];
      expect(storedEntry.content).toContain('Context token spike');
      expect(storedEntry.content).toContain('24k tokens');
      expect(storedEntry.content.length).toBeLessThan(220);
    });

    it('stores learned memories with the finalized task snapshot when the bridge is reused', async () => {
      mockMemoryServiceStore.mockResolvedValue('stored-context-cost');
      bridge.spawn(createConfig({
        taskId: 'old-task',
        projectId: 'old-project',
        processType: 'task-execution',
      }));
      const oldWorker = getWorker();

      oldWorker.emit('message', {
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/session.ts' },
        stepNumber: 1,
      });
      oldWorker.emit('message', {
        type: 'memory:token-usage',
        inputTokens: 24_000,
        contextWindowLimit: 30_000,
        stepNumber: 2,
      });
      oldWorker.emit('message', {
        type: 'result',
        taskId: 'old-task',
        data: createSessionResult({ outcome: 'completed', stepsExecuted: 2 }),
        projectId: 'old-project',
      } satisfies WorkerMessage);

      bridge.spawn(createConfig({
        taskId: 'new-task',
        projectId: 'new-project',
        processType: 'spec-creation',
      }));

      await vi.waitFor(() => {
        expect(mockMemoryServiceStore).toHaveBeenCalled();
      });
      const storedEntry = mockMemoryServiceStore.mock.calls[0][0];
      expect(storedEntry.projectId).toBe('old-project');
      expect(storedEntry.sessionId).toBe('old-task');
      expect(storedEntry.tags).toContain('build');
      expect(storedEntry.tags).not.toContain('spec_creation');
    });

    it('continues storing remaining learned memories when one candidate fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const logHandler = vi.fn();
        mockMemoryServiceStore
          .mockRejectedValueOnce(new Error('bad candidate'))
          .mockResolvedValueOnce('stored-context-cost');
        bridge.on('log', logHandler);
        bridge.spawn(createConfig());
        const worker = getWorker();

        for (let stepNumber = 1; stepNumber <= 3; stepNumber += 1) {
          worker.emit('message', {
            type: 'memory:tool-call',
            toolName: 'Grep',
            args: { pattern: 'refreshToken', path: 'src/auth' },
            stepNumber,
          });
        }
        worker.emit('message', {
          type: 'memory:token-usage',
          inputTokens: 24_000,
          contextWindowLimit: 30_000,
          stepNumber: 4,
        });
        worker.emit('message', {
          type: 'result',
          taskId: 'task-123',
          data: createSessionResult({ outcome: 'completed', stepsExecuted: 4 }),
          projectId: 'proj-456',
        } satisfies WorkerMessage);

        await vi.waitFor(() => {
          expect(mockMemoryServiceStore).toHaveBeenCalledTimes(2);
          expect(logHandler).toHaveBeenCalledWith(
            'task-123',
            'Memory learned: 1 candidate(s) stored',
            'proj-456',
          );
        });
        expect(warnSpy).toHaveBeenCalledWith(
          '[WorkerBridge:task-123] Failed to store 1 memory candidate(s)',
        );
      } finally {
        warnSpy.mockRestore();
      }
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

    it('replaces an estimated session usage with lower provider-reported usage', () => {
      const handler = vi.fn();
      bridge.on('task-token-usage', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: {
            promptTokens: 1000,
            completionTokens: 400,
            totalTokens: 1400,
            stepsExecuted: 2,
            estimated: true,
            sessionId: 'session-a',
          },
        } as never,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'task-token-usage',
        taskId: 'task-123',
        data: {
          promptTokens: 300,
          completionTokens: 80,
          totalTokens: 380,
          stepsExecuted: 2,
          sessionId: 'session-a',
        },
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenLastCalledWith('task-123', {
        promptTokens: 300,
        completionTokens: 80,
        totalTokens: 380,
        stepsExecuted: 2,
        sessionId: 'session-a',
      }, 'proj-456');
    });

    it('allows final provider usage to correct a higher realtime same-session snapshot', () => {
      const handler = vi.fn();
      bridge.on('task-token-usage', handler);
      bridge.spawn(createConfig());

      getWorker().emit('message', {
        type: 'stream-event',
        taskId: 'task-123',
        data: {
          type: 'usage-update',
          usage: {
            promptTokens: 900,
            completionTokens: 120,
            totalTokens: 1020,
            stepsExecuted: 4,
            sessionId: 'session-a',
          },
        } as never,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      getWorker().emit('message', {
        type: 'task-token-usage',
        taskId: 'task-123',
        data: {
          promptTokens: 420,
          completionTokens: 80,
          totalTokens: 500,
          stepsExecuted: 2,
          sessionId: 'session-a',
        },
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(handler).toHaveBeenLastCalledWith('task-123', {
        promptTokens: 420,
        completionTokens: 80,
        totalTokens: 500,
        stepsExecuted: 2,
        sessionId: 'session-a',
      }, 'proj-456');
    });
  });

  // ---------------------------------------------------------------------------
  // Result handling
  // ---------------------------------------------------------------------------

  describe('result handling', () => {
    it('emits the original session result before exit', () => {
      const eventOrder: string[] = [];
      const resultHandler = vi.fn((_taskId: string, _result: SessionResult, _projectId?: string) => {
        eventOrder.push('session-result');
      });
      const exitHandler = vi.fn(() => {
        eventOrder.push('exit');
      });
      bridge.on('session-result', resultHandler);
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({
        outcome: 'completed',
        stepsExecuted: 7,
      });
      getWorker().emit('message', {
        type: 'result',
        taskId: 'task-123',
        data: result,
        projectId: 'proj-456',
      } satisfies WorkerMessage);

      expect(resultHandler).toHaveBeenCalledWith('task-123', result, 'proj-456');
      expect(resultHandler.mock.calls[0]?.[1]).toBe(result);
      expect(eventOrder).toEqual(['session-result', 'exit']);
    });

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

    it('keeps non-Direct context_window outcome as exit code 0', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      bridge.spawn(createConfig());

      const result = createSessionResult({ outcome: 'context_window' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 0, 'task-execution', undefined);
    });

    it('maps Direct context_window outcome to exit code 1', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      const baseConfig = createConfig();
      bridge.spawn(createConfig({
        session: {
          ...baseConfig.session,
          agentType: 'direct_task',
          workflowMode: 'off',
        },
      }));

      const result = createSessionResult({ outcome: 'context_window' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', undefined);
    });

    it('maps Direct max_steps outcome to exit code 1', () => {
      const exitHandler = vi.fn();
      bridge.on('exit', exitHandler);
      const baseConfig = createConfig();
      bridge.spawn(createConfig({
        session: {
          ...baseConfig.session,
          agentType: 'direct_task',
          workflowMode: 'off',
        },
      }));

      const result = createSessionResult({ outcome: 'max_steps' });
      getWorker().emit('message', { type: 'result', taskId: 'task-123', data: result });

      expect(exitHandler).toHaveBeenCalledWith('task-123', 1, 'task-execution', undefined);
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
          usage: { promptTokens: 2462, completionTokens: 53, totalTokens: 2515, stepsExecuted: 1 },
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
        stepsExecuted: 1,
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
