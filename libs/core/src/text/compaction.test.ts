import { describe, expect, it } from 'vitest';

import {
  compactAutocodeRetryLine,
  compactAutocodeRetryText,
  formatAutocodeRetryErrorLines,
} from './compaction.js';

describe('Autocode retry text compaction', () => {
  it('keeps the tail of long retry text for actionable parser errors', () => {
    const compacted = compactAutocodeRetryText(
      [
        'JSON repair failed near the beginning.',
        'middle context '.repeat(120),
        'FINAL_JSON_PARSE_ERROR_AT_LINE_88_COLUMN_13',
      ].join('\n'),
      240,
    );

    expect(compacted).toContain('JSON repair failed');
    expect(compacted).toContain('[truncated middle');
    expect(compacted).toContain('FINAL_JSON_PARSE_ERROR_AT_LINE_88_COLUMN_13');
    expect(compacted.length).toBeLessThanOrEqual(240);
  });

  it('keeps the tail of single-line retry errors', () => {
    const compacted = compactAutocodeRetryLine(
      `At "phases.0.subtasks.0.description": ${'nested schema detail '.repeat(40)} FINAL_REQUIRED_FIELD_MISSING`,
      180,
    );

    expect(compacted).toContain('At "phases.0.subtasks.0.description"');
    expect(compacted).toContain('[truncated middle');
    expect(compacted).toContain('FINAL_REQUIRED_FIELD_MISSING');
    expect(compacted.length).toBeLessThanOrEqual(180);
  });

  it('keeps actionable tails in compact retry error lists', () => {
    const lines = formatAutocodeRetryErrorLines(
      Array.from(
        { length: 3 },
        (_, index) => `error ${index}: ${'verbose details '.repeat(35)} TAIL_${index}`,
      ),
      { maxErrors: 2, maxCharsPerError: 150 },
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('TAIL_0');
    expect(lines[1]).toContain('TAIL_1');
    expect(lines[2]).toContain('1 more error(s) omitted');
  });
});
