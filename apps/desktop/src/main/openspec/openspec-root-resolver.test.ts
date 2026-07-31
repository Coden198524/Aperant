import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OpenSpecRootResolver,
  assertSafeRelativePath,
  isPathInside,
  resolveTrustedExistingFile,
} from './openspec-root-resolver';

describe('OpenSpec root path guards', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal, absolute, UNC, drive and null-byte paths', () => {
    for (const value of [
      '../secret.md',
      'nested/../secret.md',
      '/etc/passwd',
      '\\\\server\\share\\secret.md',
      'C:\\secret.md',
      'artifact\0.md',
      'nested//artifact.md',
    ]) {
      expect(() => assertSafeRelativePath(value)).toThrow();
    }
    expect(assertSafeRelativePath('specs/payments/spec.md')).toBe('specs/payments/spec.md');
  });

  it('allows contained files and rejects files outside the trusted root', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-root-'));
    roots.push(root);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'artifact.md'), '# artifact');
    expect(resolveTrustedExistingFile(root, 'nested/artifact.md')).toBe(
      join(root, 'nested', 'artifact.md'),
    );
    expect(() => resolveTrustedExistingFile(root, '../artifact.md')).toThrow();
    expect(isPathInside(join(root, 'nested', 'artifact.md'), root)).toBe(true);
  });

  it('returns stable domain errors when an official change or artifact root disappears', () => {
    const planningRoot = mkdtempSync(
      join(tmpdir(), 'aperant-openspec-missing-change-'),
    );
    roots.push(planningRoot);
    const missingChangeRoot = join(
      planningRoot,
      'openspec',
      'changes',
      'archived-change',
    );
    const resolver = new OpenSpecRootResolver();

    expect(() =>
      resolver.validateOfficialChangeRoot(planningRoot, missingChangeRoot)
    ).toThrow('OpenSpec change root is no longer available.');
    expect(() =>
      resolveTrustedExistingFile(missingChangeRoot, 'proposal.md')
    ).toThrow('OpenSpec artifact root is no longer available.');

    for (const operation of [
      () => resolver.validateOfficialChangeRoot(planningRoot, missingChangeRoot),
      () => resolveTrustedExistingFile(missingChangeRoot, 'proposal.md'),
    ]) {
      try {
        operation();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toMatch(
          /ENOENT|realpath|[A-Z]:\\|\/tmp\//i,
        );
      }
    }
  });

  it('rejects symlink traversal even when the target exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'aperant-openspec-outside-'));
    roots.push(root, outside);
    writeFileSync(join(outside, 'secret.md'), 'secret');
    try {
      symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    expect(() => resolveTrustedExistingFile(root, 'linked/secret.md')).toThrow();
  });

  it('authorizes official project/Store/edit roots without allowing boundary escapes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-workspace-'));
    const store = mkdtempSync(join(tmpdir(), 'aperant-openspec-store-'));
    const outside = mkdtempSync(join(tmpdir(), 'aperant-openspec-escape-'));
    roots.push(workspace, store, outside);
    mkdirSync(join(workspace, 'nested'));
    mkdirSync(join(store, 'nested'));
    const resolver = new OpenSpecRootResolver();

    const projectRoot = {
      cwd: workspace,
      workspaceRoot: workspace,
      rootKind: 'project' as const,
      rootLabel: 'workspace',
      worktree: false,
    };
    expect(resolver.validateOfficialPlanningRoot(projectRoot, workspace)).toBe(workspace);
    expect(() => resolver.validateOfficialPlanningRoot(projectRoot, outside)).toThrow(
      /outside the task workspace/,
    );
    expect(resolver.validateOfficialEditRoot(
      projectRoot,
      workspace,
      join(workspace, 'nested'),
    )).toBe(join(workspace, 'nested'));
    expect(() => resolver.validateOfficialEditRoot(
      projectRoot,
      workspace,
      outside,
    )).toThrow(/outside the authorized workspace/);

    const storeRoot = {
      ...projectRoot,
      rootKind: 'store' as const,
      storeId: 'shared-store',
    };
    expect(resolver.validateOfficialPlanningRoot(storeRoot, store)).toBe(store);
    expect(resolver.validateOfficialEditRoot(
      storeRoot,
      store,
      join(store, 'nested'),
    )).toBe(join(store, 'nested'));
    expect(() => resolver.validateOfficialEditRoot(
      storeRoot,
      store,
      outside,
    )).toThrow(/outside the authorized workspace/);
  });
});
