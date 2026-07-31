import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import type { Project, Task } from '../../shared/types';
import type { OpenSpecRootKind } from '../../shared/types';
import { createOrGetWorktree } from '../ai/worktree';
import { findTaskWorktree } from '../worktree-paths';
import { isSpecDevelopmentTask } from '../../shared/utils/task-mode';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const COMMON_BRANCHES = ['develop', 'main', 'master', 'dev', 'trunk'];

export interface OpenSpecResolvedRoot {
  cwd: string;
  workspaceRoot: string;
  rootKind: OpenSpecRootKind;
  storeId?: string;
  rootLabel: string;
  worktree: boolean;
}

export class OpenSpecPathUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenSpecPathUnavailableError';
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function canonicalExistingDirectory(
  path: string,
  label = 'OpenSpec root',
): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) {
      throw new Error(`${label} is not a directory.`);
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new OpenSpecPathUnavailableError(
        `${label} is no longer available.`,
      );
    }
    throw error;
  }
  return canonical;
}

function gitRefExists(projectPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: projectPath,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveBaseBranch(task: Task, project: Project): string {
  const configured = task.metadata?.baseBranch?.trim() || project.settings?.mainBranch?.trim();
  if (configured && (
    gitRefExists(project.path, configured) ||
    gitRefExists(project.path, `origin/${configured}`)
  )) {
    return configured;
  }
  for (const branch of COMMON_BRANCHES) {
    if (gitRefExists(project.path, branch) || gitRefExists(project.path, `origin/${branch}`)) {
      return branch;
    }
  }
  try {
    const current = execFileSync('git', ['branch', '--show-current'], {
      cwd: project.path,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (current) return current;
  } catch {
    // The worktree creator will surface a useful error if no branch can be found.
  }
  return 'main';
}

export function isPathInside(childPath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(childPath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function assertSafeRelativePath(value: string, label = 'Relative path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  if (
    value.includes('\0') ||
    isAbsolute(value) ||
    value.startsWith('\\\\') ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`${label} must be a relative path.`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  return normalized;
}

/**
 * Resolves an existing file and rejects symlink/junction traversal outside the
 * trusted root. The renderer never supplies a root or absolute path.
 */
export function resolveTrustedExistingFile(rootPath: string, relativePath: string): string {
  const safeRelativePath = assertSafeRelativePath(relativePath);
  const canonicalRoot = canonicalExistingDirectory(
    rootPath,
    'OpenSpec artifact root',
  );
  const candidate = resolve(canonicalRoot, safeRelativePath);
  if (!isPathInside(candidate, canonicalRoot) || !existsSync(candidate)) {
    throw new Error('Requested OpenSpec artifact does not exist inside the trusted root.');
  }
  let canonicalCandidate: string;
  try {
    canonicalCandidate = realpathSync.native(candidate);
    if (
      !isPathInside(canonicalCandidate, canonicalRoot) ||
      !statSync(canonicalCandidate).isFile()
    ) {
      throw new Error('Requested OpenSpec artifact crosses the trusted root boundary.');
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new OpenSpecPathUnavailableError(
        'Requested OpenSpec artifact is no longer available.',
      );
    }
    throw error;
  }

  // Explicitly reject a symlink at any existing path segment. realpath containment
  // already protects the boundary; this also makes the policy fail closed.
  let cursor = canonicalRoot;
  for (const segment of safeRelativePath.split('/')) {
    cursor = resolve(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('OpenSpec artifact paths may not traverse symbolic links.');
    }
  }
  return canonicalCandidate;
}

export class OpenSpecRootResolver {
  async ensureTaskWorktree(task: Task, project: Project): Promise<void> {
    if (!task.metadata?.useWorktree || findTaskWorktree(project.path, task.specId)) {
      return;
    }

    await createOrGetWorktree(
      project.path,
      task.specId,
      resolveBaseBranch(task, project),
      task.metadata?.useLocalBranch ?? false,
      task.metadata?.pushNewBranches ?? project.settings?.pushNewBranches === true,
      project.autoBuildPath,
      false,
    );
  }

  resolve(task: Task, project: Project): OpenSpecResolvedRoot {
    if (!isSpecDevelopmentTask(task)) {
      throw new Error('OpenSpec APIs can only be used with Spec development mode tasks.');
    }
    if (task.projectId && task.projectId !== project.id) {
      throw new Error('Task does not belong to the requested project.');
    }

    const configuredRootKind = task.metadata?.openSpec?.rootKind ?? 'project';
    const rootKind: OpenSpecRootKind = configuredRootKind === 'store' ? 'store' : 'project';
    const storeId = task.metadata?.openSpec?.storeId?.trim();
    if (rootKind === 'store' && (!storeId || !SAFE_ID.test(storeId))) {
      throw new Error('Spec task references an invalid or missing registered OpenSpec store ID.');
    }

    const worktreePath = task.metadata?.useWorktree
      ? findTaskWorktree(project.path, task.specId)
      : null;
    if (task.metadata?.useWorktree && !worktreePath) {
      throw new Error('The task worktree has not been created yet.');
    }
    const workspaceRoot = canonicalExistingDirectory(
      worktreePath ?? project.path,
      'OpenSpec workspace root',
    );

    return {
      cwd: workspaceRoot,
      workspaceRoot,
      rootKind,
      ...(storeId ? { storeId } : {}),
      rootLabel: rootKind === 'store' ? `Store: ${storeId}` : basename(workspaceRoot),
      worktree: Boolean(worktreePath),
    };
  }

  validateOfficialChangeRoot(
    planningRoot: string,
    changeRoot: string,
  ): { planningRoot: string; changeRoot: string } {
    const canonicalPlanningRoot = canonicalExistingDirectory(
      planningRoot,
      'OpenSpec planning root',
    );
    const canonicalChangeRoot = canonicalExistingDirectory(
      changeRoot,
      'OpenSpec change root',
    );
    if (!isPathInside(canonicalChangeRoot, canonicalPlanningRoot)) {
      throw new Error('OpenSpec returned a change root outside its resolved planning root.');
    }
    return {
      planningRoot: canonicalPlanningRoot,
      changeRoot: canonicalChangeRoot,
    };
  }

  validateOfficialPlanningRoot(
    resolvedRoot: OpenSpecResolvedRoot,
    officialRoot: string,
  ): string {
    const canonicalOfficialRoot = canonicalExistingDirectory(
      officialRoot,
      'OpenSpec planning root',
    );
    if (
      resolvedRoot.rootKind === 'project' &&
      !isPathInside(canonicalOfficialRoot, resolvedRoot.workspaceRoot)
    ) {
      throw new Error(
        'OpenSpec resolved a planning root outside the task workspace. Select the registered Store explicitly to authorize it.',
      );
    }
    return canonicalOfficialRoot;
  }

  validateOfficialEditRoot(
    resolvedRoot: OpenSpecResolvedRoot,
    planningRoot: string,
    editRoot: string,
  ): string {
    const canonicalPlanningRoot = canonicalExistingDirectory(
      planningRoot,
      'OpenSpec planning root',
    );
    const canonicalEditRoot = canonicalExistingDirectory(
      editRoot,
      'OpenSpec edit root',
    );
    if (
      !isPathInside(canonicalEditRoot, resolvedRoot.workspaceRoot) &&
      !isPathInside(canonicalEditRoot, canonicalPlanningRoot)
    ) {
      throw new Error(
        'OpenSpec returned an allowed edit root outside the authorized workspace and planning root.',
      );
    }
    return canonicalEditRoot;
  }

  relativeToChangeRoot(changeRoot: string, filePath: string): string {
    const rel = relative(changeRoot, filePath).replace(/\\/g, '/');
    return assertSafeRelativePath(rel, 'Artifact path');
  }

  resolveArtifactFile(changeRoot: string, relativePath: string): string {
    return resolveTrustedExistingFile(changeRoot, relativePath);
  }
}

export const __openSpecRootResolverTestUtils = {
  resolveBaseBranch,
  canonicalExistingDirectory,
  SAFE_ID,
};
