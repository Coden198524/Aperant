import { describe, expect, it, vi } from 'vitest';
import { createRecordMemoryStub, createRecordMemoryTool } from '../tools/record-memory';
import { createSearchMemoryTool } from '../tools/search-memory';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory } from '../types';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    type: 'gotcha',
    content: 'Always check token expiry before validating claims.',
    confidence: 0.9,
    tags: [],
    relatedFiles: ['src/auth/token.ts'],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

async function executeTool<TInput, TOutput>(
  aiTool: unknown,
  input: TInput,
): Promise<TOutput> {
  const executable = aiTool as { execute: (input: TInput) => Promise<TOutput> };
  return executable.execute(input);
}

describe('memory agent tools', () => {
  it('keeps search_memory output compact and deduplicated', async () => {
    const longContent = 'Use the auth refresh helper before API calls. '.repeat(30);
    const proxy = {
      searchMemory: vi.fn().mockResolvedValue([
        makeMemory({ id: 'a', content: longContent }),
        makeMemory({ id: 'b', content: longContent }),
        makeMemory({ id: 'c', type: 'decision', content: 'Auth tokens are stored in secure storage.' }),
      ]),
    } as unknown as WorkerObserverProxy;
    const tool = createSearchMemoryTool(proxy, 'project-1');

    const result = await executeTool<
      { query: string },
      string
    >(tool, { query: 'auth token handling' });

    expect(proxy.searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      projectId: 'project-1',
    }));
    expect((result.match(/\[gotcha\]/g) ?? [])).toHaveLength(1);
    expect(result).toContain('2. [decision]');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('does not echo full memory content after recording', async () => {
    const proxy = {
      recordMemory: vi.fn().mockResolvedValue('12345678-aaaa-bbbb-cccc-123456789abc'),
    } as unknown as WorkerObserverProxy;
    const tool = createRecordMemoryTool(proxy, 'project-1', 'session-1');

    const result = await executeTool<
      { type: 'gotcha'; content: string; relatedFiles: string[] },
      string
    >(tool, {
      type: 'gotcha',
      content: 'This is a reusable implementation gotcha that should not be echoed back.',
      relatedFiles: ['src/auth/token.ts'],
    });

    expect(result).toBe('Memory recorded (id: 12345678).');
    expect(result).not.toContain('reusable implementation gotcha');
  });

  it('keeps unavailable memory stub responses compact', async () => {
    const tool = createRecordMemoryStub();

    const result = await executeTool<
      { type: 'gotcha'; content: string },
      string
    >(tool, {
      type: 'gotcha',
      content: 'This content should not be echoed when persistence is unavailable.',
    });

    expect(result).toBe('Memory noted locally, but memory persistence is unavailable in this session.');
  });
});
