import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import type {
  GetOpenSpecArtifactDiffInput,
  OpenSpecAction,
  OpenSpecArtifactContent,
  OpenSpecArtifactDiff,
  OpenSpecArtifactSnapshot,
  OpenSpecArtifactStatus,
  OpenSpecBoardSnapshot,
  OpenSpecChangeSummary,
  OpenSpecValidationIssue,
  OpenSpecValidationSummary,
  Project,
  ReadOpenSpecArtifactInput,
  Task,
} from '../../shared/types';
import {
  OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE,
  OPEN_SPEC_VERSION,
} from '../../shared/types';
import { OpenSpecCliAdapter, type OpenSpecCliScope } from './openspec-cli-adapter';
import {
  OpenSpecPathUnavailableError,
  OpenSpecRootResolver,
  isPathInside,
} from './openspec-root-resolver';
import { OpenSpecRuntimeStore } from './openspec-runtime-store';

const SAFE_CHANGE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

interface RawOpenSpecRoot {
  path: string;
  source?: string;
}

interface RawOpenSpecArtifactPath {
  outputPath: string;
  resolvedOutputPath?: string;
  existingOutputPaths?: string[];
}

interface RawOpenSpecArtifact {
  id: string;
  outputPath: string;
  status: string;
  missingDeps?: string[];
}

interface RawOpenSpecStatus {
  changeName: string;
  schemaName: string;
  planningHome: {
    kind?: string;
    root: string;
    changesDir?: string;
    defaultSchema?: string;
  };
  changeRoot: string;
  artifactPaths: Record<string, RawOpenSpecArtifactPath>;
  isComplete: boolean;
  applyRequires: string[];
  nextSteps: string[];
  actionContext?: {
    mode?: string;
    sourceOfTruth?: string;
    linkedContext?: string[];
    allowedEditRoots?: string[];
    requiresAffectedAreaSelection?: boolean;
    constraints?: string[];
  };
  artifacts: RawOpenSpecArtifact[];
  root: RawOpenSpecRoot;
}

interface RawOpenSpecInstructions {
  changeName: string;
  artifactId: string;
  schemaName: string;
  changeDir: string;
  outputPath: string;
  resolvedOutputPath?: string;
  existingOutputPaths?: string[];
  description?: string;
  instruction?: string;
  template?: string;
  dependencies?: Array<{
    id: string;
    done?: boolean;
    path?: string;
    description?: string;
  }>;
  unlocks?: string[];
}

interface RawOpenSpecSchema {
  name: string;
  description?: string;
  artifacts?: string[];
  source?: string;
}

interface RawValidation {
  items?: Array<{
    id?: string;
    type?: string;
    valid?: boolean;
    issues?: Array<{
      level?: string;
      path?: string;
      message?: string;
    }>;
  }>;
  summary?: {
    totals?: {
      items?: number;
      passed?: number;
      failed?: number;
    };
  };
  status?: Array<{
    severity?: string;
    message?: string;
    target?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`OpenSpec JSON field "${field}" has an unsupported shape.`);
  }
  return value;
}

function instructionDependencies(
  value: unknown,
): NonNullable<RawOpenSpecInstructions['dependencies']> {
  if (!Array.isArray(value)) {
    throw new Error('OpenSpec JSON field "dependencies" has an unsupported shape.');
  }
  return value.map((dependency, index) => {
    if (!isRecord(dependency) || typeof dependency.id !== 'string') {
      throw new Error(`OpenSpec dependencies[${index}] is invalid.`);
    }
    return {
      id: dependency.id,
      ...(typeof dependency.done === 'boolean' ? { done: dependency.done } : {}),
      ...(typeof dependency.path === 'string' ? { path: dependency.path } : {}),
      ...(typeof dependency.description === 'string'
        ? { description: dependency.description }
        : {}),
    };
  });
}

function parseStatus(value: unknown): RawOpenSpecStatus {
  if (!isRecord(value)) {
    throw new Error('OpenSpec status response must be an object.');
  }
  const planningHome = value.planningHome;
  const artifactPaths = value.artifactPaths;
  if (
    typeof value.changeName !== 'string' ||
    typeof value.schemaName !== 'string' ||
    !isRecord(planningHome) ||
    typeof planningHome.root !== 'string' ||
    typeof value.changeRoot !== 'string' ||
    !isRecord(artifactPaths) ||
    typeof value.isComplete !== 'boolean' ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error('OpenSpec status response is missing required 1.6.0 fields.');
  }

  const parsedArtifactPaths: Record<string, RawOpenSpecArtifactPath> = {};
  for (const [id, rawPath] of Object.entries(artifactPaths)) {
    if (!isRecord(rawPath) || typeof rawPath.outputPath !== 'string') {
      throw new Error(`OpenSpec artifactPaths.${id} is invalid.`);
    }
    parsedArtifactPaths[id] = {
      outputPath: rawPath.outputPath,
      ...(typeof rawPath.resolvedOutputPath === 'string'
        ? { resolvedOutputPath: rawPath.resolvedOutputPath }
        : {}),
      existingOutputPaths: rawPath.existingOutputPaths === undefined
        ? []
        : stringArray(rawPath.existingOutputPaths, `artifactPaths.${id}.existingOutputPaths`),
    };
  }

  const artifacts = value.artifacts.map((artifact, index): RawOpenSpecArtifact => {
    if (
      !isRecord(artifact) ||
      typeof artifact.id !== 'string' ||
      typeof artifact.outputPath !== 'string' ||
      typeof artifact.status !== 'string'
    ) {
      throw new Error(`OpenSpec artifacts[${index}] is invalid.`);
    }
    return {
      id: artifact.id,
      outputPath: artifact.outputPath,
      status: artifact.status,
      missingDeps: artifact.missingDeps === undefined
        ? []
        : stringArray(artifact.missingDeps, `artifacts[${index}].missingDeps`),
    };
  });

  return {
    changeName: value.changeName,
    schemaName: value.schemaName,
    planningHome: {
      root: planningHome.root,
      ...(typeof planningHome.kind === 'string' ? { kind: planningHome.kind } : {}),
      ...(typeof planningHome.changesDir === 'string' ? { changesDir: planningHome.changesDir } : {}),
      ...(typeof planningHome.defaultSchema === 'string' ? { defaultSchema: planningHome.defaultSchema } : {}),
    },
    changeRoot: value.changeRoot,
    artifactPaths: parsedArtifactPaths,
    isComplete: value.isComplete,
    applyRequires: stringArray(value.applyRequires, 'applyRequires'),
    nextSteps: stringArray(value.nextSteps, 'nextSteps'),
    artifacts,
    root: isRecord(value.root) && typeof value.root.path === 'string'
      ? { path: value.root.path, ...(typeof value.root.source === 'string' ? { source: value.root.source } : {}) }
      : { path: planningHome.root },
    ...(isRecord(value.actionContext)
      ? {
          actionContext: {
            ...(typeof value.actionContext.mode === 'string' ? { mode: value.actionContext.mode } : {}),
            ...(typeof value.actionContext.sourceOfTruth === 'string'
              ? { sourceOfTruth: value.actionContext.sourceOfTruth }
              : {}),
            ...(Array.isArray(value.actionContext.linkedContext)
              ? { linkedContext: stringArray(value.actionContext.linkedContext, 'actionContext.linkedContext') }
              : {}),
            ...(Array.isArray(value.actionContext.allowedEditRoots)
              ? { allowedEditRoots: stringArray(value.actionContext.allowedEditRoots, 'actionContext.allowedEditRoots') }
              : {}),
            ...(typeof value.actionContext.requiresAffectedAreaSelection === 'boolean'
              ? { requiresAffectedAreaSelection: value.actionContext.requiresAffectedAreaSelection }
              : {}),
            ...(Array.isArray(value.actionContext.constraints)
              ? { constraints: stringArray(value.actionContext.constraints, 'actionContext.constraints') }
              : {}),
          },
        }
      : {}),
  };
}

function parseInstructions(value: unknown): RawOpenSpecInstructions {
  if (
    !isRecord(value) ||
    typeof value.changeName !== 'string' ||
    typeof value.artifactId !== 'string' ||
    typeof value.schemaName !== 'string' ||
    typeof value.changeDir !== 'string' ||
    typeof value.outputPath !== 'string'
  ) {
    throw new Error('OpenSpec instructions response is missing required 1.6.0 fields.');
  }
  return {
    changeName: value.changeName,
    artifactId: value.artifactId,
    schemaName: value.schemaName,
    changeDir: value.changeDir,
    outputPath: value.outputPath,
    ...(typeof value.resolvedOutputPath === 'string' ? { resolvedOutputPath: value.resolvedOutputPath } : {}),
    existingOutputPaths: value.existingOutputPaths === undefined
      ? []
      : stringArray(value.existingOutputPaths, 'existingOutputPaths'),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.instruction === 'string' ? { instruction: value.instruction } : {}),
    ...(typeof value.template === 'string' ? { template: value.template } : {}),
    dependencies: value.dependencies === undefined
      ? []
      : instructionDependencies(value.dependencies),
    unlocks: value.unlocks === undefined ? [] : stringArray(value.unlocks, 'unlocks'),
  };
}

function mapArtifactStatus(value: string): OpenSpecArtifactStatus {
  switch (value) {
    case 'blocked':
    case 'ready':
    case 'done':
      return value;
    default:
      return 'unknown';
  }
}

const ACTIVE_PLANNING_UPDATE_STATES = new Set([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
]);

function projectArtifactRuntimeState(input: {
  officialStatus: OpenSpecArtifactStatus;
  existingOutputPaths: readonly string[];
  modifiedAt?: string;
  runtimeState: string;
  activeAction: OpenSpecAction | null;
  activeRunStartedAt: string | null;
}): {
  status: OpenSpecArtifactStatus;
  inProgress: boolean;
} {
  const updateActive =
    input.activeAction === 'update' &&
    ACTIVE_PLANNING_UPDATE_STATES.has(input.runtimeState);
  if (
    updateActive &&
    input.officialStatus === 'done'
  ) {
    const startedAt = Date.parse(input.activeRunStartedAt ?? '');
    const modifiedAt = Date.parse(input.modifiedAt ?? '');
    if (
      Number.isFinite(startedAt) &&
      (
        input.existingOutputPaths.length === 0 ||
        !Number.isFinite(modifiedAt) ||
        modifiedAt < startedAt
      )
    ) {
      return {
        status: 'ready',
        inProgress: true,
      };
    }
  }

  return {
    status: input.officialStatus,
    inProgress:
      input.runtimeState === 'running' &&
      input.activeAction === 'continue' &&
      input.officialStatus === 'ready',
  };
}

function parseChecklist(content: string): { completed: number; total: number } {
  const matches = [...content.matchAll(/^\s*-\s+\[([ xX])\]\s+/gm)];
  return {
    completed: matches.filter((match) => match[1].toLowerCase() === 'x').length,
    total: matches.length,
  };
}

function parseSpecMetrics(content: string): { requirements: number; scenarios: number } {
  return {
    requirements: (content.match(/^### Requirement:/gm) ?? []).length,
    scenarios: (content.match(/^#### Scenario:/gm) ?? []).length,
  };
}

function sourcePatch(relativePath: string, content: string): string {
  const lines = content.split(/\r?\n/);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function artifactRefreshRequiredError(message: string): Error {
  return new Error(
    `[${OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE}] ${message}`,
  );
}

function rethrowArtifactAccessError(error: unknown): never {
  if (
    error instanceof OpenSpecPathUnavailableError ||
    isMissingPathError(error)
  ) {
    throw artifactRefreshRequiredError(
      'Requested OpenSpec artifact is no longer available. ' +
      'Refresh the task and select an active change before trying again.',
    );
  }
  throw error;
}

function snapshotProjectionDigest(
  snapshot: Omit<OpenSpecBoardSnapshot, 'revision'>,
): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export class OpenSpecStatusService {
  private readonly revisions = new Map<string, number>();
  private readonly revisionDigests = new Map<string, string>();
  private readonly officialRoots = new Map<string, string>();
  private readonly schemaDescriptions = new Map<string, {
    expiresAt: number;
    descriptions: Map<string, string>;
  }>();

  constructor(
    private readonly cli: OpenSpecCliAdapter,
    private readonly roots: OpenSpecRootResolver,
    private readonly runtimeStore: OpenSpecRuntimeStore,
  ) {}

  private scope(root: ReturnType<OpenSpecRootResolver['resolve']>): OpenSpecCliScope {
    return {
      cwd: root.cwd,
      rootKind: root.rootKind,
      storeId: root.storeId,
    };
  }

  private revisionKey(task: Task, project: Project): string {
    return `${project.id}::${task.id}`;
  }

  private withRevision(
    task: Task,
    project: Project,
    snapshot: Omit<OpenSpecBoardSnapshot, 'revision'>,
  ): OpenSpecBoardSnapshot {
    const key = this.revisionKey(task, project);
    const digest = snapshotProjectionDigest(snapshot);
    const previousDigest = this.revisionDigests.get(key);
    let revision = this.revisions.get(key) ?? 0;
    if (revision === 0 || digest !== previousDigest) {
      revision += 1;
      this.revisions.set(key, revision);
      this.revisionDigests.set(key, digest);
    }
    return { ...snapshot, revision };
  }

  async listChanges(task: Task, project: Project): Promise<OpenSpecChangeSummary[]> {
    const root = this.roots.resolve(task, project);
    const raw = await this.cli.list<unknown>(this.scope(root));
    if (!isRecord(raw) || !Array.isArray(raw.changes)) {
      throw new Error('OpenSpec list response is missing changes.');
    }
    if (isRecord(raw.root) && typeof raw.root.path === 'string') {
      this.officialRoots.set(this.revisionKey(task, project), raw.root.path);
    }
    return raw.changes.map((change, index) => {
      if (!isRecord(change) || typeof change.name !== 'string') {
        throw new Error(`OpenSpec changes[${index}] is invalid.`);
      }
      return {
        name: change.name,
        completedTasks: typeof change.completedTasks === 'number' ? change.completedTasks : 0,
        totalTasks: typeof change.totalTasks === 'number' ? change.totalTasks : 0,
        ...(typeof change.lastModified === 'string' ? { lastModified: change.lastModified } : {}),
        status: typeof change.status === 'string' ? change.status : 'unknown',
      };
    });
  }

  private async loadInstructions(
    scope: OpenSpecCliScope,
    status: RawOpenSpecStatus,
  ): Promise<Map<string, RawOpenSpecInstructions>> {
    const entries = await Promise.all(status.artifacts.map(async (artifact) => {
      try {
        const raw = await this.cli.instructions<unknown>(scope, {
          artifactId: artifact.id,
          changeName: status.changeName,
          schemaName: status.schemaName,
        });
        return [artifact.id, parseInstructions(raw)] as const;
      } catch {
        return null;
      }
    }));
    return new Map(entries.filter(
      (entry): entry is readonly [string, RawOpenSpecInstructions] => entry !== null,
    ));
  }

  private concreteRelativePaths(
    status: RawOpenSpecStatus,
    artifact: RawOpenSpecArtifact,
  ): string[] {
    const rawPaths = status.artifactPaths[artifact.id]?.existingOutputPaths ?? [];
    return rawPaths
      .filter((filePath) => isPathInside(filePath, status.changeRoot))
      .map((filePath) => this.roots.relativeToChangeRoot(status.changeRoot, filePath));
  }

  private async schemaDescription(
    scope: OpenSpecCliScope,
    rootKey: string,
    schemaName: string,
  ): Promise<string | undefined> {
    const cached = this.schemaDescriptions.get(rootKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.descriptions.get(schemaName);
    }
    const rawSchemas = await this.cli.schemas<unknown>(scope);
    if (!Array.isArray(rawSchemas)) {
      throw new Error('OpenSpec schemas response must be an array.');
    }
    const descriptions = new Map<string, string>();
    for (const rawSchema of rawSchemas) {
      if (
        rawSchema &&
        typeof rawSchema === 'object' &&
        !Array.isArray(rawSchema) &&
        typeof (rawSchema as RawOpenSpecSchema).name === 'string' &&
        typeof (rawSchema as RawOpenSpecSchema).description === 'string'
      ) {
        descriptions.set(
          (rawSchema as RawOpenSpecSchema).name,
          (rawSchema as RawOpenSpecSchema).description as string,
        );
      }
    }
    this.schemaDescriptions.set(rootKey, {
      expiresAt: Date.now() + 30_000,
      descriptions,
    });
    return descriptions.get(schemaName);
  }

  private availableActions(
    initialized: boolean,
    status: RawOpenSpecStatus | null,
    changes: OpenSpecChangeSummary[],
  ): OpenSpecAction[] {
    if (!initialized) {
      return ['new', 'propose', 'onboard', 'explore'];
    }
    const actions = new Set<OpenSpecAction>(['explore', 'new', 'propose', 'onboard']);
    if (!status) {
      if (changes.length >= 2) actions.add('bulk-archive');
      return [...actions];
    }
    actions.add('update');
    actions.add('sync');
    actions.add('verify');
    if (status.artifacts.some((artifact) => artifact.status === 'ready')) {
      actions.add('continue');
    }
    if (!status.isComplete) {
      actions.add('ff');
    }
    const artifactState = new Map(status.artifacts.map((artifact) => [artifact.id, artifact.status]));
    if (
      status.actionContext?.requiresAffectedAreaSelection !== true
      && status.applyRequires.every((id) => artifactState.get(id) === 'done')
    ) {
      actions.add('apply');
    }
    // The official Archive workflow permits incomplete artifacts/tasks after
    // warning and asking for confirmation. Do not replace that workflow with
    // a stricter Aperant-only gate.
    actions.add('archive');
    if (changes.length >= 2) {
      actions.add('bulk-archive');
    }
    return [...actions];
  }

  async getSnapshot(task: Task, project: Project): Promise<OpenSpecBoardSnapshot> {
    const root = this.roots.resolve(task, project);
    const scope = this.scope(root);
    await this.cli.version(scope);
    this.runtimeStore.initialize(task, project);
    const runtime = this.runtimeStore.read(task, project);

    const initialized = root.rootKind === 'store' || existsSync(join(root.cwd, 'openspec'));
    let changes: OpenSpecChangeSummary[] = [];
    if (initialized) {
      changes = await this.listChanges(task, project);
    }
    const configuredChange = (
      this.runtimeStore.read(task, project).selectedChangeName ??
      task.metadata?.openSpec?.changeName
    )?.trim();
    const changeName = configuredChange && changes.some((change) => change.name === configuredChange)
      ? configuredChange
      : changes.length === 1
        ? changes[0].name
        : configuredChange || null;

    if (!initialized || !changeName || !changes.some((change) => change.name === changeName)) {
      const archived = Boolean(
        initialized &&
        configuredChange &&
        this.listArchivedChanges(task, project).some((change) => (
          change.name === configuredChange ||
          change.name.replace(/^\d{4}-\d{2}-\d{2}-/, '') === configuredChange
        )),
      );
      const snapshot: Omit<OpenSpecBoardSnapshot, 'revision'> = {
        taskId: task.id,
        openSpecVersion: OPEN_SPEC_VERSION,
        rootKind: root.rootKind,
        rootLabel: root.rootLabel,
        initialized,
        changeName: archived ? configuredChange ?? null : null,
        schema: {
          name: task.metadata?.openSpec?.schemaName ?? 'spec-driven',
        },
        artifacts: [],
        applyRequires: [],
        workflowStage: archived ? 'archived' : runtime.workflowStage,
        activeRun: this.runtimeStore.getActiveRun(task, project),
        validation: null,
        nextSteps: initialized
          ? archived
            ? ['The selected change is archived. Select an active change or run New/Propose.']
            : ['Select an existing change or run New/Propose.']
          : ['Initialize OpenSpec by running New, Propose, or Onboard.'],
        availableActions: this.availableActions(initialized, null, changes),
        archived,
      };
      return this.withRevision(task, project, snapshot);
    }

    const rawStatus = await this.cli.status<unknown>(scope, {
      changeName,
    });
    const status = parseStatus(rawStatus);
    const planningRoot = this.roots.validateOfficialPlanningRoot(
      root,
      status.planningHome.root,
    );
    this.roots.validateOfficialChangeRoot(status.planningHome.root, status.changeRoot);
    const instructionMap = await this.loadInstructions(scope, status);
    let schemaDescription: string | undefined;
    try {
      schemaDescription = await this.schemaDescription(
        { ...scope, cwd: planningRoot },
        `${root.rootKind}:${root.storeId ?? ''}:${planningRoot}`,
        status.schemaName,
      );
    } catch {
      // Status is still authoritative if optional schema description lookup fails.
    }

    const artifacts: OpenSpecArtifactSnapshot[] = status.artifacts.map((artifact) => {
      const instructions = instructionMap.get(artifact.id);
      const existingOutputPaths = this.concreteRelativePaths(status, artifact);
      let modifiedAt: string | undefined;
      let metrics: OpenSpecArtifactSnapshot['metrics'];
      let checklist: OpenSpecArtifactSnapshot['checklist'];
      for (const relativePath of existingOutputPaths) {
        try {
          const filePath = this.roots.resolveArtifactFile(status.changeRoot, relativePath);
          const modified = statSync(filePath).mtime.toISOString();
          if (!modifiedAt || modified > modifiedAt) modifiedAt = modified;
          if (relativePath.endsWith('/spec.md') || relativePath === 'spec.md') {
            const parsed = parseSpecMetrics(readFileSync(filePath, 'utf8'));
            metrics = {
              requirements: (metrics?.requirements ?? 0) + parsed.requirements,
              scenarios: (metrics?.scenarios ?? 0) + parsed.scenarios,
            };
          }
          if (relativePath.endsWith('tasks.md')) {
            checklist = parseChecklist(readFileSync(filePath, 'utf8'));
          }
        } catch {
          // A raced external edit will be reconciled by the next watcher event.
        }
      }
      const runtimeState = projectArtifactRuntimeState({
        officialStatus: mapArtifactStatus(artifact.status),
        existingOutputPaths,
        modifiedAt,
        runtimeState: runtime.state,
        activeAction: runtime.activeAction,
        activeRunStartedAt: runtime.activeRunStartedAt,
      });
      return {
        id: artifact.id,
        description: instructions?.description,
        outputPath: artifact.outputPath,
        status: runtimeState.status,
        missingDeps: artifact.missingDeps ?? [],
        existingOutputPaths,
        dependencies: instructions?.dependencies?.map((dependency) => dependency.id) ??
          artifact.missingDeps ??
          [],
        unlocks: instructions?.unlocks ?? [],
        instruction: instructions?.instruction,
        template: instructions?.template,
        inProgress: runtimeState.inProgress,
        blocksApply: status.applyRequires.includes(artifact.id),
        ...(checklist ? { checklist } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
        ...(metrics ? { metrics } : {}),
      };
    });

    let taskProgress: OpenSpecBoardSnapshot['taskProgress'];
    const tasksArtifact = artifacts.find((artifact) =>
      artifact.id === 'tasks' ||
      artifact.existingOutputPaths.some((filePath) => filePath.endsWith('tasks.md')),
    );
    const tasksPath = tasksArtifact?.existingOutputPaths.find((filePath) => filePath.endsWith('tasks.md'));
    if (tasksPath) {
      try {
        taskProgress = parseChecklist(readFileSync(
          this.roots.resolveArtifactFile(status.changeRoot, tasksPath),
          'utf8',
        ));
      } catch {
        // Display remains usable without optional checklist metrics.
      }
    }

    const digest = createHash('sha256').update(JSON.stringify(rawStatus)).digest('hex');
    this.runtimeStore.update(task, project, {
      lastReconciledAt: new Date().toISOString(),
      lastStatusDigest: `sha256:${digest}`,
    });
    return this.withRevision(task, project, {
      taskId: task.id,
      openSpecVersion: OPEN_SPEC_VERSION,
      rootKind: root.rootKind,
      rootLabel: root.rootLabel,
      initialized: true,
      changeName: status.changeName,
      schema: {
        name: status.schemaName,
        ...(schemaDescription ? { description: schemaDescription } : {}),
      },
      artifacts,
      applyRequires: status.applyRequires,
      ...(taskProgress ? { taskProgress } : {}),
      workflowStage: runtime.workflowStage,
      actionContext: {
        planningHome: status.planningHome,
        ...(status.actionContext?.mode ? { mode: status.actionContext.mode } : {}),
        ...(status.actionContext?.sourceOfTruth
          ? { sourceOfTruth: status.actionContext.sourceOfTruth }
          : {}),
        linkedContext: status.actionContext?.linkedContext ?? [],
        allowedEditRoots: status.actionContext?.allowedEditRoots ?? [],
        requiresAffectedAreaSelection:
          status.actionContext?.requiresAffectedAreaSelection ?? false,
        constraints: status.actionContext?.constraints ?? [],
      },
      activeRun: this.runtimeStore.getActiveRun(task, project),
      validation: null,
      nextSteps: status.nextSteps,
      availableActions: this.availableActions(true, status, changes),
      rawStatus,
      unsupportedStatus: artifacts.some((artifact) => artifact.status === 'unknown'),
      archived: false,
    });
  }

  async validate(
    task: Task,
    project: Project,
    input: { changeName?: string; strict?: boolean } = {},
  ): Promise<OpenSpecValidationSummary> {
    const root = this.roots.resolve(task, project);
    const raw = await this.cli.validate<RawValidation>(this.scope(root), {
      itemName: input.changeName ?? task.metadata?.openSpec?.changeName,
      strict: input.strict,
    });
    const issues: OpenSpecValidationIssue[] = [];
    for (const item of raw.items ?? []) {
      for (const issue of item.issues ?? []) {
        if (!issue.message) continue;
        const level = issue.level?.toLowerCase();
        issues.push({
          ...(issue.path ? { path: issue.path } : {}),
          message: issue.message,
          severity: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
        });
      }
    }
    for (const status of raw.status ?? []) {
      if (!status.message) continue;
      issues.push({
        ...(status.target ? { path: status.target } : {}),
        message: status.message,
        severity: status.severity === 'error' ? 'error' : status.severity === 'warning' ? 'warning' : 'info',
      });
    }
    const failed = raw.summary?.totals?.failed ?? issues.filter((issue) => issue.severity === 'error').length;
    return {
      valid: failed === 0,
      checkedAt: new Date().toISOString(),
      issues,
    };
  }

  private async artifactContext(
    task: Task,
    project: Project,
    input: ReadOpenSpecArtifactInput,
  ): Promise<{
    status: RawOpenSpecStatus;
    artifact: OpenSpecArtifactSnapshot;
    relativePath: string;
    filePath: string;
  }> {
    const snapshot = await this.getSnapshot(task, project);
    const expectedChangeName = typeof input.expectedChangeName === 'string'
      ? input.expectedChangeName
      : '';
    if (
      !SAFE_CHANGE_NAME.test(expectedChangeName) ||
      !snapshot.changeName ||
      snapshot.changeName !== expectedChangeName
    ) {
      throw artifactRefreshRequiredError(
        'OpenSpec artifact request expected change no longer matches the selected change. ' +
        'Refresh the task and try again.',
      );
    }
    const root = this.roots.resolve(task, project);
    // getSnapshot already obtained and validated the authoritative status used
    // to build the artifact path allowlist. Reuse that exact response here so
    // an external OpenSpec update cannot mix paths from status A with the
    // change root from a later status B.
    const status = parseStatus(snapshot.rawStatus);
    this.roots.validateOfficialPlanningRoot(root, status.planningHome.root);
    this.roots.validateOfficialChangeRoot(status.planningHome.root, status.changeRoot);
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === input.artifactId);
    if (!artifact) throw new Error('Unknown OpenSpec artifact ID.');
    const requestedPath = input.relativePath ?? artifact.existingOutputPaths[0];
    if (!requestedPath || !artifact.existingOutputPaths.includes(requestedPath)) {
      throw new Error('Requested path is not one of the official artifact output paths.');
    }
    return {
      status,
      artifact,
      relativePath: requestedPath,
      filePath: this.roots.resolveArtifactFile(status.changeRoot, requestedPath),
    };
  }

  async readArtifact(
    task: Task,
    project: Project,
    input: ReadOpenSpecArtifactInput,
  ): Promise<OpenSpecArtifactContent> {
    try {
      const context = await this.artifactContext(task, project, input);
      const stats = statSync(context.filePath);
      if (stats.size > 2 * 1024 * 1024) {
        throw new Error('OpenSpec artifact exceeds the 2 MiB preview limit.');
      }
      return {
        artifactId: context.artifact.id,
        relativePath: context.relativePath,
        content: readFileSync(context.filePath, 'utf8'),
        modifiedAt: stats.mtime.toISOString(),
      };
    } catch (error) {
      rethrowArtifactAccessError(error);
    }
  }

  async getArtifactDiff(
    task: Task,
    project: Project,
    input: GetOpenSpecArtifactDiffInput,
  ): Promise<OpenSpecArtifactDiff> {
    try {
      const context = await this.artifactContext(task, project, input);
      const root = this.roots.resolve(task, project);
      const gitRelativePath = relative(root.workspaceRoot, context.filePath).replace(/\\/g, '/');
      if (isPathInside(context.filePath, root.workspaceRoot)) {
        try {
          const patch = execFileSync(
            'git',
            ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', gitRelativePath],
            {
              cwd: root.workspaceRoot,
              encoding: 'utf8',
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'ignore'],
              maxBuffer: 2 * 1024 * 1024,
            },
          );
          if (patch.trim()) {
            return {
              artifactId: context.artifact.id,
              relativePath: context.relativePath,
              patch,
              base: 'git',
            };
          }
        } catch {
          // Fall back to a safe read-only new-file patch below.
        }
      }
      const content = readFileSync(context.filePath, 'utf8');
      return {
        artifactId: context.artifact.id,
        relativePath: context.relativePath,
        patch: sourcePatch(context.relativePath, content),
        base: 'unavailable',
      };
    } catch (error) {
      rethrowArtifactAccessError(error);
    }
  }

  listArchivedChanges(task: Task, project: Project): OpenSpecChangeSummary[] {
    const root = this.roots.resolve(task, project);
    const officialRoot = this.officialRoots.get(this.revisionKey(task, project)) ??
      root.workspaceRoot;
    const archiveDir = join(officialRoot, 'openspec', 'changes', 'archive');
    if (!existsSync(archiveDir)) return [];
    return readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        completedTasks: 0,
        totalTasks: 0,
        status: 'archived',
        archived: true,
        lastModified: statSync(join(archiveDir, entry.name)).mtime.toISOString(),
      }));
  }
}

export const __openSpecStatusTestUtils = {
  parseStatus,
  parseInstructions,
  parseChecklist,
  parseSpecMetrics,
  instructionDependencies,
  mapArtifactStatus,
  projectArtifactRuntimeState,
  snapshotProjectionDigest,
};
