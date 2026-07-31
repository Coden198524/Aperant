import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOrGetWorktree } from './worktree-manager';

let repositoryPath: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'autocode-worktree-race-'));
  repositoryPath = root;
  git(['init', '-b', 'main'], root);
  writeFileSync(join(root, 'README.md'), '# test\n');
  git(['add', 'README.md'], root);
  git([
    '-c',
    'user.name=Autocode Test',
    '-c',
    'user.email=autocode-test@example.invalid',
    'commit',
    '-m',
    'test: initial commit',
  ], root);
  return root;
}

afterEach(() => {
  if (repositoryPath) {
    rmSync(repositoryPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    repositoryPath = undefined;
  }
});

describe('createOrGetWorktree', () => {
  it(
    'deduplicates concurrent creation requests for the same task',
    async () => {
      const root = createRepository();
      const specId = '005-concurrent-openspec';

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          createOrGetWorktree(root, specId, 'main', true),
        ),
      );

      const expectedPath = resolve(
        root,
        '.autocode',
        'worktrees',
        'tasks',
        specId,
      );
      expect(results.map((result) => result.worktreePath))
        .toEqual(Array.from({ length: 4 }, () => expectedPath));
      expect(results.map((result) => result.branch))
        .toEqual(Array.from({ length: 4 }, () => `autocode/${specId}`));
      expect(existsSync(expectedPath)).toBe(true);

      const worktreeList = git(['worktree', 'list', '--porcelain'], root)
        .replace(/\\/g, '/');
      const expectedWorktreeLine = `worktree ${expectedPath.replace(/\\/g, '/')}`;
      expect(worktreeList.split(/\r?\n/).filter((line) =>
        line === expectedWorktreeLine
      )).toHaveLength(1);

      await expect(
        createOrGetWorktree(root, specId, 'main', true),
      ).resolves.toMatchObject({
        worktreePath: expectedPath,
        branch: `autocode/${specId}`,
      });
    },
    15_000,
  );
});
