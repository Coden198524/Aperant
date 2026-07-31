import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenSpecBoardSnapshot,
  Project,
  Task,
} from '../../shared/types';
import type { OpenSpecCliScope } from './openspec-cli-adapter';
import {
  OpenSpecService,
  __openSpecServiceTestUtils,
} from './openspec-service';
import type { OpenSpecRuntimeFile } from './openspec-runtime-store';

function changeStatusPayload(
  root: string,
  changeName: string,
  schemaName: string,
  artifactId: string,
) {
  const changeRoot = join(root, 'openspec', 'changes', changeName);
  const outputPath = `${artifactId}.md`;
  return {
    changeName,
    schemaName,
    planningHome: {
      kind: 'repo',
      root,
      changesDir: join(root, 'openspec', 'changes'),
      defaultSchema: 'spec-driven',
    },
    changeRoot,
    artifactPaths: {
      [artifactId]: {
        outputPath,
        resolvedOutputPath: join(changeRoot, outputPath),
        existingOutputPaths: [],
      },
    },
    isComplete: false,
    applyRequires: [artifactId],
    nextSteps: [`Create ${artifactId}.`],
    artifacts: [{
      id: artifactId,
      outputPath,
      status: 'ready',
      missingDeps: [],
    }],
    root: {
      path: root,
      source: 'nearest',
    },
  };
}

describe('OpenSpecService watcher scope', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('watches workspace, external Store planning root, and the real Git index', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-watch-workspace-'));
    const planningRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-watch-store-'));
    temporaryRoots.push(workspace, planningRoot);
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore', windowsHide: true });
    writeFileSync(join(workspace, 'tracked.txt'), 'tracked\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], {
      cwd: workspace,
      stdio: 'ignore',
      windowsHide: true,
    });

    const indexPath = __openSpecServiceTestUtils.gitIndexPath(workspace);
    expect(indexPath).toBeTruthy();
    expect(__openSpecServiceTestUtils.buildOpenSpecWatchPaths(
      workspace,
      planningRoot,
    )).toEqual([
      resolve(indexPath as string),
      resolve(planningRoot),
      resolve(workspace),
    ].sort());
  });

  it('releases only the watchers inside a worktree before it is deleted', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-release-'));
    temporaryRoots.push(projectRoot);
    const worktreePath = join(
      projectRoot,
      '.autocode',
      'worktrees',
      'tasks',
      '005-spec-task',
    );
    mkdirSync(join(worktreePath, 'openspec'), { recursive: true });

    const service = new OpenSpecService({} as never, vi.fn(), vi.fn());
    const internal = service as unknown as {
      watchers: Map<string, {
        watcher: { close: () => Promise<void> };
        paths: string[];
        timer: ReturnType<typeof setTimeout> | null;
      }>;
    };
    const closeWorktreeRoot = vi.fn().mockResolvedValue(undefined);
    const closeNestedPlanningRoot = vi.fn().mockResolvedValue(undefined);
    const closeProjectRoot = vi.fn().mockResolvedValue(undefined);
    const pendingReconcile = setTimeout(() => undefined, 60_000);
    internal.watchers.set('worktree-root', {
      watcher: { close: closeWorktreeRoot },
      paths: [worktreePath],
      timer: pendingReconcile,
    });
    internal.watchers.set('worktree-planning-root', {
      watcher: { close: closeNestedPlanningRoot },
      paths: [join(worktreePath, 'openspec')],
      timer: null,
    });
    internal.watchers.set('project-root', {
      watcher: { close: closeProjectRoot },
      paths: [projectRoot],
      timer: null,
    });

    await service.releaseWorktreeHandles(
      { id: 'project-a', path: projectRoot } as Project,
      worktreePath,
    );

    expect(closeWorktreeRoot).toHaveBeenCalledOnce();
    expect(closeNestedPlanningRoot).toHaveBeenCalledOnce();
    expect(closeProjectRoot).not.toHaveBeenCalled();
    expect([...internal.watchers.keys()]).toEqual(['project-root']);

    clearTimeout(pendingReconcile);
  });

  it('does not ignore an explicitly watched Git index while ignoring broad internal trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-watch-ignore-'));
    temporaryRoots.push(root);
    const indexPath = join(root, '.git', 'index');
    const explicit = new Set([resolve(indexPath)]);
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      indexPath,
      explicit,
    )).toBe(false);
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      join(root, '.git', 'objects', 'pack'),
      explicit,
    )).toBe(true);
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      join(root, 'node_modules', 'package', 'index.js'),
      explicit,
    )).toBe(true);
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      join(root, '.autocode', 'specs', 'runtime.json'),
      explicit,
    )).toBe(true);

    const worktreeRoot = join(
      root,
      '.autocode',
      'worktrees',
      'tasks',
      'spec-watch-task',
    );
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      join(worktreeRoot, 'openspec', 'changes', 'change-a', 'tasks.md'),
      explicit,
      [worktreeRoot],
    )).toBe(false);
    expect(__openSpecServiceTestUtils.shouldIgnoreOpenSpecWatchPath(
      join(worktreeRoot, 'node_modules', 'package', 'index.js'),
      explicit,
      [worktreeRoot],
    )).toBe(true);
  });

  it('derives the official planning root from the authoritative status payload', () => {
    const planningRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-status-root-'));
    temporaryRoots.push(planningRoot);
    const snapshot = {
      rawStatus: {
        planningHome: {
          root: planningRoot,
        },
      },
    } as OpenSpecBoardSnapshot;
    expect(__openSpecServiceTestUtils.statusPlanningRoot(snapshot))
      .toBe(resolve(planningRoot));
  });

  it('reconciles an external OpenSpec edit when the workspace is inside .autocode/worktrees', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-watch-external-'));
    temporaryRoots.push(projectRoot);
    const workspace = join(
      projectRoot,
      '.autocode',
      'worktrees',
      'tasks',
      'spec-watch-task',
    );
    mkdirSync(workspace, { recursive: true });
    const openSpecRoot = join(workspace, 'openspec');
    mkdirSync(openSpecRoot, { recursive: true });
    const configPath = join(openSpecRoot, 'config.yaml');
    writeFileSync(configPath, 'schema: spec-driven\n', 'utf8');

    const task = {
      id: 'spec-watch-task',
      specId: 'spec-watch-task',
      projectId: 'project-watch',
      title: 'Watch OpenSpec',
      description: 'Refresh after an external edit.',
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata: {
        developmentMode: 'spec',
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          schemaName: 'spec-driven',
        },
      },
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      updatedAt: new Date('2026-07-28T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'project-watch',
      name: 'Watch project',
      path: workspace,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;
    const publish = vi.fn();
    const service = new OpenSpecService(
      {} as never,
      publish,
      vi.fn(),
    );
    let revision = 0;
    vi.spyOn(service.status, 'getSnapshot').mockImplementation(async () => ({
      taskId: task.id,
      openSpecVersion: '1.6.0',
      rootKind: 'project',
      rootLabel: 'Watch project',
      initialized: true,
      changeName: 'watch-change',
      schema: { name: 'spec-driven' },
      artifacts: [],
      applyRequires: [],
      activeRun: null,
      validation: null,
      nextSteps: [readFileSync(configPath, 'utf8').trim()],
      availableActions: ['explore'],
      archived: false,
      revision: ++revision,
    }));

    try {
      const initial = await service.getSnapshot(task, project);
      expect(initial.revision).toBe(1);

      writeFileSync(configPath, 'schema: product-flow\n', 'utf8');

      await vi.waitFor(() => {
        expect(publish).toHaveBeenCalledWith(
          task,
          project,
          expect.objectContaining({
            type: 'snapshot',
            snapshot: expect.objectContaining({
              revision: 2,
              nextSteps: ['schema: product-flow'],
            }),
          }),
        );
      }, {
        timeout: 5_000,
        interval: 50,
      });
    } finally {
      await service.dispose();
    }
  }, 10_000);

  it('reruns an in-flight reconciliation after a watched artifact changes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-watch-race-'));
    temporaryRoots.push(workspace);
    const openSpecRoot = join(workspace, 'openspec');
    mkdirSync(openSpecRoot, { recursive: true });
    const configPath = join(openSpecRoot, 'config.yaml');
    writeFileSync(configPath, 'schema: spec-driven\n', 'utf8');

    const task = {
      id: 'spec-watch-race-task',
      specId: 'spec-watch-race-task',
      projectId: 'project-watch-race',
      title: 'Watch OpenSpec race',
      description: 'Do not reuse a stale reconciliation after an artifact edit.',
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata: {
        developmentMode: 'spec',
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          schemaName: 'spec-driven',
        },
      },
      createdAt: new Date('2026-07-31T00:00:00.000Z'),
      updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'project-watch-race',
      name: 'Watch race project',
      path: workspace,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;
    const publish = vi.fn();
    const service = new OpenSpecService(
      {} as never,
      publish,
      vi.fn(),
    );
    const boardSnapshot = (
      revision: number,
      nextStep: string,
    ): OpenSpecBoardSnapshot => ({
      taskId: task.id,
      openSpecVersion: '1.6.0',
      rootKind: 'project',
      rootLabel: project.name,
      initialized: true,
      changeName: 'watch-change',
      schema: { name: 'spec-driven' },
      artifacts: [],
      applyRequires: [],
      activeRun: null,
      validation: null,
      nextSteps: [nextStep],
      availableActions: ['explore'],
      archived: false,
      revision,
    });
    let resolveInFlight:
      | ((snapshot: OpenSpecBoardSnapshot) => void)
      | undefined;
    const inFlightSnapshot = new Promise<OpenSpecBoardSnapshot>((resolvePending) => {
      resolveInFlight = resolvePending;
    });
    const getSnapshot = vi.spyOn(service.status, 'getSnapshot')
      .mockResolvedValueOnce(boardSnapshot(1, 'schema: spec-driven'))
      .mockImplementationOnce(async () => await inFlightSnapshot)
      .mockImplementationOnce(async () =>
        boardSnapshot(3, readFileSync(configPath, 'utf8').trim()));

    try {
      await service.getSnapshot(task, project);
      const inFlightReconcile = service.reconcile(task, project, true);
      await vi.waitFor(() => {
        expect(getSnapshot).toHaveBeenCalledTimes(2);
      });

      writeFileSync(configPath, 'schema: product-flow\n', 'utf8');
      const generations = (
        service as unknown as {
          reconcileGenerations: Map<string, number>;
        }
      ).reconcileGenerations;
      await vi.waitFor(() => {
        expect(
          generations.get(`${project.id}::${task.id}`) ?? 0,
        ).toBeGreaterThan(0);
      }, {
        timeout: 5_000,
        interval: 50,
      });

      resolveInFlight?.(boardSnapshot(2, 'schema: spec-driven'));
      const reconciled = await inFlightReconcile;

      expect(getSnapshot).toHaveBeenCalledTimes(3);
      expect(reconciled.nextSteps).toEqual(['schema: product-flow']);
      expect(publish).toHaveBeenCalledWith(
        task,
        project,
        expect.objectContaining({
          type: 'snapshot',
          snapshot: expect.objectContaining({
            nextSteps: ['schema: product-flow'],
          }),
        }),
      );
    } finally {
      resolveInFlight?.(boardSnapshot(2, 'schema: spec-driven'));
      await service.dispose();
    }
  }, 10_000);

  it('restarts an in-flight reconciliation after selecting another Change', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-select-race-'));
    temporaryRoots.push(workspace);
    mkdirSync(join(workspace, 'openspec', 'changes', 'change-a'), {
      recursive: true,
    });
    mkdirSync(join(workspace, 'openspec', 'changes', 'change-b'), {
      recursive: true,
    });

    const task = {
      id: 'select-race-task',
      specId: 'select-race-task',
      projectId: 'select-race-project',
      title: 'Select Change during reconcile',
      description: 'Keep the selected Change authoritative.',
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
      createdAt: new Date('2026-07-31T00:00:00.000Z'),
      updatedAt: new Date('2026-07-31T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'select-race-project',
      name: 'Select race project',
      path: workspace,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;
    const publish = vi.fn();
    const service = new OpenSpecService(
      {} as never,
      publish,
      vi.fn(),
    );
    const snapshot = (
      changeName: string,
      revision: number,
    ): OpenSpecBoardSnapshot => ({
      taskId: task.id,
      openSpecVersion: '1.6.0',
      rootKind: 'project',
      rootLabel: project.name,
      initialized: true,
      changeName,
      schema: { name: 'spec-driven' },
      artifacts: [],
      applyRequires: [],
      activeRun: null,
      validation: null,
      nextSteps: [],
      availableActions: ['explore'],
      archived: false,
      revision,
    });
    const oldSnapshot = snapshot('change-a', 1);
    const selectedSnapshot = snapshot('change-b', 2);
    let resolveOldSnapshot: ((value: OpenSpecBoardSnapshot) => void) | undefined;
    const pendingOldSnapshot = new Promise<OpenSpecBoardSnapshot>((resolvePending) => {
      resolveOldSnapshot = resolvePending;
    });
    const getSnapshot = vi.spyOn(service.status, 'getSnapshot')
      .mockImplementationOnce(async () => await pendingOldSnapshot)
      .mockResolvedValueOnce(selectedSnapshot);
    vi.spyOn(service.status, 'listChanges').mockResolvedValue([
      {
        name: 'change-a',
        completedTasks: 0,
        totalTasks: 0,
        status: 'active',
      },
      {
        name: 'change-b',
        completedTasks: 0,
        totalTasks: 0,
        status: 'active',
      },
    ]);

    try {
      const initialReconcile = service.reconcile(task, project, true);
      await vi.waitFor(() => {
        expect(getSnapshot).toHaveBeenCalledTimes(1);
      });

      const selectChange = service.selectChange(task, project, 'change-b');
      await vi.waitFor(() => {
        expect(service.runtimeStore.read(task, project).selectedChangeName)
          .toBe('change-b');
      });

      resolveOldSnapshot?.(oldSnapshot);
      const [initialResult, selectedResult] = await Promise.all([
        initialReconcile,
        selectChange,
      ]);

      expect(getSnapshot).toHaveBeenCalledTimes(2);
      expect(initialResult.changeName).toBe('change-b');
      expect(selectedResult.changeName).toBe('change-b');
      expect(publish.mock.calls
        .map(([, , event]) => event)
        .filter((event) => event.type === 'snapshot'))
        .toEqual([
          expect.objectContaining({
            snapshot: expect.objectContaining({
              changeName: 'change-b',
            }),
          }),
        ]);
    } finally {
      await service.dispose();
    }
  }, 10_000);

  it('uses each selected Change schema instead of the task creation schema', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aperant-openspec-mixed-schema-'));
    temporaryRoots.push(workspace);
    mkdirSync(join(workspace, 'openspec', 'changes', 'spec-change'), {
      recursive: true,
    });
    mkdirSync(join(workspace, 'openspec', 'changes', 'custom-change'), {
      recursive: true,
    });

    const task = {
      id: 'mixed-schema-task',
      specId: 'mixed-schema-task',
      projectId: 'mixed-schema-project',
      title: 'Mixed schema task',
      description: 'Switch between changes created with different schemas.',
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata: {
        developmentMode: 'spec',
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          schemaName: 'spec-driven',
          changeName: 'spec-change',
        },
      },
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'mixed-schema-project',
      name: 'Mixed schema project',
      path: workspace,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;
    const service = new OpenSpecService(
      {} as never,
      vi.fn(),
      vi.fn(),
    );
    const payloads = {
      'spec-change': changeStatusPayload(
        workspace,
        'spec-change',
        'spec-driven',
        'proposal',
      ),
      'custom-change': changeStatusPayload(
        workspace,
        'custom-change',
        'custom-board',
        'brief',
      ),
    };

    vi.spyOn(service.cli, 'version').mockResolvedValue('1.6.0');
    vi.spyOn(service.cli, 'list').mockImplementation(async <T>() => ({
      changes: [
        { name: 'spec-change', status: 'active' },
        { name: 'custom-change', status: 'active' },
      ],
      root: { path: workspace, source: 'nearest' },
    }) as T);
    const status = vi.spyOn(service.cli, 'status').mockImplementation(
      async <T>(
        _scope: OpenSpecCliScope,
        input: {
          changeName: string;
          schemaName?: string;
          signal?: AbortSignal;
        },
      ) => structuredClone(
        payloads[input.changeName as keyof typeof payloads],
      ) as T,
    );
    const instructions = vi.spyOn(service.cli, 'instructions').mockImplementation(
      async <T>(
        _scope: OpenSpecCliScope,
        input: {
          artifactId: string;
          changeName: string;
          schemaName?: string;
          signal?: AbortSignal;
        },
      ) => {
        const payload = payloads[input.changeName as keyof typeof payloads];
        const artifact = payload.artifacts[0];
        return {
          changeName: input.changeName,
          artifactId: input.artifactId,
          schemaName: payload.schemaName,
          changeDir: payload.changeRoot,
          outputPath: artifact.outputPath,
          description: `${payload.schemaName} ${artifact.id}`,
          dependencies: [],
          unlocks: [],
        } as T;
      },
    );
    vi.spyOn(service.cli, 'schemas').mockImplementation(async <T>() => ([
      {
        name: 'spec-driven',
        description: 'Default schema',
        artifacts: ['proposal'],
        source: 'package',
      },
      {
        name: 'custom-board',
        description: 'Custom board schema',
        artifacts: ['brief'],
        source: 'project',
      },
    ]) as T);

    try {
      const initial = await service.getSnapshot(task, project);
      expect(initial.schema.name).toBe('spec-driven');
      expect(initial.artifacts.map((artifact) => artifact.id)).toEqual([
        'proposal',
      ]);

      const selected = await service.selectChange(task, project, 'custom-change');
      expect(selected.schema).toMatchObject({
        name: 'custom-board',
        description: 'Custom board schema',
      });
      expect(selected.artifacts.map((artifact) => artifact.id)).toEqual([
        'brief',
      ]);

      expect(status.mock.calls.map(([, input]) => input)).toEqual([
        { changeName: 'spec-change' },
        { changeName: 'custom-change' },
      ]);
      expect(instructions).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          changeName: 'custom-change',
          artifactId: 'brief',
          schemaName: 'custom-board',
        }),
      );
    } finally {
      await service.dispose();
    }
  }, 10_000);
});

function startTaskFixture(): Task {
  return {
    id: 'resume-spec-task',
    specId: 'resume-spec-task',
    projectId: 'resume-spec-project',
    title: 'Resume Spec task',
    description: 'Build the requested feature without restarting its OpenSpec Change.',
    status: 'human_review',
    reviewReason: 'stopped',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      openSpec: {
        formatVersion: 1,
        rootKind: 'project',
        schemaName: 'spec-driven',
        startAction: 'new',
      },
    },
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T00:00:00.000Z'),
  };
}

function startProjectFixture(): Project {
  return {
    id: 'resume-spec-project',
    name: 'Resume Spec project',
    path: 'E:\\Work\\ResumeSpecProject',
    autoBuildPath: '.autocode',
    settings: {},
  } as Project;
}

function startSnapshot(
  overrides: Partial<OpenSpecBoardSnapshot> = {},
): OpenSpecBoardSnapshot {
  return {
    taskId: 'resume-spec-task',
    openSpecVersion: '1.6.0',
    rootKind: 'project',
    rootLabel: 'Resume Spec project',
    initialized: true,
    changeName: 'existing-change',
    schema: { name: 'spec-driven' },
    artifacts: [{
      id: 'proposal',
      outputPath: 'proposal.md',
      status: 'ready',
      missingDeps: [],
      existingOutputPaths: [],
      dependencies: [],
      unlocks: [],
      inProgress: false,
      blocksApply: true,
    }],
    applyRequires: ['tasks'],
    activeRun: null,
    validation: null,
    nextSteps: [],
    availableActions: ['continue', 'explore'],
    archived: false,
    revision: 1,
    ...overrides,
  };
}

function startRuntime(
  overrides: Partial<OpenSpecRuntimeFile> = {},
): OpenSpecRuntimeFile {
  return {
    formatVersion: 1,
    taskStatus: 'human_review',
    reviewReason: 'stopped',
    workflowStage: 'planning',
    executionPhase: 'cancelled',
    activeRunId: null,
    activeRunStartedAt: null,
    activeAction: null,
    state: 'cancelled',
    waitingInteraction: null,
    lastSuccessfulAction: 'continue',
    selectedChangeName: 'existing-change',
    lastReconciledAt: '2026-07-31T00:10:00.000Z',
    lastStatusDigest: 'status-digest',
    lastError: null,
    recoveryInput: null,
    interruptedFromState: null,
    waitingReason: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:10:00.000Z',
    ...overrides,
  };
}

describe('OpenSpecService task-level continuation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serviceWithStatus(
    snapshot: OpenSpecBoardSnapshot,
    runtime: OpenSpecRuntimeFile = startRuntime(),
  ): {
    service: OpenSpecService;
    task: Task;
    project: Project;
  } {
    const task = startTaskFixture();
    const project = startProjectFixture();
    const service = new OpenSpecService({} as never, vi.fn(), vi.fn());
    vi.spyOn(service, 'getSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(service.runtimeStore, 'read').mockReturnValue(runtime);
    return { service, task, project };
  }

  it('continues a ready existing Change instead of replaying the configured New Action', async () => {
    const { service, task, project } = serviceWithStatus(startSnapshot());
    const runAction = vi.spyOn(service, 'runAction')
      .mockResolvedValue({ runId: 'continue-run' });

    await expect(service.startTask(task, project)).resolves.toEqual({
      runId: 'continue-run',
    });
    expect(runAction).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledWith(task, project, {
      taskId: task.id,
      projectId: project.id,
      action: 'continue',
      changeName: 'existing-change',
    });
  });

  it('retries Apply from official task progress after a failed implementation run', async () => {
    const snapshot = startSnapshot({
      artifacts: [{
        ...startSnapshot().artifacts[0],
        id: 'tasks',
        outputPath: 'tasks.md',
        status: 'done',
        blocksApply: false,
      }],
      taskProgress: { completed: 1, total: 3 },
      availableActions: ['apply', 'verify', 'archive'],
    });
    const { service, task, project } = serviceWithStatus(
      snapshot,
      startRuntime({
        state: 'failed',
        workflowStage: 'implementation',
        executionPhase: 'failed',
        lastError: 'Provider failed during Apply.',
      }),
    );
    const runAction = vi.spyOn(service, 'runAction')
      .mockResolvedValue({ runId: 'apply-run' });

    await service.startTask(task, project);

    expect(runAction).toHaveBeenCalledWith(task, project, {
      taskId: task.id,
      projectId: project.id,
      action: 'apply',
      changeName: 'existing-change',
    });
  });

  it('does not cross the planning review gate through generic task start', async () => {
    const planningReady = startSnapshot({
      artifacts: [{
        ...startSnapshot().artifacts[0],
        id: 'tasks',
        outputPath: 'tasks.md',
        status: 'done',
        blocksApply: false,
      }],
      taskProgress: { completed: 0, total: 3 },
      availableActions: ['update', 'apply', 'verify', 'archive'],
    });
    const { service, task, project } = serviceWithStatus(
      planningReady,
      startRuntime({
        workflowStage: 'planning',
        reviewReason: 'plan_review',
      }),
    );
    const runAction = vi.spyOn(service, 'runAction')
      .mockResolvedValue({ runId: 'unexpected-apply-run' });

    await expect(service.startTask(task, project)).rejects.toThrow(
      'explicitly select Start implementation',
    );
    expect(runAction).not.toHaveBeenCalled();
  });

  it('uses the configured start Action only for a genuinely empty workflow', async () => {
    const snapshot = startSnapshot({
      initialized: false,
      changeName: null,
      artifacts: [],
      applyRequires: [],
      availableActions: ['new', 'propose', 'explore'],
    });
    const { service, task, project } = serviceWithStatus(
      snapshot,
      startRuntime({
        state: 'idle',
        executionPhase: 'idle',
        lastSuccessfulAction: null,
        selectedChangeName: null,
      }),
    );
    const runAction = vi.spyOn(service, 'runAction')
      .mockResolvedValue({ runId: 'new-run' });

    await service.startTask(task, project);

    expect(runAction).toHaveBeenCalledWith(task, project, {
      taskId: task.id,
      projectId: project.id,
      action: 'new',
      arguments: task.description,
    });
  });

  it('retries the saved initial Action when an interruption happened before any Change existed', async () => {
    const interruptedRuntime = startRuntime({
      state: 'interrupted',
      executionPhase: 'interrupted',
      activeRunId: 'interrupted-propose-run',
      activeRunStartedAt: '2026-07-31T00:05:00.000Z',
      activeAction: 'propose',
      selectedChangeName: null,
      recoveryInput: {
        action: 'propose',
        changeName: 'recovered-change',
        arguments: 'Preserve the original proposal request.',
      },
      interruptedFromState: 'running',
    });
    const { service, task, project } = serviceWithStatus(
      startSnapshot({
        initialized: true,
        changeName: null,
        artifacts: [],
        applyRequires: [],
        activeRun: {
          runId: 'interrupted-propose-run',
          action: 'propose',
          state: 'interrupted',
          startedAt: '2026-07-31T00:05:00.000Z',
          recoverable: true,
        },
        availableActions: ['new', 'propose', 'explore'],
      }),
      interruptedRuntime,
    );
    vi.spyOn(service.status, 'listChanges').mockResolvedValue([]);
    const runner = Reflect.get(service, 'runner') as {
      runAction: (
        task: Task,
        project: Project,
        input: {
          taskId: string;
          projectId: string;
          action: string;
          changeName?: string;
          arguments?: string;
        },
        options?: { resumeRunId?: string },
      ) => Promise<{ runId: string }>;
    };
    const runAction = vi.spyOn(runner, 'runAction')
      .mockResolvedValue({ runId: 'retried-propose-run' });

    await service.startTask(task, project);

    expect(runAction).toHaveBeenCalledWith(
      task,
      project,
      {
        taskId: task.id,
        projectId: project.id,
        action: 'propose',
        changeName: 'recovered-change',
        arguments: 'Preserve the original proposal request.',
      },
      { resumeRunId: 'interrupted-propose-run' },
    );
  });

  it('derives Continue from status when an interrupted New already created a Change', async () => {
    const interruptedRuntime = startRuntime({
      state: 'interrupted',
      executionPhase: 'interrupted',
      activeRunId: 'interrupted-new-run',
      activeRunStartedAt: '2026-07-31T00:05:00.000Z',
      activeAction: 'new',
      recoveryInput: {
        action: 'new',
        arguments: 'Build the requested feature.',
      },
      interruptedFromState: 'running',
    });
    const { service, task, project } = serviceWithStatus(
      startSnapshot({
        activeRun: {
          runId: 'interrupted-new-run',
          action: 'new',
          state: 'interrupted',
          startedAt: '2026-07-31T00:05:00.000Z',
          recoverable: true,
        },
      }),
      interruptedRuntime,
    );
    const runner = Reflect.get(service, 'runner') as {
      runAction: (
        task: Task,
        project: Project,
        input: {
          taskId: string;
          projectId: string;
          action: string;
          changeName?: string;
        },
        options?: { resumeRunId?: string },
      ) => Promise<{ runId: string }>;
    };
    const runAction = vi.spyOn(runner, 'runAction')
      .mockResolvedValue({ runId: 'derived-continue-run' });

    await service.startTask(task, project);

    expect(runAction).toHaveBeenCalledWith(
      task,
      project,
      {
        taskId: task.id,
        projectId: project.id,
        action: 'continue',
        changeName: 'existing-change',
      },
      { resumeRunId: 'interrupted-new-run' },
    );
  });

  it('never auto-confirms an interrupted Archive Action', async () => {
    const { service, task, project } = serviceWithStatus(
      startSnapshot({
        activeRun: {
          runId: 'interrupted-archive-run',
          action: 'archive',
          state: 'interrupted',
          startedAt: '2026-07-31T00:05:00.000Z',
          recoverable: true,
        },
      }),
      startRuntime({
        state: 'interrupted',
        activeRunId: 'interrupted-archive-run',
        activeRunStartedAt: '2026-07-31T00:05:00.000Z',
        activeAction: 'archive',
        recoveryInput: {
          action: 'archive',
          changeName: 'existing-change',
        },
        interruptedFromState: 'running',
      }),
    );
    const runAction = vi.spyOn(service, 'runAction');

    await expect(service.startTask(task, project)).rejects.toThrow(
      'archive requires explicit confirmation to resume.',
    );
    expect(runAction).not.toHaveBeenCalled();
  });

  it('coalesces duplicate task-start requests into one OpenSpec Action', async () => {
    const { service, task, project } = serviceWithStatus(startSnapshot());
    const runAction = vi.spyOn(service, 'runAction')
      .mockResolvedValue({ runId: 'single-continue-run' });

    const results = await Promise.all([
      service.startTask(task, project),
      service.startTask(task, project),
    ]);

    expect(results).toEqual([
      { runId: 'single-continue-run' },
      { runId: 'single-continue-run' },
    ]);
    expect(service.getSnapshot).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledOnce();
  });

  it('does not create another Change when multiple active Changes require selection', async () => {
    const { service, task, project } = serviceWithStatus(startSnapshot({
      changeName: null,
      artifacts: [],
      applyRequires: [],
      availableActions: ['new', 'propose', 'explore', 'bulk-archive'],
    }));
    vi.spyOn(service.status, 'listChanges').mockResolvedValue([
      {
        name: 'change-a',
        completedTasks: 0,
        totalTasks: 0,
        status: 'active',
      },
      {
        name: 'change-b',
        completedTasks: 0,
        totalTasks: 0,
        status: 'active',
      },
    ]);
    const runAction = vi.spyOn(service, 'runAction');

    await expect(service.startTask(task, project)).rejects.toThrow(
      'Select an existing OpenSpec Change',
    );
    expect(runAction).not.toHaveBeenCalled();
  });

  it('does not restart an archived Change', async () => {
    const { service, task, project } = serviceWithStatus(startSnapshot({
      artifacts: [],
      availableActions: ['new', 'propose', 'explore'],
      archived: true,
    }));
    const runAction = vi.spyOn(service, 'runAction');

    await expect(service.startTask(task, project)).rejects.toThrow(
      'already archived',
    );
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe('OpenSpecService archived worktree recovery', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('self-heals legacy status once and serves offline history without recreating the worktree', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aperant-openspec-archived-'));
    temporaryRoots.push(projectRoot);
    const task = {
      id: 'archived-spec-task',
      specId: 'archived-spec-task',
      projectId: 'archived-project',
      title: 'Archived Spec task',
      description: 'Already archived.',
      status: 'backlog',
      subtasks: [],
      logs: [],
      metadata: {
        developmentMode: 'spec',
        useWorktree: true,
        openSpec: {
          formatVersion: 1,
          rootKind: 'project',
          schemaName: 'spec-driven',
        },
      },
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      updatedAt: new Date('2026-07-28T00:00:00.000Z'),
    } satisfies Task;
    const project = {
      id: 'archived-project',
      name: 'Archived project',
      path: projectRoot,
      autoBuildPath: '.autocode',
      settings: {},
    } as Project;
    const publish = vi.fn();
    const publishTaskStatus = vi.fn();
    const service = new OpenSpecService(
      {} as never,
      publish,
      publishTaskStatus,
    );
    service.runtimeStore.initialize(task, project);
    service.runtimeStore.update(task, project, {
      taskStatus: 'done',
      reviewReason: null,
      workflowStage: 'archived',
      executionPhase: 'complete',
      state: 'succeeded',
      lastSuccessfulAction: 'archive',
      selectedChangeName: 'archived-change',
    });
    const ensureTaskWorktree = vi.spyOn(
      service.roots,
      'ensureTaskWorktree',
    );
    const getOfficialSnapshot = vi.spyOn(service.status, 'getSnapshot');
    const readOfficialArtifact = vi.spyOn(service.status, 'readArtifact');
    const getOfficialArtifactDiff = vi.spyOn(
      service.status,
      'getArtifactDiff',
    );

    const [snapshot, changes, history] = await Promise.all([
      service.getSnapshot(task, project),
      service.listChanges(task, project),
      service.getHistory(task, project),
    ]);

    expect(snapshot).toMatchObject({
      taskId: task.id,
      changeName: 'archived-change',
      workflowStage: 'archived',
      archived: true,
      availableActions: [],
      artifacts: [],
      revision: 1,
    });
    expect(changes).toEqual([
      expect.objectContaining({
        name: 'archived-change',
        status: 'archived',
        archived: true,
      }),
    ]);
    expect(history.activeRun).toBeNull();
    expect(publishTaskStatus).toHaveBeenCalledOnce();
    expect(publishTaskStatus).toHaveBeenCalledWith(
      task,
      project,
      'done',
    );
    expect(ensureTaskWorktree).not.toHaveBeenCalled();
    expect(getOfficialSnapshot).not.toHaveBeenCalled();

    const emitted = await service.reconcile(task, project, true);
    expect(emitted.revision).toBeGreaterThan(snapshot.revision);
    expect(publish).toHaveBeenCalledWith(
      task,
      project,
      expect.objectContaining({
        type: 'snapshot',
        revision: emitted.revision,
      }),
    );

    await expect(service.readArtifact(task, project, {
      taskId: task.id,
      projectId: project.id,
      expectedChangeName: 'archived-change',
      artifactId: 'proposal',
    })).rejects.toThrow(/worktree was removed/);
    await expect(service.getArtifactDiff(task, project, {
      taskId: task.id,
      projectId: project.id,
      expectedChangeName: 'archived-change',
      artifactId: 'proposal',
      relativePath: 'proposal.md',
    })).resolves.toEqual({
      artifactId: 'proposal',
      relativePath: 'proposal.md',
      patch: '',
      base: 'unavailable',
    });
    expect(readOfficialArtifact).not.toHaveBeenCalled();
    expect(getOfficialArtifactDiff).not.toHaveBeenCalled();
    expect(publishTaskStatus).toHaveBeenCalledOnce();
  });
});
