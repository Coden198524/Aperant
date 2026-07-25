import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));
vi.mock('../cli-tool-manager', () => ({
  getToolPath: () => 'git',
}));
vi.mock('./git-isolation', () => ({
  getIsolatedGitEnv: () => ({}),
}));

const { isWorktreeUntrackedByGit } = await import('./worktree-cleanup');

const PROJECT = 'C:/projects/app';
const WORKTREE = 'C:/projects/app/.autocode/worktrees/tasks/003-unlua';

describe('isWorktreeUntrackedByGit', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('reports untracked when git no longer lists the worktree', () => {
    // Windows case: the directory survives because another process holds it, but git's own
    // bookkeeping is already clean, so the task is logically cleaned up.
    execFileSyncMock.mockReturnValue([
      'worktree C:/projects/app',
      'HEAD 0e64673',
      'branch refs/heads/master',
      '',
    ].join('\n'));

    expect(isWorktreeUntrackedByGit(PROJECT, WORKTREE)).toBe(true);
  });

  it('reports tracked when git still lists the worktree', () => {
    execFileSyncMock.mockReturnValue([
      'worktree C:/projects/app',
      '',
      `worktree ${WORKTREE}`,
      'branch refs/heads/task/003-unlua',
      '',
    ].join('\n'));

    expect(isWorktreeUntrackedByGit(PROJECT, WORKTREE)).toBe(false);
  });

  it('matches paths that differ only by separators or a trailing slash', () => {
    execFileSyncMock.mockReturnValue([
      `worktree ${WORKTREE.replace(/\//g, '\\')}\\`,
      '',
    ].join('\n'));

    expect(isWorktreeUntrackedByGit(PROJECT, WORKTREE)).toBe(false);
  });

  it('treats an unreadable git state as still tracked so real cleanup is never skipped', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('git unavailable');
    });

    expect(isWorktreeUntrackedByGit(PROJECT, WORKTREE)).toBe(false);
  });
});
