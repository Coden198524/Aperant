import { describe, expect, it } from 'vitest';

import {
  analyzeAutocodeFailureAndRecover,
  expandAutocodeContextStrategy,
  formatAutocodeFailureAnalysis,
  formatAutocodeRecoverySummary,
  seekAutocodeHelpStrategy,
  type AutocodeFailureRecord,
} from './agent-context-recovery.js';

function makeFailure(overrides: Partial<AutocodeFailureRecord> = {}): AutocodeFailureRecord {
  return {
    attempt: 1,
    outcome: 'error',
    error: 'Unknown failure',
    timestamp: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent context recovery prompt formatting', () => {
  it('truncates long unknown failure errors before formatting recovery prompts', async () => {
    const longError = `Unexpected opaque failure ${'verbose diagnostic '.repeat(120)}RECOVERY_ERROR_TAIL_MUST_REMAIN`;
    const analysis = await analyzeAutocodeFailureAndRecover(
      {
        id: '1.1',
        description: `Update settings persistence ${'with extra context '.repeat(80)}RECOVERY_DESCRIPTION_TAIL_MUST_REMAIN`,
      },
      [makeFailure({ error: longError })],
    );

    const prompt = formatAutocodeFailureAnalysis(analysis);
    const summary = formatAutocodeRecoverySummary(analysis);

    expect(prompt).toContain('Unknown failure cause');
    expect(prompt).toContain('recovery middle omitted');
    expect(prompt).toContain('RECOVERY_ERROR_TAIL_MUST_REMAIN');
    expect(summary).toContain('recovery middle omitted');
    expect(summary).toContain('RECOVERY_ERROR_TAIL_MUST_REMAIN');
    expect(prompt.length).toBeLessThan(2600);
  });

  it('preserves tail constraints from long missing-context task descriptions', async () => {
    const analysis = await analyzeAutocodeFailureAndRecover(
      {
        id: '1.2',
        description: `Update settings persistence ${'with extra context '.repeat(80)}DESC_TAIL_OK`,
      },
      [makeFailure({ error: 'Cannot find settings repository helper' })],
    );

    const prompt = formatAutocodeFailureAnalysis(analysis);
    const summary = formatAutocodeRecoverySummary(analysis);

    expect(analysis.pattern).toBe('missing_context');
    expect(prompt).toContain('DESC_TAIL_OK');
    expect(summary).toContain('DESC_TAIL_OK');
    expect(prompt).toContain('recovery middle omitted');
    expect(prompt.length).toBeLessThan(2600);
  });

  it('limits recovery file lists in expanded context prompts', () => {
    const strategy = expandAutocodeContextStrategy({
      description: 'Update many files',
      filesToModify: Array.from({ length: 20 }, (_, index) => `src/feature-${index}/${'nested/'.repeat(10)}component.ts`),
    });
    const prompt = formatAutocodeFailureAnalysis({
      pattern: 'missing_context',
      rootCause: 'Missing context',
      strategy,
      alternatives: [],
    });

    expect(strategy.additionalFiles?.length).toBeLessThanOrEqual(13);
    expect(prompt).toContain('... ');
    expect(prompt).toContain('more');
    expect(prompt.length).toBeLessThan(2600);
  });

  it('keeps seek-help failure history compact', () => {
    const strategy = seekAutocodeHelpStrategy(
      {
        id: '2.1',
        description: `Difficult task ${'detail '.repeat(100)}HELP_DESCRIPTION_TAIL_MUST_REMAIN`,
      },
      Array.from({ length: 6 }, (_, index) => makeFailure({
        attempt: index + 1,
        error: `Failure ${index + 1} ${'stack frame '.repeat(80)}HISTORY_TAIL_MUST_REMAIN_${index + 1}`,
      })),
    );
    const prompt = formatAutocodeFailureAnalysis({
      pattern: 'tool_error',
      rootCause: 'Tool failure',
      strategy,
      alternatives: [],
    });

    expect(prompt).toContain('3 earlier attempt(s) omitted');
    expect(prompt).toContain('attempt 6 error');
    expect(prompt).toContain('recovery middle omitted');
    expect(prompt).toContain('HELP_DESCRIPTION_TAIL_MUST_REMAIN');
    expect(prompt).not.toContain('HISTORY_TAIL_MUST_REMAIN_1');
    expect(prompt).toContain('HISTORY_TAIL_MUST_REMAIN_6');
    expect(prompt.length).toBeLessThan(2600);
  });
});
