import { execFileSync } from 'node:child_process';

import type {
  OpenSpecAction,
  Project,
  Task,
} from '../../shared/types';
import type { OpenSpecResolvedRoot } from './openspec-root-resolver';
import { resolveBaseBranch } from './openspec-root-resolver';

const SHARED_SPEC_ACTIONS = new Set<OpenSpecAction>([
  'sync',
  'archive',
  'bulk-archive',
]);
const SAFE_GIT_REF = /^(?:origin\/)?[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

export interface OpenSpecGitBaselineCheck {
  checked: boolean;
  baseRef?: string;
  baseTip?: string;
  mergeBase?: string;
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    gitText(cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseRef(task: Task, project: Project): string {
  const branch = resolveBaseBranch(task, project);
  if (
    !SAFE_GIT_REF.test(branch)
    || branch.includes('..')
    || branch.includes('//')
  ) {
    throw new Error('The task worktree has an unsafe Git base branch.');
  }
  const candidates = branch.startsWith('origin/')
    ? [branch]
    : task.metadata?.useLocalBranch
      ? [branch, `origin/${branch}`]
      : [`origin/${branch}`, branch];
  const baseRef = candidates.find((candidate) =>
    gitRefExists(project.path, candidate),
  );
  if (!baseRef) {
    throw new Error(
      `The task worktree base branch "${branch}" no longer resolves.`,
    );
  }
  return baseRef;
}

/**
 * Protects Archive/Sync from silently applying against stale main specs in a
 * task worktree. Root locks serialize Actions but cannot make a stale branch
 * contain newer OpenSpec commits from its base branch.
 */
export class OpenSpecGitBaselineGuard {
  assertSafeForAction(
    task: Task,
    project: Project,
    root: OpenSpecResolvedRoot,
    action: OpenSpecAction,
  ): OpenSpecGitBaselineCheck {
    if (
      !root.worktree
      || root.rootKind !== 'project'
      || !SHARED_SPEC_ACTIONS.has(action)
    ) {
      return { checked: false };
    }

    const conflicts = gitText(root.workspaceRoot, [
      'diff',
      '--name-only',
      '--diff-filter=U',
    ]);
    if (conflicts) {
      throw new Error(
        'OpenSpec Archive/Sync is paused because the task worktree contains unresolved Git conflicts. Resolve them and retry the official Action.',
      );
    }

    const mainSpecChanges = gitText(project.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      'openspec',
    ]);
    if (mainSpecChanges) {
      throw new Error(
        'OpenSpec Archive/Sync is paused because the main workspace has uncommitted OpenSpec changes. Commit or stash them, refresh OpenSpec, and retry.',
      );
    }

    const baseRef = resolveBaseRef(task, project);
    const baseTip = gitText(project.path, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${baseRef}^{commit}`,
    ]);
    const mergeBase = gitText(root.workspaceRoot, [
      'merge-base',
      'HEAD',
      baseTip,
    ]);
    if (mergeBase !== baseTip) {
      const changedOpenSpecPaths = gitText(project.path, [
        'diff',
        '--name-only',
        mergeBase,
        baseTip,
        '--',
        'openspec',
      ]);
      if (changedOpenSpecPaths) {
        throw new Error(
          `OpenSpec Archive/Sync is paused because ${baseRef} contains newer OpenSpec changes than this task worktree. Rebase or update the worktree, refresh OpenSpec, and retry.`,
        );
      }
    }

    return {
      checked: true,
      baseRef,
      baseTip,
      mergeBase,
    };
  }
}

export const __openSpecGitBaselineTestUtils = {
  resolveBaseRef,
  SAFE_GIT_REF,
  SHARED_SPEC_ACTIONS,
};
