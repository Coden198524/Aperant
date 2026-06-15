import { describe, expect, it } from 'vitest';

import type { Memory } from '../types.js';
import {
  type ContextPackingConfig,
  estimateTokens,
  MAX_PROMPT_CONTEXT_MEMORIES,
  MIN_PACKED_MEMORY_CONFIDENCE,
  packContext,
} from './context-packer.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-001',
    type: 'gotcha',
    content: 'Always preserve packaged Electron resource paths before moving files.',
    confidence: 0.9,
    tags: ['electron'],
    relatedFiles: ['src/main/resources.ts'],
    relatedModules: ['desktop'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'global',
    source: 'agent_explicit',
    sessionId: 'session-001',
    provenanceSessionIds: [],
    projectId: 'project-001',
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('keeps the existing latin text estimate', () => {
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('a'.repeat(1000))).toBe(250);
    expect(estimateTokens('')).toBe(0);
  });

  it('uses a more conservative estimate for CJK prompt text', () => {
    const cjkText = '\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25';
    expect(estimateTokens(cjkText)).toBe(cjkText.length);
    expect(estimateTokens(`save ${cjkText}`)).toBeGreaterThan(Math.ceil(`save ${cjkText}`.length / 4));
  });
});

describe('packContext memory quality gate', () => {
  it('filters untrusted memories before packing context', () => {
    const result = packContext([
      makeMemory({ id: 'good', content: 'Trusted packaged path pattern.' }),
      makeMemory({ id: 'deprecated', content: 'Deprecated memory should not appear.', deprecated: true }),
      makeMemory({ id: 'review', content: 'Pending review memory should not appear.', needsReview: true }),
      makeMemory({
        id: 'stale',
        content: 'Stale memory should not appear.',
        staleAt: '2000-01-01T00:00:00.000Z',
      }),
      makeMemory({
        id: 'low-confidence',
        content: 'Low confidence memory should not appear.',
        confidence: MIN_PACKED_MEMORY_CONFIDENCE - 0.01,
      }),
    ], 'implement');

    expect(result).toContain('Trusted packaged path pattern.');
    expect(result).not.toContain('Deprecated memory should not appear.');
    expect(result).not.toContain('Pending review memory should not appear.');
    expect(result).not.toContain('Stale memory should not appear.');
    expect(result).not.toContain('Low confidence memory should not appear.');
  });

  it('normalizes invalid and duplicate prompt memories before packing context', () => {
    const result = packContext(
      [
        makeMemory({ id: ' ', content: 'blank id should be skipped' }),
        makeMemory({ id: 'blank-content', content: '   ' }),
        makeMemory({ id: 'duplicate', content: '  First duplicate should remain.  ' }),
        makeMemory({ id: ' duplicate ', content: 'Second duplicate should be skipped.' }),
        makeMemory({ id: 'bad-confidence', content: 'Bad confidence should be skipped.', confidence: Number.NaN }),
        makeMemory({
          id: 'metadata',
          content: '  Metadata \n memory  ',
          citationText: '  Source \n citation  ',
          relatedFiles: [' src/auth.ts ', 'src/auth.ts', ' src/session.ts '],
        }),
      ],
      'implement',
    );

    expect(result).toContain('First duplicate should remain.');
    expect(result).toContain('Metadata memory');
    expect(result).toContain('[^ Memory: Source citation]');
    expect(result).toContain('src/auth.ts, src/session.ts');
    expect(result).not.toContain('blank id should be skipped');
    expect(result).not.toContain('Second duplicate should be skipped.');
    expect(result).not.toContain('Bad confidence should be skipped.');
  });

  it('ignores malformed prompt metadata without aborting context packing', () => {
    const result = packContext(
      [
        makeMemory({
          id: 42 as unknown as string,
          content: 'Bad id should be skipped.',
        }),
        makeMemory({
          id: 'malformed-metadata',
          content: 'Malformed metadata should still pack.',
          citationText: 42 as unknown as string,
          relatedFiles: [' src/auth.ts ', 7 as unknown as string, 'src/session.ts'],
          relatedModules: [false as unknown as string, ' auth '] as string[],
        }),
      ],
      'implement',
      { totalBudget: 120, allocation: undefined as unknown as ContextPackingConfig['allocation'] },
    );

    expect(result).toContain('Malformed metadata should still pack.');
    expect(result).toContain('src/auth.ts, src/session.ts');
    expect(result).not.toContain('Bad id should be skipped.');
    expect(result).not.toContain('[^ Memory:');
  });

  it('caps prompt context candidate normalization before spending token budget', () => {
    const result = packContext(
      Array.from({ length: MAX_PROMPT_CONTEXT_MEMORIES + 5 }, (_, index) =>
        makeMemory({
          id: `candidate-${index}`,
          content: `Distinct compact memory candidate ${index} covers topic_${index} branch_${index}.`,
        }),
      ),
      'implement',
      { totalBudget: 10_000, allocation: { gotcha: 1 } },
    );

    expect(result).toContain(`topic_${MAX_PROMPT_CONTEXT_MEMORIES - 1}`);
    expect(result).not.toContain(`topic_${MAX_PROMPT_CONTEXT_MEMORIES}`);
  });

  it('does not let filtered memories consume the prompt candidate cap', () => {
    const result = packContext(
      [
        ...Array.from({ length: MAX_PROMPT_CONTEXT_MEMORIES }, (_, index) =>
          makeMemory({
            id: `low-confidence-${index}`,
            content: `Low confidence memory ${index} should not consume the candidate cap.`,
            confidence: 0.1,
          }),
        ),
        makeMemory({
          id: 'trusted-after-noise',
          content: 'Trusted memory after noisy candidates should still appear.',
        }),
      ],
      'implement',
      { totalBudget: 10_000, allocation: { gotcha: 1 } },
    );

    expect(result).toContain('Trusted memory after noisy candidates should still appear.');
    expect(result).not.toContain('Low confidence memory');
  });

  it('keeps pinned or user-verified memories even when they need review or are low confidence', () => {
    const result = packContext([
      makeMemory({
        id: 'verified',
        content: 'Verified review memory can guide future work.',
        confidence: 0.2,
        needsReview: true,
        userVerified: true,
      }),
      makeMemory({
        id: 'pinned',
        content: 'Pinned stale memory can guide future work.',
        confidence: 0.2,
        staleAt: '2000-01-01T00:00:00.000Z',
        pinned: true,
      }),
    ], 'implement');

    expect(result).toContain('Verified review memory can guide future work.');
    expect(result).toContain('Pinned stale memory can guide future work.');
  });

  it('skips oversized memories and still packs later concise memories', () => {
    const result = packContext([
      makeMemory({
        id: 'oversized',
        content: 'Oversized memory should not block smaller relevant memory. '.repeat(80),
        relatedFiles: ['src/very/deep/path/that/also/adds/metadata/to/the/formatted/memory.ts'],
        citationText: 'large citation '.repeat(40),
      }),
      makeMemory({
        id: 'concise',
        content: 'Concise retry gotcha fits the tight budget.',
      }),
    ], 'implement', {
      totalBudget: 45,
      allocation: { gotcha: 1 },
    });

    expect(result).toContain('Concise retry gotcha fits the tight budget.');
    expect(result).not.toContain('Oversized memory should not block');
  });

  it('compacts oversized localized memories instead of dropping them when budget remains', () => {
    const cjkText = '\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25';
    const totalBudget = 80;
    const result = packContext(
      [
        makeMemory({
          id: 'localized-long',
          content: `Start ${cjkText.repeat(80)} FINAL_LOCALIZED_MEMORY_TAIL_OK`,
          relatedFiles: [],
          citationText: undefined,
        }),
      ],
      'implement',
      { totalBudget, allocation: { gotcha: 1 } },
    );

    expect(result).toContain('Start');
    expect(result).toContain('memory middle omitted');
    expect(result).toContain('FINAL_LOCALIZED_MEMORY_TAIL_OK');
    expect(estimateTokens(result)).toBeLessThanOrEqual(totalBudget);
  });

  it('keeps packed context within the configured token budget including heading overhead', () => {
    const totalBudget = 48;
    const result = packContext(
      Array.from({ length: 8 }, (_, index) =>
        makeMemory({
          id: `budget-${index}`,
          content: `Concise budget memory ${index}.`,
          relatedFiles: [],
          citationText: undefined,
        }),
      ),
      'implement',
      { totalBudget, allocation: { gotcha: 1 } },
    );

    expect(result).toContain('Relevant Context from Memory');
    expect(estimateTokens(result)).toBeLessThanOrEqual(totalBudget);
  });

  it('reclaims unused allocation for additional prioritized memories', () => {
    const totalBudget = 44;
    const result = packContext(
      [
        makeMemory({
          id: 'gotcha-1',
          content: 'First compact gotcha about token cache.',
          relatedFiles: [],
        }),
        makeMemory({
          id: 'gotcha-2',
          content: 'Second compact gotcha about renderer bridge.',
          relatedFiles: [],
        }),
      ],
      'implement',
      { totalBudget, allocation: { gotcha: 0.45, error_pattern: 0.45 } },
    );

    expect(result).toContain('First compact gotcha');
    expect(result).toContain('Second compact gotcha');
    expect(estimateTokens(result)).toBeLessThanOrEqual(totalBudget);
  });

  it('preserves tail lessons when packing long memory content', () => {
    const result = packContext([
      makeMemory({
        id: 'tail-lesson',
        content: `Start with the failing settings save path. ${'verbose diagnostic detail '.repeat(80)} FINAL_MEMORY_LESSON_TAIL_OK`,
        relatedFiles: [`src/${'nested/'.repeat(20)}settings-store.ts`],
        citationText: `Investigation began with noisy logs. ${'more citation detail '.repeat(20)} FINAL_CITATION_TAIL_OK`,
      }),
    ], 'implement');

    expect(result).toContain('Start with the failing settings save path');
    expect(result).toContain('memory middle omitted');
    expect(result).toContain('FINAL_MEMORY_LESSON_TAIL_OK');
    expect(result).toContain('settings-store.ts');
    expect(result).toContain('FINAL_CITATION_TAIL_OK');
  });

  it('deduplicates repeated memory content across memory types', () => {
    const repeated = 'Check settings save failures against userData settings path permissions first.';
    const result = packContext([
      makeMemory({ id: 'gotcha-duplicate', type: 'gotcha', content: repeated }),
      makeMemory({ id: 'error-pattern-duplicate', type: 'error_pattern', content: repeated }),
    ], 'implement');

    expect(result).toContain('Gotcha');
    expect(result).not.toContain('Error Pattern');
    expect((result.match(/settings save failures/g) ?? []).length).toBe(1);
  });

  it('deduplicates similar Chinese memory content without relying on whitespace tokenization', () => {
    const result = packContext([
      makeMemory({
        id: 'zh-gotcha',
        type: 'gotcha',
        content: '设置页面保存失败时，先检查 userData/settings.json 权限和写入路径。',
      }),
      makeMemory({
        id: 'zh-error',
        type: 'error_pattern',
        content: '设置页面保存失败时先检查 userData/settings.json 权限和写入路径',
      }),
    ], 'implement');

    expect(result).toContain('设置页面保存失败时');
    expect(result).toContain('Gotcha');
    expect(result).not.toContain('Error Pattern');
    expect((result.match(/设置页面保存失败时/g) ?? []).length).toBe(1);
  });
});
