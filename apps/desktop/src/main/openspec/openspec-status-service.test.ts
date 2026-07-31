import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE,
  isOpenSpecArtifactRefreshRequiredError,
  type OpenSpecBoardSnapshot,
  type Project,
  type Task,
} from '../../shared/types';
import type { OpenSpecCliAdapter } from './openspec-cli-adapter';
import { OpenSpecRootResolver } from './openspec-root-resolver';
import type { OpenSpecRuntimeStore } from './openspec-runtime-store';
import {
  OpenSpecStatusService,
  __openSpecStatusTestUtils,
} from './openspec-status-service';

function task(projectId: string): Task {
  return {
    id: 'task-spec',
    specId: 'task-spec',
    projectId,
    title: 'Spec task',
    description: 'Implement a Spec task.',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: 'project',
        schemaName: 'spec-driven',
        changeName: 'change-a',
      },
    },
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    updatedAt: new Date('2026-07-28T00:00:00.000Z'),
  };
}

function project(root: string): Project {
  return {
    id: 'project-a',
    name: 'Project A',
    path: root,
    autoBuildPath: '.autocode',
  } as Project;
}

function statusPayload(root: string) {
  const changeRoot = join(root, 'openspec', 'changes', 'change-a');
  return {
    changeName: 'change-a',
    schemaName: 'spec-driven',
    planningHome: {
      kind: 'repo',
      root,
      changesDir: join(root, 'openspec', 'changes'),
      defaultSchema: 'spec-driven',
    },
    changeRoot,
    artifactPaths: {
      proposal: {
        outputPath: 'proposal.md',
        resolvedOutputPath: join(changeRoot, 'proposal.md'),
        existingOutputPaths: [] as string[],
      },
      design: {
        outputPath: 'design.md',
        resolvedOutputPath: join(changeRoot, 'design.md'),
        existingOutputPaths: [] as string[],
      },
    },
    isComplete: false,
    applyRequires: ['design'],
    nextSteps: ['Create proposal.'],
    actionContext: {
      mode: 'repo-local',
      sourceOfTruth: 'repo',
      linkedContext: ['docs/architecture.md'],
      allowedEditRoots: [root],
      requiresAffectedAreaSelection: false,
      constraints: [],
    },
    artifacts: [
      {
        id: 'proposal',
        outputPath: 'proposal.md',
        status: 'ready',
      },
      {
        id: 'design',
        outputPath: 'design.md',
        status: 'blocked',
        missingDeps: ['proposal'],
      },
    ],
    root: { path: root, source: 'nearest' },
  };
}

describe('OpenSpec 1.6.0 status parsers', () => {
  it('adapts official instruction dependency objects without dropping instructions', () => {
    const parsed = __openSpecStatusTestUtils.parseInstructions({
      changeName: 'change-a',
      artifactId: 'tasks',
      schemaName: 'spec-driven',
      changeDir: '/repo/openspec/changes/change-a',
      outputPath: 'tasks.md',
      description: 'Implementation tasks',
      instruction: 'Create tasks.',
      template: '- [ ] 1.1 Task',
      dependencies: [
        {
          id: 'design',
          done: true,
          path: 'design.md',
          description: 'Design',
        },
      ],
      unlocks: [],
    });

    expect(parsed.dependencies).toEqual([
      {
        id: 'design',
        done: true,
        path: 'design.md',
        description: 'Design',
      },
    ]);
    expect(parsed.instruction).toBe('Create tasks.');
    expect(parsed.template).toBe('- [ ] 1.1 Task');
  });

  it('fails closed on malformed status and maps unknown artifact states', () => {
    expect(() => __openSpecStatusTestUtils.parseStatus({ artifacts: [] })).toThrow(
      /missing required 1\.6\.0 fields/,
    );
    expect(__openSpecStatusTestUtils.mapArtifactStatus('future-state')).toBe('unknown');
  });

  it('parses task checklists and OpenSpec requirement/scenario metrics read-only', () => {
    expect(__openSpecStatusTestUtils.parseChecklist([
      '- [x] 1.1 Complete',
      '- [ ] 1.2 Pending',
      '- [X] 1.3 Complete',
    ].join('\n'))).toEqual({ completed: 2, total: 3 });
    expect(__openSpecStatusTestUtils.parseSpecMetrics([
      '### Requirement: First',
      '#### Scenario: A',
      '#### Scenario: B',
      '### Requirement: Second',
    ].join('\n'))).toEqual({ requirements: 2, scenarios: 2 });
  });

  it('projects all four completed planning documents through Update progress', () => {
    const startedAt = '2026-07-31T12:00:00.000Z';
    const artifactModifiedAt = new Map([
      ['proposal', '2026-07-31T11:00:00.000Z'],
      ['specs', '2026-07-31T11:01:00.000Z'],
      ['design', '2026-07-31T11:02:00.000Z'],
      ['tasks', '2026-07-31T11:03:00.000Z'],
    ]);
    const project = (id: string) =>
      __openSpecStatusTestUtils.projectArtifactRuntimeState({
        officialStatus: 'done',
        existingOutputPaths: [`${id}.md`],
        modifiedAt: artifactModifiedAt.get(id),
        runtimeState: 'running',
        activeAction: 'update',
        activeRunStartedAt: startedAt,
      });

    expect(['proposal', 'specs', 'design', 'tasks'].map(project)).toEqual([
      { status: 'ready', inProgress: true },
      { status: 'ready', inProgress: true },
      { status: 'ready', inProgress: true },
      { status: 'ready', inProgress: true },
    ]);

    artifactModifiedAt.set('proposal', startedAt);
    expect(project('proposal')).toEqual({
      status: 'done',
      inProgress: false,
    });
    expect(project('specs')).toEqual({
      status: 'ready',
      inProgress: true,
    });
  });

  it('preserves official status outside a trustworthy active Update window', () => {
    const project = (
      overrides: Partial<Parameters<
        typeof __openSpecStatusTestUtils.projectArtifactRuntimeState
      >[0]> = {},
    ) => __openSpecStatusTestUtils.projectArtifactRuntimeState({
      officialStatus: 'done',
      existingOutputPaths: ['proposal.md'],
      modifiedAt: '2026-07-31T11:00:00.000Z',
      runtimeState: 'running',
      activeAction: 'update',
      activeRunStartedAt: '2026-07-31T12:00:00.000Z',
      ...overrides,
    });

    expect(project({ runtimeState: 'succeeded' })).toEqual({
      status: 'done',
      inProgress: false,
    });
    expect(project({ activeAction: 'apply' })).toEqual({
      status: 'done',
      inProgress: false,
    });
    expect(project({ activeRunStartedAt: null })).toEqual({
      status: 'done',
      inProgress: false,
    });
    expect(project({
      existingOutputPaths: [],
      modifiedAt: undefined,
    })).toEqual({
      status: 'ready',
      inProgress: true,
    });
    expect(project({
      officialStatus: 'ready',
      activeAction: 'continue',
    })).toEqual({
      status: 'ready',
      inProgress: true,
    });
  });
});

describe('OpenSpecStatusService snapshots', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses official dependencies, keeps Archive available, caches schemas, and deduplicates revisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-status-'));
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-workspace-'));
    roots.push(root, workspace);
    mkdirSync(join(root, 'openspec', 'changes', 'change-a'), { recursive: true });
    const rawStatus = statusPayload(root);

    const cli = {
      version: vi.fn().mockResolvedValue('1.6.0'),
      list: vi.fn().mockResolvedValue({
        changes: [{ name: 'change-a', status: 'no-tasks' }],
        root: { path: root, source: 'nearest' },
      }),
      status: vi.fn().mockImplementation(async () => structuredClone(rawStatus)),
      instructions: vi.fn().mockImplementation(async (_scope, input) => ({
        changeName: 'change-a',
        artifactId: input.artifactId,
        schemaName: 'spec-driven',
        changeDir: join(root, 'openspec', 'changes', 'change-a'),
        outputPath: input.artifactId === 'proposal' ? 'proposal.md' : 'design.md',
        description: `${input.artifactId} description`,
        instruction: `${input.artifactId} instruction`,
        template: `${input.artifactId} template`,
        dependencies: input.artifactId === 'design'
          ? [{
              id: 'proposal',
              done: false,
              path: 'proposal.md',
              description: 'Proposal',
            }]
          : [],
        unlocks: input.artifactId === 'proposal' ? ['design'] : [],
      })),
      schemas: vi.fn().mockResolvedValue([
        {
          name: 'spec-driven',
          description: 'Official schema',
          artifacts: ['proposal', 'design'],
          source: 'package',
        },
      ]),
    } as unknown as OpenSpecCliAdapter;
    const rootResolver = {
      resolve: vi.fn().mockReturnValue({
        cwd: workspace,
        workspaceRoot: workspace,
        rootKind: 'store',
        storeId: 'status-store',
        rootLabel: 'status-root',
        worktree: false,
      }),
      validateOfficialPlanningRoot: vi.fn((_resolved, officialRoot) => officialRoot),
      validateOfficialChangeRoot: vi.fn(),
      relativeToChangeRoot: vi.fn(),
      resolveArtifactFile: vi.fn(),
    } as unknown as OpenSpecRootResolver;
    const runtime = {
      initialize: vi.fn(),
      read: vi.fn().mockReturnValue({
        state: 'idle',
        activeAction: null,
        selectedChangeName: 'change-a',
      }),
      update: vi.fn(),
      getActiveRun: vi.fn().mockReturnValue(null),
    } as unknown as OpenSpecRuntimeStore;
    const service = new OpenSpecStatusService(cli, rootResolver, runtime);
    const currentTask = task('project-a');
    const currentProject = project(root);

    const first = await service.getSnapshot(currentTask, currentProject);
    const second = await service.getSnapshot(currentTask, currentProject);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(1);
    expect((cli.status as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [expect.anything(), { changeName: 'change-a' }],
      [expect.anything(), { changeName: 'change-a' }],
    ]);
    expect((cli.instructions as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.anything(),
          expect.objectContaining({
            changeName: 'change-a',
            schemaName: 'spec-driven',
          }),
        ],
      ]),
    );
    expect(first.schema.description).toBe('Official schema');
    expect(first.availableActions).toContain('archive');
    expect(first.actionContext).toEqual({
      planningHome: rawStatus.planningHome,
      mode: 'repo-local',
      sourceOfTruth: 'repo',
      linkedContext: ['docs/architecture.md'],
      allowedEditRoots: [root],
      requiresAffectedAreaSelection: false,
      constraints: [],
    });
    expect(first.artifacts.find((artifact) => artifact.id === 'design')).toMatchObject({
      description: 'design description',
      dependencies: ['proposal'],
      instruction: 'design instruction',
      template: 'design template',
      blocksApply: true,
    });
    expect((cli as unknown as { schemas: ReturnType<typeof vi.fn> }).schemas).toHaveBeenCalledTimes(1);
    expect((cli as unknown as { schemas: ReturnType<typeof vi.fn> }).schemas)
      .toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));

    rawStatus.nextSteps = ['Create proposal.', 'Then create design.'];
    const third = await service.getSnapshot(currentTask, currentProject);
    expect(third.revision).toBe(2);

    rawStatus.artifacts[1].status = 'done';
    rawStatus.actionContext.requiresAffectedAreaSelection = true;
    const selectionRequired = await service.getSnapshot(currentTask, currentProject);
    expect(selectionRequired.availableActions).not.toContain('apply');

    rawStatus.actionContext.requiresAffectedAreaSelection = false;
    const selectionNotRequired = await service.getSnapshot(currentTask, currentProject);
    expect(selectionNotRequired.availableActions).toContain('apply');
  });

  it('refreshes four Update artifact states as their files are revised', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-update-status-'));
    roots.push(root);
    const changeRoot = join(root, 'openspec', 'changes', 'change-a');
    const files = new Map([
      ['proposal', join(changeRoot, 'proposal.md')],
      ['specs', join(changeRoot, 'specs', 'example', 'spec.md')],
      ['design', join(changeRoot, 'design.md')],
      ['tasks', join(changeRoot, 'tasks.md')],
    ]);
    mkdirSync(join(changeRoot, 'specs', 'example'), { recursive: true });
    const startedAt = new Date('2026-07-31T12:00:00.000Z');
    const beforeUpdate = new Date('2026-07-31T11:00:00.000Z');
    for (const [id, filePath] of files) {
      writeFileSync(filePath, `# ${id}\n`);
      utimesSync(filePath, beforeUpdate, beforeUpdate);
    }

    const rawStatus = {
      ...statusPayload(root),
      artifactPaths: Object.fromEntries(
        [...files].map(([id, filePath]) => [
          id,
          {
            outputPath: id === 'specs' ? 'specs/**/*.md' : `${id}.md`,
            resolvedOutputPath: filePath,
            existingOutputPaths: [filePath],
          },
        ]),
      ),
      isComplete: true,
      applyRequires: ['tasks'],
      nextSteps: [],
      artifacts: [...files].map(([id]) => ({
        id,
        outputPath: id === 'specs' ? 'specs/**/*.md' : `${id}.md`,
        status: 'done',
        missingDeps: [],
      })),
    };
    const runtimeState: {
      state: string;
      activeAction: string | null;
      activeRunStartedAt: string | null;
      selectedChangeName: string;
      workflowStage: string;
    } = {
      state: 'running',
      activeAction: 'update',
      activeRunStartedAt: startedAt.toISOString(),
      selectedChangeName: 'change-a',
      workflowStage: 'planning',
    };
    const cli = {
      version: vi.fn().mockResolvedValue('1.6.0'),
      list: vi.fn().mockResolvedValue({
        changes: [{ name: 'change-a' }],
        root: { path: root, source: 'nearest' },
      }),
      status: vi.fn().mockImplementation(async () => structuredClone(rawStatus)),
      instructions: vi.fn().mockImplementation(async (_scope, input) => ({
        changeName: 'change-a',
        artifactId: input.artifactId,
        schemaName: 'spec-driven',
        changeDir: changeRoot,
        outputPath: rawStatus.artifactPaths[input.artifactId]?.outputPath ??
          `${input.artifactId}.md`,
        dependencies: [],
        unlocks: [],
      })),
      schemas: vi.fn().mockResolvedValue([]),
    } as unknown as OpenSpecCliAdapter;
    const rootResolver = {
      resolve: vi.fn().mockReturnValue({
        cwd: root,
        workspaceRoot: root,
        rootKind: 'project',
        rootLabel: 'root',
        worktree: false,
      }),
      validateOfficialPlanningRoot: vi.fn((_resolved, officialRoot) => officialRoot),
      validateOfficialChangeRoot: vi.fn(),
      relativeToChangeRoot: vi.fn((officialChangeRoot, filePath) =>
        relative(officialChangeRoot, filePath).replace(/\\/g, '/')),
      resolveArtifactFile: vi.fn((officialChangeRoot, relativePath) =>
        join(officialChangeRoot, relativePath)),
    } as unknown as OpenSpecRootResolver;
    const runtime = {
      initialize: vi.fn(),
      read: vi.fn(() => runtimeState),
      update: vi.fn(),
      getActiveRun: vi.fn().mockReturnValue({
        runId: 'run-update',
        action: 'update',
        state: 'running',
        startedAt: startedAt.toISOString(),
      }),
    } as unknown as OpenSpecRuntimeStore;
    const service = new OpenSpecStatusService(cli, rootResolver, runtime);
    const currentTask = task('project-a');
    const currentProject = project(root);

    const pending = await service.getSnapshot(currentTask, currentProject);
    expect(pending.artifacts).toHaveLength(4);
    expect(pending.artifacts.every((artifact) =>
      artifact.status === 'ready' && artifact.inProgress)).toBe(true);

    const proposalPath = files.get('proposal');
    expect(proposalPath).toBeDefined();
    const revisedAt = new Date('2026-07-31T12:00:01.000Z');
    utimesSync(proposalPath as string, revisedAt, revisedAt);
    const partlyUpdated = await service.getSnapshot(currentTask, currentProject);
    expect(partlyUpdated.artifacts.find((artifact) => artifact.id === 'proposal'))
      .toMatchObject({
        status: 'done',
        inProgress: false,
      });
    expect(partlyUpdated.artifacts.find((artifact) => artifact.id === 'specs'))
      .toMatchObject({
        status: 'ready',
        inProgress: true,
      });
    expect(partlyUpdated.revision).toBeGreaterThan(pending.revision);

    runtimeState.state = 'succeeded';
    runtimeState.activeAction = null;
    runtimeState.activeRunStartedAt = null;
    const completed = await service.getSnapshot(currentTask, currentProject);
    expect(completed.artifacts.every((artifact) =>
      artifact.status === 'done' && !artifact.inProgress)).toBe(true);
    expect(completed.revision).toBeGreaterThan(partlyUpdated.revision);
  });

  it('marks snapshots unsupported when upstream introduces an unknown artifact state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-status-unknown-'));
    roots.push(root);
    mkdirSync(join(root, 'openspec', 'changes', 'change-a'), { recursive: true });
    const rawStatus = statusPayload(root);
    rawStatus.artifacts[0].status = 'future-state';
    const cli = {
      version: vi.fn().mockResolvedValue('1.6.0'),
      list: vi.fn().mockResolvedValue({
        changes: [{ name: 'change-a' }],
        root: { path: root },
      }),
      status: vi.fn().mockResolvedValue(rawStatus),
      instructions: vi.fn().mockResolvedValue({
        changeName: 'change-a',
        artifactId: 'proposal',
        schemaName: 'spec-driven',
        changeDir: join(root, 'openspec', 'changes', 'change-a'),
        outputPath: 'proposal.md',
        dependencies: [],
        unlocks: [],
      }),
      schemas: vi.fn().mockResolvedValue([]),
    } as unknown as OpenSpecCliAdapter;
    const rootResolver = {
      resolve: vi.fn().mockReturnValue({
        cwd: root,
        workspaceRoot: root,
        rootKind: 'project',
        rootLabel: 'root',
        worktree: false,
      }),
      validateOfficialPlanningRoot: vi.fn(),
      validateOfficialChangeRoot: vi.fn(),
      relativeToChangeRoot: vi.fn(),
      resolveArtifactFile: vi.fn(),
    } as unknown as OpenSpecRootResolver;
    const runtime = {
      initialize: vi.fn(),
      read: vi.fn().mockReturnValue({
        state: 'idle',
        activeAction: null,
        selectedChangeName: 'change-a',
      }),
      update: vi.fn(),
      getActiveRun: vi.fn().mockReturnValue(null),
    } as unknown as OpenSpecRuntimeStore;

    const snapshot = await new OpenSpecStatusService(cli, rootResolver, runtime)
      .getSnapshot(task('project-a'), project(root));
    expect(snapshot.unsupportedStatus).toBe(true);
    expect(snapshot.artifacts[0].status).toBe('unknown');
  });

  it.each(['read', 'diff'] as const)(
    'uses one authoritative status response for artifact %s requests',
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-artifact-status-'));
      roots.push(root);
      const firstChangeRoot = join(root, 'openspec', 'changes', 'change-a');
      const racedChangeRoot = join(root, 'openspec', 'changes', 'change-raced');
      mkdirSync(firstChangeRoot, { recursive: true });
      mkdirSync(racedChangeRoot, { recursive: true });
      writeFileSync(join(firstChangeRoot, 'proposal.md'), '# Authoritative proposal\n');

      const firstStatus = statusPayload(root);
      firstStatus.artifactPaths.proposal.existingOutputPaths = [
        join(firstChangeRoot, 'proposal.md'),
      ];
      const racedStatus = structuredClone(firstStatus);
      racedStatus.changeRoot = racedChangeRoot;
      racedStatus.artifactPaths.proposal.resolvedOutputPath =
        join(racedChangeRoot, 'proposal.md');
      racedStatus.artifactPaths.proposal.existingOutputPaths = [
        join(racedChangeRoot, 'proposal.md'),
      ];

      const cli = {
        version: vi.fn().mockResolvedValue('1.6.0'),
        list: vi.fn().mockResolvedValue({
          changes: [{ name: 'change-a' }],
          root: { path: root, source: 'nearest' },
        }),
        status: vi.fn()
          .mockResolvedValueOnce(firstStatus)
          .mockResolvedValueOnce(racedStatus),
        instructions: vi.fn().mockImplementation(async (_scope, input) => ({
          changeName: 'change-a',
          artifactId: input.artifactId,
          schemaName: 'spec-driven',
          changeDir: firstChangeRoot,
          outputPath: input.artifactId === 'proposal' ? 'proposal.md' : 'design.md',
          dependencies: [],
          unlocks: [],
        })),
        schemas: vi.fn().mockResolvedValue([]),
      } as unknown as OpenSpecCliAdapter;
      const rootResolver = {
        resolve: vi.fn().mockReturnValue({
          cwd: root,
          workspaceRoot: root,
          rootKind: 'project',
          rootLabel: 'root',
          worktree: false,
        }),
        validateOfficialPlanningRoot: vi.fn((_resolved, officialRoot) => officialRoot),
        validateOfficialChangeRoot: vi.fn(),
        relativeToChangeRoot: vi.fn((changeRoot, filePath) =>
          relative(changeRoot, filePath).replace(/\\/g, '/')),
        resolveArtifactFile: vi.fn((changeRoot, relativePath) =>
          join(changeRoot, relativePath)),
      } as unknown as OpenSpecRootResolver;
      const runtime = {
        initialize: vi.fn(),
        read: vi.fn().mockReturnValue({
          state: 'idle',
          activeAction: null,
          selectedChangeName: 'change-a',
        }),
        update: vi.fn(),
        getActiveRun: vi.fn().mockReturnValue(null),
      } as unknown as OpenSpecRuntimeStore;
      const service = new OpenSpecStatusService(cli, rootResolver, runtime);
      const input = {
        taskId: 'task-spec',
        expectedChangeName: 'change-a',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      };

      const result = operation === 'read'
        ? await service.readArtifact(task('project-a'), project(root), input)
        : await service.getArtifactDiff(task('project-a'), project(root), input);

      expect(result.relativePath).toBe('proposal.md');
      expect(cli.status).toHaveBeenCalledTimes(1);
      expect(rootResolver.resolveArtifactFile).toHaveBeenLastCalledWith(
        firstChangeRoot,
        'proposal.md',
      );
    },
  );

  it.each(['read', 'diff'] as const)(
    'rejects an artifact %s request when its expected change is no longer selected',
    async (operation) => {
      const root = mkdtempSync(
        join(tmpdir(), 'aperant-openspec-stale-artifact-change-'),
      );
      roots.push(root);
      const changeRoot = join(root, 'openspec', 'changes', 'change-b');
      mkdirSync(changeRoot, { recursive: true });
      writeFileSync(join(changeRoot, 'proposal.md'), '# Change B proposal\n');

      const rawStatus = statusPayload(root);
      rawStatus.changeName = 'change-b';
      rawStatus.changeRoot = changeRoot;
      rawStatus.artifactPaths.proposal.resolvedOutputPath =
        join(changeRoot, 'proposal.md');
      rawStatus.artifactPaths.proposal.existingOutputPaths = [
        join(changeRoot, 'proposal.md'),
      ];
      const resolveArtifactFile = vi.fn();
      const rootResolver = {
        resolve: vi.fn(),
        validateOfficialPlanningRoot: vi.fn(),
        validateOfficialChangeRoot: vi.fn(),
        resolveArtifactFile,
      } as unknown as OpenSpecRootResolver;
      const service = new OpenSpecStatusService(
        {} as OpenSpecCliAdapter,
        rootResolver,
        {} as OpenSpecRuntimeStore,
      );
      vi.spyOn(service, 'getSnapshot').mockResolvedValue({
        taskId: 'task-spec',
        openSpecVersion: '1.6.0',
        rootKind: 'project',
        rootLabel: 'root',
        initialized: true,
        changeName: 'change-b',
        schema: { name: 'spec-driven' },
        artifacts: [{
          id: 'proposal',
          outputPath: 'proposal.md',
          status: 'done',
          missingDeps: [],
          existingOutputPaths: ['proposal.md'],
          dependencies: [],
          unlocks: [],
          inProgress: false,
          blocksApply: false,
        }],
        applyRequires: [],
        activeRun: null,
        validation: null,
        nextSteps: [],
        availableActions: ['update'],
        rawStatus,
        archived: false,
        revision: 2,
      });
      const input = {
        taskId: 'task-spec',
        expectedChangeName: 'change-a',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      };

      let thrown: unknown;
      try {
        if (operation === 'read') {
          await service.readArtifact(task('project-a'), project(root), input);
        } else {
          await service.getArtifactDiff(task('project-a'), project(root), input);
        }
      } catch (error) {
        thrown = error;
      }

      expect(isOpenSpecArtifactRefreshRequiredError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain(
        OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE,
      );
      expect((thrown as Error).message).not.toMatch(
        /[A-Z]:\\|\/tmp\/|change-b[\\/]/i,
      );
      expect(rootResolver.resolve).not.toHaveBeenCalled();
      expect(resolveArtifactFile).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'diff'] as const)(
    'returns a stable artifact error when the selected change root disappears before %s',
    async (operation) => {
      const root = mkdtempSync(
        join(tmpdir(), 'aperant-openspec-missing-artifact-root-'),
      );
      roots.push(root);
      const rawStatus = statusPayload(root);
      const missingChangeRoot = rawStatus.changeRoot;
      rawStatus.artifactPaths.proposal.existingOutputPaths = [
        join(missingChangeRoot, 'proposal.md'),
      ];
      const service = new OpenSpecStatusService(
        {} as OpenSpecCliAdapter,
        new OpenSpecRootResolver(),
        {} as OpenSpecRuntimeStore,
      );
      vi.spyOn(service, 'getSnapshot').mockResolvedValue({
        taskId: 'task-spec',
        openSpecVersion: '1.6.0',
        rootKind: 'project',
        rootLabel: 'root',
        initialized: true,
        changeName: 'change-a',
        schema: { name: 'spec-driven' },
        artifacts: [{
          id: 'proposal',
          outputPath: 'proposal.md',
          status: 'done',
          missingDeps: [],
          existingOutputPaths: ['proposal.md'],
          dependencies: [],
          unlocks: [],
          inProgress: false,
          blocksApply: false,
        }],
        applyRequires: [],
        activeRun: null,
        validation: null,
        nextSteps: [],
        availableActions: ['update'],
        rawStatus,
        archived: false,
        revision: 1,
      } as OpenSpecBoardSnapshot);
      const input = {
        taskId: 'task-spec',
        expectedChangeName: 'change-a',
        artifactId: 'proposal',
        relativePath: 'proposal.md',
      };

      let thrown: unknown;
      try {
        if (operation === 'read') {
          await service.readArtifact(task('project-a'), project(root), input);
        } else {
          await service.getArtifactDiff(task('project-a'), project(root), input);
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        'Requested OpenSpec artifact is no longer available.',
      );
      expect((thrown as Error).message).not.toMatch(
        /ENOENT|realpath|[A-Z]:\\|\/tmp\//i,
      );
    },
  );

  it('recognizes the official dated archive directory when the selected change is no longer active', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-status-archive-'));
    roots.push(root);
    mkdirSync(
      join(root, 'openspec', 'changes', 'archive', '2026-07-28-change-a'),
      { recursive: true },
    );
    const cli = {
      version: vi.fn().mockResolvedValue('1.6.0'),
      list: vi.fn().mockResolvedValue({
        changes: [],
        root: { path: root, source: 'nearest' },
      }),
    } as unknown as OpenSpecCliAdapter;
    const rootResolver = {
      resolve: vi.fn().mockReturnValue({
        cwd: root,
        workspaceRoot: root,
        rootKind: 'project',
        rootLabel: 'root',
        worktree: false,
      }),
    } as unknown as OpenSpecRootResolver;
    const runtime = {
      initialize: vi.fn(),
      read: vi.fn().mockReturnValue({
        state: 'idle',
        activeAction: null,
        selectedChangeName: 'change-a',
      }),
      getActiveRun: vi.fn().mockReturnValue(null),
    } as unknown as OpenSpecRuntimeStore;

    const snapshot = await new OpenSpecStatusService(cli, rootResolver, runtime)
      .getSnapshot(task('project-a'), project(root));
    expect(snapshot).toMatchObject({
      archived: true,
      changeName: 'change-a',
      artifacts: [],
    });
    expect(snapshot.nextSteps[0]).toMatch(/archived/i);
  });
});
