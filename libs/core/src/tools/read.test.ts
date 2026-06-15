import { describe, expect, it } from 'vitest';

import { formatReadContent, formatWithLineNumbers, MAX_READ_LINE_LENGTH } from './read.js';

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

  it('reports an empty requested range instead of emitting a phantom line', () => {
    const result = formatReadContent('line1\nline2\nline3', 99, 5);

    expect(result).toBe("[No lines in requested range: offset 99 is beyond the file's 3 total lines.]");
    expect(result).not.toContain('\t');
  });

  it('reports zero line limits explicitly', () => {
    const result = formatReadContent('line1\nline2\nline3', 0, 0);

    expect(result).toBe('[No lines requested: limit must be greater than 0. File has 3 total lines.]');
    expect(result).not.toContain('\t');
  });

  it('clamps negative offsets to the beginning of the file', () => {
    const result = formatReadContent('line1\nline2\nline3', -10, 2);

    expect(result).toContain('1\tline1');
    expect(result).toContain('2\tline2');
    expect(result).toContain('Showing lines 1-2 of 3 total lines');
  });
});
