/**
 * buildQaSessionContext Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildQaSessionContext } from '../../injection/qa-context';
import type { MemoryService, Memory } from '../../types';
import { estimateTokens } from '../../retrieval/context-packer';

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
  const sharedHead = 'Retry auth validation with fake timers before asserting token expiry. '.repeat(4);
  const uniqueMiddle = Array.from(
    { length: 90 },
    (_, index) => `${uniqueLabel.toLowerCase()}_${index}`,
  ).join(' ');
  const sharedTail = ' Confirm callback error UI after the retry path settles.'.repeat(4);
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

describe('buildQaSessionContext', () => {
  let memoryService: MemoryService;

  beforeEach(() => {
    memoryService = makeMemoryService();
  });

  it('returns empty string when no memories exist', async () => {
    const result = await buildQaSessionContext('Validate auth flow', ['auth'], memoryService, 'proj-1');
    expect(result).toBe('');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalled();
  });

  it('includes error patterns when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [makeMemory('ep-1', 'Token validation fails silently on expired JWT', 'error_pattern')];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('ERROR PATTERNS');
    expect(result).toContain('Token validation fails silently');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('ep-1');
  });

  it('includes e2e observations when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('e2e_observation')) {
        return [makeMemory('eo-1', 'Login button requires 500ms delay before becoming clickable', 'e2e_observation')];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('E2E OBSERVATIONS');
    expect(result).toContain('500ms delay');
  });

  it('includes requirements when found', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [makeMemory('req-1', 'All API endpoints must return 401 not 403 for auth failures', 'requirement')];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('KNOWN REQUIREMENTS');
    expect(result).toContain('401 not 403');
  });

  it('includes validation workflow recipes', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('r1', 'Step 1: Check login. Step 2: Verify token expiry.', 'workflow_recipe'),
    ]);

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('VALIDATION WORKFLOW');
    expect(result).toContain('Check login');
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledWith('Validate auth', {
      limit: 1,
      projectId: 'proj-1',
      recordAccess: false,
    });
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('r1');
  });

  it('wraps output in QA section header/footer', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [makeMemory('r1', 'Auth must use HTTPS', 'requirement')];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('=== MEMORY CONTEXT FOR QA ===');
    expect(result).toContain('=== END MEMORY CONTEXT ===');
  });

  it('returns empty string gracefully on error', async () => {
    vi.mocked(memoryService.search).mockRejectedValue(new Error('DB error'));
    vi.mocked(memoryService.searchWorkflowRecipe).mockRejectedValue(new Error('DB error'));

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toBe('');
  });

  it('runs all 4 queries in parallel', async () => {
    await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(memoryService.search).toHaveBeenCalledTimes(3); // e2e_obs, error_pattern, requirement
    for (const call of vi.mocked(memoryService.search).mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        promptContextOnly: true,
        recordAccess: false,
      }));
    }
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledTimes(1);
  });

  it('passes projectId to workflow recipe search', async () => {
    await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'qa-project');

    expect(vi.mocked(memoryService.searchWorkflowRecipe)).toHaveBeenCalledWith('Validate auth', {
      limit: 1,
      projectId: 'qa-project',
      recordAccess: false,
    });
  });

  it('normalizes module filters and spec description before QA lookups', async () => {
    await buildQaSessionContext('  Validate   auth\nflow  ', [' auth ', 'AUTH', 'browser'], memoryService, 'qa-project');

    for (const call of vi.mocked(memoryService.search).mock.calls) {
      expect(call[0].relatedModules).toEqual(['auth', 'browser']);
    }
    expect(vi.mocked(memoryService.searchWorkflowRecipe)).toHaveBeenCalledWith('Validate auth flow', {
      limit: 1,
      projectId: 'qa-project',
      recordAccess: false,
    });
  });

  it('skips module-scoped QA searches when modules normalize empty', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('recipe', 'Run the smoke checks first.', 'workflow_recipe'),
    ]);

    const result = await buildQaSessionContext(' Validate auth ', [' ', '\n'], memoryService, 'proj-1');

    expect(memoryService.search).not.toHaveBeenCalled();
    expect(memoryService.searchWorkflowRecipe).toHaveBeenCalledWith('Validate auth', {
      limit: 1,
      projectId: 'proj-1',
      recordAccess: false,
    });
    expect(result).toContain('VALIDATION WORKFLOW');
  });

  it('prioritizes requirements before error patterns in output', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [makeMemory('r1', 'Must use HTTPS', 'requirement')];
      }
      if (filters.types?.includes('error_pattern')) {
        return [makeMemory('ep1', 'Silent token failure', 'error_pattern')];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    const reqPos = result.indexOf('KNOWN REQUIREMENTS');
    const errPos = result.indexOf('ERROR PATTERNS');
    expect(reqPos).toBeGreaterThanOrEqual(0);
    expect(errPos).toBeGreaterThanOrEqual(0);
    expect(reqPos).toBeLessThan(errPos);
  });

  it('deduplicates near-duplicate QA memories across sections', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [
          makeMemory(
            'req-auth-callback',
            'Auth callback tests must wait for token cache refresh before asserting listener notifications.',
            'requirement',
          ),
        ];
      }
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory(
            'ep-duplicate',
            'Auth callback tests should wait for token cache refresh before asserting listener notification.',
            'error_pattern',
          ),
          makeMemory(
            'ep-distinct',
            'OAuth retry tests need a mocked clock to avoid flaky expiry assertions.',
            'error_pattern',
          ),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Auth callback tests must wait');
    expect(result).toContain('OAuth retry tests need a mocked clock');
    expect(result).not.toContain('Auth callback tests should wait');
  });

  it('omits generic status lines from QA memories before formatting', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory(
            'ep-status-only',
            [
              'All tests passed.',
              'No issues found.',
              'Duration: 1234ms',
            ].join('\n'),
            'error_pattern',
          ),
          makeMemory(
            'ep-actionable',
            [
              'OAuth retry tests need a mocked clock to avoid flaky expiry assertions.',
              'npm run typecheck passed.',
              'No issues found.',
            ].join('\n'),
            'error_pattern',
          ),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('ERROR PATTERNS');
    expect(result).toContain('OAuth retry tests need a mocked clock');
    expect(result).not.toContain('All tests passed');
    expect(result).not.toContain('npm run typecheck passed');
    expect(result).not.toContain('No issues found');
    expect(result).not.toContain('Duration: 1234ms');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('ep-actionable');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('ep-status-only');
  });

  it('records access only for QA memories visible in formatted context', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [
          makeMemory(
            'req-visible',
            'Auth callback tests must wait for token cache refresh before asserting listener notifications.',
            'requirement',
          ),
        ];
      }
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory(
            'ep-duplicate',
            'Auth callback tests should wait for token cache refresh before asserting listener notification.',
            'error_pattern',
          ),
          makeMemory(
            'ep-visible',
            'OAuth retry tests need a mocked clock to avoid flaky expiry assertions.',
            'error_pattern',
          ),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Auth callback tests must wait');
    expect(result).toContain('OAuth retry tests need a mocked clock');
    expect(result).not.toContain('Auth callback tests should wait');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('req-visible');
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('ep-visible');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('ep-duplicate');
  });

  it('does not record QA memories partially removed by the final context truncation', async () => {
    vi.mocked(memoryService.searchWorkflowRecipe).mockResolvedValueOnce([
      makeMemory('recipe-tail', makeLongContent('QA_RECIPE_TAIL'), 'workflow_recipe'),
    ]);
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('requirement')) {
        return [
          makeMemory('req-visible-1', makeLongContent('QA_REQ_VISIBLE_ONE'), 'requirement'),
          makeMemory('req-visible-2', makeLongContent('QA_REQ_VISIBLE_TWO'), 'requirement'),
        ];
      }
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory('ep-visible-1', makeLongContent('QA_ERROR_VISIBLE_ONE'), 'error_pattern'),
          makeMemory('ep-visible-2', makeLongContent('QA_ERROR_VISIBLE_TWO'), 'error_pattern'),
        ];
      }
      if (filters.types?.includes('e2e_observation')) {
        return [
          makeMemory('e2e-middle', makeLongContent('QA_MIDDLE_SHOULD_DROP'), 'e2e_observation'),
          makeMemory('e2e-late', makeLongContent('QA_E2E_LATE'), 'e2e_observation'),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('middle omitted');
    expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('e2e-middle');
  });

  it('filters duplicate and untrusted QA memories before formatting', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory('ep-high', 'Expired token tests fail unless the clock is frozen.', 'error_pattern'),
          makeMemory('ep-low', 'Low confidence QA memory should not enter context.', 'error_pattern'),
          makeMemory('ep-review', 'Pending review QA memory should not enter context.', 'error_pattern'),
          makeMemory('ep-dup', 'Expired token tests fail unless the clock is frozen.', 'error_pattern'),
          makeMemory('ep-second', 'OAuth callback tests need a mocked redirect URI.', 'error_pattern'),
          makeMemory('ep-third', 'Third error pattern should be capped out.', 'error_pattern'),
        ].map((memory) => {
          if (memory.id === 'ep-low') return { ...memory, confidence: 0.2 };
          if (memory.id === 'ep-review') return { ...memory, needsReview: true };
          return memory;
        });
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Expired token tests fail');
    expect(result).toContain('mocked redirect URI');
    expect(result).not.toContain('Low confidence');
    expect(result).not.toContain('Pending review');
    expect(result).not.toContain('Third error pattern');
    expect((result.match(/Expired token tests fail/g) ?? [])).toHaveLength(1);
    expect(result.length).toBeLessThanOrEqual(1700);
  });

  it('deduplicates QA memories by their compact rendered content', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          { ...makeMemory('render-low', makeRenderedDuplicateContent('LOWER'), 'error_pattern'), confidence: 0.7 },
          { ...makeMemory('render-high', makeRenderedDuplicateContent('HIGHER'), 'error_pattern'), confidence: 0.95 },
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Retry auth validation');
    expect(result).toContain('Confirm callback error UI');
    expect((result.match(/\[middle omitted\]/g) ?? [])).toHaveLength(1);
    expect(memoryService.updateAccessCount).toHaveBeenCalledTimes(1);
    expect(memoryService.updateAccessCount).toHaveBeenCalledWith('render-high');
  });

  it('preserves the tail of compacted QA memories', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory(
            'ep-long',
            `Token refresh fails after the first retry ${'browser trace '.repeat(80)}QA_MEMORY_TAIL_OK`,
            'error_pattern',
          ),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('ERROR PATTERNS');
    expect(result).toContain('middle omitted');
    expect(result).toContain('QA_MEMORY_TAIL_OK');
    expect(result.length).toBeLessThanOrEqual(1700);
  });

  it('keeps localized QA memory context within the estimated token budget', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory(
            'ep-localized',
            [
              'QA 记忆开头',
              '这是一段会显著增加 token 的中文验证上下文。'.repeat(120),
              'QA 记忆尾部',
            ].join(' '),
            'error_pattern',
          ),
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('验证认证', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('ERROR PATTERNS');
    expect(result).toContain('QA 记忆开头');
    expect(result).toContain('QA 记忆尾部');
    expect(result.length).toBeLessThanOrEqual(1700);
    expect(estimateTokens(result)).toBeLessThanOrEqual(425);
  });

  it('caps related file references for QA error patterns', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          {
            ...makeMemory('ep-files', 'Retry assertions need fake timers.', 'error_pattern'),
            relatedFiles: [
              'src/auth/token-refresh.test.ts',
              'src/auth/session-store.ts',
              'src\\auth\\clock-utils.ts',
              'src/auth/fourth-should-not-appear.ts',
              'src/auth/fifth-should-not-appear.ts',
            ],
          },
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('[token-refresh.test.ts, session-store.ts, clock-utils.ts, ...]');
    expect(result).not.toContain('fourth-should-not-appear');
    expect(result).not.toContain('fifth-should-not-appear');
    expect(result.length).toBeLessThanOrEqual(1700);
  });

  it('deduplicates repeated related file references across QA error patterns', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          {
            ...makeMemory('ep-refresh', 'Token refresh assertions need fake timers.', 'error_pattern'),
            relatedFiles: [
              'src/auth/session-store.ts',
              'src/auth/token-refresh.test.ts',
            ],
          },
          {
            ...makeMemory('ep-retry', 'Retry assertions need mocked network delays.', 'error_pattern'),
            relatedFiles: [
              './SRC\\auth\\session-store.ts/',
              'src/auth/retry-policy.test.ts',
            ],
          },
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Token refresh assertions need fake timers.');
    expect(result).toContain('Retry assertions need mocked network delays.');
    expect((result.match(/session-store\.ts/g) ?? [])).toHaveLength(1);
    expect(result).toContain('token-refresh.test.ts');
    expect(result).toContain('retry-policy.test.ts');
  });

  it('omits QA error file refs already visible in memory content', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          {
            ...makeMemory(
              'ep-mentioned-file',
              'session-store.ts assertions fail after auth-token.test.ts retries.',
              'error_pattern',
            ),
            relatedFiles: [
              'src/auth/session-store.ts',
              'src/auth/token.test.ts',
              'src/auth/retry-policy.test.ts',
            ],
          },
        ];
      }
      return [];
    });

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('session-store.ts assertions fail');
    expect(result).toContain('[token.test.ts, retry-policy.test.ts]');
    expect((result.match(/session-store\.ts/g) ?? [])).toHaveLength(1);
  });

  it('filters stale QA memories unless they are pinned or user verified', async () => {
    vi.mocked(memoryService.search).mockImplementation(async (filters) => {
      if (filters.types?.includes('error_pattern')) {
        return [
          makeMemory('stale', 'Old flaky auth assertion should not guide QA.', 'error_pattern'),
          makeMemory('pinned-stale', 'Pinned auth callback failure remains relevant.', 'error_pattern'),
          makeMemory('verified-stale', 'Verified token expiry assertion remains relevant.', 'error_pattern'),
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

    const result = await buildQaSessionContext('Validate auth', ['auth'], memoryService, 'proj-1');

    expect(result).toContain('Pinned auth callback failure');
    expect(result).toContain('Verified token expiry assertion');
    expect(result).not.toContain('Old flaky auth assertion');
  });
});
