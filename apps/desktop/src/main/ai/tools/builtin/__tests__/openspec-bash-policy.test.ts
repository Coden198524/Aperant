import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getOpenSpecBashPolicyDenial,
  type OpenSpecBashPolicy,
} from '../openspec-bash-policy';

describe('OpenSpec Bash policy', () => {
  const temporaryRoots: string[] = [];

  function roots(): {
    root: string;
    openSpecRoot: string;
    outsideRoot: string;
    policy: OpenSpecBashPolicy;
  } {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-bash-root-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-bash-outside-'));
    temporaryRoots.push(root, outsideRoot);
    const openSpecRoot = join(root, 'openspec');
    mkdirSync(openSpecRoot, { recursive: true });
    return {
      root,
      openSpecRoot,
      outsideRoot,
      policy: {
        allowedPathRoots: [root],
        allowedWritePaths: [openSpecRoot],
        storeId: 'trusted-store',
      },
    };
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows the pinned CLI and only the task-authorized Store ID', () => {
    const { root, policy } = roots();
    expect(getOpenSpecBashPolicyDenial(
      'openspec status --change safe-change --store trusted-store --json',
      root,
      policy,
      false,
    )).toBeNull();
    expect(getOpenSpecBashPolicyDenial(
      'openspec list --store another-store --json',
      root,
      policy,
      false,
    )).toMatch(/untrusted Store/);
    expect(getOpenSpecBashPolicyDenial(
      'npx @fission-ai/openspec status --change safe-change --json',
      root,
      policy,
      false,
    )).toMatch(/application-pinned/);
    expect(getOpenSpecBashPolicyDenial(
      'openspec store unregister trusted-store',
      root,
      policy,
      false,
    )).toMatch(/cannot modify.*Store registry/);
  });

  it('rejects absolute, traversal, environment-expanded, and symlink escape paths', () => {
    const { root, outsideRoot, policy } = roots();
    expect(getOpenSpecBashPolicyDenial(
      `type "${join(outsideRoot, 'secret.txt')}"`,
      root,
      policy,
      false,
    )).toMatch(/outside the authorized roots/);
    expect(getOpenSpecBashPolicyDenial('type ..\\secret.txt', root, policy, false))
      .toMatch(/parent-traversing/);
    expect(getOpenSpecBashPolicyDenial('type $HOME/.ssh/id_rsa', root, policy, false))
      .toMatch(/home-relative/);

    const link = join(root, 'linked-outside');
    try {
      symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    expect(getOpenSpecBashPolicyDenial(
      `type "${join(link, 'secret.txt')}"`,
      root,
      policy,
      false,
    )).toMatch(/outside the authorized roots/);
  });

  it('keeps planning writes under openspec and denies implicit workspace mutation', () => {
    const { root, openSpecRoot, policy } = roots();
    expect(getOpenSpecBashPolicyDenial(
      `mkdir -p "${join(openSpecRoot, 'changes', 'archive')}"`,
      root,
      policy,
      false,
    )).toBeNull();
    expect(getOpenSpecBashPolicyDenial(
      `echo unsafe > "${join(root, 'source.ts')}"`,
      root,
      policy,
      false,
    )).toMatch(/write target is outside/);
    expect(getOpenSpecBashPolicyDenial('npm run build', root, policy, false))
      .toMatch(/potentially mutating command/);
  });

  it('allows an explicitly authorized ADR root without widening the workspace', () => {
    const { root, openSpecRoot, policy } = roots();
    const adrRoot = join(root, 'adr');
    mkdirSync(adrRoot, { recursive: true });
    const adrPolicy = {
      ...policy,
      allowedWritePaths: [openSpecRoot, adrRoot],
    };
    const adrFile = join(adrRoot, '0001-use-events.md').replace(/\\/g, '/');
    expect(getOpenSpecBashPolicyDenial(
      `echo "# Decision" > "${adrFile}"`,
      root,
      adrPolicy,
      false,
    )).toBeNull();
    expect(getOpenSpecBashPolicyDenial(
      `echo unsafe > "${join(root, 'source.ts')}"`,
      root,
      adrPolicy,
      false,
    )).toMatch(/write target is outside/);
  });

  it('blocks mutation and inline-shell bypasses for read-only Actions', () => {
    const { root, openSpecRoot, policy } = roots();
    expect(getOpenSpecBashPolicyDenial(
      `touch "${join(openSpecRoot, 'changed.md')}"`,
      root,
      policy,
      true,
    )).toMatch(/read-only/);
    expect(getOpenSpecBashPolicyDenial(
      'node -e "require(\'fs\').writeFileSync(\'owned\', \'x\')"',
      root,
      policy,
      true,
    )).toMatch(/inline interpreter/);
    expect(getOpenSpecBashPolicyDenial('cat openspec/config.yaml', root, policy, true))
      .toBeNull();
  });

  it('prevents Store selection in a project-local task', () => {
    const { root, policy } = roots();
    expect(getOpenSpecBashPolicyDenial(
      'openspec list --store trusted-store --json',
      root,
      { ...policy, storeId: undefined },
      false,
    )).toMatch(/untrusted Store|cannot select a Store/);
  });
});
