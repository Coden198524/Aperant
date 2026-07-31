import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';

import type { Project, Task } from '../../shared/types';
import { OPEN_SPEC_VERSION } from '../../shared/types';
import { OpenSpecRuntimeStore } from './openspec-runtime-store';

function task(projectId: string): Task {
  return {
    id: 'spec-task',
    specId: '001-spec-task',
    projectId,
    title: 'Spec task',
    description: 'Use the official OpenSpec workflow.',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      developmentMode: 'spec',
      useWorktree: false,
      openSpec: {
        formatVersion: 1,
        startAction: 'new',
        rootKind: 'project',
        changeName: 'change-a',
        schemaName: 'spec-driven',
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

describe('OpenSpecRuntimeStore', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes only runtime/link/log bookkeeping with the pinned OpenSpec identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-runtime-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();

    store.initialize(currentTask, currentProject);
    const specDir = store.getSpecDir(currentTask, currentProject);
    const link = JSON.parse(readFileSync(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecLink),
      'utf8',
    )) as Record<string, unknown>;

    expect(link).toMatchObject({
      formatVersion: 1,
      taskId: currentTask.id,
      developmentMode: 'spec',
      openSpecVersion: OPEN_SPEC_VERSION,
      rootKind: 'project',
      workspaceId: currentProject.id,
      changeName: 'change-a',
      schemaName: 'spec-driven',
    });
    expect(existsSync(join(specDir, 'logs'))).toBe(true);
    expect(existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan))).toBe(false);
    expect(existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.requirements))).toBe(false);
    expect(existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile))).toBe(false);
    expect(store.read(currentTask, currentProject)).toMatchObject({
      taskStatus: 'backlog',
      reviewReason: null,
      workflowStage: 'planning',
    });
  });

  it('persists the review reason and OpenSpec workflow stage', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-lifecycle-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();

    store.initialize(currentTask, currentProject);
    store.update(currentTask, currentProject, {
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'verified',
      executionPhase: 'complete',
    });

    expect(new OpenSpecRuntimeStore().read(currentTask, currentProject)).toMatchObject({
      taskStatus: 'human_review',
      reviewReason: 'completed',
      workflowStage: 'verified',
      executionPhase: 'complete',
    });
  });

  it('persists an interrupted interaction, exposes recovery, and cancels it idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-recovery-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runId = randomUUID();
    const interaction = {
      interactionId: randomUUID(),
      runId,
      taskId: currentTask.id,
      prompt: 'Choose a change.',
      createdAt: '2026-07-28T01:00:00.000Z',
      questions: [{
        question: 'Which change?',
        options: [{ label: 'change-a' }],
      }],
    };

    store.initialize(currentTask, currentProject);
    store.setRecoveryInput(currentTask, currentProject, {
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'apply',
      changeName: 'change-a',
      arguments: 'continue implementation',
    });
    store.update(currentTask, currentProject, {
      activeRunId: runId,
      activeRunStartedAt: '2026-07-28T00:59:00.000Z',
      activeAction: 'apply',
      state: 'awaiting_user',
      taskStatus: 'in_progress',
      waitingInteraction: interaction,
    });

    const recovered = store.recoverInterruptedRun(currentTask, currentProject);
    expect(recovered).toMatchObject({
      activeRunId: runId,
      activeAction: 'apply',
      state: 'interrupted',
      taskStatus: 'error',
      reviewReason: 'errors',
      interruptedFromState: 'awaiting_user',
      waitingInteraction: interaction,
      recoveryInput: {
        action: 'apply',
        changeName: 'change-a',
        arguments: 'continue implementation',
      },
    });
    expect(store.recoverInterruptedRun(currentTask, currentProject).state).toBe('interrupted');

    const interruptedHistory = store.readHistory(currentTask, currentProject);
    expect(interruptedHistory.activeRun).toMatchObject({
      runId,
      action: 'apply',
      state: 'interrupted',
      recoverable: true,
    });
    expect(interruptedHistory.runs[0]).toMatchObject({
      runId,
      action: 'apply',
      state: 'interrupted',
      durationMs: expect.any(Number),
    });
    expect(interruptedHistory.waitingInteraction).toEqual(interaction);

    store.cancelInterruptedRun(currentTask, currentProject, runId);
    const cancelledHistory = store.readHistory(currentTask, currentProject);
    expect(cancelledHistory.activeRun).toBeNull();
    expect(cancelledHistory.waitingInteraction).toBeNull();
    expect(cancelledHistory.runs).toHaveLength(1);
    expect(cancelledHistory.runs[0]).toMatchObject({
      runId,
      action: 'apply',
      state: 'cancelled',
    });
    expect(store.read(currentTask, currentProject)).toMatchObject({
      taskStatus: 'human_review',
      reviewReason: 'stopped',
      executionPhase: 'stopped',
    });
    expect(() => store.cancelInterruptedRun(currentTask, currentProject, runId)).toThrow(
      /no longer available/,
    );
  });

  it('restores persisted history, ignores malformed records, and constrains run-log reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-history-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runId = randomUUID();

    store.initialize(currentTask, currentProject);
    store.appendActionEvent(currentTask, currentProject, {
      runId,
      taskId: currentTask.id,
      projectId: currentProject.id,
      action: 'verify',
      state: 'succeeded',
      timestamp: '2026-07-28T02:00:05.000Z',
      startedAt: '2026-07-28T02:00:00.000Z',
      completedAt: '2026-07-28T02:00:05.000Z',
      durationMs: 5_000,
      interactionCount: 2,
    });
    store.appendRunLog(currentTask, currentProject, runId, '第一段\n');
    store.appendRunLog(currentTask, currentProject, runId, 'second line\n');

    const history = store.readHistory(currentTask, currentProject);
    expect(history.runs).toEqual([
      expect.objectContaining({
        runId,
        action: 'verify',
        state: 'succeeded',
        durationMs: 5_000,
        interactionCount: 2,
      }),
    ]);
    expect(history.latestRunLog).toEqual({
      runId,
      content: '第一段\nsecond line\n',
      truncated: false,
    });
    expect(() => store.readRunLog(currentTask, currentProject, '../runtime')).toThrow(
      /Invalid OpenSpec run ID/,
    );
  });

  it('aggregates run logs in chronological order and reuses the latest activity segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-activity-order-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runIds = [randomUUID(), randomUUID(), randomUUID()];
    const startedAt = [
      '2026-07-28T03:00:00.000Z',
      '2026-07-28T03:01:00.000Z',
      '2026-07-28T03:02:00.000Z',
    ];
    store.initialize(currentTask, currentProject);

    for (const index of [2, 0, 1]) {
      store.appendActionEvent(currentTask, currentProject, {
        runId: runIds[index],
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'continue',
        state: 'succeeded',
        timestamp: startedAt[index],
        startedAt: startedAt[index],
        completedAt: startedAt[index],
      });
      store.appendRunLog(
        currentTask,
        currentProject,
        runIds[index],
        `run ${index + 1}\n`,
      );
    }

    const history = store.readHistory(currentTask, currentProject);
    expect(history.activityLog).toMatchObject({
      truncated: false,
      segments: [
        { runId: runIds[0], content: 'run 1\n', truncated: false },
        { runId: runIds[1], content: 'run 2\n', truncated: false },
        { runId: runIds[2], content: 'run 3\n', truncated: false },
      ],
    });
    expect(history.latestRunLog).toBe(history.activityLog.segments[2]);
  });

  it('allocates the aggregate byte budget from the newest run backwards', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-activity-bytes-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runIds = [randomUUID(), randomUUID(), randomUUID()];
    const twoMiB = 2 * 1024 * 1024;
    store.initialize(currentTask, currentProject);

    for (const [index, runId] of runIds.entries()) {
      const startedAt = new Date(Date.UTC(2026, 6, 28, 4, index)).toISOString();
      store.appendActionEvent(currentTask, currentProject, {
        runId,
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'apply',
        state: 'succeeded',
        timestamp: startedAt,
        startedAt,
        completedAt: startedAt,
      });
      store.appendRunLog(currentTask, currentProject, runId, String(index).repeat(twoMiB));
    }

    const history = store.readHistory(currentTask, currentProject);
    expect(history.activityLog.truncated).toBe(true);
    expect(history.activityLog.segments.map((segment) => segment.runId)).toEqual([
      runIds[1],
      runIds[2],
    ]);
    expect(history.activityLog.segments.every((segment) => !segment.truncated)).toBe(true);
    expect(history.activityLog.segments.reduce(
      (bytes, segment) => bytes + Buffer.byteLength(segment.content),
      0,
    )).toBe(4 * 1024 * 1024);
    expect(history.latestRunLog).toBe(history.activityLog.segments[1]);
  });

  it('limits aggregate activity to the 100 newest runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-activity-runs-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runIds = Array.from({ length: 101 }, () => randomUUID());
    store.initialize(currentTask, currentProject);

    for (const [index, runId] of runIds.entries()) {
      const startedAt = new Date(Date.UTC(2026, 6, 28, 5, 0, index)).toISOString();
      store.appendActionEvent(currentTask, currentProject, {
        runId,
        taskId: currentTask.id,
        projectId: currentProject.id,
        action: 'verify',
        state: 'succeeded',
        timestamp: startedAt,
        startedAt,
        completedAt: startedAt,
      });
    }

    const history = store.readHistory(currentTask, currentProject);
    expect(history.activityLog.truncated).toBe(true);
    expect(history.activityLog.segments).toHaveLength(100);
    expect(history.activityLog.segments.map((segment) => segment.runId)).toEqual(
      runIds.slice(1),
    );
  });

  it('returns a valid UTF-8 tail and marks oversized action logs as truncated', () => {
    const root = mkdtempSync(join(tmpdir(), 'aperant-openspec-log-tail-'));
    roots.push(root);
    const currentTask = task('project-a');
    const currentProject = project(root);
    const store = new OpenSpecRuntimeStore();
    const runId = randomUUID();
    store.initialize(currentTask, currentProject);

    store.appendRunLog(
      currentTask,
      currentProject,
      runId,
      `${'前'.repeat(800_000)}\nTAIL\n`,
    );
    const log = store.readRunLog(currentTask, currentProject, runId);
    expect(log.truncated).toBe(true);
    expect(log.content).toContain('TAIL\n');
    expect(log.content).not.toContain('\uFFFD');
  });
});
