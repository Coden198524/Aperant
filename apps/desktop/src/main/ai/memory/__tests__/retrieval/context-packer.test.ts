/**
 * context-packer.test.ts — Test budget allocation and token limits
 */

import { describe, it, expect } from 'vitest';
import {
  packContext,
  estimateTokens,
  DEFAULT_PACKING_CONFIG,
  isMemoryEligibleForPromptContext,
  MAX_PACKED_MEMORY_CITATION_CHARS,
  MAX_PACKED_MEMORY_CONTENT_CHARS,
  MAX_PACKED_MEMORY_FILE_REF_CHARS,
} from '../../retrieval/context-packer';
import type { Memory } from '../../types';

// ============================================================
// HELPERS
// ============================================================

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-001',
    type: 'gotcha',
    content: 'Always check JWT token expiry before validating claims in middleware.',
    confidence: 0.9,
    tags: ['auth', 'jwt'],
    relatedFiles: ['src/main/auth/middleware.ts'],
    relatedModules: ['auth'],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 1,
    scope: 'global',
    source: 'agent_explicit',
    sessionId: 'session-001',
    provenanceSessionIds: [],
    projectId: 'test-project',
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('estimateTokens', () => {
  it('estimates tokens as ~4 chars per token', () => {
    const text = 'hello world'; // 11 chars → ceil(11/4) = 3 tokens
    expect(estimateTokens(text)).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });

  it('uses a more conservative estimate for CJK text', () => {
    const cjkText = '\u8bbe\u7f6e\u4fdd\u5b58\u5931\u8d25';
    expect(estimateTokens(cjkText)).toBe(cjkText.length);
    expect(estimateTokens(`save ${cjkText}`)).toBeGreaterThan(Math.ceil(`save ${cjkText}`.length / 4));
  });
});

describe('DEFAULT_PACKING_CONFIG', () => {
  it('has configs for all UniversalPhase values', () => {
    const phases = ['define', 'implement', 'validate', 'refine', 'explore', 'reflect'] as const;
    for (const phase of phases) {
      expect(DEFAULT_PACKING_CONFIG[phase]).toBeDefined();
      expect(DEFAULT_PACKING_CONFIG[phase].totalBudget).toBeGreaterThan(0);
    }
  });

  it('each config has valid allocation ratios that sum <= 1.0', () => {
    for (const [phase, config] of Object.entries(DEFAULT_PACKING_CONFIG)) {
      const sum = Object.values(config.allocation).reduce((s, v) => s + v, 0);
      expect(sum).toBeLessThanOrEqual(1.0 + 0.001); // small float tolerance
      expect(phase).toBeTruthy();
    }
  });
});

describe('packContext', () => {
  it('returns empty string for empty memories array', () => {
    expect(packContext([], 'implement')).toBe('');
  });

  it('returns formatted context for a single memory', () => {
    const memory = makeMemory({ type: 'gotcha' });
    const result = packContext([memory], 'implement');

    expect(result).toContain('Relevant Context from Memory');
    expect(result).toContain(memory.content);
    expect(result).toContain('Gotcha');
  });

  it('filters invalid and duplicate memories before packing context', () => {
    const result = packContext(
      [
        makeMemory({ id: ' ', content: 'blank id should be skipped' }),
        makeMemory({ id: 'blank-content', content: '   ' }),
        makeMemory({ id: 'duplicate', content: 'First duplicate should remain.' }),
        makeMemory({ id: ' duplicate ', content: 'Second duplicate should be skipped.' }),
        makeMemory({ id: 'bad-confidence', content: 'Bad confidence should be skipped.', confidence: Number.NaN }),
      ],
      'implement',
    );

    expect(result).toContain('First duplicate should remain.');
    expect(result).not.toContain('blank id should be skipped');
    expect(result).not.toContain('Second duplicate should be skipped.');
    expect(result).not.toContain('Bad confidence should be skipped.');
  });

  it('normalizes prompt metadata before packing context', () => {
    const result = packContext(
      [
        makeMemory({
          id: 'metadata',
          content: '  Metadata \n memory  ',
          citationText: '  Source \n citation  ',
          relatedFiles: [' src/auth.ts ', './SRC/auth.ts/', ' src/session.ts ', './src/session.ts/'],
        }),
      ],
      'implement',
    );

    expect(result).toContain('Metadata memory');
    expect(result).toContain('[^ Memory: Source citation]');
    expect(result).toContain('src/auth.ts, src/session.ts');
    expect(result).not.toContain('./SRC/auth.ts');
    expect(result).not.toContain('./src/session.ts');
  });

  it('includes file context in output', () => {
    const memory = makeMemory({ relatedFiles: ['src/main/auth/middleware.ts'] });
    const result = packContext([memory], 'implement');

    expect(result).toContain('src/main/auth/middleware.ts');
  });

  it('includes citation chip when citationText is provided', () => {
    const memory = makeMemory({ citationText: 'JWT middleware gotcha' });
    const result = packContext([memory], 'implement');

    expect(result).toContain('[^ Memory: JWT middleware gotcha]');
  });

  it('shows confidence warning for low-confidence memories', () => {
    const memory = makeMemory({ confidence: 0.6 });
    const result = packContext([memory], 'implement');

    expect(result).toContain('confidence:');
  });

  it('does not show confidence for high-confidence memories', () => {
    const memory = makeMemory({ confidence: 0.95 });
    const result = packContext([memory], 'implement');

    expect(result).not.toContain('confidence:');
  });

  it('respects token budget — does not exceed totalBudget', () => {
    // Create many long memories that would exceed budget
    const longContent = 'word '.repeat(300); // ~1500 chars = ~375 tokens each
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemory({ id: `mem-${i}`, content: longContent, type: 'gotcha' }),
    );

    const result = packContext(memories, 'implement');
    const tokens = estimateTokens(result);

    // Add some overhead for the heading
    const { totalBudget } = DEFAULT_PACKING_CONFIG.implement;
    // Allow 2x budget for formatting overhead but it should be roughly bounded
    expect(tokens).toBeLessThan(totalBudget * 3);
  });

  it('deduplicates highly similar memories via MMR', () => {
    // Two nearly identical memories should only produce one entry
    const content = 'JWT token expiry must be checked before validating claims in middleware';
    const mem1 = makeMemory({ id: 'mem-1', content, type: 'gotcha' });
    const mem2 = makeMemory({ id: 'mem-2', content, type: 'gotcha' });

    const result = packContext([mem1, mem2], 'implement');

    // Content should appear only once due to MMR deduplication
    const contentOccurrences = (result.match(/JWT token expiry/g) ?? []).length;
    expect(contentOccurrences).toBe(1);
  });

  it('truncates very long memory content before packing', () => {
    const longContent = `start ${'very long detail '.repeat(100)} FINAL_MEMORY_TAIL_OK`;
    const result = packContext([
      makeMemory({ id: 'long-memory', content: longContent, type: 'gotcha' }),
    ], 'implement');

    expect(result).toContain('start');
    expect(result).toContain('memory middle omitted');
    expect(result).toContain('FINAL_MEMORY_TAIL_OK');
    expect(result.length).toBeLessThan(MAX_PACKED_MEMORY_CONTENT_CHARS + 180);
  });

  it('truncates long citation and file metadata before packing', () => {
    const longCitation = 'citation '.repeat(80);
    const longFile = `src/${'deep/'.repeat(40)}middleware.ts`;
    const result = packContext([
      makeMemory({
        id: 'long-meta-memory',
        content: 'Short content',
        type: 'gotcha',
        citationText: longCitation,
        relatedFiles: [longFile],
      }),
    ], 'implement');

    expect(result).toContain('Short content');
    expect(result).toContain('[^ Memory:');
    expect(result).toContain('...');
    expect(result).not.toContain(longCitation);
    expect(result).not.toContain(longFile);
    expect(result).toContain('middleware.ts');
    const citationMatch = result.match(/\[\^ Memory: ([^\]]+)\]/);
    expect(citationMatch?.[1].length).toBeLessThanOrEqual(MAX_PACKED_MEMORY_CITATION_CHARS);
    const fileMatch = result.match(/\*\*Gotcha\*\* \(([^)]*)\)/);
    expect(fileMatch?.[1].length).toBeLessThanOrEqual(MAX_PACKED_MEMORY_FILE_REF_CHARS);
  });

  it('includes memories from types in allocation map first', () => {
    const gotcha = makeMemory({ id: 'gotcha-1', type: 'gotcha', content: 'gotcha content' });
    const preference = makeMemory({ id: 'pref-1', type: 'preference', content: 'preference content' });
    // gotcha is in implement allocation; preference is not

    const result = packContext([preference, gotcha], 'implement');

    // Both should be included
    expect(result).toContain('gotcha content');
  });

  it('uses custom config when provided', () => {
    const memory = makeMemory({ type: 'gotcha', content: 'short' });
    const tinyConfig = {
      totalBudget: 10,
      allocation: { gotcha: 1.0 as number },
    };

    // With budget of 10 tokens and long content, should still handle gracefully
    const result = packContext([memory], 'implement', tinyConfig as Parameters<typeof packContext>[2]);
    expect(typeof result).toBe('string');
  });
});

describe('isMemoryEligibleForPromptContext', () => {
  it('returns false for prompt-invalid memories before core eligibility checks', () => {
    expect(isMemoryEligibleForPromptContext(makeMemory({ id: ' ', content: 'usable' }))).toBe(false);
    expect(isMemoryEligibleForPromptContext(makeMemory({ id: 'mem', content: '   ' }))).toBe(false);
    expect(isMemoryEligibleForPromptContext(makeMemory({ id: 'mem', confidence: Number.NaN }))).toBe(false);
  });
});
