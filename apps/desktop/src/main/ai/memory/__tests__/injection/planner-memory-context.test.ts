/**
 * buildPlannerMemoryContext Tests
 *
 * Tests context building with mocked MemoryService.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPlannerMemoryContext } from '../../injection/planner-memory-context';
import type { MemoryService, Memory } from '../../types';
import { estimateTokens } from '../../retrieval/context-packer';

// ============================================================
// HELPERS
// ============================================================

function makeMemory(id: string, content: string, type: Memory['type'] = 'gotcha'): Memory {
  return {
    id,
    type,
    content,
    confidence: 0.8,
    tags: [],
    relatedFiles: [],
    relatedModules: ['auth'],
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

function makeMemoryService(): MemoryService {
  return {
    store: vi.fn().mockResolvedValue('id'),
    search: vi.fn().mockResolvedValue([]),
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

// ============================================================
// TESTS
// ============================================================

describe('buildPlannerMemoryContext', () => {
  let memoryService: MemoryService;

  beforeEach(() => {
    memoryService = makeMemoryService();
  });

  it('returns empty string when no memories exist', async () => {
    const result = await buildPlannerMemoryContext(
      'Add authentication',
      ['auth'],
      memoryService,
      'proj-1',
    );
    expect(result).toBe('');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalled();
  });

  it('includes workflow recipes when found', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('r1', 'Step 1: Validate token. Step 2: Check permissions.', 'workflow_recipe'),
    ]);

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('WORKFLOW RECIPES');
    expect(result).toContain('Step 1: Validate token');
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledWith('Add auth', {
      limit: 1,
      projectId: 'proj-1',
      recordAccess: false,
    });
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('r1');
  });

  it('includes task calibrations with ratio when JSON content is parseable', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('task_calibration')) {
        return [
          makeMemory(
            'cal-1',
            JSON.stringify({ module: 'auth', ratio: 1.4, averageActualSteps: 140, averagePlannedSteps: 100, sampleCount: 5 }),
            'task_calibration',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('TASK CALIBRATIONS');
    expect(result).toContain('1.40x');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('cal-1');
  });

  it('includes dead ends when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [makeMemory('de-1', 'Using bcrypt v5 broke the token format', 'dead_end')];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('DEAD ENDS');
    expect(result).toContain('bcrypt v5');
  });

  it('includes causal dependencies when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('causal_dependency')) {
        return [makeMemory('cd-1', 'Must migrate DB schema before updating token model', 'causal_dependency')];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('CAUSAL DEPENDENCIES');
    expect(result).toContain('migrate DB schema');
  });

  it('includes recent outcomes when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('work_unit_outcome')) {
        return [makeMemory('out-1', 'Auth module refactored successfully in spec 023', 'work_unit_outcome')];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('RECENT OUTCOMES');
    expect(result).toContain('spec 023');
  });

  it('deduplicates near-duplicate planner memories across sections', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory(
        'recipe-auth-order',
        'When changing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
        'workflow_recipe',
      ),
    ]);
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory(
            'dead-duplicate',
            'When changing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
            'dead_end',
          ),
          makeMemory(
            'dead-distinct',
            'Mock the OAuth clock before testing refresh retries.',
            'dead_end',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('When changing auth refresh flow');
    expect(result).toContain('Mock the OAuth clock');
    expect(result).not.toContain('before notifying listener and keep');
  });

  it('omits generic session metrics from recent outcomes', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('work_unit_outcome')) {
        return [
          makeMemory(
            'out-1',
            [
              'Work unit s1 finished with outcome: success.',
              'Summary: Auth module refactored successfully.',
              'Efficient token usage - concise and focused implementation',
              'Completed quickly with few steps - good planning',
              'Files: src/auth/session.ts',
            ].join('\n'),
            'work_unit_outcome',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('RECENT OUTCOMES');
    expect(result).toContain('Auth module refactored successfully');
    expect(result).toContain('src/auth/session.ts');
    expect(result).not.toContain('Efficient token usage');
    expect(result).not.toContain('Completed quickly');
  });

  it('only includes sections that have results', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('r1', 'Recipe content', 'workflow_recipe'),
    ]);
    // All search() calls return empty

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('WORKFLOW RECIPES');
    expect(result).not.toContain('TASK CALIBRATIONS');
    expect(result).not.toContain('DEAD ENDS');
  });

  it('wraps output in section header and footer', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('r1', 'Some recipe', 'workflow_recipe'),
    ]);

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('=== MEMORY CONTEXT FOR PLANNER ===');
    expect(result).toContain('=== END MEMORY CONTEXT ===');
  });

  it('passes projectId to all search calls', async () => {
    await buildPlannerMemoryContext('task', ['mod-a'], memoryService, 'my-project');

    // All search calls should use the provided projectId
    const allSearchCalls = vi.mocked(memoryService.search).mock.calls;
    for (const call of allSearchCalls) {
      expect(call[0].projectId).toBe('my-project');
    }
    expect(vi.mocked(memoryService.searchWorkflowRecipe)).toHaveBeenCalledWith('task', {
      limit: 1,
      projectId: 'my-project',
      recordAccess: false,
    });
  });

  it('normalizes module filters and task description before planner lookups', async () => {
    await buildPlannerMemoryContext('  Add   auth\nflow  ', [' auth ', 'AUTH', 'token'], memoryService, 'my-project');

    for (const call of vi.mocked(memoryService.search).mock.calls) {
      expect(call[0].relatedModules).toEqual(['auth', 'token']);
    }
    expect(vi.mocked(memoryService.searchWorkflowRecipe)).toHaveBeenCalledWith('Add auth flow', {
      limit: 1,
      projectId: 'my-project',
      recordAccess: false,
    });
  });

  it('skips module-scoped planner searches when modules normalize empty', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('recipe', 'Use the short validation path.', 'workflow_recipe'),
    ]);

    const result = await buildPlannerMemoryContext(' Add auth ', [' ', '\n'], memoryService, 'proj-1');

    expect(memoryService.search).not.toHaveBeenCalled();
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledWith('Add auth', {
      limit: 1,
      projectId: 'proj-1',
      recordAccess: false,
    });
    expect(result).toContain('WORKFLOW RECIPES');
  });

  it('runs all 5 queries in parallel', async () => {
    const callOrder: string[] = [];
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      callOrder.push(JSON.stringify(filters.types));
      return [];
    });
    vi.mocked(memoryService.searchWorkflowRecipe).mockImplementation(async () => {
      callOrder.push('workflow_recipe');
      return [];
    });

    await buildPlannerMemoryContext('task', ['mod'], memoryService, 'proj-1');

    // All 5 queries should have been called
    expect(memoryService.search).toHaveBeenCalledTimes(4);
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledTimes(1);
  });

  it('returns empty string gracefully when memoryService throws', async () => {
    vi.mocked(memoryService.search).mockRejectedValue(new Error('DB unavailable'));
    vi.mocked(memoryService.searchWorkflowRecipe).mockRejectedValue(new Error('DB unavailable'));

    const result = await buildPlannerMemoryContext('task', ['mod'], memoryService, 'proj-1');

    expect(result).toBe('');
  });

  it('keeps planner memory compact by filtering low-value and duplicate items', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory('dead-high', 'Do not run auth migrations before loading feature flags.', 'dead_end'),
          makeMemory('dead-low', 'Low confidence dead end should not enter context.', 'dead_end'),
          makeMemory('dead-review', 'Unverified review memory should not enter context.', 'dead_end'),
          makeMemory('dead-dup', 'Do not run auth migrations before loading feature flags.', 'dead_end'),
          makeMemory('dead-second', 'Mock the OAuth clock before testing refresh retries.', 'dead_end'),
          makeMemory('dead-third', 'Third dead end should be capped out.', 'dead_end'),
        ].map((memory) => {
          if (memory.id === 'dead-low') return { ...memory, confidence: 0.2 };
          if (memory.id === 'dead-review') return { ...memory, needsReview: true };
          return memory;
        });
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Do not run auth migrations');
    expect(result).toContain('Mock the OAuth clock');
    expect(result).not.toContain('Low confidence');
    expect(result).not.toContain('Unverified review');
    expect(result).not.toContain('Third dead end');
    expect((result.match(/Do not run auth migrations/g) ?? [])).toHaveLength(1);
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('preserves the tail of compacted planner memories', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory(
            'dead-long',
            `Start with the migration guard ${'planning detail '.repeat(80)}PLANNER_MEMORY_TAIL_OK`,
            'dead_end',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('DEAD ENDS');
    expect(result).toContain('middle omitted');
    expect(result).toContain('PLANNER_MEMORY_TAIL_OK');
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('keeps localized planner memory context within the estimated token budget', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory(
            'dead-localized',
            [
              '规划记忆开头',
              '这是一段会显著增加 token 的中文规划上下文。'.repeat(120),
              '规划记忆尾部',
            ].join(' '),
            'dead_end',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('添加认证', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('DEAD ENDS');
    expect(result).toContain('规划记忆开头');
    expect(result).toContain('规划记忆尾部');
    expect(result.length).toBeLessThanOrEqual(1800);
    expect(estimateTokens(result)).toBeLessThanOrEqual(450);
  });

  it('filters stale planner memories unless they are pinned or user verified', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory('stale', 'Old auth workaround should not guide new planning.', 'dead_end'),
          makeMemory('pinned-stale', 'Pinned auth migration order remains relevant.', 'dead_end'),
          makeMemory('verified-stale', 'Verified auth rollback gotcha remains relevant.', 'dead_end'),
        ].map((memory) => {
          if (memory.id === 'pinned-stale') {
            return { ...memory, staleAt: '2000-01-01T00:00:00.000Z', pinned: true };
          }
          if (memory.id === 'verified-stale') {
            return { ...memory, staleAt: '2000-01-01T00:00:00.000Z', userVerified: true };
          }
          return { ...memory, staleAt: '2000-01-01T00:00:00.000Z' };
        });
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Pinned auth migration order');
    expect(result).toContain('Verified auth rollback gotcha');
    expect(result).not.toContain('Old auth workaround');
  });
});
