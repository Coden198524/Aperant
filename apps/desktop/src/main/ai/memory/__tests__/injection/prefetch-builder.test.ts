import { describe, expect, it, vi } from 'vitest';
import { buildPrefetchPlan } from '../../injection/prefetch-builder';
import type { Memory, MemoryService } from '../../types';

function makeMemory(content: string): Memory {
  return {
    id: 'prefetch-1',
    type: 'prefetch_pattern',
    content,
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'observer_inferred',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
  };
}

function makeMemoryService(memories: Memory[]): MemoryService {
  return {
    store: vi.fn().mockResolvedValue('id'),
    search: vi.fn().mockResolvedValue(memories),
    searchByPattern: vi.fn().mockResolvedValue(null),
    insertUserTaught: vi.fn().mockResolvedValue('id'),
    searchWorkflowRecipe: vi.fn().mockResolvedValue([]),
    updateAccessCount: vi.fn().mockResolvedValue(undefined),
    deprecateMemory: vi.fn().mockResolvedValue(undefined),
    verifyMemory: vi.fn().mockResolvedValue(undefined),
    pinMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  };
}

describe('buildPrefetchPlan', () => {
  it('keeps the default prefetch plan compact', async () => {
    const files = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    const memoryService = makeMemoryService([
      makeMemory(JSON.stringify({
        alwaysReadFiles: files,
        frequentlyReadFiles: files,
      })),
    ]);

    const plan = await buildPrefetchPlan(['auth'], memoryService, 'project-1');

    expect(plan.totalTokenBudget).toBe(8192);
    expect(plan.maxFiles).toBe(6);
    expect(plan.alwaysReadFiles).toHaveLength(6);
    expect(plan.frequentlyReadFiles).toHaveLength(4);
  });
});
