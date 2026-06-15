/**
 * StepInjectionDecider Tests
 *
 * Tests all three injection triggers:
 *   1. Gotcha injection (file read with known gotchas)
 *   2. Scratchpad reflection (new entries since last step)
 *   3. Search short-circuit (Grep/Glob pattern matches known memory)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StepInjectionDecider } from '../../injection/step-injection-decider';
import type { MemoryService, Memory } from '../../types';
import type { Scratchpad } from '../../observer/scratchpad';
import type { AcuteCandidate } from '../../types';
import { estimateTokens } from '../../retrieval/context-packer';

// ============================================================
// HELPERS
// ============================================================

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    type: 'gotcha',
    content: 'Always check null before accessing .id',
    confidence: 0.85,
    tags: [],
    relatedFiles: ['/src/auth.ts'],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'sess-1',
    provenanceSessionIds: [],
    projectId: 'proj-1',
    ...overrides,
  };
}

function makeScratchpad(newEntries: AcuteCandidate[] = []): Scratchpad {
  return {
    getNewSince: vi.fn().mockReturnValue(newEntries),
  } as unknown as Scratchpad;
}

function makeMemoryService(overrides: Partial<MemoryService> = {}): MemoryService {
  return {
    store: vi.fn().mockResolvedValue('new-id'),
    search: vi.fn().mockResolvedValue([]),
    searchByPattern: vi.fn().mockResolvedValue(null),
    insertUserTaught: vi.fn().mockResolvedValue('user-id'),
    searchWorkflowRecipe: vi.fn().mockResolvedValue([]),
    updateAccessCount: vi.fn().mockResolvedValue(undefined),
    deprecateMemory: vi.fn().mockResolvedValue(undefined),
    verifyMemory: vi.fn().mockResolvedValue(undefined),
    pinMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('StepInjectionDecider', () => {
  let decider: StepInjectionDecider;
  let memoryService: MemoryService;
  let scratchpad: Scratchpad;

  beforeEach(() => {
    memoryService = makeMemoryService();
    scratchpad = makeScratchpad();
    decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');
  });

  describe('Trigger 1: Gotcha injection', () => {
    it('returns gotcha_injection when file reads match known gotchas', async () => {
      const gotcha = makeMemory({ id: 'gotcha-1', type: 'gotcha' });
      vi.mocked(memoryService.search).mockResolvedValueOnce([gotcha]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).not.toBeNull();
      expect(result?.type).toBe('gotcha_injection');
      expect(result?.memoryIds).toContain('gotcha-1');
      expect(result?.content).toContain('MEMORY ALERT');
      expect(memoryService.updateAccessCount).toHaveBeenCalledWith('gotcha-1');
    });

    it('includes error_pattern and dead_end types in gotcha search', async () => {
      await decider.decide(3, {
        toolCalls: [{ toolName: 'Edit', args: { file_path: '/src/main.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          types: expect.arrayContaining(['gotcha', 'error_pattern', 'dead_end']),
          promptContextOnly: true,
          recordAccess: false,
        }),
      );
    });

    it('limits gotcha search and truncates long injected content', async () => {
      const longContent = `Long gotcha content ${'detail '.repeat(80)}GOTCHA_TAIL_OK`;
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'long-gotcha',
          content: longContent,
          relatedFiles: [
            '/src/auth/refresh-token-service-with-a-very-long-name.ts',
            '/src/auth/session-store-with-a-very-long-name.ts',
            '/src/auth/route-guard-with-a-very-long-name.ts',
            '/src/auth/legacy-token-migration.ts',
            '/src/auth/oauth-callback.ts',
          ],
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [
          { toolName: 'Read', args: { file_path: '/src/auth.ts' } },
          { toolName: 'Read', args: { file_path: '/src/auth.ts' } },
        ],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
        relatedFiles: ['/src/auth.ts'],
        limit: 6,
        promptContextOnly: true,
      }));
      expect(result?.content).toContain('+2 more');
      expect(result?.content).not.toContain('refresh-token-service-with-a-very-long-name.ts');
      expect(result?.content.length).toBeLessThan(longContent.length);
      expect(result?.content).toContain('middle omitted');
      expect(result?.content).toContain('GOTCHA_TAIL_OK');
    });

    it('deduplicates gotcha file references before applying the visible file limit', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'path-gotcha',
          content: 'Keep auth retry state inside the session store.',
          relatedFiles: [
            'src\\auth\\session-store.ts',
            'SRC/auth/session-store.ts',
            './SRC/auth/session-store.ts/',
            'src/auth/token-cache.ts',
            'src/auth/retry-policy.ts',
          ],
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.content).toContain('session-store.ts');
      expect(result?.content).toContain('token-cache.ts');
      expect(result?.content).toContain('retry-policy.ts');
      expect(result?.content).not.toContain('+1 more');
      expect((result?.content.match(/session-store\.ts/g) ?? [])).toHaveLength(1);
    });

    it('omits gotcha file refs already visible in injected content', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'mentioned-file-gotcha',
          content: 'session-store.ts fails after auth-token.ts retry; keep cache checks focused.',
          relatedFiles: [
            'src/auth/session-store.ts',
            'src/auth/token-cache.ts',
            'src/auth/retry-policy.ts',
          ],
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.content).toContain('session-store.ts fails');
      expect(result?.content).toContain('(token-cache.ts, retry-policy.ts)');
      expect((result?.content.match(/session-store\.ts/g) ?? [])).toHaveLength(1);
    });

    it('keeps localized gotcha injections within an estimated token budget', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'localized-gotcha',
          content: [
            '注入记忆开头',
            '这是一段会显著增加 token 的中文 gotcha 上下文。'.repeat(80),
            '注入记忆尾部',
          ].join(' '),
          relatedFiles: ['/src/auth/本地化文件名很长很长很长很长很长.ts'],
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('gotcha_injection');
      expect(result?.content).toContain('注入记忆开头');
      expect(result?.content).toContain('注入记忆尾部');
      expect(estimateTokens(result?.content ?? '')).toBeLessThanOrEqual(140);
    });

    it('normalizes and deduplicates read paths before gotcha search', async () => {
      await decider.decide(5, {
        toolCalls: [
          { toolName: 'Read', args: { file_path: ' src\\auth\\token.ts ' } },
          { toolName: 'Read', args: { file_path: 'src/auth//token.ts' } },
          { toolName: 'Read', args: { file_path: './SRC/auth/token.ts/' } },
          { toolName: 'Edit', args: { file_path: 'src/auth/token.ts' } },
        ],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.search).toHaveBeenCalledWith(expect.objectContaining({
        relatedFiles: ['src/auth/token.ts'],
        promptContextOnly: true,
      }));
    });

    it('filters low-quality gotchas returned by the memory service before injecting', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({ id: 'low', content: 'Low confidence gotcha should not inject.', confidence: 0.2 }),
        makeMemory({ id: 'review', content: 'Pending review gotcha should not inject.', needsReview: true }),
        makeMemory({ id: 'stale', content: 'Stale gotcha should not inject.', staleAt: '2000-01-01T00:00:00.000Z' }),
        makeMemory({ id: 'good', content: 'Trusted gotcha should inject.' }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('gotcha_injection');
      expect(result?.memoryIds).toEqual(['good']);
      expect(result?.content).toContain('Trusted gotcha should inject.');
      expect(result?.content).not.toContain('Low confidence gotcha');
      expect(result?.content).not.toContain('Pending review gotcha');
      expect(result?.content).not.toContain('Stale gotcha');
    });

    it('skips low-value gotcha content before injecting memory alerts', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'generic-status',
          content: [
            'npm run typecheck passed.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          confidence: 0.95,
        }),
        makeMemory({
          id: 'actionable-gotcha',
          content: [
            'No issues found.',
            'Mock the OAuth clock before testing refresh retries.',
          ].join('\n'),
          confidence: 0.9,
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('gotcha_injection');
      expect(result?.memoryIds).toEqual(['actionable-gotcha']);
      expect(result?.content).toContain('Mock the OAuth clock before testing refresh retries.');
      expect(result?.content).not.toContain('npm run typecheck passed');
      expect(result?.content).not.toContain('No issues found');
      expect(memoryService.updateAccessCount).toHaveBeenCalledWith('actionable-gotcha');
      expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('generic-status');
    });

    it('deduplicates near-duplicate gotchas before using the two injection slots', async () => {
      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'duplicate-low',
          content: 'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
          confidence: 0.76,
        }),
        makeMemory({
          id: 'duplicate-high',
          content: 'When editing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
          confidence: 0.92,
        }),
        makeMemory({
          id: 'distinct',
          content: 'Mock the OAuth clock before testing refresh retries.',
          confidence: 0.82,
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.memoryIds).toEqual(['duplicate-high', 'distinct']);
      expect(result?.content).toContain('Mock the OAuth clock');
      expect(result?.content).toContain('notifying listener and keep');
      expect(result?.content).not.toContain('notifying listeners and keep');
    });

    it('deduplicates gotchas by their compact rendered injection line', async () => {
      const sharedHead = `RENDERED_DUP_HEAD ${'shared token refresh context '.repeat(16)}`;
      const sharedTail = ' Verify expired token retry before merging.'.repeat(3);

      vi.mocked(memoryService.search).mockResolvedValueOnce([
        makeMemory({
          id: 'rendered-duplicate-low',
          content: `${sharedHead}${'alpha-only-middle-detail '.repeat(100)}${sharedTail}`,
          confidence: 0.9,
        }),
        makeMemory({
          id: 'rendered-duplicate-high',
          content: `${sharedHead}${'beta-only-middle-detail '.repeat(100)}${sharedTail}`,
          confidence: 0.95,
        }),
        makeMemory({
          id: 'distinct',
          content: 'Mock the OAuth clock before testing refresh retries.',
          confidence: 0.72,
        }),
      ]);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.memoryIds).toEqual(['rendered-duplicate-high', 'distinct']);
      expect(result?.content).toContain('Mock the OAuth clock');
      expect(result?.content?.match(/RENDERED_DUP_HEAD/g)).toHaveLength(1);
      expect(memoryService.updateAccessCount).toHaveBeenCalledWith('rendered-duplicate-high');
      expect(memoryService.updateAccessCount).toHaveBeenCalledWith('distinct');
      expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('rendered-duplicate-low');
    });

    it('skips already-injected memory IDs', async () => {
      const gotcha = makeMemory({ id: 'gotcha-already-seen' });
      vi.mocked(memoryService.search).mockImplementation(async (filters) => {
        // Simulate the filter function being applied: if filter rejects the memory, return empty
        const passesFilter = filters.filter ? filters.filter(gotcha) : true;
        return passesFilter ? [gotcha] : [];
      });

      await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(['gotcha-already-seen']),
      });

      // The filter passed to search would exclude the already-injected ID
      // The mock returns based on filter, so result depends on mock implementation
      // We primarily verify that the injectedMemoryIds Set is passed in the filter
      expect(memoryService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.any(Function),
        }),
      );
    });

    it('only triggers for Read and Edit tool calls, not Bash', async () => {
      await decider.decide(3, {
        toolCalls: [{ toolName: 'Bash', args: { command: 'npm test' } }],
        injectedMemoryIds: new Set(),
      });

      // search should not be called for gotchas when no Read/Edit calls
      const gotchaSearchCalls = vi.mocked(memoryService.search).mock.calls.filter(
        (call) => call[0].types?.includes('gotcha'),
      );
      expect(gotchaSearchCalls).toHaveLength(0);
    });

    it('ignores malformed file paths without blocking later triggers', async () => {
      const capturedAt = Date.now();
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: { triggeringText: 'Use the stable helper instead.' },
          priority: 0.9,
          capturedAt,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: 42 } }],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.search).not.toHaveBeenCalled();
      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.content).toContain('Use the stable helper instead.');
    });
  });

  describe('Trigger 2: Scratchpad reflection', () => {
    it('returns scratchpad_reflection when new entries exist', async () => {
      const newEntry: AcuteCandidate = {
        signalType: 'self_correction',
        rawData: { triggeringText: 'Actually the method is called differently' },
        priority: 0.9,
        capturedAt: Date.now(),
        stepNumber: 4,
      };
      scratchpad = makeScratchpad([newEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      // No file reads, so gotcha trigger won't fire
      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Bash', args: { command: 'ls' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).not.toBeNull();
      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.memoryIds[0]).toMatch(/^scratchpad:[a-f0-9]{16}$/);
      expect(result?.content).toContain('MEMORY REFLECTION');
    });

    it('limits and truncates scratchpad reflections before injecting them', async () => {
      const longText = `Use the source template instead ${'because '.repeat(80)}SCRATCHPAD_TAIL_OK`;
      const capturedAt = Date.now();
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: { triggeringText: longText },
          priority: 0.9,
          capturedAt,
          stepNumber: 4,
        },
        {
          signalType: 'error_retry',
          rawData: { triggeringText: 'Retry failed because the generated file was overwritten.' },
          priority: 0.9,
          capturedAt: capturedAt + 1,
          stepNumber: 4,
        },
        {
          signalType: 'backtrack',
          rawData: { triggeringText: 'Third scratchpad entry should be omitted.' },
          priority: 0.9,
          capturedAt: capturedAt + 2,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.memoryIds).toHaveLength(2);
      expect(result?.content).toContain('Use the source template instead');
      expect(result?.content).toContain('Retry failed');
      expect(result?.content).not.toContain('Third scratchpad entry');
      expect(result?.content).toContain('SCRATCHPAD_TAIL_OK');
      expect(result?.content).toContain('middle omitted');
    });

    it('skips empty scratchpad entries before applying the reflection limit', async () => {
      const capturedAt = Date.now();
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: { triggeringText: '   ' },
          priority: 0.9,
          capturedAt,
          stepNumber: 4,
        },
        {
          signalType: 'error_retry',
          rawData: {},
          priority: 0.9,
          capturedAt: capturedAt + 1,
          stepNumber: 4,
        },
        {
          signalType: 'backtrack',
          rawData: { matchedText: 'Use the stable backtrack target.' },
          priority: 0.9,
          capturedAt: capturedAt + 2,
          stepNumber: 4,
        },
        {
          signalType: 'parallel_conflict',
          rawData: { triggeringText: 'Resolve the latest writer before retrying.' },
          priority: 0.9,
          capturedAt: capturedAt + 3,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.memoryIds).toHaveLength(2);
      expect(result?.content).toContain('Use the stable backtrack target.');
      expect(result?.content).toContain('Resolve the latest writer before retrying.');
      expect(result?.content).not.toContain('self_correction:');
      expect(result?.content).not.toContain('error_retry:');
    });

    it('strips low-value scratchpad status before selecting reflections', async () => {
      const capturedAt = Date.now();
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: {
            triggeringText:
              'No relevant memories found for this query; continue with focused inspection instead of repeating this search.',
          },
          priority: 0.95,
          capturedAt,
          stepNumber: 4,
        },
        {
          signalType: 'error_retry',
          rawData: {
            triggeringText: [
              'npm run typecheck passed.',
              'Retry the sqlite-backed memory search after the worker lock is released.',
              'No issues found.',
              'Completed at: 2026-06-15T00:00:00.000Z',
            ].join('\n'),
          },
          priority: 0.9,
          capturedAt: capturedAt + 1,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.memoryIds).toHaveLength(1);
      expect(result?.content).toContain(
        'Retry the sqlite-backed memory search after the worker lock is released.',
      );
      expect(result?.content).not.toContain('No relevant memories found');
      expect(result?.content).not.toContain('npm run typecheck passed');
      expect(result?.content).not.toContain('No issues found');
      expect(result?.content).not.toContain('Completed at:');
    });

    it('deduplicates scratchpad reflections by compact rendered text before applying the limit', async () => {
      const capturedAt = Date.now();
      const sharedHead = `SCRATCH_RENDERED_DUP_HEAD ${'shared scratchpad context '.repeat(8)}`;
      const sharedTail = ' Verify the retry path before continuing.'.repeat(2);
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: { triggeringText: `${sharedHead}${'alpha-middle '.repeat(80)}${sharedTail}` },
          priority: 0.8,
          capturedAt,
          stepNumber: 4,
        },
        {
          signalType: 'error_retry',
          rawData: { triggeringText: `${sharedHead}${'beta-middle '.repeat(80)}${sharedTail}` },
          priority: 0.95,
          capturedAt: capturedAt + 1,
          stepNumber: 4,
        },
        {
          signalType: 'parallel_conflict',
          rawData: { triggeringText: 'Resolve the latest writer before retrying.' },
          priority: 0.8,
          capturedAt: capturedAt + 2,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.memoryIds).toHaveLength(2);
      expect(result?.memoryIds.every((id) => /^scratchpad:[a-f0-9]{16}$/.test(id))).toBe(true);
      expect(result?.memoryIds[0]).not.toBe(result?.memoryIds[1]);
      expect(result?.content).toContain('Resolve the latest writer before retrying.');
      expect(result?.content?.match(/SCRATCH_RENDERED_DUP_HEAD/g)).toHaveLength(1);
      expect(result?.content).not.toContain('self_correction:');
    });

    it('keeps localized scratchpad reflections within an estimated token budget', async () => {
      const capturedAt = Date.now();
      scratchpad = makeScratchpad([
        {
          signalType: 'self_correction',
          rawData: {
            triggeringText: [
              '反思开头',
              '这是一段会显著增加 token 的中文 scratchpad 观察。'.repeat(60),
              '反思尾部',
            ].join(' '),
          },
          priority: 0.9,
          capturedAt,
          stepNumber: 4,
        },
      ]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('scratchpad_reflection');
      expect(result?.content).toContain('反思开头');
      expect(result?.content).toContain('反思尾部');
      expect(estimateTokens(result?.content ?? '')).toBeLessThanOrEqual(75);
    });

    it('skips low-priority scratchpad entries to avoid noisy injections', async () => {
      const newEntry: AcuteCandidate = {
        signalType: 'config_touch',
        rawData: { triggeringText: 'Touched a common config file' },
        priority: 0.5,
        capturedAt: Date.now(),
        stepNumber: 4,
      };
      scratchpad = makeScratchpad([newEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
    });

    it('does not inject the same scratchpad entry twice', async () => {
      const capturedAt = Date.now();
      const newEntry: AcuteCandidate = {
        signalType: 'self_correction',
        rawData: { triggeringText: 'Actually the method is called differently' },
        priority: 0.9,
        capturedAt,
        stepNumber: 4,
      };
      scratchpad = makeScratchpad([newEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set([`scratchpad:self_correction:4:${capturedAt}`]),
      });

      expect(result).toBeNull();
    });

    it('does not reinject equivalent scratchpad text recorded at a later step', async () => {
      const firstEntry: AcuteCandidate = {
        signalType: 'self_correction',
        rawData: { triggeringText: 'Use the stable retry helper before continuing.' },
        priority: 0.9,
        capturedAt: Date.now(),
        stepNumber: 4,
      };
      scratchpad = makeScratchpad([firstEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const firstResult = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(firstResult?.type).toBe('scratchpad_reflection');

      const repeatedEntry: AcuteCandidate = {
        ...firstEntry,
        capturedAt: firstEntry.capturedAt + 10_000,
        stepNumber: 9,
      };
      scratchpad = makeScratchpad([repeatedEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const repeatedResult = await decider.decide(10, {
        toolCalls: [],
        injectedMemoryIds: new Set(firstResult?.memoryIds ?? []),
      });

      expect(repeatedResult).toBeNull();
    });

    it('passes stepNumber - 1 to getNewSince', async () => {
      const getSpy = vi.mocked(scratchpad.getNewSince);

      await decider.decide(10, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(getSpy).toHaveBeenCalledWith(9);
    });

    it('returns null when scratchpad has no new entries', async () => {
      scratchpad = makeScratchpad([]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
    });
  });

  describe('Trigger 3: Search short-circuit', () => {
    it('returns search_short_circuit when Grep pattern matches a known memory', async () => {
      const known = makeMemory({ id: 'grep-match', content: 'Use useCallback for memoized handlers' });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).not.toBeNull();
      expect(result?.type).toBe('search_short_circuit');
      expect(result?.memoryIds).toContain('grep-match');
      expect(result?.memoryIds.some((id) => /^search-pattern:[a-f0-9]{16}$/.test(id))).toBe(true);
      expect(result?.content).toContain('MEMORY CONTEXT');
      expect(memoryService.searchByPattern).toHaveBeenCalledWith('useCallback', {
        projectId: 'proj-1',
        recordAccess: false,
      });
      expect(memoryService.updateAccessCount).toHaveBeenCalledWith('grep-match');
    });

    it('preserves the tail when compacting search short-circuit memories', async () => {
      const known = makeMemory({
        id: 'grep-match',
        content: `Use the callback-specific fixture ${'search detail '.repeat(80)}SHORT_CIRCUIT_TAIL_OK`,
      });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('search_short_circuit');
      expect(result?.content).toContain('middle omitted');
      expect(result?.content).toContain('SHORT_CIRCUIT_TAIL_OK');
    });

    it('keeps localized search short-circuit injections within an estimated token budget', async () => {
      const known = makeMemory({
        id: 'grep-localized',
        content: [
          '短路记忆开头',
          '这是一段会显著增加 token 的中文搜索短路上下文。'.repeat(80),
          '短路记忆尾部',
        ].join(' '),
      });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('search_short_circuit');
      expect(result?.content).toContain('短路记忆开头');
      expect(result?.content).toContain('短路记忆尾部');
      expect(estimateTokens(result?.content ?? '')).toBeLessThanOrEqual(105);
    });

    it('skips broad Glob patterns for search_short_circuit', async () => {
      const known = makeMemory({ id: 'glob-match' });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Glob', args: { glob: '**/*.test.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
      expect(memoryService.searchByPattern).not.toHaveBeenCalled();
    });

    it('skips search_short_circuit if memory is already injected', async () => {
      const known = makeMemory({ id: 'already-injected' });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'something' } }],
        injectedMemoryIds: new Set(['already-injected']),
      });

      expect(result).toBeNull();
    });

    it('skips repeated search_short_circuit patterns already injected this session', async () => {
      const known = makeMemory({ id: 'pattern-match', content: 'Use the cached auth callback.' });
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(known);

      const firstResult = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: ' useCallback ' } }],
        injectedMemoryIds: new Set(),
      });

      expect(firstResult?.type).toBe('search_short_circuit');
      vi.mocked(memoryService.searchByPattern).mockClear();

      const repeatedResult = await decider.decide(6, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(firstResult?.memoryIds ?? []),
      });

      expect(repeatedResult).toBeNull();
      expect(memoryService.searchByPattern).not.toHaveBeenCalled();
    });

    it('skips Grep entries with empty patterns', async () => {
      await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: '' } }],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.searchByPattern).not.toHaveBeenCalled();
    });

    it('skips overly long Grep patterns to avoid noisy memory lookups', async () => {
      await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'specific '.repeat(40) } }],
        injectedMemoryIds: new Set(),
      });

      expect(memoryService.searchByPattern).not.toHaveBeenCalled();
    });

    it('does not short-circuit with low-quality pattern matches', async () => {
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(
        makeMemory({
          id: 'low-quality-match',
          content: 'Low confidence pattern match should not inject.',
          confidence: 0.2,
        }),
      );

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
    });

    it('does not short-circuit with low-value pattern matches', async () => {
      vi.mocked(memoryService.searchByPattern).mockResolvedValueOnce(
        makeMemory({
          id: 'low-value-match',
          content: [
            'Memory search results for "auth": 1. [gotcha] Already shown.',
            'No issues found.',
            'Completed at: 2026-06-15T00:00:00.000Z',
          ].join('\n'),
          confidence: 0.95,
        }),
      );

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'useCallback' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
      expect(memoryService.updateAccessCount).not.toHaveBeenCalledWith('low-value-match');
    });

    it('only checks last 3 Grep/Glob calls', async () => {
      vi.mocked(memoryService.searchByPattern).mockResolvedValue(null);

      await decider.decide(5, {
        toolCalls: [
          { toolName: 'Grep', args: { pattern: 'pat1' } },
          { toolName: 'Grep', args: { pattern: 'pat2' } },
          { toolName: 'Grep', args: { pattern: 'pat3' } },
          { toolName: 'Grep', args: { pattern: 'pat4' } },
          { toolName: 'Grep', args: { pattern: 'pat5' } },
        ],
        injectedMemoryIds: new Set(),
      });

      // Should only check the last 3: pat3, pat4, pat5
      expect(memoryService.searchByPattern).toHaveBeenCalledTimes(3);
      expect(vi.mocked(memoryService.searchByPattern).mock.calls).toEqual([
        ['pat3', { projectId: 'proj-1', recordAccess: false }],
        ['pat4', { projectId: 'proj-1', recordAccess: false }],
        ['pat5', { projectId: 'proj-1', recordAccess: false }],
      ]);
    });

    it('deduplicates repeated recent Grep and Glob patterns before memory lookup', async () => {
      vi.mocked(memoryService.searchByPattern).mockResolvedValue(null);

      await decider.decide(5, {
        toolCalls: [
          { toolName: 'Grep', args: { pattern: 'useCallback' } },
          { toolName: 'Grep', args: { pattern: ' useCallback ' } },
          { toolName: 'Glob', args: { glob: 'auth-refresh' } },
        ],
        injectedMemoryIds: new Set(),
      });

      expect(vi.mocked(memoryService.searchByPattern).mock.calls).toEqual([
        ['useCallback', { projectId: 'proj-1', recordAccess: false }],
        ['auth-refresh', { projectId: 'proj-1', recordAccess: false }],
      ]);
    });

    it('ignores non-string search patterns and folds whitespace before lookup', async () => {
      vi.mocked(memoryService.searchByPattern).mockResolvedValue(null);

      await decider.decide(5, {
        toolCalls: [
          { toolName: 'Grep', args: { pattern: { nested: 'ignored' } } },
          { toolName: 'Grep', args: { pattern: ' use   callback ' } },
          { toolName: 'Glob', args: { glob: 'use callback' } },
        ],
        injectedMemoryIds: new Set(),
      });

      expect(vi.mocked(memoryService.searchByPattern).mock.calls).toEqual([
        ['use callback', { projectId: 'proj-1', recordAccess: false }],
      ]);
    });
  });

  describe('error handling', () => {
    it('returns null gracefully when memoryService.search throws', async () => {
      vi.mocked(memoryService.search).mockRejectedValueOnce(new Error('DB error'));

      const result = await decider.decide(3, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/foo.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
    });

    it('returns null gracefully when memoryService.searchByPattern throws', async () => {
      vi.mocked(memoryService.searchByPattern).mockRejectedValueOnce(new Error('timeout'));

      const result = await decider.decide(3, {
        toolCalls: [{ toolName: 'Grep', args: { pattern: 'foo' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result).toBeNull();
    });
  });

  describe('trigger priority', () => {
    it('returns gotcha_injection first when file reads match, before checking scratchpad', async () => {
      const gotcha = makeMemory({ id: 'g1' });
      vi.mocked(memoryService.search).mockResolvedValueOnce([gotcha]);

      const newEntry: AcuteCandidate = {
        signalType: 'self_correction',
        rawData: { triggeringText: 'correction' },
        priority: 0.9,
        capturedAt: Date.now(),
        stepNumber: 4,
      };
      scratchpad = makeScratchpad([newEntry]);
      decider = new StepInjectionDecider(memoryService, scratchpad, 'proj-1');

      const result = await decider.decide(5, {
        toolCalls: [{ toolName: 'Read', args: { file_path: '/src/auth.ts' } }],
        injectedMemoryIds: new Set(),
      });

      expect(result?.type).toBe('gotcha_injection');
    });
  });
});
