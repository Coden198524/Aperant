import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/types';
import type { OpenSpecService } from '../../openspec/openspec-service';
import { releaseOpenSpecWorktreeHandles } from './worktree-handle-release';

const project = { id: 'project-a', path: 'C:\\project' } as Project;
const worktreePath = 'C:\\project\\.autocode\\worktrees\\tasks\\005-spec-task';

describe('releaseOpenSpecWorktreeHandles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the worktree handles held by the OpenSpec service', async () => {
    const releaseWorktreeHandles = vi.fn().mockResolvedValue(undefined);

    await releaseOpenSpecWorktreeHandles(
      { releaseWorktreeHandles } as unknown as OpenSpecService,
      project,
      worktreePath,
      '[TEST]',
    );

    expect(releaseWorktreeHandles).toHaveBeenCalledWith(project, worktreePath);
  });

  it('is a no-op without an OpenSpec service or worktree path', async () => {
    const releaseWorktreeHandles = vi.fn().mockResolvedValue(undefined);

    await expect(releaseOpenSpecWorktreeHandles(
      undefined,
      project,
      worktreePath,
      '[TEST]',
    )).resolves.toBeUndefined();
    await expect(releaseOpenSpecWorktreeHandles(
      { releaseWorktreeHandles } as unknown as OpenSpecService,
      project,
      '',
      '[TEST]',
    )).resolves.toBeUndefined();

    expect(releaseWorktreeHandles).not.toHaveBeenCalled();
  });

  it('lets cleanup continue when releasing handles fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const releaseWorktreeHandles = vi.fn()
      .mockRejectedValue(new Error('watcher close failed'));

    await expect(releaseOpenSpecWorktreeHandles(
      { releaseWorktreeHandles } as unknown as OpenSpecService,
      project,
      worktreePath,
      '[TEST]',
    )).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[TEST]'),
      expect.any(Error),
    );
  });
});
