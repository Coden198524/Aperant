import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  AUTOCODE_TASK_ARTIFACTS,
  getAutocodeSpecDir,
} from '@autocode/core';

import type {
  OpenSpecAction,
  OpenSpecActionHistory,
  OpenSpecActionRunSummary,
  OpenSpecInteraction,
  OpenSpecRunLog,
  OpenSpecRunState,
  Project,
  ReviewReason,
  RunOpenSpecActionInput,
  Task,
  TaskStatus,
} from '../../shared/types';
import { OPEN_SPEC_ACTIONS, OPEN_SPEC_VERSION } from '../../shared/types';
import { writeFileAtomicSync } from '../utils/atomic-file';

const ACTION_LOG_READ_LIMIT_BYTES = 5 * 1024 * 1024;
const RUN_LOG_READ_LIMIT_BYTES = 2 * 1024 * 1024;
const ACTIVITY_LOG_READ_LIMIT_BYTES = 4 * 1024 * 1024;
const ACTIVITY_LOG_RUN_LIMIT = 100;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_RUN_STATES = new Set<OpenSpecRunState>([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
]);
const RUN_STATES = new Set<OpenSpecRunState>([
  ...ACTIVE_RUN_STATES,
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const ACTIONS = new Set<OpenSpecAction>(OPEN_SPEC_ACTIONS);
const REVIEW_REASONS = new Set<ReviewReason>([
  'completed',
  'errors',
  'qa_rejected',
  'plan_review',
  'stopped',
  'needs_input',
]);

export const OPEN_SPEC_WORKFLOW_STAGES = [
  'planning',
  'implementation',
  'verified',
  'archived',
] as const;

export type OpenSpecWorkflowStage = (typeof OPEN_SPEC_WORKFLOW_STAGES)[number];

const WORKFLOW_STAGES = new Set<OpenSpecWorkflowStage>(OPEN_SPEC_WORKFLOW_STAGES);

export interface OpenSpecRecoverableActionInput {
  action: OpenSpecAction;
  changeName?: string;
  arguments?: string;
  selectedChanges?: string[];
}

export interface OpenSpecRuntimeFile {
  formatVersion: 1;
  taskStatus: TaskStatus;
  /**
   * Optional on disk for compatibility with runtime files written before the
   * lifecycle fields were introduced. read() always returns normalized values.
   */
  reviewReason?: ReviewReason | null;
  workflowStage?: OpenSpecWorkflowStage;
  executionPhase: string;
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  activeAction: OpenSpecAction | null;
  state: OpenSpecRunState | 'idle';
  waitingInteraction: OpenSpecInteraction | null;
  lastSuccessfulAction: OpenSpecAction | null;
  selectedChangeName: string | null;
  lastReconciledAt: string | null;
  lastStatusDigest: string | null;
  lastError: string | null;
  recoveryInput: OpenSpecRecoverableActionInput | null;
  interruptedFromState: OpenSpecRunState | null;
  waitingReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ResolvedOpenSpecRuntimeFile = Omit<
  OpenSpecRuntimeFile,
  'reviewReason' | 'workflowStage'
> & {
  reviewReason: ReviewReason | null;
  workflowStage: OpenSpecWorkflowStage;
};

export interface OpenSpecLinkFile {
  formatVersion: 1;
  taskId: string;
  developmentMode: 'spec';
  openSpecVersion: typeof OPEN_SPEC_VERSION;
  rootKind: 'project' | 'store';
  workspaceId: string;
  worktreeId: string | null;
  storeId: string | null;
  changeName: string | null;
  schemaName: string;
  createdAt: string;
}

export interface OpenSpecActionEventRecord {
  runId: string;
  taskId: string;
  projectId: string;
  action: OpenSpecAction;
  state: OpenSpecRunState;
  timestamp: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorCode?: string;
  error?: string;
  interactionCount?: number;
}

function parseJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isAction(value: unknown): value is OpenSpecAction {
  return typeof value === 'string' && ACTIONS.has(value as OpenSpecAction);
}

function isRunState(value: unknown): value is OpenSpecRunState {
  return typeof value === 'string' && RUN_STATES.has(value as OpenSpecRunState);
}

function isReviewReason(value: unknown): value is ReviewReason {
  return typeof value === 'string' && REVIEW_REASONS.has(value as ReviewReason);
}

function isWorkflowStage(value: unknown): value is OpenSpecWorkflowStage {
  return typeof value === 'string' && WORKFLOW_STAGES.has(value as OpenSpecWorkflowStage);
}

function inferWorkflowStage(
  parsed: OpenSpecRuntimeFile | null,
): OpenSpecWorkflowStage {
  if (isWorkflowStage(parsed?.workflowStage)) return parsed.workflowStage;
  if (
    parsed?.lastSuccessfulAction === 'archive' ||
    parsed?.lastSuccessfulAction === 'bulk-archive'
  ) {
    return 'archived';
  }
  if (parsed?.lastSuccessfulAction === 'verify') return 'verified';
  if (parsed?.lastSuccessfulAction === 'apply') return 'implementation';
  return 'planning';
}

function optionalString(value: unknown, maxLength = 32_000): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function normalizeRecoveryInput(value: unknown): OpenSpecRecoverableActionInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isAction(input.action)) return null;
  const selectedChanges = Array.isArray(input.selectedChanges) &&
    input.selectedChanges.every((item) => typeof item === 'string' && item.length <= 128)
    ? input.selectedChanges as string[]
    : undefined;
  return {
    action: input.action,
    ...(optionalString(input.changeName, 128) ? { changeName: input.changeName as string } : {}),
    ...(optionalString(input.arguments) ? { arguments: input.arguments as string } : {}),
    ...(selectedChanges ? { selectedChanges: [...selectedChanges] } : {}),
  };
}

function toRecoveryInput(input: RunOpenSpecActionInput): OpenSpecRecoverableActionInput {
  return {
    action: input.action,
    ...(input.changeName ? { changeName: input.changeName } : {}),
    ...(input.arguments ? { arguments: input.arguments } : {}),
    ...(input.selectedChanges ? { selectedChanges: [...input.selectedChanges] } : {}),
  };
}

function readTail(path: string, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, length, start);
  } finally {
    closeSync(descriptor);
  }
  return { buffer, truncated: start > 0 };
}

function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < Math.min(buffer.length, 4) && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString('utf8');
}

export class OpenSpecRuntimeStore {
  getSpecDir(task: Task, project: Project): string {
    return getAutocodeSpecDir({
      projectRoot: project.path,
      dataDirName: project.autoBuildPath,
      specId: task.specId,
    });
  }

  private runtimePath(task: Task, project: Project): string {
    return join(this.getSpecDir(task, project), AUTOCODE_TASK_ARTIFACTS.openSpecRuntime);
  }

  initialize(task: Task, project: Project): void {
    const specDir = this.getSpecDir(task, project);
    mkdirSync(specDir, { recursive: true });
    const now = new Date().toISOString();
    const existing = this.read(task, project);
    if (!existsSync(this.runtimePath(task, project))) {
      this.write(task, project, existing);
    }

    const link: OpenSpecLinkFile = {
      formatVersion: 1,
      taskId: task.id,
      developmentMode: 'spec',
      openSpecVersion: OPEN_SPEC_VERSION,
      rootKind: task.metadata?.openSpec?.rootKind === 'store' ? 'store' : 'project',
      workspaceId: project.id,
      worktreeId: task.metadata?.useWorktree ? task.specId : null,
      storeId: task.metadata?.openSpec?.storeId ?? null,
      changeName: task.metadata?.openSpec?.changeName ?? null,
      schemaName: task.metadata?.openSpec?.schemaName ?? 'spec-driven',
      createdAt: existing.createdAt || now,
    };
    writeFileAtomicSync(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecLink),
      `${JSON.stringify(link, null, 2)}\n`,
    );
    mkdirSync(join(specDir, 'logs'), { recursive: true });
  }

  read(task: Task, project: Project): OpenSpecRuntimeFile {
    const now = new Date().toISOString();
    const parsed = parseJsonFile<OpenSpecRuntimeFile>(this.runtimePath(task, project));
    const state = parsed?.state === 'idle' || isRunState(parsed?.state)
      ? parsed.state
      : 'idle';
    return {
      formatVersion: 1,
      taskStatus: parsed?.taskStatus ?? task.status ?? 'backlog',
      reviewReason: isReviewReason(parsed?.reviewReason)
        ? parsed.reviewReason
        : isReviewReason(task.reviewReason)
          ? task.reviewReason
          : null,
      workflowStage: inferWorkflowStage(parsed),
      executionPhase: parsed?.executionPhase ?? 'idle',
      activeRunId: optionalString(parsed?.activeRunId, 64) ?? null,
      activeRunStartedAt: optionalString(parsed?.activeRunStartedAt, 64) ?? null,
      activeAction: isAction(parsed?.activeAction) ? parsed.activeAction : null,
      state,
      waitingInteraction: parsed?.waitingInteraction ?? null,
      lastSuccessfulAction: isAction(parsed?.lastSuccessfulAction)
        ? parsed.lastSuccessfulAction
        : null,
      selectedChangeName: optionalString(parsed?.selectedChangeName, 128) ??
        task.metadata?.openSpec?.changeName ??
        null,
      lastReconciledAt: optionalString(parsed?.lastReconciledAt, 64) ?? null,
      lastStatusDigest: optionalString(parsed?.lastStatusDigest, 256) ?? null,
      lastError: optionalString(parsed?.lastError) ?? null,
      recoveryInput: normalizeRecoveryInput(parsed?.recoveryInput),
      interruptedFromState: isRunState(parsed?.interruptedFromState)
        ? parsed.interruptedFromState
        : null,
      waitingReason: optionalString(parsed?.waitingReason, 1_000) ?? null,
      createdAt: parsed?.createdAt ?? now,
      updatedAt: parsed?.updatedAt ?? now,
    };
  }

  /**
   * Recover process-bound state once during service startup. This must not be
   * performed by read(): normal reads also happen while an Action is active.
   */
  recoverInterruptedRun(task: Task, project: Project): OpenSpecRuntimeFile {
    const runtime = this.read(task, project);
    if (
      !ACTIVE_RUN_STATES.has(runtime.state as OpenSpecRunState)
    ) {
      return runtime;
    }
    const interruptedAt = new Date().toISOString();
    const next = this.update(task, project, {
      state: 'interrupted',
      taskStatus: 'error',
      reviewReason: 'errors',
      executionPhase: 'interrupted',
      interruptedFromState: runtime.state as OpenSpecRunState,
      lastError:
        'The OpenSpec Action was interrupted when Aperant exited. Continue the same official Action or cancel the interrupted run.',
    });
    if (runtime.activeRunId && runtime.activeAction) {
      const startedAt = runtime.activeRunStartedAt ?? runtime.createdAt;
      this.appendActionEvent(task, project, {
        runId: runtime.activeRunId,
        taskId: task.id,
        projectId: project.id,
        action: runtime.activeAction,
        state: 'interrupted',
        timestamp: interruptedAt,
        startedAt,
        completedAt: interruptedAt,
        durationMs: Math.max(0, Date.parse(interruptedAt) - Date.parse(startedAt)),
        errorCode: 'app_interrupted',
      });
    }
    return next;
  }

  write(task: Task, project: Project, runtime: OpenSpecRuntimeFile): void {
    const specDir = this.getSpecDir(task, project);
    mkdirSync(specDir, { recursive: true });
    writeFileAtomicSync(
      this.runtimePath(task, project),
      `${JSON.stringify(runtime, null, 2)}\n`,
    );
  }

  update(
    task: Task,
    project: Project,
    patch: Partial<OpenSpecRuntimeFile>,
  ): OpenSpecRuntimeFile {
    const runtime = this.read(task, project);
    const next: ResolvedOpenSpecRuntimeFile = {
      ...runtime,
      ...patch,
      formatVersion: 1,
      reviewReason: patch.reviewReason === null || isReviewReason(patch.reviewReason)
        ? patch.reviewReason
        : runtime.reviewReason ?? null,
      workflowStage: isWorkflowStage(patch.workflowStage)
        ? patch.workflowStage
        : runtime.workflowStage ?? inferWorkflowStage(runtime),
      updatedAt: new Date().toISOString(),
    };
    this.write(task, project, next);
    return next;
  }

  getActiveRun(task: Task, project: Project): OpenSpecActionRunSummary | null {
    const runtime = this.read(task, project);
    if (!runtime.activeRunId || !runtime.activeAction || runtime.state === 'idle') {
      return null;
    }
    return {
      runId: runtime.activeRunId,
      action: runtime.activeAction,
      state: runtime.state,
      startedAt: runtime.activeRunStartedAt ?? runtime.createdAt,
      ...(runtime.lastError ? { error: runtime.lastError } : {}),
      ...(runtime.state === 'interrupted' ? { recoverable: Boolean(runtime.recoveryInput) } : {}),
      ...(runtime.waitingReason ? { waitingReason: runtime.waitingReason } : {}),
    };
  }

  setRecoveryInput(
    task: Task,
    project: Project,
    input: RunOpenSpecActionInput,
  ): OpenSpecRuntimeFile {
    return this.update(task, project, {
      recoveryInput: toRecoveryInput(input),
      interruptedFromState: null,
    });
  }

  prepareResume(
    task: Task,
    project: Project,
    runId: string,
  ): OpenSpecRecoverableActionInput {
    const runtime = this.read(task, project);
    if (
      runtime.state !== 'interrupted' ||
      runtime.activeRunId !== runId ||
      !runtime.activeAction ||
      !runtime.recoveryInput
    ) {
      throw new Error('The interrupted OpenSpec Action is no longer recoverable.');
    }
    const input = runtime.recoveryInput;
    this.update(task, project, {
      activeRunId: null,
      activeRunStartedAt: null,
      activeAction: null,
      state: 'idle',
      waitingInteraction: null,
      recoveryInput: null,
      interruptedFromState: null,
      waitingReason: null,
      lastError: null,
      reviewReason: null,
      executionPhase: 'idle',
    });
    return input;
  }

  cancelInterruptedRun(task: Task, project: Project, runId: string): void {
    const runtime = this.read(task, project);
    if (runtime.state !== 'interrupted' || runtime.activeRunId !== runId || !runtime.activeAction) {
      throw new Error('The interrupted OpenSpec Action is no longer available.');
    }
    const completedAt = new Date().toISOString();
    const startedAt = runtime.activeRunStartedAt ?? runtime.createdAt;
    this.appendActionEvent(task, project, {
      runId,
      taskId: task.id,
      projectId: project.id,
      action: runtime.activeAction,
      state: 'cancelled',
      timestamp: completedAt,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      errorCode: 'interrupted_run_cancelled',
    });
    this.update(task, project, {
      activeRunId: null,
      activeRunStartedAt: null,
      activeAction: null,
      state: 'cancelled',
      waitingInteraction: null,
      recoveryInput: null,
      interruptedFromState: null,
      waitingReason: null,
      lastError: null,
      executionPhase: 'stopped',
      taskStatus: 'human_review',
      reviewReason: 'stopped',
    });
  }

  appendActionEvent(task: Task, project: Project, record: OpenSpecActionEventRecord): void {
    const specDir = this.getSpecDir(task, project);
    mkdirSync(specDir, { recursive: true });
    appendFileSync(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecActions),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  }

  appendRunLog(task: Task, project: Project, runId: string, text: string): void {
    const logsDir = join(this.getSpecDir(task, project), 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, `${runId}.log`), text, 'utf8');
  }

  readRunLog(task: Task, project: Project, runId: string): OpenSpecRunLog {
    return this.readRunLogWithLimit(task, project, runId, RUN_LOG_READ_LIMIT_BYTES).log;
  }

  private readRunLogWithLimit(
    task: Task,
    project: Project,
    runId: string,
    maxBytes: number,
  ): { log: OpenSpecRunLog; bytesRead: number } {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error('Invalid OpenSpec run ID.');
    }
    const path = join(this.getSpecDir(task, project), 'logs', `${runId}.log`);
    if (!existsSync(path)) {
      return {
        log: { runId, content: '', truncated: false },
        bytesRead: 0,
      };
    }
    const readLimit = Math.max(0, Math.min(maxBytes, RUN_LOG_READ_LIMIT_BYTES));
    const { buffer, truncated } = readTail(path, readLimit);
    return {
      log: {
        runId,
        content: decodeUtf8Tail(buffer),
        truncated,
      },
      bytesRead: buffer.length,
    };
  }

  readHistory(task: Task, project: Project): OpenSpecActionHistory {
    const actionsPath = join(
      this.getSpecDir(task, project),
      AUTOCODE_TASK_ARTIFACTS.openSpecActions,
    );
    const records = new Map<string, OpenSpecActionRunSummary>();
    let actionHistoryTruncated = false;
    if (existsSync(actionsPath)) {
      const { buffer, truncated } = readTail(actionsPath, ACTION_LOG_READ_LIMIT_BYTES);
      actionHistoryTruncated = truncated;
      let text = decodeUtf8Tail(buffer);
      if (truncated) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Partial<OpenSpecActionEventRecord>;
          if (
            !record.runId ||
            !RUN_ID_PATTERN.test(record.runId) ||
            !isAction(record.action) ||
            !isRunState(record.state)
          ) {
            continue;
          }
          const completedAt = optionalString(record.completedAt, 64) ??
            optionalString(record.timestamp, 64);
          const durationMs = typeof record.durationMs === 'number' &&
            Number.isFinite(record.durationMs) &&
            record.durationMs >= 0
            ? record.durationMs
            : undefined;
          const startedAt = optionalString(record.startedAt, 64) ??
            (completedAt && durationMs !== undefined
              ? new Date(Date.parse(completedAt) - durationMs).toISOString()
              : completedAt) ??
            new Date(0).toISOString();
          records.set(record.runId, {
            runId: record.runId,
            action: record.action,
            state: record.state,
            startedAt,
            ...(completedAt ? { completedAt } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(typeof record.interactionCount === 'number'
              ? { interactionCount: record.interactionCount }
              : {}),
            ...(optionalString(record.error) ? { error: record.error } : {}),
            ...(record.state === 'interrupted' ? { recoverable: true } : {}),
          });
        } catch {
          // Ignore a malformed line without losing the rest of the local history.
        }
      }
    }

    const activeRun = this.getActiveRun(task, project);
    if (activeRun) {
      records.set(activeRun.runId, {
        ...records.get(activeRun.runId),
        ...activeRun,
      });
    }
    const runs = [...records.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
    const latestRunId = activeRun?.runId ?? runs.at(-1)?.runId;
    const newestFirstSegments: OpenSpecRunLog[] = [];
    let remainingBytes = ACTIVITY_LOG_READ_LIMIT_BYTES;
    let activityLogTruncated = actionHistoryTruncated;
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      if (
        newestFirstSegments.length >= ACTIVITY_LOG_RUN_LIMIT ||
        remainingBytes <= 0
      ) {
        activityLogTruncated = true;
        break;
      }
      const { log, bytesRead } = this.readRunLogWithLimit(
        task,
        project,
        runs[index].runId,
        remainingBytes,
      );
      newestFirstSegments.push(log);
      remainingBytes -= bytesRead;
      activityLogTruncated ||= log.truncated;
    }
    if (newestFirstSegments.length < runs.length) {
      activityLogTruncated = true;
    }
    const activityLogSegments = newestFirstSegments.reverse();
    const latestActivitySegment = latestRunId
      ? activityLogSegments.find((segment) => segment.runId === latestRunId)
      : undefined;
    return {
      runs,
      activeRun,
      waitingInteraction: this.read(task, project).waitingInteraction,
      activityLog: {
        segments: activityLogSegments,
        truncated: activityLogTruncated,
      },
      latestRunLog: latestRunId
        ? latestActivitySegment ?? this.readRunLog(task, project, latestRunId)
        : null,
      pendingPlanningReview: null,
    };
  }
}

export const __openSpecRuntimeStoreTestUtils = {
  normalizeRecoveryInput,
  decodeUtf8Tail,
  RUN_ID_PATTERN,
};
