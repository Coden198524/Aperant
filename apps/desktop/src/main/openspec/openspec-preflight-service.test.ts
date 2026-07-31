import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../shared/types';
import type { OpenSpecCliAdapter } from './openspec-cli-adapter';
import {
  OpenSpecPreflightService,
  __openSpecPreflightTestUtils,
} from './openspec-preflight-service';

function project(root: string): Project {
  return {
    id: 'project-a',
    name: 'Project A',
    path: root,
    autoBuildPath: '.autocode',
  } as Project;
}

function cli(overrides: Record<string, unknown> = {}): OpenSpecCliAdapter {
  return {
    version: vi.fn().mockResolvedValue('1.6.0'),
    storeList: vi.fn().mockResolvedValue({ stores: [], status: [] }),
    schemas: vi.fn().mockResolvedValue([
      {
        name: 'spec-driven',
        description: 'Default schema',
        artifacts: ['proposal', 'specs', 'design', 'tasks'],
        source: 'package',
      },
      {
        name: 'spec-driven-with-adr',
        description: 'Spec-driven schema with durable ADR review',
        artifacts: ['proposal', 'specs', 'design', 'adr', 'tasks'],
        source: 'package',
      },
    ]),
    templates: vi.fn().mockImplementation(
      (_scope: unknown, schema: string) =>
        Promise.resolve({ schema, artifacts: [] }),
    ),
    context: vi.fn(),
    list: vi.fn().mockResolvedValue({ changes: [], root: null }),
    ...overrides,
  } as unknown as OpenSpecCliAdapter;
}

describe('OpenSpecPreflightService', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates a project root, pinned version, schema templates, and available change name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-'));
    roots.push(root);
    const adapter = cli();
    const result = await new OpenSpecPreflightService(adapter).run(project(root), {
      projectId: 'project-a',
      rootKind: 'project',
      schemaName: 'spec-driven-with-adr',
      changeName: 'new-change',
      startAction: 'new',
    });

    expect(result).toMatchObject({
      valid: true,
      openSpecVersion: '1.6.0',
      rootKind: 'project',
      initialized: false,
      schemaName: 'spec-driven-with-adr',
      availableSchemas: ['spec-driven', 'spec-driven-with-adr'],
      changeExists: false,
    });
    expect(result.checks.map((entry) => entry.code)).toEqual([
      'version',
      'project-root',
      'schema',
      'change',
    ]);
    expect((adapter.templates as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: root }),
      'spec-driven-with-adr',
    );
  });

  it('fails creation preflight on a colliding change but permits Explore to use it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-change-'));
    roots.push(root);
    mkdirSync(join(root, 'openspec'), { recursive: true });
    const adapter = cli({
      list: vi.fn().mockResolvedValue({
        changes: [{ name: 'existing-change' }],
        root: { path: root },
      }),
    });
    const service = new OpenSpecPreflightService(adapter);

    const create = await service.run(project(root), {
      projectId: 'project-a',
      changeName: 'existing-change',
      startAction: 'propose',
    });
    expect(create.valid).toBe(false);
    expect(create.changeExists).toBe(true);
    expect(create.checks.find((entry) => entry.code === 'change')).toMatchObject({
      ok: false,
      severity: 'error',
    });

    const explore = await service.run(project(root), {
      projectId: 'project-a',
      changeName: 'existing-change',
      startAction: 'explore',
    });
    expect(explore.valid).toBe(true);
  });

  it('resolves only registered Store IDs through official context', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-project-'));
    const storeRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-store-'));
    roots.push(projectRoot, storeRoot);
    mkdirSync(join(storeRoot, 'openspec'), { recursive: true });
    const adapter = cli({
      storeList: vi.fn().mockResolvedValue({
        stores: [{ id: 'shared-specs', root: storeRoot }],
        status: [],
      }),
      context: vi.fn().mockResolvedValue({
        root: { path: storeRoot, source: 'store', store_id: 'shared-specs' },
      }),
      list: vi.fn().mockResolvedValue({
        changes: [],
        root: { path: storeRoot, source: 'store' },
      }),
    });

    const valid = await new OpenSpecPreflightService(adapter).run(project(projectRoot), {
      projectId: 'project-a',
      rootKind: 'store',
      storeId: 'shared-specs',
      schemaName: 'spec-driven',
    });
    expect(valid).toMatchObject({
      valid: true,
      rootKind: 'store',
      rootLabel: 'Store: shared-specs',
      initialized: true,
      registeredStores: ['shared-specs'],
    });
    expect(adapter.context).toHaveBeenCalledWith(expect.objectContaining({
      rootKind: 'store',
      storeId: 'shared-specs',
    }));

    const missing = await new OpenSpecPreflightService(cli()).run(project(projectRoot), {
      projectId: 'project-a',
      rootKind: 'store',
      storeId: 'not-registered',
    });
    expect(missing.valid).toBe(false);
    expect(missing.checks.find((entry) => entry.code === 'store')).toMatchObject({
      ok: false,
      severity: 'error',
    });
  });

  it('fails closed for unknown schemas, unsafe identifiers, and non-Git worktree roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-invalid-'));
    roots.push(root);
    const unknownSchema = await new OpenSpecPreflightService(cli()).run(project(root), {
      projectId: 'project-a',
      schemaName: 'custom-schema',
    });
    expect(unknownSchema.valid).toBe(false);
    expect(unknownSchema.checks.find((entry) => entry.code === 'schema')?.ok).toBe(false);

    await expect(new OpenSpecPreflightService(cli()).run(project(root), {
      projectId: 'project-a',
      changeName: '../escape',
    })).rejects.toThrow(/kebab-case/);

    const worktree = await new OpenSpecPreflightService(cli()).run(project(root), {
      projectId: 'project-a',
      useWorktree: true,
    });
    expect(worktree.valid).toBe(false);
    expect(worktree.checks.find((entry) => entry.code === 'worktree')?.ok).toBe(false);
  });

  it('accepts an initialized Git root for worktree mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-preflight-git-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore', windowsHide: true });
    const result = await new OpenSpecPreflightService(cli()).run(project(root), {
      projectId: 'project-a',
      useWorktree: true,
    });
    expect(result.valid).toBe(true);
    expect(__openSpecPreflightTestUtils.gitWorktreeCheck(root)).toMatchObject({
      code: 'worktree',
      ok: true,
    });
  });
});
