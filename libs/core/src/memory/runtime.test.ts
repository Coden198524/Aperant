import { describe, expect, it } from 'vitest';

import { estimateTokens } from './retrieval/context-packer.js';
import {
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_FILE_REF_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_TOKENS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_TOKENS,
  AUTOCODE_MEMORY_RUNTIME_CONTEXT_MIN_CONFIDENCE,
  AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT,
  AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS,
  AUTOCODE_MEMORY_RUNTIME_RECENT_TOOL_CALL_LIMIT,
  buildAutocodeWorkUnitOutcomeMemoryEntry,
  buildAutocodeWorkUnitOutcomeSessionInsight,
  compactAutocodeMemoryRuntimeInjectedMemoryIds,
  compactAutocodeMemoryRuntimeReasoningText,
  compactAutocodeMemoryRuntimeToolArgs,
  compactAutocodeMemoryRuntimeToolResult,
  formatAutocodeMemoryRuntimeContext,
  toAutocodeMemoryRuntimeRecentContext,
} from './runtime.js';
import type { Memory } from './types.js';

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

function renderedDuplicateRuntimeContent(uniqueLabel: string): string {
  const sharedHead = 'Use the shared auth retry guard before refreshing tokens. '.repeat(4);
  const uniqueMiddle = Array.from(
    { length: 90 },
    (_, index) => `${uniqueLabel.toLowerCase()}_${index}`,
  ).join(' ');
  const sharedTail = ' Verify expired-token retry before merging.'.repeat(4);
  return `${sharedHead}${uniqueMiddle}${sharedTail}`;
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

  it('keeps localized runtime context within the estimated token budget', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'localized-memory',
        content: [
          '本地化记忆开头',
          '这里是会显著增加 token 的中文上下文。'.repeat(AUTOCODE_MEMORY_RUNTIME_CONTEXT_ITEM_MAX_TOKENS * 3),
          '本地化记忆尾部应该保留',
        ].join(' '),
        confidence: 0.98,
        relatedFiles: [
          `src/${'深层目录/'.repeat(80)}localized-tail-preserved.ts`,
        ],
      }),
    ]);

    expect(formatted.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_CHARS);
    expect(estimateTokens(formatted)).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_CONTEXT_MAX_TOKENS);
    expect(formatted).toContain('本地化记忆开头');
    expect(formatted).toContain('本地化记忆尾部应该保留');
    expect(formatted).toContain('localized-tail-preserved.ts');
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
        relatedFiles: ['src\\auth\\session-store.ts', 'src/auth/token-cache.ts'],
      }),
      memory({
        id: 'auth-decision',
        type: 'decision',
        content: 'Keep auth token refresh retries inside the session store boundary.',
        confidence: 0.94,
        relatedFiles: ['./SRC/auth/session-store.ts/', 'src/auth/retry-policy.ts'],
      }),
    ]);

    expect(formatted).toContain('Refresh auth state before notifying renderer listeners.');
    expect(formatted).toContain('Keep auth token refresh retries inside the session store boundary.');
    expect((formatted.match(/src\/auth\/session-store\.ts/g) ?? [])).toHaveLength(1);
    expect(formatted).not.toContain('./SRC/auth/session-store.ts');
    expect(formatted).toContain('src/auth/token-cache.ts');
    expect(formatted).toContain('src/auth/retry-policy.ts');
  });

  it('reports memories omitted by the max item limit', () => {
    const formatted = formatAutocodeMemoryRuntimeContext(
      Array.from({ length: 8 }, (_, index) => memory({
        id: `limit-${index}`,
        content: `LIMITED_MEMORY_${index}`,
        confidence: 0.9 - index * 0.01,
      })),
      3,
    );

    expect(formatted.match(/- \[/g)).toHaveLength(3);
    expect(formatted).toContain('LIMITED_MEMORY_0');
    expect(formatted).toContain('LIMITED_MEMORY_2');
    expect(formatted).not.toContain('LIMITED_MEMORY_3');
    expect(formatted).toContain('5 more memory item(s) omitted');
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

  it('strips generic outcome noise from runtime project memory', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'outcome-with-noise',
        type: 'work_unit_outcome',
        content: [
          'Work unit s1 finished with outcome: success.',
          'Summary: Auth module narrowed memory lookup before editing.',
          'npm run typecheck passed.',
          'No issues found.',
          '\u4efb\u52a1\u5df2\u5b8c\u6210',
          'Duration: 1234ms',
          'Completed at: 2026-06-15T00:00:00.000Z',
        ].join('\n'),
        confidence: 0.95,
        relatedFiles: ['src/auth/session.ts'],
      }),
    ]);

    expect(formatted).toContain('[work_unit_outcome]');
    expect(formatted).toContain('Auth module narrowed memory lookup');
    expect(formatted).toContain('src/auth/session.ts');
    expect(formatted).not.toContain('Work unit s1 finished');
    expect(formatted).not.toContain('npm run typecheck passed');
    expect(formatted).not.toContain('No issues found');
    expect(formatted).not.toContain('\u4efb\u52a1\u5df2\u5b8c\u6210');
    expect(formatted).not.toContain('Duration: 1234ms');
    expect(formatted).not.toContain('Completed at:');
  });

  it('strips generic status lines from non-outcome runtime project memory', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'gotcha-with-noise',
        type: 'gotcha',
        content: [
          'npm run typecheck passed.',
          'Mock the OAuth clock before testing refresh retries.',
          'No issues found.',
          'Completed at: 2026-06-15T00:00:00.000Z',
        ].join('\n'),
        confidence: 0.95,
        relatedFiles: ['src/auth/session.ts'],
      }),
      memory({
        id: 'gotcha-status-only',
        type: 'gotcha',
        content: [
          'npm run typecheck passed.',
          'No issues found.',
          'Completed at: 2026-06-15T00:00:00.000Z',
        ].join('\n'),
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toContain('[gotcha]');
    expect(formatted).toContain('Mock the OAuth clock before testing refresh retries');
    expect(formatted).toContain('src/auth/session.ts');
    expect(formatted).not.toContain('npm run typecheck passed');
    expect(formatted).not.toContain('No issues found');
    expect(formatted).not.toContain('Completed at:');
    expect(formatted).not.toContain('gotcha-status-only');
  });

  it('omits outcome memories that only contain low-value runtime lines', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'empty-outcome',
        type: 'work_unit_outcome',
        content: [
          'Work unit s1 finished with outcome: success.',
          'npm run typecheck passed.',
          'No issues found.',
          'Completed at: 2026-06-15T00:00:00.000Z',
        ].join('\n'),
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toBe('');
  });

  it('omits machine-only runtime memories from project context', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'prefetch',
        type: 'prefetch_pattern',
        content: JSON.stringify({
          alwaysReadFiles: ['src/auth/session.ts'],
          frequentlyReadFiles: ['src/auth/token.ts'],
        }),
        confidence: 0.95,
      }),
      memory({
        id: 'context-cost',
        type: 'context_cost',
        content: 'High token usage per step - may need more focused approach.',
        confidence: 0.95,
      }),
      memory({
        id: 'visible',
        type: 'gotcha',
        content: 'Visible runtime gotcha remains available.',
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toContain('Visible runtime gotcha remains available.');
    expect(formatted).toContain('search_memory("files to read")');
    expect(formatted).toContain('search_memory("token cost")');
    expect(formatted).not.toContain('prefetch_pattern');
    expect(formatted).not.toContain('alwaysReadFiles');
    expect(formatted).not.toContain('src/auth/session.ts');
    expect(formatted).not.toContain('High token usage per step');
  });

  it('keeps prefetch_pattern memories discoverable without injecting their content by default', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'prefetch',
        type: 'prefetch_pattern',
        content: JSON.stringify({
          alwaysReadFiles: ['src/auth/session.ts'],
          frequentlyReadFiles: ['src/auth/token.ts'],
        }),
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toContain('## Project Memory');
    expect(formatted).toContain('search_memory("files to read")');
    expect(formatted).not.toContain('alwaysReadFiles');
    expect(formatted).not.toContain('src/auth/session.ts');
  });

  it('does not advertise low-quality prefetch_pattern memories in runtime context', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'prefetch-low-confidence',
        type: 'prefetch_pattern',
        content: JSON.stringify({
          alwaysReadFiles: ['LOW_CONFIDENCE_PREFETCH_SHOULD_NOT_APPEAR.ts'],
        }),
        confidence: 0.1,
      }),
    ]);

    expect(formatted).toBe('');
  });

  it('keeps context_cost memories discoverable without injecting their content by default', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'context-cost',
        type: 'context_cost',
        content: 'Context token spike: prompt reached 24k tokens; narrow broad file rereads.',
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toContain('## Project Memory');
    expect(formatted).toContain('search_memory("token cost")');
    expect(formatted).not.toContain('Context token spike');
  });

  it('does not advertise low-quality context_cost memories in runtime context', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'context-cost-low-confidence',
        type: 'context_cost',
        content: 'LOW_CONFIDENCE_CONTEXT_COST_SHOULD_NOT_APPEAR',
        confidence: 0.1,
      }),
    ]);

    expect(formatted).toBe('');
  });

  it('respects maxItems zero when machine-only memories are present', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'prefetch',
        type: 'prefetch_pattern',
        content: JSON.stringify({
          alwaysReadFiles: ['src/auth/session.ts'],
        }),
        confidence: 0.95,
      }),
      memory({
        id: 'context-cost',
        type: 'context_cost',
        content: 'Context token spike: prompt reached 24k tokens; narrow broad file rereads.',
        confidence: 0.95,
      }),
    ], 0);

    expect(formatted).toBe('');
  });

  it('deduplicates runtime memories by their compact rendered content', () => {
    const formatted = formatAutocodeMemoryRuntimeContext([
      memory({
        id: 'render-low',
        content: renderedDuplicateRuntimeContent('LOWER'),
        confidence: 0.7,
      }),
      memory({
        id: 'render-high',
        content: renderedDuplicateRuntimeContent('HIGHER'),
        confidence: 0.95,
      }),
    ]);

    expect(formatted).toContain('Use the shared auth retry guard');
    expect(formatted).toContain('Verify expired-token retry');
    expect((formatted.match(/\[middle omitted\]/g) ?? [])).toHaveLength(1);
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

  it('strips low-value tool result text before runtime memory observation', () => {
    const compactText = compactAutocodeMemoryRuntimeToolResult([
      'npm run typecheck passed.',
      'Retry the import scan with --runInBand when the sqlite watcher holds the lock.',
      'No issues found.',
      'Completed at: 2026-06-15T00:00:00.000Z',
    ].join('\n'));

    expect(compactText).toBe(
      'Retry the import scan with --runInBand when the sqlite watcher holds the lock.',
    );

    const compactObject = compactAutocodeMemoryRuntimeToolResult({
      status: 'success',
      summary: [
        'No issues found.',
        'Project scoped cache warmup must include the workspace id.',
        'Completed at: 2026-06-15T00:00:00.000Z',
      ].join('\n'),
    }) as Record<string, unknown>;

    expect(compactObject.status).toBe('success');
    expect(compactObject.summary).toBe(
      'Project scoped cache warmup must include the workspace id.',
    );

    const compactArray = compactAutocodeMemoryRuntimeToolResult([
      'No issues found.',
      'Use stable worker request IDs when retrying memory searches.',
    ]) as { type: string; length: number; items: unknown[] };

    expect(compactArray).toEqual({
      type: 'array',
      length: 2,
      items: ['Use stable worker request IDs when retrying memory searches.'],
    });
  });

  it('compacts object tool results without letting omitted bulk fields crowd diagnostics', () => {
    const compact = compactAutocodeMemoryRuntimeToolResult({
      content: 'x'.repeat(5_000),
      stdout: 'stdout '.repeat(500),
      stderr: [
        'stderr '.repeat(500),
        'Error: stderr dependency resolution failed',
        'tail '.repeat(80),
        'FINAL_STDERR_TAIL',
      ].join(' '),
      output: 'output '.repeat(500),
      data: { huge: 'payload '.repeat(500) },
      text: 'text '.repeat(500),
      ...Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`detail${index}`, `detail-${index}`]),
      ),
      exitCode: 1,
      status: 'failed',
      error: `Error: build failed ${'because dependency resolution failed '.repeat(40)}FINAL_ERROR_TAIL`,
    }) as Record<string, unknown>;

    expect(Object.keys(compact).length).toBeLessThanOrEqual(12);
    expect(compact.omittedKeys).toEqual(['content', 'stdout', 'stderr', 'output', 'data', 'text']);
    expect(String(compact.diagnosticText)).toContain('stderr:');
    expect(String(compact.diagnosticText)).toContain('Error: stderr dependency resolution failed');
    expect(String(compact.diagnosticText)).toContain('FINAL_STDERR_TAIL');
    expect(String(compact.diagnosticText).length).toBeLessThanOrEqual(360);
    expect(compact).not.toHaveProperty('stdout');
    expect(compact).not.toHaveProperty('stderr');
    expect(compact.exitCode).toBe(1);
    expect(compact.status).toBe('failed');
    expect(String(compact.error)).toContain('Error: build failed');
    expect(String(compact.error)).toContain('FINAL_ERROR_TAIL');
  });

  it('treats camelCase output fields as compact omitted diagnostics', () => {
    const compact = compactAutocodeMemoryRuntimeToolResult({
      stdOut: 'stdout noise '.repeat(500),
      stdErr: [
        'stderr noise '.repeat(500),
        'Error: renderer preload build failed',
        'tail '.repeat(80),
        'FINAL_STDERR_TAIL',
      ].join(' '),
      exitCode: 1,
      status: 'failed',
    }) as Record<string, unknown>;

    expect(compact.omittedKeys).toEqual(['stdout', 'stderr']);
    expect(compact).not.toHaveProperty('stdOut');
    expect(compact).not.toHaveProperty('stdErr');
    expect(compact.exitCode).toBe(1);
    expect(compact.status).toBe('failed');
    expect(String(compact.diagnosticText)).toContain('stderr:');
    expect(String(compact.diagnosticText)).toContain('Error: renderer preload build failed');
    expect(String(compact.diagnosticText)).toContain('FINAL_STDERR_TAIL');
    expect(String(compact.diagnosticText).length).toBeLessThanOrEqual(360);
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

  it('compacts injected memory ids for runtime recent context', () => {
    const compactIds = compactAutocodeMemoryRuntimeInjectedMemoryIds([
      '',
      ' existing-id ',
      'x'.repeat(200),
      ...Array.from({ length: 130 }, (_, index) => `memory-${index}`),
    ]);
    const context = toAutocodeMemoryRuntimeRecentContext({
      toolCalls: Array.from({ length: 8 }, (_, index) => ({
        toolName: index % 2 === 0 ? 'Grep' : 'Write',
        args: {
          pattern: `pattern-${index}`,
          file_path: `/src/generated-${index}.ts`,
          content: 'x'.repeat(5_000),
          command: `npm test ${'--workspace apps/desktop '.repeat(30)}TAIL-${index}`,
        },
      })),
      injectedMemoryIds: [
        ' ',
        ' existing-id ',
        ...Array.from({ length: 130 }, (_, index) => `memory-${index}`),
      ],
    });

    expect(compactIds).toHaveLength(AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_LIMIT);
    expect(compactIds).not.toContain('existing-id');
    expect(compactIds).not.toContain('memory-0');
    expect(compactIds).toContain('memory-2');
    expect(compactIds).toContain('memory-129');
    expect(context.injectedMemoryIds.size).toBe(AUTOCODE_MEMORY_RUNTIME_INJECTED_MEMORY_ID_LIMIT);
    expect(context.injectedMemoryIds.has('memory-129')).toBe(true);
    expect(context.toolCalls).toHaveLength(AUTOCODE_MEMORY_RUNTIME_RECENT_TOOL_CALL_LIMIT);
    expect(context.toolCalls[0].args.pattern).toBe('pattern-3');
    expect(context.toolCalls[0].args).not.toHaveProperty('content');
    expect(String(context.toolCalls[0].args.command)).toHaveLength(240);
  });

  it('compacts stored work-unit outcome memory content and session insights', () => {
    const longSummary = [
      'SUMMARY_HEAD',
      'x'.repeat(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS * 3),
      'SUMMARY_TAIL_SHOULD_BE_PRESERVED',
    ].join(' ');
    const relatedFiles = Array.from(
      { length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT + 5 },
      (_, index) => `src/${'very/long/path/'.repeat(20)}${index}/file-with-extra-context.ts`,
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

    const entryRelatedFiles = entry.relatedFiles ?? [];

    expect(entry.content.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_OUTCOME_CONTENT_MAX_CHARS);
    expect(entry.content).toContain('SUMMARY_HEAD');
    expect(entry.content).toContain('ERROR_TAIL_SHOULD_BE_PRESERVED');
    expect(entry.content).toContain('[middle omitted]');
    expect(entry.content).not.toContain('finished with outcome');
    expect(entry.content).not.toContain('Duration:');
    expect(entry.content).not.toContain('Completed at:');
    expect(entry.citationText?.length).toBeLessThanOrEqual(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FIELD_MAX_CHARS);
    expect(entry.citationText).toContain('SUMMARY_TAIL_SHOULD_BE_PRESERVED');
    expect(entryRelatedFiles).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT);
    expect(entryRelatedFiles.every((file) => file.length <= AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_MAX_CHARS)).toBe(true);
    expect(entryRelatedFiles.every((file) => !file.includes('[middle omitted]'))).toBe(true);
    expect(entryRelatedFiles[0]).toContain('file-with-extra-context.ts');
    expect(insight.insights.join('\n')).toContain('SUMMARY_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.insights.join('\n')).toContain('ERROR_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.workUnit.description ?? '').toContain('DESCRIPTION_TAIL_SHOULD_BE_PRESERVED');
    expect(insight.keyFiles).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_FILE_REF_LIMIT);
    expect(insight.keyFiles.every((file) => !file.includes('[middle omitted]'))).toBe(true);
  });

  it('deduplicates equivalent work-unit outcome metadata before spending budgets', () => {
    const input = {
      projectId: 'project-1',
      sessionId: 'session-1',
      workUnitId: '1.1',
      outcome: 'success' as const,
      relatedFiles: [
        'src\\auth\\token.ts',
        './SRC/auth/token.ts/',
        'src/auth/retry-policy.ts',
      ],
      relatedModules: [' auth ', 'AUTH', 'billing'],
      tags: [' custom-tag ', 'CUSTOM-TAG'],
      upstreamTaskIds: [' task-1 ', 'TASK-1', 'task-2'],
      completedAt: '2026-06-14T00:00:00.000Z',
    };

    const entry = buildAutocodeWorkUnitOutcomeMemoryEntry(input);
    const insight = buildAutocodeWorkUnitOutcomeSessionInsight(input);
    const entryTags = entry.tags ?? [];

    expect(entry.relatedFiles).toEqual([
      'src/auth/token.ts',
      'src/auth/retry-policy.ts',
    ]);
    expect(entry.relatedModules).toEqual(['auth', 'billing']);
    expect(entryTags.filter((tag) => tag.toLowerCase() === 'custom-tag')).toHaveLength(1);
    expect(entryTags).toContain('upstream:task-1');
    expect(entryTags).not.toContain('upstream:TASK-1');
    expect(insight.keyFiles).toEqual([
      'src/auth/token.ts',
      'src/auth/retry-policy.ts',
    ]);
    expect(insight.workUnit.upstreamTaskIds).toEqual(['task-1', 'task-2']);
  });

  it('bounds work-unit outcome tags, modules, and upstream task ids', () => {
    const entry = buildAutocodeWorkUnitOutcomeMemoryEntry({
      projectId: 'project-1',
      sessionId: 'session-1',
      workUnitId: '1.2',
      outcome: 'success',
      tags: [
        'custom-tag',
        ...Array.from({ length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_LIMIT + 10 }, (_, index) =>
          `tag-${index}-${'verbose-tag-detail-'.repeat(8)}TAIL`),
      ],
      relatedModules: Array.from(
        { length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_LIMIT + 4 },
        (_, index) => `module-${index}-${'nested-module-context-'.repeat(8)}TAIL`,
      ),
      upstreamTaskIds: Array.from(
        { length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT + 4 },
        (_, index) => `upstream-${index}-${'verbose-upstream-context-'.repeat(8)}TAIL`,
      ),
      completedAt: '2026-06-14T00:00:00.000Z',
    });
    const insight = buildAutocodeWorkUnitOutcomeSessionInsight({
      projectId: 'project-1',
      sessionId: 'session-1',
      workUnitId: '1.2',
      outcome: 'success',
      upstreamTaskIds: Array.from(
        { length: AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT + 4 },
        (_, index) => `upstream-${index}-${'verbose-upstream-context-'.repeat(8)}TAIL`,
      ),
      completedAt: '2026-06-14T00:00:00.000Z',
    });

    const entryTags = entry.tags ?? [];
    const entryRelatedModules = entry.relatedModules ?? [];

    expect(entryTags).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_LIMIT);
    expect(entryTags.every((tag) => tag.length <= AUTOCODE_MEMORY_RUNTIME_OUTCOME_TAG_MAX_CHARS)).toBe(true);
    expect(entryTags).toContain('work_unit');
    expect(entryTags).toContain('success');
    expect(entryTags).toContain('custom-tag');
    expect(entryRelatedModules).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_LIMIT);
    expect(entryRelatedModules.every((module) =>
      module.length <= AUTOCODE_MEMORY_RUNTIME_OUTCOME_RELATED_MODULE_MAX_CHARS)).toBe(true);
    expect(entryRelatedModules[0]).toContain('TAIL');
    expect(insight.workUnit.upstreamTaskIds).toHaveLength(AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_LIMIT);
    expect(insight.workUnit.upstreamTaskIds.every((taskId) =>
      taskId.length <= AUTOCODE_MEMORY_RUNTIME_OUTCOME_UPSTREAM_TASK_MAX_CHARS)).toBe(true);
    expect(insight.workUnit.upstreamTaskIds[0]).toContain('TAIL');
  });
});
