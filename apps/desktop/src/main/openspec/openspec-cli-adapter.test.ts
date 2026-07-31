import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpenSpecCliAdapter } from './openspec-cli-adapter';

describe.sequential('OpenSpecCliAdapter contract against 1.6.0', () => {
  const cli = new OpenSpecCliAdapter();
  let root = '';
  let storeProbeRoot = '';
  let storeRoot = '';
  let storeWorkspace = '';
  let storeCli: OpenSpecCliAdapter;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aperant-openspec-contract-'));
    storeProbeRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-store-contract-'));
    storeRoot = join(storeProbeRoot, 'store');
    storeWorkspace = join(storeProbeRoot, 'workspace');
    const xdgConfigHome = join(storeProbeRoot, 'config');
    const xdgDataHome = join(storeProbeRoot, 'data');
    mkdirSync(storeWorkspace, { recursive: true });
    mkdirSync(xdgConfigHome, { recursive: true });
    mkdirSync(xdgDataHome, { recursive: true });
    storeCli = new OpenSpecCliAdapter({
      environment: {
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
      },
    });
  });

  afterAll(() => {
    if (root?.startsWith(tmpdir())) {
      rmSync(root, { recursive: true, force: true });
    }
    if (storeProbeRoot?.startsWith(tmpdir())) {
      rmSync(storeProbeRoot, { recursive: true, force: true });
    }
  });

  it('initializes and reports the pinned version', async () => {
    await expect(cli.version({ cwd: root })).resolves.toBe('1.6.0');
    await expect(cli.init({ cwd: root })).resolves.toBeUndefined();
  }, 30_000);

  it('creates a change and exposes the official status/instructions shape', async () => {
    const created = await cli.newChange<Record<string, unknown>>(
      { cwd: root },
      { changeName: 'adapter-contract' },
    );
    expect(created).toMatchObject({
      change: {
        id: 'adapter-contract',
        schema: 'spec-driven',
      },
    });

    const status = await cli.status<Record<string, unknown>>(
      { cwd: root },
      { changeName: 'adapter-contract' },
    );
    expect(status).toMatchObject({
      changeName: 'adapter-contract',
      schemaName: 'spec-driven',
      isComplete: false,
    });
    expect(status.planningHome).toBeTypeOf('object');
    expect(status.changeRoot).toBeTypeOf('string');
    expect(status.artifactPaths).toBeTypeOf('object');
    expect(status.artifacts).toBeInstanceOf(Array);
    expect(status.applyRequires).toBeInstanceOf(Array);
    expect(status.nextSteps).toBeInstanceOf(Array);

    const instructions = await cli.instructions<Record<string, unknown>>(
      { cwd: root },
      { artifactId: 'proposal', changeName: 'adapter-contract' },
    );
    expect(instructions).toMatchObject({
      changeName: 'adapter-contract',
      artifactId: 'proposal',
      schemaName: 'spec-driven',
      outputPath: 'proposal.md',
    });

    const designInstructions = await cli.instructions<{
      dependencies: Array<Record<string, unknown>>;
    }>(
      { cwd: root },
      { artifactId: 'design', changeName: 'adapter-contract' },
    );
    expect(designInstructions.dependencies).toEqual([
      expect.objectContaining({
        id: 'proposal',
        done: false,
        path: 'proposal.md',
      }),
    ]);
  }, 45_000);

  it('lists schemas, templates, context, changes, and validation JSON', async () => {
    const schemas = await cli.schemas<Array<Record<string, unknown>>>({ cwd: root });
    expect(schemas.some((schema) => schema.name === 'spec-driven')).toBe(true);

    const schemaResolution = await cli.schemaWhich<{
      name: string;
      source: string;
      path: string;
    }>({ cwd: root }, 'spec-driven');
    expect(schemaResolution).toMatchObject({
      name: 'spec-driven',
      source: 'package',
    });
    expect(schemaResolution.path).toMatch(/[\\/]schemas[\\/]spec-driven$/);

    const templates = await cli.templates<unknown>({ cwd: root }, 'spec-driven');
    expect(templates).toBeTruthy();

    const context = await cli.context<Record<string, unknown>>({ cwd: root });
    expect(context.root).toBeTruthy();

    const list = await cli.list<{ changes: Array<{ name: string }> }>({ cwd: root });
    expect(list.changes.some((change) => change.name === 'adapter-contract')).toBe(true);

    const validation = await cli.validate<Record<string, unknown>>(
      { cwd: root },
      { itemName: 'adapter-contract', strict: true },
    );
    expect(validation).toBeTypeOf('object');
  }, 45_000);

  it('accepts official-format artifacts, validates/shows them, and archives through the pinned CLI', async () => {
    const changeRoot = join(root, 'openspec', 'changes', 'adapter-contract');
    mkdirSync(join(changeRoot, 'specs', 'adapter-contract'), { recursive: true });
    writeFileSync(join(changeRoot, 'proposal.md'), [
      '## Why',
      '',
      'Verify the packaged OpenSpec adapter contract.',
      '',
      '## What Changes',
      '',
      '- Add an adapter contract capability.',
      '',
      '## Capabilities',
      '',
      '### New Capabilities',
      '',
      '- `adapter-contract`: Defines the adapter contract.',
      '',
      '### Modified Capabilities',
      '',
      'None.',
      '',
      '## Impact',
      '',
      'Contract-test files only.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(
      join(changeRoot, 'specs', 'adapter-contract', 'spec.md'),
      [
        '## ADDED Requirements',
        '',
        '### Requirement: Adapter reports official status',
        'The adapter MUST return the official OpenSpec status JSON.',
        '',
        '#### Scenario: Status is available',
        '- **WHEN** a valid change is queried',
        '- **THEN** the adapter returns its artifact graph',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(join(changeRoot, 'design.md'), [
      '## Context',
      '',
      'The adapter executes the pinned CLI.',
      '',
      '## Goals / Non-Goals',
      '',
      '**Goals:** Preserve the official contract.',
      '',
      '**Non-Goals:** Define a second workflow.',
      '',
      '## Decisions',
      '',
      'Use the pinned CLI JSON output.',
      '',
      '## Risks / Trade-offs',
      '',
      'Upstream changes require an explicit version upgrade.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(changeRoot, 'tasks.md'), [
      '## 1. Contract',
      '',
      '- [x] 1.1 Validate the adapter contract',
      '',
    ].join('\n'), 'utf8');

    const status = await cli.status<{
      isComplete: boolean;
      artifacts: Array<{ status: string }>;
    }>({ cwd: root }, { changeName: 'adapter-contract' });
    expect(status.isComplete).toBe(true);
    expect(status.artifacts.every((artifact) => artifact.status === 'done')).toBe(true);

    const validation = await cli.validate<{
      summary?: { totals?: { failed?: number } };
    }>({ cwd: root }, {
      itemName: 'adapter-contract',
      strict: true,
    });
    expect(validation.summary?.totals?.failed ?? 0).toBe(0);

    const shown = await cli.show<Record<string, unknown>>(
      { cwd: root },
      { itemName: 'adapter-contract', type: 'change' },
    );
    expect(shown).toBeTypeOf('object');

    await cli.archive<Record<string, unknown>>(
      { cwd: root },
      {
        changeName: 'adapter-contract',
        confirmed: true,
      },
    );
    const active = await cli.list<{ changes: Array<{ name: string }> }>({ cwd: root });
    expect(active.changes.some((change) => change.name === 'adapter-contract')).toBe(false);
    const archiveRoot = join(root, 'openspec', 'changes', 'archive');
    expect(existsSync(archiveRoot)).toBe(true);
    expect(readdirSync(archiveRoot)).toContainEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}-adapter-contract$/),
    );
  }, 60_000);

  it('discovers a project-local custom Schema and returns its dynamic artifact graph', async () => {
    const schemaRoot = join(root, 'openspec', 'schemas', 'custom-board');
    mkdirSync(schemaRoot, { recursive: true });
    writeFileSync(join(schemaRoot, 'schema.yaml'), [
      'name: custom-board',
      'version: 1',
      'description: Two-artifact custom board contract',
      'artifacts:',
      '  - id: brief',
      '    generates: brief.md',
      '    description: A compact change brief',
      '    template: brief.md',
      '    instruction: |',
      '      Describe the requested change.',
      '    requires: []',
      '  - id: checklist',
      '    generates: checklist.md',
      '    description: A custom implementation checklist',
      '    template: checklist.md',
      '    instruction: |',
      '      Create the implementation checklist.',
      '    requires:',
      '      - brief',
      'apply:',
      '  requires: [checklist]',
      '  tracks: checklist.md',
      '  instruction: |',
      '    Complete the custom checklist.',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(schemaRoot, 'brief.md'), '# Brief\n', 'utf8');
    writeFileSync(join(schemaRoot, 'checklist.md'), '- [ ] 1.1 Implement\n', 'utf8');

    const schemas = await cli.schemas<Array<{ name: string; source: string }>>({ cwd: root });
    expect(schemas).toContainEqual(expect.objectContaining({
      name: 'custom-board',
      source: 'project',
    }));
    await cli.templates<unknown>({ cwd: root }, 'custom-board');
    await cli.newChange<unknown>(
      { cwd: root },
      {
        changeName: 'custom-board-change',
        schemaName: 'custom-board',
      },
    );
    const status = await cli.status<{
      schemaName: string;
      artifacts: Array<{ id: string; status: string }>;
      applyRequires: string[];
    }>({ cwd: root }, {
      changeName: 'custom-board-change',
      schemaName: 'custom-board',
    });
    expect(status.schemaName).toBe('custom-board');
    expect(status.artifacts).toEqual([
      expect.objectContaining({ id: 'brief', status: 'ready' }),
      expect.objectContaining({ id: 'checklist', status: 'blocked' }),
    ]);
    expect(status.applyRequires).toEqual(['checklist']);
  }, 45_000);

  it('uses a real isolated Store registry and keeps planning in the registered Store root', async () => {
    const setup = await storeCli.execute(
      { cwd: storeWorkspace },
      [
        'store',
        'setup',
        'contract-store',
        '--path',
        storeRoot,
        '--no-init-git',
        '--json',
      ],
      { timeoutMs: 60_000 },
    );
    expect(JSON.parse(setup.stdout)).toMatchObject({
      store: {
        id: 'contract-store',
        root: storeRoot,
      },
      registry: {
        registered: true,
      },
      status: [],
    });

    const scope = {
      cwd: storeWorkspace,
      rootKind: 'store' as const,
      storeId: 'contract-store',
    };
    const stores = await storeCli.storeList<{
      stores: Array<{ id: string; root: string }>;
    }>({ cwd: storeWorkspace });
    expect(stores.stores).toContainEqual({
      id: 'contract-store',
      root: storeRoot,
    });

    const context = await storeCli.context<{
      root: { path: string; source: string; store_id: string };
      status: unknown[];
    }>(scope);
    expect(context).toMatchObject({
      root: {
        path: storeRoot,
        source: 'store',
        store_id: 'contract-store',
      },
      status: [],
    });

    await storeCli.newChange(scope, { changeName: 'store-change' });
    const status = await storeCli.status<{
      changeName: string;
      planningHome: { root: string };
      changeRoot: string;
      actionContext: { allowedEditRoots: string[] };
      artifacts: Array<{ id: string; status: string }>;
    }>(scope, { changeName: 'store-change' });
    expect(status.changeName).toBe('store-change');
    expect(status.planningHome.root).toBe(storeRoot);
    expect(status.changeRoot).toBe(join(storeRoot, 'openspec', 'changes', 'store-change'));
    expect(status.actionContext.allowedEditRoots).toEqual([storeRoot]);
    expect(status.artifacts).toContainEqual(
      expect.objectContaining({ id: 'proposal', status: 'ready' }),
    );

    const instructions = await storeCli.instructions<{
      changeDir: string;
      outputPath: string;
    }>(scope, {
      artifactId: 'proposal',
      changeName: 'store-change',
    });
    expect(instructions.changeDir).toBe(status.changeRoot);
    expect(instructions.outputPath).toBe('proposal.md');
    const listed = await storeCli.list<{ changes: Array<{ name: string }> }>(scope);
    expect(listed.changes).toContainEqual(expect.objectContaining({ name: 'store-change' }));

    const shadowSchemaRoot = join(
      storeRoot,
      'openspec',
      'schemas',
      'spec-driven-with-adr',
    );
    mkdirSync(shadowSchemaRoot, { recursive: true });
    writeFileSync(join(shadowSchemaRoot, 'schema.yaml'), [
      'name: spec-driven-with-adr',
      'version: 1',
      'description: Store-local shadow used by the resolution contract test',
      'artifacts: []',
      '',
    ].join('\n'), 'utf8');
    const shadowResolution = await storeCli.schemaWhich<{
      name: string;
      source: string;
      path: string;
    }>({ cwd: storeRoot }, 'spec-driven-with-adr');
    expect(shadowResolution).toEqual(expect.objectContaining({
      name: 'spec-driven-with-adr',
      source: 'project',
      path: shadowSchemaRoot,
    }));
  }, 60_000);
});
