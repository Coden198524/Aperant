import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS,
  AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS,
  buildAutocodeDirectCompletionSummary,
  extractAutocodeDirectTaskDescription,
  inferAutocodeDirectValidationEvidence,
  isAutocodeSuccessfulDirectOutcome,
} from './direct-task-summary.js';

describe('direct task summary helpers', () => {
  it('does not treat context window exhaustion as Direct completion', () => {
    expect(isAutocodeSuccessfulDirectOutcome({
      outcome: 'context_window',
      stepsExecuted: 12,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      durationMs: 1,
      toolCallCount: 0,
    })).toBe(false);
    expect(isAutocodeSuccessfulDirectOutcome({
      outcome: 'completed',
      stepsExecuted: 12,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      durationMs: 1,
      toolCallCount: 0,
    })).toBe(true);
  });

  it('infers reported Direct validation results from the final response', () => {
    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: '| Verification | npm test -- direct-task-summary.test.ts passed |' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: npm test failed with 2 assertion errors.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_failed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'What changed: answered the question directly.' }],
      durationMs: 1,
      toolCallCount: 0,
    })).toMatchObject({ status: 'not_run' });
  });

  it('keeps both ends of oversized direct task descriptions', () => {
    const longTask = [
      'Opening direct rule: keep configuration tables as JSON.',
      ...Array.from(
        { length: 180 },
        (_, index) => `Large direct task context ${index}: ${'diagnostic noise '.repeat(8)}`,
      ),
      'Closing direct rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    const description = extractAutocodeDirectTaskDescription({
      initialMessages: [{ content: longTask }],
      specDir: 'E:/repo/.autocode/specs/001-task',
    });

    expect(description).toContain('Opening direct rule: keep configuration tables as JSON.');
    expect(description).toContain('direct task middle omitted for summary budget');
    expect(description).toContain('Closing direct rule: convert only model-readable prose references to Markdown.');
    expect(description).not.toContain('Large direct task context 120');
    expect(description.length).toBeLessThanOrEqual(AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS);
  });

  it('folds repeated direct task description lines before storing summaries', () => {
    const repeatedLine = 'DIRECT TASK REPEAT: same setup instruction without new signal.';
    const description = extractAutocodeDirectTaskDescription({
      initialMessages: [{
        content: [
          'DIRECT TASK HEAD',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'DIRECT TASK TAIL',
        ].join('\n'),
      }],
      specDir: 'E:/repo/.autocode/specs/001-task',
    });

    expect(description).toContain('DIRECT TASK HEAD');
    expect(description).toContain('DIRECT TASK TAIL');
    expect(description).toContain('119 repeated line(s) omitted for prompt budget');
    expect((description.match(/DIRECT TASK REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('falls back to the spec directory name when no initial task message exists', () => {
    expect(extractAutocodeDirectTaskDescription({
      initialMessages: [],
      specDir: 'E:/repo/.autocode/specs/001-task',
    })).toBe('Direct model execution for 001-task');
  });

  it('keeps both ends of oversized direct completion summaries', () => {
    const longFinal = [
      'Opening final summary: implemented focused direct change.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large final response context ${index}: ${'verbose verification log '.repeat(6)}`,
      ),
      'Closing final summary: verification passed and review notes remain visible.',
    ].join('\n');

    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'completed',
        stepsExecuted: 1,
        toolCallCount: 1,
        durationMs: 1,
        messages: [{ role: 'assistant', content: longFinal }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(summary).toContain('Opening final summary: implemented focused direct change.');
    expect(summary).toContain('direct final response middle omitted for summary budget');
    expect(summary).toContain('Closing final summary: verification passed and review notes remain visible.');
    expect(summary).not.toContain('Large final response context 160');
    expect(summary).toContain('| Item | Details |');
    expect(summary).toContain('Tokens: 2 total (1 prompt, 1 completion)');
    expect(summary.length).toBeLessThan(AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS + 1_000);
  });

  it('folds repeated direct completion summary lines before appending quality details', () => {
    const repeatedLine = 'DIRECT FINAL REPEAT: same verification detail without new signal.';
    const finalText = [
      'DIRECT FINAL HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'DIRECT FINAL TAIL',
    ].join('\n');

    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'completed',
        stepsExecuted: 1,
        toolCallCount: 1,
        durationMs: 1,
        messages: [{ role: 'assistant', content: finalText }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(summary).toContain('DIRECT FINAL HEAD');
    expect(summary).toContain('DIRECT FINAL TAIL');
    expect(summary).toContain('119 repeated line(s) omitted for prompt budget');
    expect((summary.match(/DIRECT FINAL REPEAT/g) ?? [])).toHaveLength(1);
    expect(summary).toContain('| Item | Details |');
  });

  it('includes compact token usage in fallback direct completion summaries', () => {
    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'error',
        stepsExecuted: 2,
        toolCallCount: 3,
        durationMs: 1,
        messages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: true },
        error: { code: 'generic_error', message: 'failed', retryable: false },
      },
    });

    expect(summary).toContain('| Verification |');
    expect(summary).toContain('Session outcome: error. Steps: 2. Tools: 3.');
    expect(summary).toContain('Tokens: 15 total (10 prompt, 5 completion, estimated).');
  });
});
