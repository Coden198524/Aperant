/**
 * MemoryObserver Tests
 *
 * Tests observe() with mock messages and verifies the <2ms budget.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryObserver } from '../../observer/memory-observer';
import type { MemoryIpcRequest } from '../../types';

describe('MemoryObserver', () => {
  let observer: MemoryObserver;

  beforeEach(() => {
    observer = new MemoryObserver('test-session-1', 'build', 'test-project');
  });

  describe('observe() budget', () => {
    it('processes tool-call messages within 2ms', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: '/src/main.ts' },
        stepNumber: 1,
      };

      const start = process.hrtime.bigint();
      observer.observe(msg);
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;

      expect(elapsed).toBeLessThan(2);
    });

    it('processes reasoning messages within 2ms', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'I need to read the file first to understand the structure.',
        stepNumber: 2,
      };

      const start = process.hrtime.bigint();
      observer.observe(msg);
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;

      expect(elapsed).toBeLessThan(2);
    });

    it('processes step-complete messages within 2ms', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:step-complete',
        stepNumber: 5,
      };

      const start = process.hrtime.bigint();
      observer.observe(msg);
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;

      expect(elapsed).toBeLessThan(2);
    });

    it('does not throw on malformed messages', () => {
      // Even if something unexpected is passed, observe must not throw
      expect(() => {
        observer.observe({ type: 'memory:step-complete', stepNumber: 1 });
      }).not.toThrow();
    });
  });

  describe('self-correction detection', () => {
    it('detects self-correction patterns in reasoning text', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'Actually, the configuration is in tsconfig.json, not in package.json as I thought.',
        stepNumber: 3,
      };

      observer.observe(msg);
      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.selfCorrectionCount).toBe(1);
      expect(scratchpad.analytics.lastSelfCorrectionStep).toBe(3);
    });

    it('creates acute candidate for self-correction', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'Wait, the API endpoint changed in v2.',
        stepNumber: 4,
      };

      observer.observe(msg);
      const candidates = observer.getNewCandidatesSince(0);
      const selfCorrectionCandidates = candidates.filter(
        (c) => c.signalType === 'self_correction',
      );
      expect(selfCorrectionCandidates.length).toBeGreaterThanOrEqual(1);
    });

    it('does not flag non-correction text', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'I will now read the configuration file and check the settings.',
        stepNumber: 2,
      };

      observer.observe(msg);
      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.selfCorrectionCount).toBe(0);
    });
  });

  describe('dead-end detection', () => {
    it('creates backtrack candidate for dead-end language', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'This approach will not work because the API is unavailable in production.',
        stepNumber: 6,
      };

      observer.observe(msg);
      const candidates = observer.getNewCandidatesSince(0);
      const backtracks = candidates.filter((c) => c.signalType === 'backtrack');
      expect(backtracks.length).toBeGreaterThanOrEqual(1);
    });

    it('detects "let me try a different approach"', () => {
      const msg: MemoryIpcRequest = {
        type: 'memory:reasoning',
        text: 'Let me try a different approach to solve this problem.',
        stepNumber: 7,
      };

      observer.observe(msg);
      const candidates = observer.getNewCandidatesSince(0);
      const backtracks = candidates.filter((c) => c.signalType === 'backtrack');
      expect(backtracks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('external tool call tracking (trust gate)', () => {
    it('records the step of the first external tool call', () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'WebFetch',
        args: { url: 'https://example.com' },
        stepNumber: 10,
      });

      // After WebFetch, self-correction should be flagged
      observer.observe({
        type: 'memory:reasoning',
        text: 'Actually, the correct method is fetch() not axios.',
        stepNumber: 11,
      });

      // The observer internally tracks the external tool call step
      // finalize() will apply the trust gate
    });
  });

  describe('file access tracking', () => {
    it('tracks multiple reads of the same file', () => {
      for (let i = 0; i < 3; i++) {
        observer.observe({
          type: 'memory:tool-call',
          toolName: 'Read',
          args: { file_path: '/src/auth.ts' },
          stepNumber: i + 1,
        });
      }

      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.fileAccessCounts.get('/src/auth.ts')).toBe(3);
    });

    it('tracks first and last access steps', () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: '/src/router.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: '/src/router.ts' },
        stepNumber: 8,
      });

      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.fileFirstAccess.get('/src/router.ts')).toBe(2);
      expect(scratchpad.analytics.fileLastAccess.get('/src/router.ts')).toBe(8);
    });

    it('tracks config file touches', () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Edit',
        args: { file_path: '/tsconfig.json' },
        stepNumber: 3,
      });

      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.configFilesTouched.has('/tsconfig.json')).toBe(true);
      expect(scratchpad.analytics.fileEditSet.has('/tsconfig.json')).toBe(true);
    });

    it('canonicalizes raw camelCase tool args before tracking files', () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: {
          filePath: ' src\\auth\\token.ts ',
          content: 'ignored large read payload',
        },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Edit',
        args: {
          filePath: 'src/auth//token.ts',
          oldString: 'old'.repeat(1_000),
          newString: 'new'.repeat(1_000),
        },
        stepNumber: 2,
      });

      const scratchpad = observer.getScratchpad();
      expect(scratchpad.analytics.fileAccessCounts.get('src/auth/token.ts')).toBe(2);
      expect(scratchpad.analytics.fileEditSet.has('src/auth/token.ts')).toBe(true);
    });
  });

  describe('finalize()', () => {
    it('returns empty array for changelog session type', async () => {
      const changelogObserver = new MemoryObserver(
        'test-session-changelog',
        'changelog',
        'test-project',
      );
      changelogObserver.observe({
        type: 'memory:reasoning',
        text: 'Actually, the version should be 2.0 not 1.5.',
        stepNumber: 1,
      });

      const candidates = await changelogObserver.finalize('success');
      expect(candidates).toHaveLength(0);
    });

    it('returns candidates on successful build', async () => {
      // Create enough signals to generate candidates
      observer.observe({
        type: 'memory:reasoning',
        text: 'Wait, I need to check the imports first.',
        stepNumber: 1,
      });

      const candidates = await observer.finalize('success');
      expect(Array.isArray(candidates)).toBe(true);
    });

    it('includes a compact diagnostic sample in repeated error candidates', async () => {
      for (let stepNumber = 1; stepNumber <= 2; stepNumber++) {
        observer.observe({
          type: 'memory:tool-result',
          toolName: 'Bash',
          result: {
            exitCode: 1,
            message: 'Command failed',
            diagnosticText:
              'stderr: TypeError: Cannot read properties of undefined in /home/alice/project/src/auth/session.ts:42',
          },
          stepNumber,
        });
      }

      const candidates = await observer.finalize('success');
      const errorRetry = candidates.find((candidate) => candidate.signalType === 'error_retry');

      expect(errorRetry?.content).toContain('Recurring error pattern (2 times)');
      expect(errorRetry?.content).toContain('Cannot read properties of undefined');
      expect(errorRetry?.content).not.toContain('/home/alice');
      expect(errorRetry?.content).toContain('fingerprint:');
      expect(errorRetry?.content.length).toBeLessThan(320);
    });

    it('uses full self-correction reasoning snippets in finalized candidates', async () => {
      observer.observe({
        type: 'memory:reasoning',
        text: 'Actually, the refresh token cache is in session-store.ts not token-cache.ts, so update listeners after the cache write.',
        stepNumber: 1,
      });

      const candidates = await observer.finalize('success');
      const selfCorrection = candidates.find(
        (candidate) => candidate.signalType === 'self_correction',
      );

      expect(selfCorrection?.content).toContain('refresh token cache is in session-store.ts');
      expect(selfCorrection?.content).toContain('update listeners after the cache write');
      expect(selfCorrection?.content).not.toBe('Self-correction detected: Actually, the refresh token cache is in session-store.ts not token-cache.ts');
    });

    it('does not promote low-value reasoning tool echoes as self-corrections', async () => {
      observer.observe({
        type: 'memory:reasoning',
        text: 'Wait, No relevant memories found for this query; continue with focused inspection instead of repeating this search.',
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:reasoning',
        text: [
          'Correction: npm run typecheck passed.',
          'No issues found.',
          'Completed at: 2026-06-15T00:00:00.000Z',
        ].join(' '),
        stepNumber: 2,
      });

      const candidates = await observer.finalize('success');

      expect(candidates.some((candidate) => candidate.signalType === 'self_correction')).toBe(false);
      expect(candidates.map((candidate) => candidate.content).join('\n')).not.toContain(
        'No relevant memories found',
      );
    });

    it('does not promote generic backtrack phrasing without actionable details', async () => {
      observer.observe({
        type: 'memory:reasoning',
        text: 'Let me try a different approach to solve this problem.',
        stepNumber: 1,
      });

      const candidates = await observer.finalize('success');

      expect(candidates.some((candidate) => candidate.signalType === 'backtrack')).toBe(false);
    });

    it('deduplicates reciprocal co-access pairs before promotion', async () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: './src/auth/a.ts/' },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src\\auth\\b.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/a.ts' },
        stepNumber: 3,
      });

      const candidates = await observer.finalize('success');
      const coAccess = candidates.filter((candidate) => candidate.signalType === 'co_access');

      expect(coAccess).toHaveLength(1);
      expect(coAccess[0].relatedFiles).toEqual(['src/auth/a.ts', 'src/auth/b.ts']);
      expect(coAccess[0].relatedModules).toEqual(['auth']);
      expect(JSON.parse(coAccess[0].content)).toEqual({
        alwaysReadFiles: [],
        frequentlyReadFiles: ['src/auth/a.ts', 'src/auth/b.ts'],
      });
    });

    it('infers focused modules from real workspace file paths', async () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'apps/desktop/src/main/ai/memory/observer/memory-observer.ts' },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'apps/desktop/src/main/ai/memory/injection/prefetch-builder.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'apps/desktop/src/main/ai/memory/observer/memory-observer.ts' },
        stepNumber: 3,
      });

      const candidates = await observer.finalize('success');
      const coAccess = candidates.filter((candidate) => candidate.signalType === 'co_access');

      expect(coAccess).toHaveLength(1);
      expect(coAccess[0].relatedModules).toEqual(['memory', 'injection', 'observer']);
      expect(coAccess[0].relatedModules).not.toContain('desktop');
      expect(coAccess[0].relatedModules).not.toContain('main');
      expect(coAccess[0].relatedModules).not.toContain('ai');
    });

    it('caps noisy co-access candidates before they crowd session memory', async () => {
      for (let index = 0; index < 14; index++) {
        observer.observe({
          type: 'memory:tool-call',
          toolName: 'Read',
          args: { file_path: `src/file-${index}.ts` },
          stepNumber: index + 1,
        });
      }

      const candidates = await observer.finalize('success');
      const coAccess = candidates.filter((candidate) => candidate.signalType === 'co_access');
      const unorderedPairs = new Set(
        coAccess.map((candidate) =>
          [...candidate.relatedFiles].sort((a, b) => a.localeCompare(b)).join('|'),
        ),
      );

      expect(coAccess).toHaveLength(8);
      expect(unorderedPairs.size).toBe(coAccess.length);
    });

    it('promotes a high context token spike into one compact context_cost candidate', async () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/session.ts' },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/session.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/auth/token-cache.ts' },
        stepNumber: 3,
      });
      observer.observe({
        type: 'memory:token-usage',
        inputTokens: 24_000,
        contextWindowLimit: 30_000,
        stepNumber: 4,
      });
      observer.observe({
        type: 'memory:token-usage',
        inputTokens: 18_000,
        contextWindowLimit: 30_000,
        stepNumber: 5,
      });

      const candidates = await observer.finalize('success');
      const contextCost = candidates.filter(
        (candidate) => candidate.signalType === 'context_token_spike',
      );

      expect(contextCost).toHaveLength(1);
      expect(contextCost[0].proposedType).toBe('context_cost');
      expect(contextCost[0].content).toContain('Context token spike');
      expect(contextCost[0].content).toContain('24k tokens');
      expect(contextCost[0].content).toContain(
        'Likely broad file reads: src/auth/session.ts, src/auth/token-cache.ts.',
      );
      expect(contextCost[0].content.length).toBeLessThan(220);
      expect(contextCost[0].relatedFiles).toEqual([
        'src/auth/session.ts',
        'src/auth/token-cache.ts',
      ]);
      expect(contextCost[0].relatedModules).toEqual(['auth']);
      expect(contextCost[0].originatingStep).toBe(4);
    });

    it('keeps context token spike file hints compact for deep workspace paths', async () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'apps/desktop/src/main/ai/memory/observer/memory-observer.ts' },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'apps/desktop/src/main/ai/memory/injection/prefetch-builder.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:token-usage',
        inputTokens: 48_000,
        contextWindowLimit: 60_000,
        stepNumber: 3,
      });

      const candidates = await observer.finalize('success');
      const contextCost = candidates.find(
        (candidate) => candidate.signalType === 'context_token_spike',
      );

      expect(contextCost?.content).toContain('Likely broad file reads:');
      expect(contextCost?.content).toContain('memory/observer/memory-observer.ts');
      expect(contextCost?.content).toContain('memory/injection/prefetch-builder.ts');
      expect(contextCost?.content.length).toBeLessThan(220);
    });

    it('does not promote normal token usage into context_cost noise', async () => {
      observer.observe({
        type: 'memory:token-usage',
        inputTokens: 7_500,
        contextWindowLimit: 30_000,
        stepNumber: 4,
      });

      const candidates = await observer.finalize('success');

      expect(candidates.some((candidate) => candidate.signalType === 'context_token_spike')).toBe(false);
      expect(observer.getScratchpad().analytics.totalInputTokens).toBe(7_500);
      expect(observer.getScratchpad().analytics.peakContextTokens).toBe(7_500);
    });

    it('does not promote generic repeated grep patterns into long-term memory', async () => {
      for (const pattern of ['test', 'src', '.ts', '.*', 'import']) {
        for (let index = 0; index < 3; index++) {
          observer.observe({
            type: 'memory:tool-call',
            toolName: 'Grep',
            args: { pattern },
            stepNumber: index + 1,
          });
        }
      }

      const candidates = await observer.finalize('success');

      expect(candidates.some((candidate) => candidate.signalType === 'repeated_grep')).toBe(false);
    });

    it('promotes focused repeated grep patterns into module insights', async () => {
      for (let index = 0; index < 3; index++) {
        observer.observe({
          type: 'memory:tool-call',
          toolName: 'Grep',
          args: { pattern: 'refreshToken retry policy' },
          stepNumber: index + 1,
        });
      }

      const candidates = await observer.finalize('success');
      const repeatedGrep = candidates.filter((candidate) => candidate.signalType === 'repeated_grep');

      expect(repeatedGrep).toHaveLength(1);
      expect(repeatedGrep[0].proposedType).toBe('module_insight');
      expect(repeatedGrep[0].content).toContain('refreshToken retry policy');
    });

    it('only returns dead_end candidates on failed session', async () => {
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/failed-a.ts' },
        stepNumber: 1,
      });
      observer.observe({
        type: 'memory:tool-call',
        toolName: 'Read',
        args: { file_path: 'src/failed-b.ts' },
        stepNumber: 2,
      });
      observer.observe({
        type: 'memory:reasoning',
        text: 'This approach will not work in this environment.',
        stepNumber: 3,
      });
      observer.observe({
        type: 'memory:reasoning',
        text: 'Wait, I was wrong about the method signature.',
        stepNumber: 4,
      });

      const candidates = await observer.finalize('failure');
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        expect(c.proposedType).toBe('dead_end');
      }
      expect(candidates.some((c) => c.signalType === 'co_access')).toBe(false);
      expect(candidates.some((c) => c.signalType === 'self_correction')).toBe(false);
    });
  });
});
