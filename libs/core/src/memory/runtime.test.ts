import { describe, expect, it } from 'vitest';

import type { Memory } from './types.js';
import {
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT,
  buildAutocodeWorkUnitOutcomeMemoryEntry,
  buildAutocodeWorkUnitOutcomeSessionInsight,
  compactAutocodeMemoryRuntimeReasoningText,
  compactAutocodeMemoryRuntimeToolArgs,
  compactAutocodeMemoryRuntimeToolResult,
  formatAutocodeMemoryRuntimeContext,
} from './runtime.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    type: 'gotcha',
    content: 'Remember the important project behavior.',
    confidence: 0.8,
    tags: [],
    relatedFiles: [],
    relatedModules: [],
    createdAt: '2026-06-14T00:00:00.000Z',
    lastAccessedAt: '2026-06-14T00:00:00.000Z',
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

describe('Autocode memory runtime context formatting', () => {
  it('bounds memory context content and related file references', () => {
    const longContent = [
      'MEMORY_HEAD',
      'x'.repeat(AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS * 3),
      'MEMORY_TAIL_SHOULD_BE_PRESERVED',
    ].join(' ');
    const memories = Array.from({ length: 10 }, (_, index) => memory({
      id: `memory-${index}`,
      type: index % 2 === 0 ? 'gotcha' : 'decision',
      content: `${longContent} ${index}`,
      relatedFiles: [
        `src/${'deep/'.repeat(20)}one-tail-preserved.ts`,
        'src/two.ts',
        'src/three.ts',
        'src/four-should-be-omitted.ts',
      ],
    }));

    const formatted = formatAutocodeMemoryRuntimeContext(memories);

    expect(formatted.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS);
    expect(formatted).toContain('## Project Memory');
    expect(formatted).toContain('MEMORY_HEAD');
    expect(formatted).toContain('MEMORY_TAIL_SHOULD_BE_PRESERVED');
    expect(formatted).toContain('one-tail-preserved.ts');
    expect(formatted).toContain('src/two.ts');
    expect(formatted).toContain('src/three.ts');
    expect(formatted).toContain('...');
    expect(formatted.match(/src\/four-should-be-omitted\.ts/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(formatted.split('\n').filter((line) => line.startsWith('- [')).length).toBeLessThanOrEqual(6);
    expect(AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_LIMIT).toBe(3);
  });

  it('omits deprecated memories from runtime context', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({ id: 'old', content: 'DEPRECATED_MEMORY_SHOULD_NOT_APPEAR', deprecated: true }),
      memory({ id: 'new', content: 'Active memory should appear.' }),
    ]);

    expect(formatted).toContain('Active memory should appear.');
    expect(formatted).not.toContain('DEPRECATED_MEMORY_SHOULD_NOT_APPEAR');
  });

  it('does not repeat file references across runtime memory context lines', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'auth-gotcha',
        content: 'Refresh auth state before notifying renderer listeners.',
        confidence: 0.95,
        relatedFiles: ['src/auth/session-store.ts', 'src/auth/token-cache.ts'],
      }),
      memory({
        id: 'auth-decision',
        type: 'decision',
        content: 'Keep auth token refresh retries inside the session store boundary.',
        confidence: 0.94,
        relatedFiles: ['src/auth/session-store.ts', 'src/auth/retry-policy.ts'],
      }),
    ]);

    expect(formatted).toContain('Refresh auth state before notifying renderer listeners.');
    expect(formatted).toContain('Keep auth token refresh retries inside the session store boundary.');
    expect((formatted.match(/src\/auth\/session-store\.ts/g) ?? [])).toHaveLength(1);
    expect(formatted).toContain('src/auth/token-cache.ts');
    expect(formatted).toContain('src/auth/retry-policy.ts');
  });

  it('does not mark files as shown when a verbose memory is skipped by budget', () => {
    const fillers = Array.from({ length: 3 }, (_, index) => memory({
      id: `filler-${index}`,
      content: `FILLER_${index}_HEAD ${'implementation detail '.repeat(70)} FILLER_${index}_TAIL`,
      confidence: 0.99 - index * 0.01,
      relatedFiles: [
        `src/very/deep/filler-${index}/first-file-with-long-context-name.ts`,
        `src/very/deep/filler-${index}/second-file-with-long-context-name.ts`,
        `src/very/deep/filler-${index}/third-file-with-long-context-name.ts`,
      ],
    }));
    const formatted = formatAutocodeMemoryRuntimeContext([
      ...fillers,
      memory({
        id: 'verbose-skipped',
        content: `VERBOSE_SKIPPED ${'large note '.repeat(80)}`,
        confidence: 0.94,
        relatedFiles: ['src/auth/session-store.ts'],
      }),
      memory({
        id: 'short-included',
        content: 'SHORT_INCLUDED_MEMORY',
        confidence: 0.93,
        relatedFiles: ['src/auth/session-store.ts'],
      }),
    ]);

    expect(formatted).not.toContain('VERBOSE_SKIPPED');
    expect(formatted).toContain('SHORT_INCLUDED_MEMORY');
    expect(formatted).toContain('src/auth/session-store.ts');
  });

  it('selects trusted unique runtime memories instead of spending context on noisy entries', () => {
    const duplicateLesson = 'Use the packaged resources path when loading bundled prompts.';
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'low-confidence',
        content: 'LOW_CONFIDENCE_SHOULD_NOT_APPEAR',
        confidence: AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE - 0.01,
      }),
      memory({
        id: 'needs-review',
        content: 'NEEDS_REVIEW_SHOULD_NOT_APPEAR',
        needsReview: true,
        confidence: 0.95,
      }),
      memory({
        id: 'stale',
        content: 'STALE_SHOULD_NOT_APPEAR',
        staleAt: '2000-01-01T00:00:00.000Z',
        confidence: 0.95,
      }),
      memory({
        id: 'duplicate-low',
        content: duplicateLesson,
        confidence: 0.7,
      }),
      memory({
        id: 'duplicate-high',
        content: duplicateLesson,
        confidence: 0.95,
      }),
      memory({
        id: 'verified',
        content: 'VERIFIED_LOW_CONFIDENCE_SHOULD_APPEAR',
        confidence: 0.1,
        needsReview: true,
        userVerified: true,
      }),
      memory({
        id: 'pinned',
        content: 'PINNED_STALE_MEMORY_SHOULD_APPEAR',
        confidence: 0.1,
        staleAt: '2000-01-01T00:00:00.000Z',
        pinned: true,
      }),
    ]);

    expect(formatted).toContain(duplicateLesson);
    expect((formatted.match(/packaged resources path/g) ?? []).length).toBe(1);
    expect(formatted).toContain('VERIFIED_LOW_CONFIDENCE_SHOULD_APPEAR');
    expect(formatted).toContain('PINNED_STALE_MEMORY_SHOULD_APPEAR');
    expect(formatted).not.toContain('LOW_CONFIDENCE_SHOULD_NOT_APPEAR');
    expect(formatted).not.toContain('NEEDS_REVIEW_SHOULD_NOT_APPEAR');
    expect(formatted).not.toContain('STALE_SHOULD_NOT_APPEAR');
  });

  it('uses later concise memories when verbose candidates would waste the context budget', () => {
    const verboseMemories = Array.from({ length: 6 }, (_, index) => memory({
      id: `verbose-${index}`,
      content: `VERBOSE_MEMORY_${index} ${'long implementation note '.repeat(40)}`,
      confidence: 0.95,
      relatedFiles: [
        `src/very/long/path/${index}/first-file-that-adds-prompt-cost.ts`,
        `src/very/long/path/${index}/second-file-that-adds-prompt-cost.ts`,
        `src/very/long/path/${index}/third-file-that-adds-prompt-cost.ts`,
      ],
    }));

    const formatted = formatAutocodeMemoryRuntimeContext([
      ...verboseMemories,
      memory({
        id: 'concise-actionable',
        content: 'CONCISE_ACTIONABLE_MEMORY_SHOULD_APPEAR',
        confidence: 0.94,
      }),
    ]);

    expect(formatted.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS);
    expect(formatted).toContain('CONCISE_ACTIONABLE_MEMORY_SHOULD_APPEAR');
    expect(formatted.split('\n').filter((line) => line.startsWith('- [')).length).toBeLessThanOrEqual(6);
  });

  it('compacts tool result text while preserving diagnostic and tail output', () => {
    const compact = compactAutocodeMemoryRuntimeToolResult([
      'NOISE_HEAD',
      'noise '.repeat(300),
      'Error: build failed because module was missing',
      'tail '.repeat(300),
      'FINAL_EXIT_CODE_1_SHOULD_BE_PRESERVED',
    ].join(' '));
    const compactText = String(compact);

    expect(typeof compact).toBe('string');
    expect(compactText.length).toBeLessThanOrEqual(1_200);
    expect(compactText).toContain('NOISE_HEAD');
    expect(compactText).toContain('Error: build failed');
    expect(compactText).toContain('FINAL_EXIT_CODE_1_SHOULD_BE_PRESERVED');
  });

  it('compacts tool args and reasoning observations before runtime memory use', () => {
    const args = compactAutocodeMemoryRuntimeToolArgs({
      file_path: '/src/generated.ts',
      pattern: 'specific-auth-refresh-pattern'.repeat(20),
      command: `npm test ${'--workspace apps/desktop '.repeat(30)} FINAL_COMMAND_ARG_TAIL`,
      content: 'x'.repeat(5_000),
      old_string: 'old'.repeat(1_000),
      new_string: 'new'.repeat(1_000),
      unexpected_payload: 'should not be retained',
    });

    expect(args.file_path).toBe('/src/generated.ts');
    expect(args).not.toHaveProperty('content');
    expect(args).not.toHaveProperty('old_string');
    expect(args).not.toHaveProperty('new_string');
    expect(args).not.toHaveProperty('unexpected_payload');
    expect(String(args.pattern)).toHaveLength(240);
    expect(String(args.command)).toHaveLength(240);
    expect(String(args.command)).toContain('FINAL_COMMAND_ARG_TAIL');

    const reasoning = compactAutocodeMemoryRuntimeReasoningText([
      'thinking '.repeat(300),
      'Correction: this file is generated, so edit the source template instead.',
      'tail '.repeat(300),
      'FINAL_REASONING_TAIL',
    ].join(' '));

    expect(reasoning.length).toBeLessThanOrEqual(900);
    expect(reasoning).toContain('Correction: this file is generated');
    expect(reasoning).toContain('FINAL_REASONING_TAIL');
  });

  it('compacts stored work-unit outcome memory content and session insights', () => {
    const longSummary = [
      'SUMMARY_HEAD',
      'x'.repeat(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS * 3),
      'SUMMARY_TAIL_SHOULD_BE_PRESERVED',
    ].join(' ');
    const relatedFiles = Array.from(
      { length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT + 5 },
      (_, index) => `src/very/long/path/${index}/file-with-extra-context.ts`,
    );

    const entry = buildAutocodeWorkUnitOutcomeMemoryEntry({
      projectId: 'project-1',
      sessionId: 'session-1',
      workUnitId: '1.1',
      workUnitTitle: 'Compact memory storage',
      workUnitDescription: `DESCRIPTION_HEAD ${'description '.repeat(200)} DESCRIPTION_TAIL_SHOULD_BE_PRESERVED`,
      outcome: 'failure',
      summary: longSummary,
      error: `ERROR_HEAD ${'stack trace '.repeat(200)} ERROR_TAIL_SHOULD_BE_PRESERVED`,
      relatedFiles,
      completedAt: '2026-06-14T00:00:00.000Z',
    });
    const insight = buildAutocodeWorkUnitOutcomeSessionInsight({
      projectId: 'project-1',
      sessionId: 'session-1',
      workUnitId: '1.1',
      workUnitDescription: `DESCRIPTION_HEAD ${'description '.repeat(200)} DESCRIPTION_TAIL_SHOULD_BE_PRESERVED`,
      outcome: 'failure',
      summary: longSummary,
      error: `ERROR_HEAD ${'stack trace '.repeat(200)} ERROR_TAIL_SHOULD_BE_PRESERVED`,
      relatedFiles,
      completedAt: '2026-06-14T00:00:00.000Z',
    });

    expect(entry.content.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS);
    expect(entry.content).toContain('SUMMARY_HEAD');
    expect(entry.content).toContain('ERROR_TAIL_SHOULD_BE_PRESERVED');
    expect(entry.content).toContain('[middle omitted]');
    expect(entry.citationText?.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS);
    expect(entry.citationText).toContain('SUMMARY_TAIL_SHOULD_BE_PRESERVED');
    expect(entry.relatedFiles).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT);
    expect(insight.insights.join('\n')).toContain('SUMMARY_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.insights.join('\n')).toContain('ERROR_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.workUnit.description ?? '').toContain('DESCRIPTION_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.keyFiles).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT);
  });
});
