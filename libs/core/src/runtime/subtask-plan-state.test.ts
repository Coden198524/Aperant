import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_SESSION_RESULT_SUMMARY_MAX_CHARS,
  extractAutocodeCompletionSummaryTable,
  summarizeAutocodeSessionResult,
} from './subtask-plan-state.js';

describe('Autocode subtask plan state summaries', () => {
  it('limits plain assistant completion summaries before they enter runtime state', () => {
    const content = [
      'Summary start',
      'important implementation and verification context '.repeat(120),
      'Summary tail should survive',
    ].join(' ');

    const summary = summarizeAutocodeSessionResult({
      messages: [{ role: 'assistant', content }],
      outcome: 'completed',
    });

    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThanOrEqual(AUTOCODE_SESSION_RESULT_SUMMARY_MAX_CHARS);
    expect(summary).toContain('Summary start');
    expect(summary).toContain('middle omitted');
    expect(summary).toContain('Summary tail should survive');
  });

  it('folds repeated plain assistant summary lines before runtime state', () => {
    const repeatedLine = 'SUBTASK SUMMARY REPEAT: same verification log line without new signal.';
    const content = [
      'SUBTASK SUMMARY HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'SUBTASK SUMMARY TAIL',
    ].join('\n');

    const summary = summarizeAutocodeSessionResult({
      messages: [{ role: 'assistant', content }],
      outcome: 'completed',
    });

    expect(summary).toContain('SUBTASK SUMMARY HEAD');
    expect(summary).toContain('SUBTASK SUMMARY TAIL');
    expect(summary).toContain('119 repeated line(s) omitted for prompt budget');
    expect((summary?.match(/SUBTASK SUMMARY REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('compacts long completion summary tables while preserving review rows', () => {
    const longDetails = `${'implementation detail '.repeat(80)}final table tail`;
    const content = [
      'Done.',
      '| Item | Details |',
      '| --- | --- |',
      `| What changed | ${longDetails} |`,
      '| Verification | npm test -- focused.test.ts |',
      `| Review notes | ${longDetails} |`,
    ].join('\n');

    const summary = summarizeAutocodeSessionResult({
      messages: [{ role: 'assistant', content }],
      outcome: 'completed',
    });

    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThanOrEqual(AUTOCODE_SESSION_RESULT_SUMMARY_MAX_CHARS);
    expect(summary).toContain('| Item | Details |');
    expect(summary).toContain('| What changed |');
    expect(summary).toContain('| Verification |');
    expect(summary).toContain('| Review notes |');
    expect(summary).toContain('final table tail');
  });

  it('recognizes localized completion summary tables', () => {
    const summary = extractAutocodeCompletionSummaryTable([
      '完成。',
      '| 项目 | 详情 |',
      '| --- | --- |',
      '| 变更内容 | 已完成运行时摘要压缩。 |',
      '| 验证 | npx vitest run subtask-plan-state.test.ts |',
    ].join('\n'));

    expect(summary).toContain('| 项目 | 详情 |');
    expect(summary).toContain('| 变更内容 |');
  });
});
