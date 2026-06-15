/**
 * WorkerObserverProxy Tests
 *
 * Tests IPC request/response correlation, timeout handling,
 * and fire-and-forget observation calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessagePort } from 'worker_threads';
import { WorkerObserverProxy } from '../../ipc/worker-observer-proxy';
import type { MemoryIpcResponse, Memory } from '../../types';
import { estimateTokens } from '../../retrieval/context-packer';

// ============================================================
// HELPERS
// ============================================================

function makeMemory(): Memory {
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
    projectId: 'proj-1',
  };
}

// ============================================================
// MOCK MESSAGE PORT
// ============================================================

function makeMockPort() {
  const listeners = new Map<string, ((msg: unknown) => void)[]>();
  const sentMessages: unknown[] = [];

  const port = {
    postMessage: vi.fn((msg: unknown) => {
      sentMessages.push(msg);
    }),
    on: (event: string, listener: (msg: unknown) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    emit: (event: string, msg: unknown) => {
      const ls = listeners.get(event) ?? [];
      for (const l of ls) l(msg);
    },
    sentMessages,
  };

  return port;
}

// Helper: schedule a response after postMessage is called.
// The mock replaces postMessage so it intercepts the message, captures
// the requestId from the message param directly, then emits the response.
function setupResponseMock(
  mockPort: ReturnType<typeof makeMockPort>,
  makeResponse: (requestId: string) => MemoryIpcResponse,
) {
  mockPort.postMessage.mockImplementationOnce((msg: unknown) => {
    // Push to sentMessages manually (mirrors default vi.fn behavior)
    mockPort.sentMessages.push(msg);
    const requestId = (msg as Record<string, unknown>).requestId as string;
    const response = makeResponse(requestId);
    mockPort.emit('message', response);
  });
}

// ============================================================
// TESTS
// ============================================================

describe('WorkerObserverProxy', () => {
  let mockPort: ReturnType<typeof makeMockPort>;
  let proxy: WorkerObserverProxy;

  beforeEach(() => {
    mockPort = makeMockPort();
    proxy = new WorkerObserverProxy(mockPort as unknown as MessagePort);
  });

  describe('fire-and-forget observation methods', () => {
    it('onToolCall posts a memory:tool-call message', () => {
      proxy.onToolCall('Read', { file_path: '/src/auth.ts' }, 3);

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'memory:tool-call',
          toolName: 'Read',
          args: { file_path: '/src/auth.ts' },
          stepNumber: 3,
        }),
      );
    });

    it('compacts large tool call arguments before posting observation IPC', () => {
      proxy.onToolCall('Write', {
        file_path: '/src/generated.ts',
        content: 'x'.repeat(5_000),
        old_string: 'old'.repeat(1_000),
        new_string: 'new'.repeat(1_000),
        command: `npm test ${'--workspace apps/desktop '.repeat(30)}`,
        unexpected_payload: 'should not be retained',
      }, 4);

      const sentMsg = mockPort.sentMessages[0] as {
        args: Record<string, unknown>;
      };
      expect(sentMsg.args.file_path).toBe('/src/generated.ts');
      expect(sentMsg.args).not.toHaveProperty('content');
      expect(sentMsg.args).not.toHaveProperty('old_string');
      expect(sentMsg.args).not.toHaveProperty('new_string');
      expect(sentMsg.args).not.toHaveProperty('unexpected_payload');
      expect(String(sentMsg.args.command)).toHaveLength(240);
    });

    it('onToolResult posts a memory:tool-result message', () => {
      proxy.onToolResult('Read', 'file contents', 3);

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'memory:tool-result',
          toolName: 'Read',
          result: 'file contents',
          stepNumber: 3,
        }),
      );
    });

    it('compacts large tool results while preserving diagnostic text and tail output', () => {
      const result = [
        'noise '.repeat(300),
        'Error: build failed because module was missing',
        'tail '.repeat(300),
        'FINAL_EXIT_CODE_1_SHOULD_BE_PRESERVED',
      ].join(' ');
      proxy.onToolResult('Bash', result, 5);

      const sentMsg = mockPort.sentMessages[0] as {
        result: string;
      };
      expect(sentMsg.result.length).toBeLessThanOrEqual(1_200);
      expect(sentMsg.result).toContain('Error: build failed');
      expect(sentMsg.result).toContain('FINAL_EXIT_CODE_1_SHOULD_BE_PRESERVED');
    });

    it('strips low-value tool result lines before posting observation IPC', () => {
      proxy.onToolResult('Bash', [
        'npm run typecheck passed.',
        'Memory search unavailable; inspect focused files next.',
        'Retry import scans with --runInBand when the sqlite watcher holds the lock.',
        'Memory noted locally, but could not be persisted.',
        'No issues found.',
        'Completed at: 2026-06-15T12:00:00.000Z',
      ].join('\n'), 5);

      const sentMsg = mockPort.sentMessages[0] as {
        result: string;
      };
      expect(sentMsg.result).toBe(
        'Retry import scans with --runInBand when the sqlite watcher holds the lock.',
      );
      expect(sentMsg.result).not.toContain('typecheck passed');
      expect(sentMsg.result).not.toContain('Memory search unavailable');
      expect(sentMsg.result).not.toContain('could not be persisted');
      expect(sentMsg.result).not.toContain('No issues found');
      expect(sentMsg.result).not.toContain('Completed at');
    });

    it('preserves compact diagnostics for omitted object tool result fields', () => {
      proxy.onToolResult('Bash', {
        stdout: 'stdout noise '.repeat(500),
        stderr: [
          'stderr noise '.repeat(500),
          'Error: build failed because module was missing',
          'tail '.repeat(80),
          'FINAL_STDERR_TAIL',
        ].join(' '),
        exitCode: 1,
      }, 6);

      const sentMsg = mockPort.sentMessages[0] as {
        result: Record<string, unknown>;
      };
      expect(sentMsg.result.omittedKeys).toEqual(['stdout', 'stderr']);
      expect(sentMsg.result).not.toHaveProperty('stdout');
      expect(sentMsg.result).not.toHaveProperty('stderr');
      expect(sentMsg.result.exitCode).toBe(1);
      expect(String(sentMsg.result.diagnosticText)).toContain('Error: build failed');
      expect(String(sentMsg.result.diagnosticText)).toContain('FINAL_STDERR_TAIL');
      expect(String(sentMsg.result.diagnosticText).length).toBeLessThanOrEqual(360);
    });

    it('onReasoning posts a memory:reasoning message', () => {
      proxy.onReasoning('I should check the imports first.', 2);

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'memory:reasoning',
          text: 'I should check the imports first.',
          stepNumber: 2,
        }),
      );
    });

    it('compacts long reasoning text while preserving correction signals', () => {
      const reasoning = [
        'thinking '.repeat(300),
        'Correction: this file is generated, so I should edit the source template instead.',
        'tail '.repeat(300),
      ].join(' ');
      proxy.onReasoning(reasoning, 6);

      const sentMsg = mockPort.sentMessages[0] as { text: string };
      expect(sentMsg.text.length).toBeLessThanOrEqual(900);
      expect(sentMsg.text).toContain('Correction: this file is generated');
    });

    it('onTokenUsage posts a compact memory:token-usage message', () => {
      proxy.onTokenUsage(18_500.9, 7, 24_000.3);

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'memory:token-usage',
          inputTokens: 18_500,
          contextWindowLimit: 24_000,
          stepNumber: 7,
        }),
      );
    });

    it('onStepComplete posts a memory:step-complete message', () => {
      proxy.onStepComplete(7);

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'memory:step-complete',
          stepNumber: 7,
        }),
      );
    });

    it('does not throw when postMessage fails', () => {
      mockPort.postMessage.mockImplementationOnce(() => {
        throw new Error('Port closed');
      });

      expect(() => proxy.onToolCall('Read', {}, 1)).not.toThrow();
    });
  });

  describe('searchMemory()', () => {
    it('sends a memory:search message and resolves with memories on success', async () => {
      const memories: Memory[] = [makeMemory()];

      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories,
      }));

      const result = await proxy.searchMemory({ query: 'auth token', projectId: 'proj-1' });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Use refreshToken() before API calls');
    });

    it('compacts verbose search filters before posting IPC requests', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories: [],
      }));

      const query = `SEARCH_HEAD ${'verbose query detail '.repeat(120)} SEARCH_TAIL`;
      await proxy.searchMemory({
        query,
        projectId: 'proj-1',
        relatedFiles: [
          'src/auth/token.ts',
          ' src\\auth\\token.ts ',
          'src/auth//token.ts',
          './SRC/auth/token.ts',
          ...Array.from(
            { length: 20 },
            (_, index) => `src/very/deep/path/${index}/${'file-name-segment-'.repeat(18)}tail-${index}.ts`,
          ),
        ],
        relatedModules: [
          ' auth ',
          'AUTH',
          ...Array.from(
            { length: 20 },
            (_, index) => `module-${index}-${'nested-'.repeat(20)}tail`,
          ),
        ],
        recordAccess: true,
        filter: () => true,
      });

      const sentMsg = mockPort.sentMessages[0] as {
        filters: {
          query?: string;
          limit?: number;
          relatedFiles?: string[];
          relatedModules?: string[];
          recordAccess?: boolean;
          filter?: unknown;
        };
      };

      expect(sentMsg.filters.query?.length).toBeLessThanOrEqual(800);
      expect(estimateTokens(sentMsg.filters.query ?? '')).toBeLessThanOrEqual(200);
      expect(sentMsg.filters.query).toContain('SEARCH_HEAD');
      expect(sentMsg.filters.query).toContain('SEARCH_TAIL');
      expect(sentMsg.filters.query).toContain('memory search middle omitted before IPC');
      expect(sentMsg.filters.limit).toBe(8);
      expect(sentMsg.filters.relatedFiles).toHaveLength(16);
      expect(new Set(sentMsg.filters.relatedFiles).size).toBe(sentMsg.filters.relatedFiles?.length);
      expect(sentMsg.filters.relatedFiles?.[0]).toBe('src/auth/token.ts');
      expect(sentMsg.filters.relatedFiles?.every((file) => file.length <= 180)).toBe(true);
      expect(sentMsg.filters.relatedFiles?.every((file) => !file.includes('[omitted]'))).toBe(true);
      expect(sentMsg.filters.relatedFiles?.some((file) => file.includes('tail-0.ts'))).toBe(true);
      expect(sentMsg.filters.relatedModules).toHaveLength(12);
      expect(sentMsg.filters.relatedModules?.[0]).toBe('auth');
      expect(sentMsg.filters.relatedModules).not.toContain('AUTH');
      expect(sentMsg.filters.relatedModules?.every((module) => module.length <= 96)).toBe(true);
      expect(sentMsg.filters.relatedModules?.every((module) => estimateTokens(module) <= 32)).toBe(true);
      expect(sentMsg.filters.recordAccess).toBe(true);
      expect(sentMsg.filters).not.toHaveProperty('filter');
    });

    it('omits search modules already represented by related files before IPC', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories: [],
      }));

      await proxy.searchMemory({
        query: 'auth token',
        projectId: 'proj-1',
        relatedFiles: [' src\\auth\\token.ts ', 'src/auth/session-store.ts'],
        relatedModules: [
          'src/auth/token.ts',
          'token.ts',
          'token',
          'session-store',
          'auth',
          'token refresh',
        ],
      });

      const sentMsg = mockPort.sentMessages[0] as {
        filters: {
          relatedFiles?: string[];
          relatedModules?: string[];
        };
      };

      expect(sentMsg.filters.relatedFiles).toEqual([
        'src/auth/token.ts',
        'src/auth/session-store.ts',
      ]);
      expect(sentMsg.filters.relatedModules).toEqual(['auth', 'token refresh']);
    });

    it('caps direct search limits before posting IPC requests', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories: [],
      }));

      await proxy.searchMemory({ projectId: 'proj-1' });

      let sentMsg = mockPort.sentMessages[0] as {
        filters: { limit?: number };
      };
      expect(sentMsg.filters.limit).toBe(12);

      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories: [],
      }));

      await proxy.searchMemory({ query: 'auth', projectId: 'proj-1', limit: 50 });

      sentMsg = mockPort.sentMessages[1] as {
        filters: { limit?: number };
      };
      expect(sentMsg.filters.limit).toBe(12);
    });

    it('keeps localized search filters within token budgets before IPC', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:search-result',
        requestId,
        memories: [],
      }));

      await proxy.searchMemory({
        query: [
          '查询开头',
          '这是一段很长的中文检索条件，会比英文更快消耗 token。'.repeat(80),
          '查询尾部',
        ].join(' '),
        projectId: 'proj-1',
        relatedFiles: [
          `src/${'深层目录/'.repeat(80)}localized-tail-preserved.ts`,
        ],
        relatedModules: [
          `模块开头${'本地化模块上下文'.repeat(40)}模块尾部`,
        ],
      });

      const sentMsg = mockPort.sentMessages[0] as {
        filters: {
          query?: string;
          relatedFiles?: string[];
          relatedModules?: string[];
        };
      };

      expect(sentMsg.filters.query?.length).toBeLessThanOrEqual(800);
      expect(estimateTokens(sentMsg.filters.query ?? '')).toBeLessThanOrEqual(200);
      expect(sentMsg.filters.query).toContain('查询开头');
      expect(sentMsg.filters.query).toContain('查询尾部');
      expect(sentMsg.filters.relatedFiles?.[0]).toContain('localized-tail-preserved.ts');
      expect(sentMsg.filters.relatedFiles?.[0]).not.toContain('[omitted]');
      expect(sentMsg.filters.relatedModules?.[0]).toContain('模块开头');
      expect(sentMsg.filters.relatedModules?.[0]).toContain('模块尾部');
      expect(estimateTokens(sentMsg.filters.relatedModules?.[0] ?? '')).toBeLessThanOrEqual(32);
    });

    it('returns empty array on error response', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:error',
        requestId,
        error: 'Service unavailable',
      }));

      const result = await proxy.searchMemory({ query: 'test', projectId: 'proj-1' });

      expect(result).toEqual([]);
    });

    it('returns empty array when postMessage throws', async () => {
      mockPort.postMessage.mockImplementationOnce(() => {
        throw new Error('Port closed');
      });

      const result = await proxy.searchMemory({ query: 'test', projectId: 'proj-1' });
      expect(result).toEqual([]);
    });
  });

  describe('recordMemory()', () => {
    it('sends a memory:record message and resolves with ID on success', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-123',
      }));

      const id = await proxy.recordMemory({
        type: 'gotcha',
        content: 'Always check null before .id',
        projectId: 'proj-1',
      });

      expect(id).toBe('new-mem-123');
    });

    it('strips low-value record memory content before posting IPC requests', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-useful',
      }));

      await proxy.recordMemory({
        type: 'gotcha',
        content: [
          'npm run typecheck passed.',
          'Memory search unavailable; inspect focused files next.',
          'Strip status-only lines before proxying worker memory writes.',
          'Memory noted locally, but could not be persisted.',
          'No issues found.',
          'Completed at: 2026-06-15T12:00:00.000Z',
        ].join('\n'),
        projectId: 'proj-1',
      });

      let sentMsg = mockPort.sentMessages[0] as {
        entry: { content: string };
      };
      expect(sentMsg.entry.content).toBe(
        'Strip status-only lines before proxying worker memory writes.',
      );
      expect(sentMsg.entry.content).not.toContain('typecheck passed');
      expect(sentMsg.entry.content).not.toContain('Memory search unavailable');
      expect(sentMsg.entry.content).not.toContain('could not be persisted');
      expect(sentMsg.entry.content).not.toContain('No issues found');
      expect(sentMsg.entry.content).not.toContain('Completed at');

      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-cost',
      }));

      await proxy.recordMemory({
        type: 'context_cost',
        content: [
          'High token usage per step: 24k tokens.',
          'Context token spike came from large memory IPC payloads.',
        ].join('\n'),
        projectId: 'proj-1',
      });

      sentMsg = mockPort.sentMessages[1] as {
        entry: { content: string };
      };
      expect(sentMsg.entry.content).toContain('High token usage per step');
      expect(sentMsg.entry.content).toContain('24k tokens');
    });

    it('compacts verbose memory entries before posting record IPC requests', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-456',
      }));

      await proxy.recordMemory({
        type: 'gotcha',
        content: `MEMORY_HEAD ${'verbose memory detail '.repeat(160)} MEMORY_TAIL`,
        projectId: 'proj-1',
        tags: [
          'auth',
          'auth',
          ...Array.from({ length: 30 }, (_, index) => `tag-${index}-${'x'.repeat(80)}`),
        ],
        relatedFiles: Array.from(
          { length: 30 },
          (_, index) => index === 0
            ? ' src\\auth\\token.ts '
            : index === 1
              ? 'src/auth//token.ts'
              : index === 2
                ? './SRC/auth/token.ts'
                : `src/very/deep/path/${index}/${'file-name-segment-'.repeat(20)}tail-${index}.ts`,
        ),
        relatedModules: [
          ' auth ',
          'AUTH',
          ...Array.from(
            { length: 20 },
            (_, index) => `module-${index}-${'nested-'.repeat(20)}tail`,
          ),
        ],
        citationText: `CITATION_HEAD ${'citation detail '.repeat(120)} CITATION_TAIL`,
        contextPrefix: `PREFIX_HEAD ${'context detail '.repeat(80)} PREFIX_TAIL`,
        methodology: `METHODOLOGY_HEAD ${'top level methodology detail '.repeat(30)} METHODOLOGY_TAIL`,
        workUnitRef: {
          methodology: `native ${'methodology detail '.repeat(30)}METHODOLOGY_TAIL`,
          hierarchy: [
            'Spec 001',
            ' spec 001 ',
            ...Array.from(
              { length: 12 },
              (_, index) => `Task ${index} ${'hierarchy detail '.repeat(20)}tail-${index}`,
            ),
          ],
          label: `LABEL_HEAD ${'work unit label detail '.repeat(80)} LABEL_TAIL`,
        },
      });

      const sentMsg = mockPort.sentMessages[0] as {
        entry: {
          content: string;
          tags?: string[];
          relatedFiles?: string[];
          relatedModules?: string[];
          citationText?: string;
          contextPrefix?: string;
          methodology?: string;
          workUnitRef?: {
            methodology: string;
            hierarchy: string[];
            label: string;
          };
        };
      };

      expect(sentMsg.entry.content.length).toBeLessThanOrEqual(2000);
      expect(estimateTokens(sentMsg.entry.content)).toBeLessThanOrEqual(500);
      expect(sentMsg.entry.content).toContain('MEMORY_HEAD');
      expect(sentMsg.entry.content).toContain('MEMORY_TAIL');
      expect(sentMsg.entry.content).toContain('memory record middle omitted before IPC');
      expect(sentMsg.entry.tags).toHaveLength(20);
      expect(new Set(sentMsg.entry.tags).size).toBe(sentMsg.entry.tags?.length);
      expect(sentMsg.entry.tags?.every((tag) => tag.length <= 64)).toBe(true);
      expect(sentMsg.entry.tags?.every((tag) => estimateTokens(tag) <= 24)).toBe(true);
      expect(sentMsg.entry.relatedFiles).toHaveLength(24);
      expect(sentMsg.entry.relatedFiles?.[0]).toBe('src/auth/token.ts');
      expect(sentMsg.entry.relatedFiles?.every((file) => file.length <= 220)).toBe(true);
      expect(sentMsg.entry.relatedFiles?.every((file) => !file.includes('[omitted]'))).toBe(true);
      expect(sentMsg.entry.relatedFiles?.some((file) => file.includes('tail-3.ts'))).toBe(true);
      expect(sentMsg.entry.relatedModules).toHaveLength(16);
      expect(sentMsg.entry.relatedModules?.[0]).toBe('auth');
      expect(sentMsg.entry.relatedModules).not.toContain('AUTH');
      expect(sentMsg.entry.relatedModules?.every((module) => module.length <= 96)).toBe(true);
      expect(sentMsg.entry.relatedModules?.every((module) => estimateTokens(module) <= 32)).toBe(true);
      expect(sentMsg.entry.citationText?.length).toBeLessThanOrEqual(1000);
      expect(estimateTokens(sentMsg.entry.citationText ?? '')).toBeLessThanOrEqual(250);
      expect(sentMsg.entry.citationText).toContain('CITATION_HEAD');
      expect(sentMsg.entry.citationText).toContain('CITATION_TAIL');
      expect(sentMsg.entry.contextPrefix?.length).toBeLessThanOrEqual(600);
      expect(estimateTokens(sentMsg.entry.contextPrefix ?? '')).toBeLessThanOrEqual(150);
      expect(sentMsg.entry.contextPrefix).toContain('PREFIX_HEAD');
      expect(sentMsg.entry.contextPrefix).toContain('PREFIX_TAIL');
      expect(sentMsg.entry.methodology?.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(sentMsg.entry.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(sentMsg.entry.methodology).toContain('METHODOLOGY_HEAD');
      expect(sentMsg.entry.methodology).toContain('METHODOLOGY_TAIL');
      expect(sentMsg.entry.workUnitRef?.methodology.length).toBeLessThanOrEqual(96);
      expect(estimateTokens(sentMsg.entry.workUnitRef?.methodology ?? '')).toBeLessThanOrEqual(24);
      expect(sentMsg.entry.workUnitRef?.hierarchy).toHaveLength(8);
      expect(sentMsg.entry.workUnitRef?.hierarchy[0]).toBe('Spec 001');
      expect(sentMsg.entry.workUnitRef?.hierarchy).not.toContain('spec 001');
      expect(sentMsg.entry.workUnitRef?.hierarchy.every((item) => item.length <= 120)).toBe(true);
      expect(sentMsg.entry.workUnitRef?.hierarchy.every((item) => estimateTokens(item) <= 32)).toBe(true);
      expect(sentMsg.entry.workUnitRef?.label.length).toBeLessThanOrEqual(300);
      expect(estimateTokens(sentMsg.entry.workUnitRef?.label ?? '')).toBeLessThanOrEqual(75);
      expect(sentMsg.entry.workUnitRef?.label).toContain('LABEL_HEAD');
      expect(sentMsg.entry.workUnitRef?.label).toContain('LABEL_TAIL');
    });

    it('omits record modules already represented by related files before IPC', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-file-dedup',
      }));

      await proxy.recordMemory({
        type: 'gotcha',
        content: 'Use shared auth helper before retrying token refresh.',
        projectId: 'proj-1',
        relatedFiles: [' src\\auth\\token.ts ', 'src/auth/session-store.ts'],
        relatedModules: [
          'src/auth/token.ts',
          'token.ts',
          'token',
          'session-store',
          'auth',
          'token refresh',
        ],
      });

      const sentMsg = mockPort.sentMessages[0] as {
        entry: {
          relatedFiles?: string[];
          relatedModules?: string[];
        };
      };

      expect(sentMsg.entry.relatedFiles).toEqual([
        'src/auth/token.ts',
        'src/auth/session-store.ts',
      ]);
      expect(sentMsg.entry.relatedModules).toEqual(['auth', 'token refresh']);
    });

    it('keeps localized memory record entries within token budgets before IPC', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:stored',
        requestId,
        id: 'new-mem-localized',
      }));

      await proxy.recordMemory({
        type: 'gotcha',
        content: [
          '记忆开头',
          '这是一段很长的中文记忆内容，会比英文更快消耗 token。'.repeat(140),
          '记忆尾部',
        ].join(' '),
        projectId: 'proj-1',
        tags: [
          `标签开头${'本地化标签'.repeat(20)}标签尾部`,
        ],
        relatedFiles: [
          `src/${'深层目录/'.repeat(100)}localized-record-tail.ts`,
        ],
        relatedModules: [
          `模块开头${'本地化模块上下文'.repeat(40)}模块尾部`,
        ],
        citationText: [
          '引用开头',
          '本地化引用细节。'.repeat(120),
          '引用尾部',
        ].join(' '),
        contextPrefix: [
          '前缀开头',
          '本地化上下文前缀。'.repeat(80),
          '前缀尾部',
        ].join(' '),
      });

      const sentMsg = mockPort.sentMessages[0] as {
        entry: {
          content: string;
          tags?: string[];
          relatedFiles?: string[];
          relatedModules?: string[];
          citationText?: string;
          contextPrefix?: string;
        };
      };

      expect(sentMsg.entry.content.length).toBeLessThanOrEqual(2000);
      expect(estimateTokens(sentMsg.entry.content)).toBeLessThanOrEqual(500);
      expect(sentMsg.entry.content).toContain('记忆开头');
      expect(sentMsg.entry.content).toContain('记忆尾部');
      expect(sentMsg.entry.tags?.[0]).toContain('标签开头');
      expect(sentMsg.entry.tags?.[0]).toContain('标签尾部');
      expect(estimateTokens(sentMsg.entry.tags?.[0] ?? '')).toBeLessThanOrEqual(24);
      expect(sentMsg.entry.relatedFiles?.[0]).toContain('localized-record-tail.ts');
      expect(sentMsg.entry.relatedFiles?.[0]).not.toContain('[omitted]');
      expect(sentMsg.entry.relatedModules?.[0]).toContain('模块开头');
      expect(sentMsg.entry.relatedModules?.[0]).toContain('模块尾部');
      expect(estimateTokens(sentMsg.entry.relatedModules?.[0] ?? '')).toBeLessThanOrEqual(32);
      expect(sentMsg.entry.citationText).toContain('引用开头');
      expect(sentMsg.entry.citationText).toContain('引用尾部');
      expect(estimateTokens(sentMsg.entry.citationText ?? '')).toBeLessThanOrEqual(250);
      expect(sentMsg.entry.contextPrefix).toContain('前缀开头');
      expect(sentMsg.entry.contextPrefix).toContain('前缀尾部');
      expect(estimateTokens(sentMsg.entry.contextPrefix ?? '')).toBeLessThanOrEqual(150);
    });

    it('returns null on error response', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:error',
        requestId,
        error: 'Write failed',
      }));

      const id = await proxy.recordMemory({
        type: 'gotcha',
        content: 'test',
        projectId: 'proj-1',
      });

      expect(id).toBeNull();
    });
  });

  describe('updateAccessCount()', () => {
    it('sends a memory:access message and resolves on ACK', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:accessed',
        requestId,
      }));

      await proxy.updateAccessCount(' mem-1 ');

      expect(mockPort.sentMessages[0]).toEqual(expect.objectContaining({
        type: 'memory:access',
        memoryId: 'mem-1',
      }));
    });

    it('ignores blank memory IDs without posting IPC', async () => {
      await proxy.updateAccessCount('   ');

      expect(mockPort.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('requestStepInjection()', () => {
    it('returns step injection when server provides one', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:step-injection-result',
        requestId,
        injection: {
          content: 'MEMORY ALERT: auth gotcha',
          type: 'gotcha_injection',
          memoryIds: ['mem-1'],
        },
      }));

      const injection = await proxy.requestStepInjection(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(injection?.content).toContain('auth gotcha');
      expect(injection?.memoryIds).toEqual(['mem-1']);
    });

    it('returns null on error response', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:error',
        requestId,
        error: 'StepInjectionDecider failed',
      }));

      const injection = await proxy.requestStepInjection(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(injection).toBeNull();
    });

    it('sends serializable context (converts Set to Array)', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:step-injection-result',
        requestId,
        injection: null,
      }));

      await proxy.requestStepInjection(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'foo' } }],
        injectedMemoryIds: new Set(['id-1', 'id-2']),
      });

      // sentMessages has 1 entry pushed by setupResponseMock
      const sentMsg = mockPort.sentMessages[0] as Record<string, unknown>;
      const ctx = sentMsg.recentContext as { injectedMemoryIds: unknown };
      // Should be an Array, not a Set (Set isn't serializable via postMessage)
      expect(Array.isArray(ctx.injectedMemoryIds)).toBe(true);
      expect(ctx.injectedMemoryIds).toContain('id-1');
    });

    it('compacts step injection context before posting IPC requests', async () => {
      setupResponseMock(mockPort, (requestId) => ({
        type: 'memory:step-injection-result',
        requestId,
        injection: null,
      }));

      await proxy.requestStepInjection(12, {
        toolCalls: Array.from({ length: 8 }, (_, index) => ({
          toolName: index % 2 === 0 ? 'Grep' : 'Write',
          args: {
            pattern: `pattern-${index}`,
            command: `npm test ${'--workspace apps/desktop '.repeat(30)}TAIL-${index}`,
            content: 'x'.repeat(5_000),
          },
        })),
        injectedMemoryIds: new Set([
          ' ',
          ' existing-id ',
          'x'.repeat(200),
          ...Array.from({ length: 130 }, (_, index) => `memory-${index}`),
        ]),
      });

      const sentMsg = mockPort.sentMessages[0] as {
        recentContext: {
          toolCalls: Array<{ args: Record<string, unknown> }>;
          injectedMemoryIds: string[];
        };
      };

      expect(sentMsg.recentContext.toolCalls).toHaveLength(5);
      expect(sentMsg.recentContext.toolCalls[0].args.pattern).toBe('pattern-3');
      expect(sentMsg.recentContext.toolCalls[0].args).not.toHaveProperty('content');
      expect(String(sentMsg.recentContext.toolCalls[0].args.command)).toHaveLength(240);
      expect(sentMsg.recentContext.injectedMemoryIds).toHaveLength(128);
      expect(sentMsg.recentContext.injectedMemoryIds).not.toContain('existing-id');
      expect(sentMsg.recentContext.injectedMemoryIds).not.toContain('memory-0');
      expect(sentMsg.recentContext.injectedMemoryIds).toContain('memory-2');
      expect(sentMsg.recentContext.injectedMemoryIds).toContain('memory-129');
      expect(sentMsg.recentContext.injectedMemoryIds).not.toContain('');
    });
  });

  describe('response correlation', () => {
    it('correctly routes concurrent responses by requestId', async () => {
      const responses: MemoryIpcResponse[] = [];

      mockPort.postMessage.mockImplementation((msg: unknown) => {
        // Push to sentMessages manually
        mockPort.sentMessages.push(msg);
        const reqId = (msg as Record<string, unknown>).requestId as string;
        setTimeout(() => {
          const response: MemoryIpcResponse = {
            type: 'memory:stored',
            requestId: reqId,
            id: `result-for-${reqId.slice(0, 8)}`,
          };
          responses.push(response);
          mockPort.emit('message', response);
        }, 0);
      });

      const [id1, id2] = await Promise.all([
        proxy.recordMemory({ type: 'gotcha', content: 'memory 1', projectId: 'p1' }),
        proxy.recordMemory({ type: 'gotcha', content: 'memory 2', projectId: 'p1' }),
      ]);

      // Both should resolve with different IDs
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });
  });
});
