import { describe, expect, it } from 'vitest';

import { MAX_READ_LINE_LENGTH, formatWithLineNumbers } from './read.js';

describe('read output formatting', () => {
  it('compacts long single lines with head and tail context', () => {
    const result = formatWithLineNumbers(
      `HEAD_${'head_'.repeat(260)}MIDDLE_SHOULD_BE_OMITTED${'tail_'.repeat(260)}TAIL_SENTINEL`,
      0,
    );

    expect(result).toMatch(/^\s*1\tHEAD_/);
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result).not.toContain('MIDDLE_SHOULD_BE_OMITTED');
    expect(result.split('\t')[1].length).toBeLessThanOrEqual(MAX_READ_LINE_LENGTH);
  });
});
