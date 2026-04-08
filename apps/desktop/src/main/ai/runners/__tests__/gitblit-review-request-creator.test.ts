import { describe, expect, it } from 'vitest';
import {
  diffGitBlitTicketIds,
  normalizeGitBlitBaseBranch,
  parseGitBlitTicketId,
  parseGitBlitTicketIdsFromRemote,
} from '../gitblit/review-request-creator';

describe('gitblit review request helpers', () => {
  it('normalizes origin-prefixed base branches', () => {
    expect(normalizeGitBlitBaseBranch('origin/develop')).toBe('develop');
    expect(normalizeGitBlitBaseBranch('main')).toBe('main');
  });

  it('parses ticket ids from common gitblit strings', () => {
    expect(parseGitBlitTicketId('refs/heads/ticket/42')).toBe(42);
    expect(parseGitBlitTicketId('origin/ticket/77')).toBe(77);
    expect(parseGitBlitTicketId('https://gitblit.example.com/tickets/?id=105')).toBe(105);
    expect(parseGitBlitTicketId('Updated GitBlit ticket #9 with a new patchset.')).toBe(9);
    expect(parseGitBlitTicketId('no ticket id here')).toBeUndefined();
  });

  it('parses remote ticket refs and detects newly created ids', () => {
    const before = parseGitBlitTicketIdsFromRemote(
      [
        'abc123\trefs/heads/ticket/11',
        'def456\trefs/heads/ticket/15',
      ].join('\n'),
    );
    const after = parseGitBlitTicketIdsFromRemote(
      [
        'abc123\trefs/heads/ticket/11',
        'def456\trefs/heads/ticket/15',
        '999999\trefs/heads/ticket/18',
      ].join('\n'),
    );

    expect([...before]).toEqual([11, 15]);
    expect(diffGitBlitTicketIds(before, after)).toEqual([18]);
  });
});
