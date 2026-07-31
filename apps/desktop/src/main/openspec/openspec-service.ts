import chokidar, { type FSWatcher } from 'chokidar';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AnswerOpenSpecInteractionInput,
  GetOpenSpecArtifactDiffInput,
  OpenSpecAction,
  OpenSpecActionHistory,
  OpenSpecArtifactContent,
  OpenSpecArtifactDiff,
  OpenSpecBoardSnapshot,
  OpenSpecChangeSummary,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewInput,
  OpenSpecPlanningReviewSummary,
  OpenSpecPreflightInput,
  OpenSpecPreflightResult,
  OpenSpecRendererEvent,
  OpenSpecRunLog,
  OpenSpecValidationSummary,
  Project,
  ReadOpenSpecArtifactInput,
  ReviewReason,
  ResumeOpenSpecActionInput,
  RunOpenSpecActionInput,
  Task,
  ValidateOpenSpecInput,
} from '../../shared/types';
import { OPEN_SPEC_VERSION } from '../../shared/types';
import { isSpecDevelopmentTask } from '../../shared/utils/task-mode';
import { resolveOpenSpecWorkflowAction } from '../../shared/utils/openspec-workflow-action';
import type { AgentManager } from '../agent';
import { projectStore } from '../project-store';
import { findTaskWorktree } from '../worktree-paths';
import { OpenSpecActionRunner } from './openspec-action-runner';
import { OpenSpecCliAdapter } from './openspec-cli-adapter';
import { OpenSpecLockManager } from './openspec-lock-manager';
import {
  OpenSpecPlanningReviewStore,
  summarizeOpenSpecPlanningReview,
} from './openspec-planning-review-store';
import { OpenSpecPreflightService } from './openspec-preflight-service';
import { OpenSpecPromptRegistry } from './openspec-prompt-registry';
import { OpenSpecRootResolver } from './openspec-root-resolver';
import { OpenSpecRuntimeStore } from './openspec-runtime-store';
import { OpenSpecStatusService } from './openspec-status-service';

const RECONCILE_DEBOUNCE_MS = 225;
const PREFLIGHT_CACHE_MS = 5_000;
const WATCHER_READY_TIMEOUT_MS = 10_000;
const ACTIVE_TASK_START_STATES = new Set([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
]);
const CONFIRMATION_ACTIONS = new Set<OpenSpecAction>([
  'archive',
  'bulk-archive',
]);
const INITIAL_WORKFLOW_ACTIONS = new Set<OpenSpecAction>([
  'new',
  'propose',
  'explore',
  'onboard',
]);

interface WatchRegistration {
  watcher: FSWatcher;
  paths: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

export type OpenSpecServicePublisher = (
  task: Task,
  project: Project,
  event: OpenSpecRendererEvent,
) => void;

export type OpenSpecTaskStatusPublisher = (
  task: Task,
  project: Project,
  status: Task['status'],
  reviewReason?: ReviewReason,
) => void;

function taskKey(task: Task, project: Project): string {
  return `${project.id}::${task.id}`;
}

function assertSpecTask(task: Task, project: Project): void {
  if (!isSpecDevelopmentTask(task)) {
    throw new Error('This operation is only available for Spec development mode tasks.');
  }
  if (task.projectId && task.projectId !== project.id) {
    throw new Error('Task does not belong to the requested project.');
  }
}

function statusPlanningRoot(snapshot: OpenSpecBoardSnapshot): string | null {
  if (!snapshot.rawStatus || typeof snapshot.rawStatus !== 'object' || Array.isArray(snapshot.rawStatus)) {
    return null;
  }
  const planningHome = (snapshot.rawStatus as Record<string, unknown>).planningHome;
  if (!planningHome || typeof planningHome !== 'object' || Array.isArray(planningHome)) {
    return null;
  }
  const root = (planningHome as Record<string, unknown>).root;
  return typeof root === 'string' && root.trim() ? resolve(root) : null;
}

function gitIndexPath(workspaceRoot: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-path', 'index'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return null;
    const path = resolve(workspaceRoot, output);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function buildOpenSpecWatchPaths(
  workspaceRoot: string,
  planningRoot?: string | null,
): string[] {
  const paths = [resolve(workspaceRoot)];
  if (planningRoot) paths.push(resolve(planningRoot));
  const indexPath = gitIndexPath(workspaceRoot);
  if (indexPath) paths.push(resolve(indexPath));
  return [...new Set(paths)].sort();
}

function shouldIgnoreOpenSpecWatchPath(
  path: string,
  explicitFiles: ReadonlySet<string>,
  watchRoots: readonly string[] = [],
): boolean {
  const normalized = resolve(path);
  if (explicitFiles.has(normalized)) return false;
  const ignoredSegment = /(^|[/\\])(?:\.git|node_modules|\.autocode)([/\\]|$)/;
  const relativePaths = watchRoots
    .map((root) => relative(resolve(root), normalized))
    .filter((candidate) => (
      candidate === '' ||
      (
        !isAbsolute(candidate) &&
        candidate !== '..' &&
        !candidate.startsWith(`..\\`) &&
        !candidate.startsWith('../')
      )
    ));
  if (relativePaths.length > 0) {
    // Ignore internal trees relative to the roots we deliberately watch. The
    // task worktree itself commonly lives below the main project's
    // `.autocode/worktrees` directory; matching the absolute path would ignore
    // that entire workspace, including OpenSpec artifact and task updates.
    return relativePaths.every((candidate) => ignoredSegment.test(candidate));
  }
  return ignoredSegment.test(normalized);
}

function waitForOpenSpecWatcherReady(watcher: FSWatcher): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error('Timed out while starting the OpenSpec filesystem watcher.'));
    }, WATCHER_READY_TIMEOUT_MS);
    const onReady = (): void => {
      cleanup();
      resolveReady();
    };
    const onError = (error: unknown): void => {
      cleanup();
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      watcher.off('ready', onReady);
      watcher.off('error', onError);
    };
    watcher.once('ready', onReady);
    watcher.once('error', onError);
  });
}

/**
 * Main-process facade for the isolated OpenSpec workflow.
 *
 * It owns all mutable runtime components, snapshot caching and filesystem
 * reconciliation. Renderer callers never receive or submit an absolute root.
 */
export class OpenSpecService {
  readonly cli = new OpenSpecCliAdapter();
  readonly roots = new OpenSpecRootResolver();
  readonly runtimeStore = new OpenSpecRuntimeStore();
  readonly planningReviews = new OpenSpecPlanningReviewStore(this.runtimeStore);
  readonly prompts = new OpenSpecPromptRegistry();
  readonly locks = new OpenSpecLockManager();
  readonly status = new OpenSpecStatusService(this.cli, this.roots, this.runtimeStore);
  readonly preflight = new OpenSpecPreflightService(this.cli);

  private readonly runner: OpenSpecActionRunner;
  private readonly snapshots = new Map<string, OpenSpecBoardSnapshot>();
  private readonly validations = new Map<string, OpenSpecValidationSummary>();
  private readonly watchers = new Map<string, WatchRegistration>();
  private readonly recoveredTasks = new Set<string>();
  private readonly reconcilePromises = new Map<string, Promise<OpenSpecBoardSnapshot>>();
  private readonly reconcileGenerations = new Map<string, number>();
  private readonly reconciledGenerations = new Map<string, number>();
  private readonly taskStartPromises = new Map<string, Promise<{ runId: string }>>();
  private readonly archivedStatusRepairAttempts = new Set<string>();
  private readonly preflightCache = new Map<string, {
    expiresAt: number;
    result: OpenSpecPreflightResult;
  }>();
  private readonly planningRoots = new Map<string, string>();

  constructor(
    agentManager: AgentManager,
    private readonly publish: OpenSpecServicePublisher,
    private readonly publishTaskStatus: OpenSpecTaskStatusPublisher,
  ) {
    this.runner = new OpenSpecActionRunner(
      agentManager,
      this.cli,
      this.roots,
      this.prompts,
      this.locks,
      this.runtimeStore,
      this.status,
      publish,
      publishTaskStatus,
      async (task, project, options) => {
        const selectedChangeName = options?.selectedChangeName;
        if (
          selectedChangeName &&
          this.runtimeStore.read(task, project).selectedChangeName !==
            selectedChangeName
        ) {
          this.runtimeStore.update(task, project, {
            selectedChangeName,
          });
        }
        return await this.invalidateAndReconcile(task, project, true);
      },
    );
  }

  private invalidateReconciliation(task: Task, project: Project): void {
    const key = taskKey(task, project);
    this.reconcileGenerations.set(
      key,
      (this.reconcileGenerations.get(key) ?? 0) + 1,
    );
  }

  private async invalidateAndReconcile(
    task: Task,
    project: Project,
    emit: boolean,
  ): Promise<OpenSpecBoardSnapshot> {
    this.invalidateReconciliation(task, project);
    return await this.reconcile(task, project, emit);
  }

  private archivedWorkspaceUnavailable(
    task: Task,
    project: Project,
  ): boolean {
    if (!task.metadata?.useWorktree) return false;
    const runtime = this.runtimeStore.read(task, project);
    return (
      runtime.taskStatus === 'done' &&
      runtime.workflowStage === 'archived' &&
      !findTaskWorktree(project.path, task.specId)
    );
  }

  private offlineArchivedSnapshot(
    task: Task,
    project: Project,
  ): OpenSpecBoardSnapshot {
    const runtime = this.runtimeStore.read(task, project);
    const previousRevision =
      this.snapshots.get(taskKey(task, project))?.revision ?? 0;
    return {
      taskId: task.id,
      openSpecVersion: OPEN_SPEC_VERSION,
      rootKind: task.metadata?.openSpec?.rootKind === 'store'
        ? 'store'
        : 'project',
      rootLabel: task.metadata?.openSpec?.rootKind === 'store'
        ? `Store: ${task.metadata.openSpec.storeId ?? 'archived'}`
        : project.name,
      initialized: true,
      changeName: runtime.selectedChangeName,
      schema: {
        name: task.metadata?.openSpec?.schemaName ?? 'spec-driven',
      },
      artifacts: [],
      applyRequires: [],
      workflowStage: 'archived',
      activeRun: null,
      validation: this.validations.get(taskKey(task, project)) ?? null,
      nextSteps: [],
      availableActions: [],
      rawStatus: {
        offlineArchived: true,
      },
      archived: true,
      revision: previousRevision + 1,
    };
  }

  private async closeWatcher(task: Task, project: Project): Promise<void> {
    const key = taskKey(task, project);
    const existing = this.watchers.get(key);
    if (!existing) return;
    if (existing.timer) clearTimeout(existing.timer);
    this.watchers.delete(key);
    await existing.watcher.close();
  }

  private async prepare(task: Task, project: Project): Promise<void> {
    assertSpecTask(task, project);
    this.runtimeStore.initialize(task, project);

    const key = taskKey(task, project);
    if (!this.recoveredTasks.has(key)) {
      this.recoveredTasks.add(key);
      const recovered = this.runtimeStore.recoverInterruptedRun(task, project);
      if (recovered.state === 'interrupted') {
        projectStore.invalidateTasksCache(project.id);
        this.publishTaskStatus(
          task,
          project,
          recovered.taskStatus,
          recovered.reviewReason ?? undefined,
        );
      }
    }

    const runtime = this.runtimeStore.read(task, project);
    if (
      runtime.taskStatus === 'done' &&
      runtime.workflowStage === 'archived' &&
      task.status !== 'done' &&
      !this.archivedStatusRepairAttempts.has(key)
    ) {
      // Compatibility repair for tasks archived before OpenSpec lifecycle
      // state was mirrored into implementation_plan.md.
      this.archivedStatusRepairAttempts.add(key);
      this.publishTaskStatus(task, project, 'done');
    }

    if (this.archivedWorkspaceUnavailable(task, project)) {
      // A completed task may intentionally discard its worktree. Do not let a
      // later details refresh recreate it; history remains available from the
      // task's durable OpenSpec runtime directory.
      await this.closeWatcher(task, project);
      return;
    }

    await this.roots.ensureTaskWorktree(task, project);
    const root = this.roots.resolve(task, project);

    let planningRoot = this.planningRoots.get(key);
    if (!planningRoot && root.rootKind === 'store') {
      const context = await this.cli.context<unknown>({
        cwd: root.cwd,
        rootKind: root.rootKind,
        storeId: root.storeId,
      });
      if (
        context &&
        typeof context === 'object' &&
        !Array.isArray(context) &&
        (context as Record<string, unknown>).root &&
        typeof (context as Record<string, unknown>).root === 'object' &&
        !Array.isArray((context as Record<string, unknown>).root)
      ) {
        const officialRoot = (
          (context as Record<string, unknown>).root as Record<string, unknown>
        ).path;
        if (typeof officialRoot === 'string') {
          planningRoot = this.roots.validateOfficialPlanningRoot(root, officialRoot);
          this.planningRoots.set(key, planningRoot);
        }
      }
      if (!planningRoot) {
        throw new Error('The registered OpenSpec Store did not resolve an official planning root.');
      }
    }
    await this.ensureWatcher(
      task,
      project,
      buildOpenSpecWatchPaths(root.workspaceRoot, planningRoot),
    );
  }

  private async ensureWatcher(
    task: Task,
    project: Project,
    watchPaths: readonly string[],
  ): Promise<void> {
    const key = taskKey(task, project);
    const normalizedPaths = [...new Set(watchPaths.map((path) => resolve(path)))].sort();
    const existing = this.watchers.get(key);
    if (
      existing &&
      existing.paths.length === normalizedPaths.length &&
      existing.paths.every((path, index) => path === normalizedPaths[index])
    ) {
      return;
    }
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      await existing.watcher.close();
      this.watchers.delete(key);
    }

    const explicitFiles = new Set(
      normalizedPaths.filter((path) => {
        try {
          return existsSync(path) && statSync(path).isFile();
        } catch {
          return false;
        }
      }),
    );
    const watchRoots = normalizedPaths.filter((path) => {
      try {
        return existsSync(path) && statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
    const watcher = chokidar.watch(normalizedPaths, {
      persistent: true,
      ignoreInitial: true,
      ignored: (path) => shouldIgnoreOpenSpecWatchPath(path, explicitFiles, watchRoots),
      awaitWriteFinish: {
        stabilityThreshold: RECONCILE_DEBOUNCE_MS,
        pollInterval: 75,
      },
    });
    const registration: WatchRegistration = {
      watcher,
      paths: normalizedPaths,
      timer: null,
    };
    this.watchers.set(key, registration);

    const schedule = (): void => {
      if (registration.timer) clearTimeout(registration.timer);
      registration.timer = setTimeout(() => {
        registration.timer = null;
        void this.invalidateAndReconcile(task, project, true).catch((error) => {
          this.publish(task, project, {
            type: 'error',
            code: 'watch_reconcile_failed',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, RECONCILE_DEBOUNCE_MS);
    };
    watcher.on('add', schedule);
    watcher.on('change', schedule);
    watcher.on('unlink', schedule);
    watcher.on('addDir', schedule);
    watcher.on('unlinkDir', schedule);
    watcher.on('error', (error) => {
      this.publish(task, project, {
        type: 'error',
        code: 'watch_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await waitForOpenSpecWatcherReady(watcher);
    } catch (error) {
      if (this.watchers.get(key) === registration) {
        this.watchers.delete(key);
      }
      await watcher.close();
      throw error;
    }
  }

  async reconcile(
    task: Task,
    project: Project,
    emit = false,
  ): Promise<OpenSpecBoardSnapshot> {
    await this.prepare(task, project);
    if (this.archivedWorkspaceUnavailable(task, project)) {
      const snapshot = this.offlineArchivedSnapshot(task, project);
      this.snapshots.set(taskKey(task, project), snapshot);
      if (emit) {
        this.publish(task, project, {
          type: 'snapshot',
          revision: snapshot.revision,
          snapshot,
        });
      }
      return snapshot;
    }
    const key = taskKey(task, project);
    const existing = this.reconcilePromises.get(key);
    if (existing) {
      const snapshot = await existing;
      const currentGeneration = this.reconcileGenerations.get(key) ?? 0;
      if ((this.reconciledGenerations.get(key) ?? -1) < currentGeneration) {
        return await this.reconcile(task, project, emit);
      }
      return snapshot;
    }

    const promise = (async () => {
      while (true) {
        const generation = this.reconcileGenerations.get(key) ?? 0;
        let snapshot: OpenSpecBoardSnapshot;
        try {
          snapshot = await this.status.getSnapshot(task, project);
        } catch (error) {
          if ((this.reconcileGenerations.get(key) ?? 0) !== generation) {
            continue;
          }
          throw error;
        }
        const validation = this.validations.get(key);
        const next = validation ? { ...snapshot, validation } : snapshot;

        const planningRoot = statusPlanningRoot(next);
        if (planningRoot && existsSync(planningRoot)) {
          const root = this.roots.resolve(task, project);
          const canonicalPlanningRoot = this.roots.validateOfficialPlanningRoot(root, planningRoot);
          this.planningRoots.set(key, canonicalPlanningRoot);
          await this.ensureWatcher(
            task,
            project,
            buildOpenSpecWatchPaths(root.workspaceRoot, canonicalPlanningRoot),
          );
        }

        // A Change may be selected while the official status call is still in
        // flight. Never cache or publish the result for the previous selection;
        // repeat the reconciliation against the latest runtime selection.
        if ((this.reconcileGenerations.get(key) ?? 0) !== generation) {
          continue;
        }
        this.snapshots.set(key, next);
        this.reconciledGenerations.set(key, generation);
        if (emit) {
          this.publish(task, project, {
            type: 'snapshot',
            revision: next.revision,
            snapshot: next,
          });
        }
        return next;
      }
    })();
    this.reconcilePromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.reconcilePromises.get(key) === promise) {
        this.reconcilePromises.delete(key);
      }
    }
  }

  async getSnapshot(task: Task, project: Project): Promise<OpenSpecBoardSnapshot> {
    return await this.reconcile(task, project, false);
  }

  /**
   * Persist the stable task-to-OpenSpec link as part of task creation, before
   * the first prepare/reconcile or Action is requested.
   */
  initializeTask(task: Task, project: Project): void {
    assertSpecTask(task, project);
    this.runtimeStore.initialize(task, project);
  }

  async selectChange(
    task: Task,
    project: Project,
    changeName: string,
  ): Promise<OpenSpecBoardSnapshot> {
    await this.prepare(task, project);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(changeName)) {
      throw new Error('OpenSpec change name must be a kebab-case identifier.');
    }
    const changes = await this.status.listChanges(task, project);
    if (!changes.some((change) => change.name === changeName)) {
      throw new Error('The selected OpenSpec change does not exist in this root.');
    }
    this.runtimeStore.update(task, project, { selectedChangeName: changeName });
    return await this.invalidateAndReconcile(task, project, true);
  }

  async runAction(
    task: Task,
    project: Project,
    input: RunOpenSpecActionInput,
  ): Promise<{ runId: string }> {
    await this.prepare(task, project);
    this.clearProjectPreflightCache(project.id);
    return await this.runner.runAction(task, project, {
      ...input,
      taskId: task.id,
      projectId: project.id,
    });
  }

  async resumeAction(
    task: Task,
    project: Project,
    input: ResumeOpenSpecActionInput,
  ): Promise<{ runId: string }> {
    await this.prepare(task, project);
    this.clearProjectPreflightCache(project.id);
    return await this.runner.resumeAction(task, project, {
      ...input,
      taskId: task.id,
      projectId: project.id,
    });
  }

  private async startTaskFromOfficialStatus(
    task: Task,
    project: Project,
  ): Promise<{ runId: string }> {
    const snapshot = await this.getSnapshot(task, project);
    const runtime = this.runtimeStore.read(task, project);
    const activeRun = this.runtimeStore.getActiveRun(task, project);
    if (
      activeRun &&
      ACTIVE_TASK_START_STATES.has(activeRun.state)
    ) {
      return { runId: activeRun.runId };
    }

    const interruptedRunId = runtime.state === 'interrupted'
      ? runtime.activeRunId
      : null;
    if (runtime.state === 'interrupted') {
      if (!interruptedRunId || !runtime.recoveryInput) {
        throw new Error(
          'The interrupted OpenSpec Action cannot be recovered because its saved input is missing.',
        );
      }
      if (CONFIRMATION_ACTIONS.has(runtime.recoveryInput.action)) {
        throw new Error(
          `${runtime.recoveryInput.action} requires explicit confirmation to resume.`,
        );
      }
    }

    const activeChanges = snapshot.initialized &&
        !snapshot.changeName &&
        !snapshot.archived
      ? await this.status.listChanges(task, project)
      : [];
    const hasChanges = activeChanges.length > 0;
    const isInitialAction =
      !snapshot.initialized || (!snapshot.changeName && !hasChanges);
    const config = task.metadata?.openSpec;
    const savedInitialAction = (
      interruptedRunId &&
      isInitialAction &&
      runtime.recoveryInput &&
      INITIAL_WORKFLOW_ACTIONS.has(runtime.recoveryInput.action) &&
      snapshot.availableActions.includes(runtime.recoveryInput.action)
    )
      ? runtime.recoveryInput.action
      : null;
    const action = savedInitialAction ?? resolveOpenSpecWorkflowAction(
      interruptedRunId
        ? { ...snapshot, activeRun: null }
        : snapshot,
      {
        preferredStartAction: config?.startAction ?? 'new',
        hasChanges,
        lastSuccessfulAction: runtime.lastSuccessfulAction,
      },
    );
    if (!action) {
      if (snapshot.archived) {
        throw new Error('The selected OpenSpec Change is already archived.');
      }
      if (!snapshot.changeName && hasChanges) {
        throw new Error(
          'Select an existing OpenSpec Change before continuing this task.',
        );
      }
      throw new Error(
        'The OpenSpec task has no safe automatic Action in the current official status.',
      );
    }
    if (
      action === 'apply' &&
      runtime.workflowStage === 'planning' &&
      !(
        interruptedRunId &&
        runtime.recoveryInput?.action === 'apply'
      )
    ) {
      throw new Error(
        'OpenSpec planning is ready for review. Open the Spec task details to refine the plan or explicitly select Start implementation.',
      );
    }

    const initialChangeName = savedInitialAction
      ? runtime.recoveryInput?.changeName
      : config?.changeName;
    const initialArguments = savedInitialAction
      ? runtime.recoveryInput?.arguments ?? task.description
      : task.description;
    const input: RunOpenSpecActionInput = {
      taskId: task.id,
      projectId: project.id,
      action,
      ...(snapshot.changeName
        ? { changeName: snapshot.changeName }
        : isInitialAction && initialChangeName
          ? { changeName: initialChangeName }
          : {}),
      ...(isInitialAction ? { arguments: initialArguments } : {}),
    };

    this.clearProjectPreflightCache(project.id);
    if (interruptedRunId) {
      // A task-level Continue is status-first: an interrupted New may already
      // have created a Change, in which case replaying New would duplicate the
      // workflow. The old run remains in history while the newly derived
      // official Action is allowed to replace its process-bound runtime slot.
      return await this.runner.runAction(task, project, input, {
        resumeRunId: interruptedRunId,
      });
    }
    return await this.runAction(task, project, input);
  }

  async startTask(task: Task, project: Project): Promise<{ runId: string }> {
    assertSpecTask(task, project);
    const key = taskKey(task, project);
    const pending = this.taskStartPromises.get(key);
    if (pending) return await pending;

    const start = this.startTaskFromOfficialStatus(task, project);
    this.taskStartPromises.set(key, start);
    try {
      return await start;
    } finally {
      if (this.taskStartPromises.get(key) === start) {
        this.taskStartPromises.delete(key);
      }
    }
  }

  stopTask(task: Task, project: Project): void {
    assertSpecTask(task, project);
    const activeRun = this.runtimeStore.getActiveRun(task, project);
    if (!activeRun || ![
      'queued',
      'preparing',
      'running',
      'awaiting_user',
      'cancelling',
    ].includes(activeRun.state)) {
      throw new Error('No OpenSpec Action is currently running.');
    }
    this.runner.cancel(task, project, activeRun.runId);
  }

  async cancelAction(task: Task, project: Project, runId: string): Promise<void> {
    assertSpecTask(task, project);
    const runtime = this.runtimeStore.read(task, project);
    if (runtime.state === 'interrupted' && runtime.activeRunId === runId) {
      this.runtimeStore.cancelInterruptedRun(task, project, runId);
      try {
        // Cancelling the interrupted run abandons its planning review, so the
        // captured baseline must not linger in the runtime directory.
        this.planningReviews.discard(task, project, runId);
      } catch {
        // Cancellation must succeed even if the draft cannot be removed.
      }
      projectStore.invalidateTasksCache(project.id);
      this.publishTaskStatus(task, project, 'human_review', 'stopped');
      await this.reconcile(task, project, true);
      return;
    }
    this.runner.cancel(task, project, runId);
  }

  answerInteraction(
    task: Task,
    project: Project,
    input: AnswerOpenSpecInteractionInput,
  ): void {
    assertSpecTask(task, project);
    this.runner.answerInteraction(task, project, input);
  }

  async readArtifact(
    task: Task,
    project: Project,
    input: ReadOpenSpecArtifactInput,
  ): Promise<OpenSpecArtifactContent> {
    await this.prepare(task, project);
    if (this.archivedWorkspaceUnavailable(task, project)) {
      throw new Error(
        'Archived OpenSpec artifact content is unavailable because the task worktree was removed.',
      );
    }
    return await this.status.readArtifact(task, project, input);
  }

  async getArtifactDiff(
    task: Task,
    project: Project,
    input: GetOpenSpecArtifactDiffInput,
  ): Promise<OpenSpecArtifactDiff> {
    await this.prepare(task, project);
    if (this.archivedWorkspaceUnavailable(task, project)) {
      return {
        artifactId: input.artifactId,
        relativePath: input.relativePath ?? input.artifactId,
        patch: '',
        base: 'unavailable',
      };
    }
    return await this.status.getArtifactDiff(task, project, input);
  }

  async validate(
    task: Task,
    project: Project,
    input: ValidateOpenSpecInput,
  ): Promise<OpenSpecValidationSummary> {
    await this.prepare(task, project);
    const validation = await this.status.validate(task, project, input);
    const key = taskKey(task, project);
    this.validations.set(key, validation);
    this.publish(task, project, { type: 'validation', validation });
    const current = this.snapshots.get(key);
    if (current) {
      const snapshot = { ...current, validation };
      this.snapshots.set(key, snapshot);
      this.publish(task, project, {
        type: 'snapshot',
        revision: snapshot.revision,
        snapshot,
      });
    }
    return validation;
  }

  async listChanges(task: Task, project: Project): Promise<OpenSpecChangeSummary[]> {
    await this.prepare(task, project);
    if (this.archivedWorkspaceUnavailable(task, project)) {
      const runtime = this.runtimeStore.read(task, project);
      return runtime.selectedChangeName
        ? [{
            name: runtime.selectedChangeName,
            completedTasks: 0,
            totalTasks: 0,
            lastModified: runtime.updatedAt,
            status: 'archived',
            archived: true,
          }]
        : [];
    }
    const root = this.roots.resolve(task, project);
    const active = root.rootKind === 'store' || existsSync(join(root.cwd, 'openspec'))
      ? await this.status.listChanges(task, project)
      : [];
    return [...active, ...this.status.listArchivedChanges(task, project)];
  }

  async getHistory(task: Task, project: Project): Promise<OpenSpecActionHistory> {
    await this.prepare(task, project);
    return {
      ...this.runtimeStore.readHistory(task, project),
      pendingPlanningReview: this.planningReviews.readPending(task, project),
    };
  }

  async acknowledgePlanningReview(
    task: Task,
    project: Project,
    input: OpenSpecPlanningReviewInput,
  ): Promise<OpenSpecPlanningReviewSummary | null> {
    await this.prepare(task, project);
    return this.planningReviews.acknowledge(
      task,
      project,
      input.runId,
    );
  }

  async getPlanningReview(
    task: Task,
    project: Project,
    input: OpenSpecPlanningReviewInput,
  ): Promise<OpenSpecPlanningReview> {
    await this.prepare(task, project);
    return this.planningReviews.read(task, project, input.runId);
  }

  async retryPlanningReview(
    task: Task,
    project: Project,
    input: OpenSpecPlanningReviewInput,
  ): Promise<OpenSpecPlanningReview> {
    await this.prepare(task, project);
    const snapshot = await this.getSnapshot(task, project);
    const root = this.roots.resolve(task, project);
    const planningRoot = statusPlanningRoot(snapshot) ??
      this.planningRoots.get(taskKey(task, project)) ??
      (root.rootKind === 'project' ? root.workspaceRoot : null);
    if (!planningRoot) {
      throw new Error(
        'The official OpenSpec planning root is unavailable for review retry.',
      );
    }
    const allowedWritePaths = [join(planningRoot, 'openspec')];
    if (snapshot.schema.name === 'spec-driven-with-adr') {
      allowedWritePaths.push(join(root.workspaceRoot, 'adr'));
    }
    const release = await this.locks.acquireForAction({
      rootKey: planningRoot,
      changeName: snapshot.changeName ?? undefined,
      action: 'update',
      owner: `planning-review:${input.runId}`,
    });
    try {
      const review = this.planningReviews.retry(
        task,
        project,
        input.runId,
        allowedWritePaths,
      );
      this.publish(task, project, {
        type: 'planning-review',
        review: summarizeOpenSpecPlanningReview(review),
      });
      return review;
    } finally {
      release();
    }
  }

  async readRunLog(
    task: Task,
    project: Project,
    runId: string,
  ): Promise<OpenSpecRunLog> {
    await this.prepare(task, project);
    return this.runtimeStore.readRunLog(task, project, runId);
  }

  async preflightProject(
    project: Project,
    input: OpenSpecPreflightInput,
  ): Promise<OpenSpecPreflightResult> {
    if (input.projectId !== project.id) {
      throw new Error('OpenSpec preflight project does not match the selected project.');
    }
    const cacheKey = `${project.id}::${JSON.stringify({
      rootKind: input.rootKind ?? 'project',
      storeId: input.storeId?.trim() ?? '',
      schemaName: input.schemaName?.trim() ?? 'spec-driven',
      changeName: input.changeName?.trim() ?? '',
      startAction: input.startAction ?? 'new',
      useWorktree: input.useWorktree === true,
    })}`;
    const cached = this.preflightCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    const result = await this.preflight.run(project, input);
    this.preflightCache.set(cacheKey, {
      expiresAt: Date.now() + PREFLIGHT_CACHE_MS,
      result,
    });
    return result;
  }

  private clearProjectPreflightCache(projectId: string): void {
    for (const key of this.preflightCache.keys()) {
      if (key.startsWith(`${projectId}::`)) {
        this.preflightCache.delete(key);
      }
    }
  }

  async disposeTask(task: Task, project: Project): Promise<void> {
    const key = taskKey(task, project);
    const registration = this.watchers.get(key);
    if (registration) {
      if (registration.timer) clearTimeout(registration.timer);
      await registration.watcher.close();
      this.watchers.delete(key);
    }
    this.snapshots.delete(key);
    this.validations.delete(key);
    this.recoveredTasks.delete(key);
    this.archivedStatusRepairAttempts.delete(key);
    this.reconcileGenerations.delete(key);
    this.reconciledGenerations.delete(key);
    this.taskStartPromises.delete(key);
    this.planningRoots.delete(key);
    this.clearProjectPreflightCache(project.id);
  }

  async dispose(): Promise<void> {
    const registrations = [...this.watchers.values()];
    this.watchers.clear();
    for (const registration of registrations) {
      if (registration.timer) clearTimeout(registration.timer);
      await registration.watcher.close();
    }
    this.snapshots.clear();
    this.validations.clear();
    this.recoveredTasks.clear();
    this.archivedStatusRepairAttempts.clear();
    this.reconcileGenerations.clear();
    this.reconciledGenerations.clear();
    this.taskStartPromises.clear();
    this.planningRoots.clear();
    this.preflightCache.clear();
  }
}

export const __openSpecServiceTestUtils = {
  buildOpenSpecWatchPaths,
  gitIndexPath,
  shouldIgnoreOpenSpecWatchPath,
  statusPlanningRoot,
  waitForOpenSpecWatcherReady,
};
