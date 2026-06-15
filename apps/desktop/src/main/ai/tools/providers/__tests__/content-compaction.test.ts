import { describe, expect, it } from 'vitest';

import {
  BROWSE_CONTENT_MAX_LINE_LENGTH,
  compactBrowseContent,
} from '../content-compaction';

describe('browse content compaction', () => {
  it('folds consecutive repeated non-empty lines before returning content', () => {
    const content = [
      'Intro',
      ...Array.from({ length: 8 }, () => 'Repeated navigation item'),
      'Body',
    ].join('\n');

    const result = compactBrowseContent(content);

    expect(result).toContain('Intro');
    expect(result).toContain('Repeated navigation item');
    expect(result).toContain('[... 7 repeated content line(s) omitted ...]');
    expect(result).toContain('Body');
    expect(result.match(/Repeated navigation item/g)).toHaveLength(1);
    expect(result.length).toBeLessThan(content.length);
  });

  it('compacts very long single lines while preserving head and tail context', () => {
    const result = compactBrowseContent(
      `HEAD_${'middle_'.repeat(300)}TAIL_SENTINEL`,
    );

    expect(result).toContain('HEAD_');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result.length).toBeLessThanOrEqual(BROWSE_CONTENT_MAX_LINE_LENGTH);
  });

  it('collapses excessive blank lines without removing section boundaries', () => {
    const result = compactBrowseContent('Heading\n\n\n\n\nBody\n\n\nTail');

    expect(result).toBe('Heading\n\nBody\n\nTail');
  });

  it('still preserves head and tail when total content exceeds the budget', () => {
    const content = [
      'CONTENT_HEAD',
      ...Array.from({ length: 200 }, (_, index) => `Line ${index} ${'x'.repeat(80)}`),
      'CONTENT_TAIL',
    ].join('\n');

    const result = compactBrowseContent(content, 800);

    expect(result).toContain('CONTENT_HEAD');
    expect(result).toContain('CONTENT_TAIL');
    expect(result).toContain('[Content middle omitted for context budget]');
    expect(result.length).toBeLessThan(content.length);
  });
});
