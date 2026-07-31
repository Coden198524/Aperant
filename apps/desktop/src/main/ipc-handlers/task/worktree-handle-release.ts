import type { Project } from '../../../shared/types';
import type { OpenSpecService } from '../../openspec/openspec-service';

/**
 * Release the OS handles Aperant holds inside a task worktree before deleting it.
 *
 * A Spec task keeps a recursive watcher on its worktree so the board can react
 * to external OpenSpec edits. Windows refuses `rmdir` while that directory
 * handle is open, so worktree cleanup fails with `EBUSY: resource busy or
 * locked` unless the watcher is closed first.
 *
 * Releasing handles is a best-effort preparation step: cleanup must still run
 * when it fails, so problems are logged instead of thrown.
 */
export async function releaseOpenSpecWorktreeHandles(
  openSpecService: OpenSpecService | undefined,
  project: Project,
  worktreePath: string,
  logPrefix: string,
): Promise<void> {
  if (!openSpecService || !worktreePath) return;
  try {
    await openSpecService.releaseWorktreeHandles(project, worktreePath);
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to release OpenSpec watchers before worktree cleanup:`,
      error,
    );
  }
}
