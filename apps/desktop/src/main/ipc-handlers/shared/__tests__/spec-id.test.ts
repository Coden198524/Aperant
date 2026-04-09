import { describe, expect, it } from 'vitest';
import { buildSpecId, slugifySpecTitle } from '../spec-id';

describe('spec-id helpers', () => {
  it('slugifies ascii titles', () => {
    expect(slugifySpecTitle('Fix Login Timeout Bug')).toBe('fix-login-timeout-bug');
  });

  it('falls back when title contains no ascii word characters', () => {
    expect(buildSpecId(2, '中文任务')).toBe('002-task');
    expect(buildSpecId(7, '！！！', 'fallback')).toBe('007-fallback');
  });

  it('never returns a trailing dash-only spec id', () => {
    expect(buildSpecId(12, '---')).toBe('012-task');
  });
});
