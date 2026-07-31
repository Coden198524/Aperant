import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project, Task } from '../../shared/types';
import { OpenSpecGitBaselineGuard } from './openspec-git-baseline';
import type { OpenSpecResolvedRoot } from './openspec-root-resolver';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, relativePath: string, content: string): void {
  const segments = relativePath.split('/');
  segments.pop();
  mkdirSync(join(root, ...segments), { recursive: true });
  writeFileSync(join(root, ...relativePath.split('/')), content, 'utf8');
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', message]);
}

describe('OpenSpecGitBaselineGuard', () => {
  let sandbox = '';
  let projectRoot = '';
  let worktreeRoot = '';
  let task: Task;
  let project: Project;
  let root: OpenSpecResolvedRoot;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'aperant-openspec-git-baseline-'));
    projectRoot = join(sandbox, 'project');
    worktreeRoot = join(sandbox, 'task-worktree');
    mkdirSync(projectRoot, { recursive: true });
    git(projectRoot, ['init', '-b', 'main']);
    git(projectRoot, ['config', 'user.email', 'openspec-test@example.invalid']);
    git(projectRoot, ['config', 'user.name', 'OpenSpec Test']);
    write(
      projectRoot,
      'openspec/specs/example/spec.md',
      '# Example\n\nInitial specification.\n',
    );
    commitAll(projectRoot, 'initial openspec');
    git(projectRoot, [
      'worktree',
      'add',
      '-b',
      'spec-task',
      worktreeRoot,
      'main',
    ]);

    task = {
      id: 'task-1',
      specId: '001-spec-task',
      projectId: 'project-1',
      title: 'Spec task',
      description: 'Spec task',
      status: 'backlog',
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        developmentMode: 'spec',
        useWorktree: true,
        useLocalBranch: true,
        baseBranch: 'main',
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          changeName: 'spec-task',
          schemaName: 'spec-driven',
        },
      },
    } as unknown as Task;
    project = {
      id: 'project-1',
      name: 'Project',
      path: projectRoot,
      autoBuildPath: join(projectRoot, '.autocode'),
      createdAt: new Date(),
      updatedAt: new Date(),
      settings: {
        mainBranch: 'main',
      },
    } as unknown as Project;
    root = {
      cwd: worktreeRoot,
      workspaceRoot: worktreeRoot,
      rootKind: 'project',
      rootLabel: 'task-worktree',
      worktree: true,
    };
  });

  afterEach(() => {
    if (sandbox.startsWith(tmpdir())) {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('allows Archive/Sync when the task worktree contains the base OpenSpec tip', () => {
    const result = new OpenSpecGitBaselineGuard().assertSafeForAction(
      task,
      project,
      root,
      'archive',
    );

    expect(result).toMatchObject({
      checked: true,
      baseRef: 'main',
    });
    expect(result.baseTip).toBe(result.mergeBase);
  });

  it('ignores unrelated base-branch drift and non-shared Actions', () => {
    write(projectRoot, 'README.md', '# Project\n');
    commitAll(projectRoot, 'unrelated base change');
    const guard = new OpenSpecGitBaselineGuard();

    expect(guard.assertSafeForAction(task, project, root, 'sync').checked).toBe(true);
    expect(guard.assertSafeForAction(task, project, root, 'apply')).toEqual({
      checked: false,
    });
  });

  it('pauses Archive/Sync when the base branch contains newer OpenSpec changes', () => {
    write(
      projectRoot,
      'openspec/specs/example/spec.md',
      '# Example\n\nNew main specification.\n',
    );
    commitAll(projectRoot, 'update main openspec');

    expect(() => new OpenSpecGitBaselineGuard().assertSafeForAction(
      task,
      project,
      root,
      'sync',
    )).toThrow(/contains newer OpenSpec changes/);
  });

  it('pauses Archive/Sync for uncommitted main OpenSpec changes', () => {
    write(projectRoot, 'openspec/config.yaml', 'schema: spec-driven\n');

    expect(() => new OpenSpecGitBaselineGuard().assertSafeForAction(
      task,
      project,
      root,
      'archive',
    )).toThrow(/main workspace has uncommitted OpenSpec changes/);
  });

  it('pauses Archive/Sync for unresolved worktree conflicts', () => {
    write(
      worktreeRoot,
      'openspec/specs/example/spec.md',
      '# Example\n\nTask branch version.\n',
    );
    commitAll(worktreeRoot, 'task branch spec');
    write(
      projectRoot,
      'openspec/specs/example/spec.md',
      '# Example\n\nMain branch version.\n',
    );
    commitAll(projectRoot, 'main branch spec');
    expect(() => git(worktreeRoot, ['merge', 'main'])).toThrow();

    expect(() => new OpenSpecGitBaselineGuard().assertSafeForAction(
      task,
      project,
      root,
      'bulk-archive',
    )).toThrow(/unresolved Git conflicts/);
  });

  it('does not apply the repository baseline guard to Store planning roots', () => {
    expect(new OpenSpecGitBaselineGuard().assertSafeForAction(
      task,
      project,
      {
        ...root,
        rootKind: 'store',
        storeId: 'shared-specs',
      },
      'archive',
    )).toEqual({ checked: false });
  });
});
