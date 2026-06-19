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

function makeLongContent(label: string): string {
  return [
    label,
    ...Array.from({ length: 80 }, (_, index) => `${label.toLowerCase()}_${index}`),
    `${label}_TAIL`,
  ].join(' ');
}

function makeRenderedDuplicateContent(uniqueLabel: string): string {
  const sharedHead = 'Use auth retry guard before saving the refreshed token. '.repeat(4);
  const uniqueMiddle = Array.from(
    { length: 90 },
    (_, index) => `${uniqueLabel.toLowerCase()}_${index}`,
  ).join(' ');
  const sharedTail = ' Verify expired-token retry before merging the auth flow.'.repeat(4);
  return `${sharedHead}${uniqueMiddle}${sharedTail}`;
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

  it('includes architecture and design pattern references from similar task memories', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('pattern')) {
        return [
          {
            ...makeMemory(
              'pattern-1',
              'Route auth callbacks through the preload adapter and keep token persistence in the main-process service.',
              'pattern',
            ),
            relatedFiles: ['src/preload/auth.ts', 'src/main/auth-service.ts'],
          },
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth callback', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('ARCHITECTURE AND DESIGN PATTERN REFERENCES');
    expect(result).toContain('[pattern]');
    expect(result).toContain('preload adapter');
    expect(result).toContain('src/preload/auth.ts');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('pattern-1');
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
              'npm run typecheck passed.',
              'No issues found.',
              'Memory search results for "auth": 1. [gotcha] Refresh token cache before notifying listeners.',
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
    expect(result).not.toContain('Work unit s1 finished');
    expect(result).not.toContain('Efficient token usage');
    expect(result).not.toContain('Completed quickly');
    expect(result).not.toContain('npm run typecheck passed');
    expect(result).not.toContain('No issues found');
    expect(result).not.toContain('Memory search results');
  });

  it('omits generic status lines from non-outcome planner memories', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory(
            'dead-status-only',
            [
              'All tests passed.',
              'No issues found.',
              'Duration: 1234ms',
            ].join('\n'),
            'dead_end',
          ),
          makeMemory(
            'dead-actionable',
            [
              'Mock the OAuth clock before testing refresh retries.',
              'npm run typecheck passed.',
              'No issues found.',
            ].join('\n'),
            'dead_end',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('DEAD ENDS');
    expect(result).toContain('Mock the OAuth clock before testing refresh retries');
    expect(result).not.toContain('All tests passed');
    expect(result).not.toContain('npm run typecheck passed');
    expect(result).not.toContain('No issues found');
    expect(result).not.toContain('Duration: 1234ms');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('dead-actionable');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('dead-status-only');
  });

  it('omits localized generic outcome lines from planner context', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('work_unit_outcome')) {
        return [
          makeMemory(
            'out-localized-noise',
            [
              '\u4efb\u52a1\u5df2\u5b8c\u6210',
              '\u5168\u90e8\u6d4b\u8bd5\u5df2\u901a\u8fc7',
              '\u6ca1\u6709\u53d1\u73b0\u95ee\u9898',
              '\u8ba4\u8bc1\u6a21\u5757\u6536\u7a84\u4e86\u6587\u4ef6\u68c0\u7d22\u8303\u56f4\u3002',
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
    expect(result).toContain('\u8ba4\u8bc1\u6a21\u5757\u6536\u7a84\u4e86\u6587\u4ef6\u68c0\u7d22\u8303\u56f4');
    expect(result).toContain('src/auth/session.ts');
    expect(result).not.toContain('\u4efb\u52a1\u5df2\u5b8c\u6210');
    expect(result).not.toContain('\u5168\u90e8\u6d4b\u8bd5\u5df2\u901a\u8fc7');
    expect(result).not.toContain('\u6ca1\u6709\u53d1\u73b0\u95ee\u9898');
  });

  it('does not record access for outcomes that are stripped from planner context', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory('dead-visible', 'Mock the OAuth clock before refresh tests.', 'dead_end'),
        ];
      }
      if (filters.types?.includes('work_unit_outcome')) {
        return [
          makeMemory(
            'out-metrics-only',
            [
              'Efficient token usage - concise and focused implementation',
              'Completed quickly with few steps - good planning',
              'Used diverse set of tools - comprehensive coverage',
            ].join('\n'),
            'work_unit_outcome',
          ),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('DEAD ENDS');
    expect(result).not.toContain('RECENT OUTCOMES');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('dead-visible');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('out-metrics-only');
  });

  it('does not record planner memories removed by the final context truncation', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('recipe-visible', makeLongContent('PLANNER_RECIPE_VISIBLE'), 'workflow_recipe'),
    ]);
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('task_calibration')) {
        return [
          makeMemory('cal-visible-1', makeLongContent('PLANNER_CAL_VISIBLE_ONE'), 'task_calibration'),
          makeMemory('cal-visible-2', makeLongContent('PLANNER_CAL_VISIBLE_TWO'), 'task_calibration'),
        ];
      }
      if (filters.types?.includes('dead_end')) {
        return [
          makeMemory('dead-visible-1', makeLongContent('PLANNER_DEAD_VISIBLE_ONE'), 'dead_end'),
          makeMemory('dead-visible-2', makeLongContent('PLANNER_DEAD_VISIBLE_TWO'), 'dead_end'),
        ];
      }
      if (filters.types?.includes('causal_dependency')) {
        return [
          makeMemory('causal-middle', makeLongContent('PLANNER_MIDDLE_SHOULD_DROP'), 'causal_dependency'),
          makeMemory('causal-late', makeLongContent('PLANNER_CAUSAL_LATE'), 'causal_dependency'),
        ];
      }
      if (filters.types?.includes('work_unit_outcome')) {
        return [
          makeMemory('out-tail-1', makeLongContent('PLANNER_OUTCOME_TAIL_ONE'), 'work_unit_outcome'),
          makeMemory('out-tail-2', makeLongContent('PLANNER_OUTCOME_TAIL_TWO'), 'work_unit_outcome'),
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('middle omitted');
    expect(result).not.toContain('PLANNER_MIDDLE_SHOULD_DROP');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('causal-middle');
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
      expect(call[0].recordAccess).toBe(false);
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

  it('uses task-description architecture lookup when module filters normalize empty', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('recipe', 'Use the short validation path.', 'workflow_recipe'),
    ]);

    const result = await buildPlannerMemoryContext(' Add auth ', [' ', '\n'], memoryService, 'proj-1');

    expect(memoryService.search).toHaveBeenCalledTimes(1);
    expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
      types: ['pattern', 'decision', 'module_insight'],
      query: 'Add auth',
      projectId: 'proj-1',
      recordAccess: false,
    }));
    expect(vi.mocked(memoryService.search).mock.calls[0]?.[0]).not.toHaveProperty('relatedModules');
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledWith('Add auth', {
      limit: 1,
      projectId: 'proj-1',
      recordAccess: false,
    });
    expect(result).toContain('WORKFLOW RECIPES');
  });

  it('runs all 6 planner memory queries in parallel', async () => {
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

    // Five typed searches plus the workflow recipe lookup should have been called.
    expect(memoryService.search).toHaveBeenCalledTimes(5);
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

  it('deduplicates planner memories by their compact rendered content', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('dead_end')) {
        return [
          { ...makeMemory('render-low', makeRenderedDuplicateContent('LOWER'), 'dead_end'), confidence: 0.7 },
          { ...makeMemory('render-high', makeRenderedDuplicateContent('HIGHER'), 'dead_end'), confidence: 0.95 },
        ];
      }
      return [];
    });

    const result = await buildPlannerMemoryContext('Add auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Use auth retry guard');
    expect(result).toContain('Verify expired-token retry');
    expect((result.match(/\[middle omitted\]/g) ?? [])).toHaveLength(1);
    expect(memoryService.updateAccessCount).toHaveBeenCalledTimes(1);
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('render-high');
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
