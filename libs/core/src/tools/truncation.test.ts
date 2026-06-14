import { describe, expect, it } from 'vitest';

import {
  TOOL_OUTPUT_MAX_LINES,
  buildToolOutputTruncationContent,
  planToolOutputTruncation,
} from './truncation.js';

describe('tool output truncation planning', () => {
  it('keeps head and tail lines when line count exceeds the preview budget', () => {
    const output = Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n');

    const plan = planToolOutputTruncation(output, 'Read', 10_000, 6);

    expect(plan.wasTruncated).toBe(true);
    expect(plan.displayedLineCount).toBe(6);
    expect(plan.content).toContain('line-0');
    expect(plan.content).toContain('line-11');
    expect(plan.content).toContain('line(s) omitted');
    expect(plan.content).not.toContain('line-7');
  });

  it('uses a compact default preview line budget while preserving head and tail', () => {
    const output = Array.from(
      { length: TOOL_OUTPUT_MAX_LINES + 100 },
      (_, index) => `line-${index}`,
    ).join('\n');

    const plan = planToolOutputTruncation(output, 'Grep');

    expect(plan.wasTruncated).toBe(true);
    expect(plan.displayedLineCount).toBe(TOOL_OUTPUT_MAX_LINES);
    expect(plan.content).toContain('line-0');
    expect(plan.content).toContain(`line-${TOOL_OUTPUT_MAX_LINES + 99}`);
    expect(plan.content).toContain('line(s) omitted');
    expect(plan.content).not.toContain('line-600');
  });

  it('keeps tail failure details while respecting byte budget', () => {
    const output = [
      'BEGIN_TOOL_OUTPUT',
      ...Array.from({ length: 120 }, (_, index) => `verbose middle line ${index} ${'details '.repeat(8)}`),
      'FINAL_TOOL_FAILURE_SENTINEL',
    ].join('\n');

    const plan = planToolOutputTruncation(output, 'Bash', 520, 2_000);

    expect(plan.wasTruncated).toBe(true);
    expect(Buffer.byteLength(plan.content, 'utf-8')).toBeLessThanOrEqual(520);
    expect(plan.content).toContain('BEGIN_TOOL_OUTPUT');
    expect(plan.content).toContain('FINAL_TOOL_FAILURE_SENTINEL');
    expect(plan.content).toContain('Output middle omitted for byte budget');
  });

  it('describes truncated previews as head and tail snippets', () => {
    const output = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n');
    const plan = planToolOutputTruncation(output, 'Grep', 10_000, 4);

    const content = buildToolOutputTruncationContent(plan, {
      spilloverPath: '/tmp/full-output.txt',
    });

    expect(content).toContain('showing 4 preview lines from head/tail');
    expect(content).toContain('[Full output saved to: /tmp/full-output.txt]');
  });
});
