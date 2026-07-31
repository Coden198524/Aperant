import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  test,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  OpenSpecAction,
  OpenSpecActionHistory,
  OpenSpecArtifactSnapshot,
  OpenSpecBoardSnapshot,
  OpenSpecChangeSummary,
  OpenSpecPreflightResult,
  Task,
} from '../src/shared/types';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDir, '..');
const PROJECT_ID = 'project-openspec-e2e';
const SPEC_TASK_ID = 'task-spec-e2e';
const NOW = '2026-07-28T08:00:00.000Z';

interface MockCall {
  channel: string;
  input: unknown;
}

interface OpenSpecE2EFixture {
  project: Record<string, unknown>;
  tasks: Task[];
  snapshots: Record<string, OpenSpecBoardSnapshot>;
  changes: Record<string, OpenSpecChangeSummary[]>;
  histories: Record<string, OpenSpecActionHistory>;
  preflightValid: boolean;
  archiveConflict?: boolean;
}

interface OpenSpecE2EContext {
  app: ElectronApplication;
  page: Page;
  fixture: OpenSpecE2EFixture;
  tempDir: string;
  userDataDir: string;
}

function artifact(
  id: string,
  status: OpenSpecArtifactSnapshot['status'],
  options: Partial<OpenSpecArtifactSnapshot> = {},
): OpenSpecArtifactSnapshot {
  const outputPath = `openspec/changes/checkout-flow/${id}.md`;
  return {
    id,
    description: `${id} artifact`,
    outputPath,
    status,
    missingDeps: [],
    existingOutputPaths: status === 'done' ? [outputPath] : [],
    dependencies: [],
    unlocks: [],
    instruction: `Create the official ${id} artifact.`,
    template: `# ${id}`,
    inProgress: false,
    blocksApply: id === 'tasks',
    ...options,
  };
}

function snapshot(
  taskId: string,
  options: Partial<OpenSpecBoardSnapshot> = {},
): OpenSpecBoardSnapshot {
  return {
    taskId,
    openSpecVersion: '1.6.0',
    rootKind: 'project',
    rootLabel: 'Project · checkout-flow',
    initialized: true,
    changeName: 'checkout-flow',
    schema: {
      name: 'spec-driven',
      version: 1,
      description: 'Official OpenSpec schema',
    },
    artifacts: [
      artifact('proposal', 'done', {
        unlocks: ['specs', 'design'],
        metrics: { requirements: 2, scenarios: 3 },
      }),
      artifact('specs', 'ready', {
        dependencies: ['proposal'],
        unlocks: ['tasks'],
      }),
      artifact('design', 'blocked', {
        dependencies: ['proposal'],
        missingDeps: ['proposal-review'],
      }),
      artifact('tasks', 'done', {
        dependencies: ['specs', 'design'],
        checklist: { completed: 1, total: 3 },
        inProgress: true,
      }),
      artifact('release-notes', 'done'),
    ],
    applyRequires: ['tasks'],
    taskProgress: { completed: 1, total: 3 },
    actionContext: {
      planningHome: {
        kind: 'project',
        root: 'C:\\e2e\\project\\openspec',
        changesDir: 'C:\\e2e\\project\\openspec\\changes',
        defaultSchema: 'spec-driven',
      },
      mode: 'project',
      sourceOfTruth: 'openspec/',
      linkedContext: ['src/checkout.ts'],
      allowedEditRoots: ['C:\\e2e\\project'],
      requiresAffectedAreaSelection: false,
      constraints: ['Use official OpenSpec artifacts only.'],
    },
    activeRun: null,
    validation: {
      valid: true,
      checkedAt: NOW,
      issues: [],
    },
    nextSteps: ['Continue the next ready artifact.'],
    availableActions: [
      'explore',
      'propose',
      'apply',
      'update',
      'sync',
      'archive',
      'new',
      'continue',
      'ff',
      'verify',
      'bulk-archive',
      'onboard',
    ],
    rawStatus: { schemaName: 'spec-driven' },
    unsupportedStatus: false,
    archived: false,
    revision: 1,
    ...options,
  };
}

function task(
  id: string,
  developmentMode: 'direct' | 'standard' | 'spec',
  options: Partial<Task> = {},
): Task {
  return {
    id,
    specId: id,
    projectId: PROJECT_ID,
    title: `${developmentMode.toUpperCase()} E2E task`,
    description: `${developmentMode} mode regression fixture`,
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      sourceType: 'manual',
      developmentMode,
      workflowMode:
        developmentMode === 'direct'
          ? 'off'
          : developmentMode === 'spec'
            ? 'off'
            : 'balanced',
      ...(developmentMode === 'spec'
        ? {
            openSpec: {
              formatVersion: 1 as const,
              startAction: 'new' as const,
              rootKind: 'project' as const,
              schemaName: 'spec-driven',
              changeName: 'checkout-flow',
            },
          }
        : {}),
    },
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...options,
  };
}

function defaultFixture(): OpenSpecE2EFixture {
  const specTask = task(SPEC_TASK_ID, 'spec');
  return {
    project: {
      id: PROJECT_ID,
      name: 'OpenSpec E2E Project',
      path: 'C:\\e2e\\project',
      autoBuildPath: '.autocode',
      settings: {
        model: 'sonnet',
        memoryBackend: 'file',
        linearSync: false,
        notifications: {
          onTaskComplete: false,
          onTaskFailed: false,
          onReviewNeeded: false,
          sound: false,
        },
        mainBranch: 'main',
        pushNewBranches: false,
        useClaudeMd: true,
        maxParallelTasks: 3,
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    tasks: [specTask],
    snapshots: {
      [SPEC_TASK_ID]: snapshot(SPEC_TASK_ID),
    },
    changes: {
      [SPEC_TASK_ID]: [
        {
          name: 'checkout-flow',
          completedTasks: 1,
          totalTasks: 3,
          lastModified: NOW,
          status: 'active',
        },
        {
          name: 'search-flow',
          completedTasks: 2,
          totalTasks: 2,
          lastModified: NOW,
          status: 'active',
        },
        {
          name: 'legacy-flow',
          completedTasks: 4,
          totalTasks: 4,
          lastModified: NOW,
          status: 'active',
        },
      ],
    },
    histories: {
      [SPEC_TASK_ID]: {
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        latestRunLog: null,
      },
    },
    preflightValid: true,
  };
}

async function installFixtureHandlers(
  app: ElectronApplication,
  fixture: OpenSpecE2EFixture,
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, serializedFixture) => {
      type Runtime = typeof serializedFixture & {
        calls: MockCall[];
        runSequence: number;
      };

      const runtime: Runtime = {
        ...serializedFixture,
        calls: [],
        runSequence: 0,
      };
      const NOW = '2026-07-28T08:00:00.000Z';
      (globalThis as typeof globalThis & { __openSpecE2E?: Runtime }).__openSpecE2E =
        runtime;

      const copy = <T,>(value: T): T =>
        JSON.parse(JSON.stringify(value)) as T;
      const replace = (
        channel: string,
        handler: Parameters<typeof ipcMain.handle>[1],
      ): void => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      const historyFor = (taskId: string): OpenSpecActionHistory => {
        runtime.histories[taskId] ??= {
          runs: [],
          activeRun: null,
          waitingInteraction: null,
          latestRunLog: null,
        };
        return runtime.histories[taskId];
      };
      const changesFor = (taskId: string): OpenSpecChangeSummary[] => {
        runtime.changes[taskId] ??= [];
        return runtime.changes[taskId];
      };
      const send = (
        event: Electron.IpcMainInvokeEvent,
        taskId: string,
        projectId: string | undefined,
        value: unknown,
      ): void => {
        event.sender.send('openspec:event', taskId, value, projectId);
      };

      replace('tabState:get', () => ({
        success: true,
        data: {
          openProjectIds: [runtime.project.id],
          activeProjectId: runtime.project.id,
          tabOrder: [runtime.project.id],
        },
      }));
      replace('tabState:save', () => ({ success: true }));
      replace('project:list', () => ({
        success: true,
        data: copy([runtime.project]),
      }));
      replace('task:list', () => ({
        success: true,
        data: copy(runtime.tasks),
      }));
      replace('env:get', () => ({
        success: true,
        data: {
          githubEnabled: false,
          gitlabEnabled: false,
          yunxiaoEnabled: false,
        },
      }));
      replace(
        'task:create',
        (
          _event: Electron.IpcMainInvokeEvent,
          projectId: string,
          title: string,
          description: string,
          metadata: Record<string, unknown>,
        ) => {
          runtime.calls.push({
            channel: 'task:create',
            input: { projectId, title, description, metadata },
          });
          const created = {
            id: `created-${runtime.tasks.length + 1}`,
            specId: `created-${runtime.tasks.length + 1}`,
            projectId,
            title: title || 'Generated task title',
            description,
            status: 'backlog',
            subtasks: [],
            logs: [],
            metadata,
            createdAt: NOW,
            updatedAt: NOW,
          };
          runtime.tasks.push(created as Task);
          return { success: true, data: copy(created) };
        },
      );

      replace(
        'openspec:getSnapshot',
        (_event: Electron.IpcMainInvokeEvent, taskId: string) =>
          copy(runtime.snapshots[taskId]),
      );
      replace(
        'openspec:listChanges',
        (_event: Electron.IpcMainInvokeEvent, taskId: string) =>
          copy(changesFor(taskId)),
      );
      replace(
        'openspec:getHistory',
        (_event: Electron.IpcMainInvokeEvent, taskId: string) =>
          copy(historyFor(taskId)),
      );
      replace(
        'openspec:selectChange',
        (
          _event: Electron.IpcMainInvokeEvent,
          taskId: string,
          changeName: string,
        ) => {
          const current = runtime.snapshots[taskId];
          current.changeName = changeName;
          current.archived = false;
          current.revision += 1;
          return copy(current);
        },
      );
      replace(
        'openspec:readArtifact',
        (
          _event: Electron.IpcMainInvokeEvent,
          input: {
            artifactId: string;
            relativePath?: string;
          },
        ) => ({
          artifactId: input.artifactId,
          relativePath:
            input.relativePath ??
            `openspec/changes/checkout-flow/${input.artifactId}.md`,
          content: [
            `# ${input.artifactId}`,
            '',
            'Official OpenSpec document rendered by the E2E fixture.',
            '',
            '[Blocked external link](https://example.com)',
            '',
            '![Blocked diagram](https://example.com/diagram.png)',
          ].join('\n'),
          modifiedAt: NOW,
        }),
      );
      replace(
        'openspec:getArtifactDiff',
        (
          _event: Electron.IpcMainInvokeEvent,
          input: {
            artifactId: string;
            relativePath?: string;
          },
        ) => ({
          artifactId: input.artifactId,
          relativePath:
            input.relativePath ??
            `openspec/changes/checkout-flow/${input.artifactId}.md`,
          patch: `@@ -0,0 +1 @@\n+# ${input.artifactId}\n`,
          base: 'git',
        }),
      );
      replace(
        'openspec:validate',
        (
          event: Electron.IpcMainInvokeEvent,
          input: { taskId: string; projectId?: string },
        ) => {
          const validation = {
            valid: true,
            checkedAt: NOW,
            issues: [],
          };
          runtime.calls.push({ channel: 'openspec:validate', input });
          runtime.snapshots[input.taskId].validation = validation;
          send(event, input.taskId, input.projectId, {
            type: 'validation',
            validation,
          });
          return copy(validation);
        },
      );
      replace(
        'openspec:preflight',
        (
          _event: Electron.IpcMainInvokeEvent,
          input: Record<string, unknown>,
        ): OpenSpecPreflightResult => {
          runtime.calls.push({ channel: 'openspec:preflight', input });
          return {
            valid: runtime.preflightValid,
            openSpecVersion: '1.6.0',
            rootKind: input.rootKind === 'store' ? 'store' : 'project',
            rootLabel:
              input.rootKind === 'store'
                ? 'Store · team-planning'
                : 'Project · OpenSpec E2E Project',
            initialized: true,
            schemaName:
              typeof input.schemaName === 'string'
                ? input.schemaName
                : 'spec-driven',
            availableSchemas: [
              'spec-driven',
              'spec-driven-with-adr',
              'team-flow',
            ],
            registeredStores: ['team-planning', 'platform-planning'],
            changeExists: false,
            checks: [
              {
                code: 'version',
                ok: runtime.preflightValid,
                message: runtime.preflightValid
                  ? 'Pinned OpenSpec 1.6.0 is ready.'
                  : 'OpenSpec version mismatch: expected 1.6.0.',
                severity: runtime.preflightValid ? 'info' : 'error',
              },
            ],
          };
        },
      );
      replace(
        'openspec:readRunLog',
        (
          _event: Electron.IpcMainInvokeEvent,
          _taskId: string,
          runId: string,
        ) => ({
          runId,
          content: `Official log for ${runId}`,
          truncated: false,
        }),
      );

      replace(
        'openspec:runAction',
        (
          event: Electron.IpcMainInvokeEvent,
          input: {
            taskId: string;
            projectId?: string;
            action: OpenSpecAction;
            arguments?: string;
            selectedChanges?: string[];
            confirmed?: boolean;
          },
        ) => {
          runtime.calls.push({ channel: 'openspec:runAction', input });
          if (
            runtime.archiveConflict &&
            input.action === 'archive' &&
            input.confirmed
          ) {
            throw new Error(
              'openspec_lock_conflict: another Archive or Sync owns the root lock',
            );
          }

          const current = runtime.snapshots[input.taskId];
          const runId = `run-${++runtime.runSequence}-${input.action}`;
          const running = {
            runId,
            action: input.action,
            state: 'running' as const,
            startedAt: NOW,
          };
          current.activeRun = running;
          historyFor(input.taskId).runs.push(running);
          send(event, input.taskId, input.projectId, {
            type: 'run-state',
            run: running,
          });
          send(event, input.taskId, input.projectId, {
            type: 'output',
            runId,
            sequence: 1,
            text: `Running official ${input.action} Action\n`,
          });

          if (
            input.action === 'onboard' &&
            input.arguments?.includes('interaction')
          ) {
            const waiting = {
              ...running,
              state: 'awaiting_user' as const,
              waitingReason: 'Official Onboard Action needs an answer.',
              interactionCount: 1,
            };
            const interaction = {
              interactionId: 'interaction-onboard',
              runId,
              taskId: input.taskId,
              prompt: 'Choose the onboarding schema policy.',
              createdAt: NOW,
              questions: [
                {
                  header: 'Schema',
                  question: 'Which schema policy should OpenSpec use?',
                  options: [
                    {
                      label: 'Use strict schema',
                      description: 'Keep official validation strict.',
                    },
                    {
                      label: 'Use default schema',
                      description: 'Keep the project default.',
                    },
                  ],
                  multiSelect: false,
                },
              ],
            };
            current.activeRun = waiting;
            const history = historyFor(input.taskId);
            history.runs[history.runs.length - 1] = waiting;
            history.activeRun = waiting;
            history.waitingInteraction = interaction;
            send(event, input.taskId, input.projectId, {
              type: 'run-state',
              run: waiting,
            });
            send(event, input.taskId, input.projectId, {
              type: 'interaction-required',
              interaction,
            });
            return { runId };
          }

          if (input.action === 'new') {
            const requested = input.arguments?.trim();
            current.changeName = requested || 'new-change';
            current.archived = false;
            if (
              !changesFor(input.taskId).some(
                (change) => change.name === current.changeName,
              )
            ) {
              changesFor(input.taskId).push({
                name: current.changeName,
                completedTasks: 0,
                totalTasks: 3,
                lastModified: NOW,
                status: 'active',
              });
            }
          } else if (input.action === 'continue') {
            const ready = current.artifacts.find(
              (candidate) => candidate.status === 'ready',
            );
            if (ready) {
              ready.status = 'done';
              ready.existingOutputPaths = [ready.outputPath];
            }
            const blocked = current.artifacts.find(
              (candidate) => candidate.status === 'blocked',
            );
            if (blocked) {
              blocked.status = 'ready';
              blocked.missingDeps = [];
            }
          } else if (
            input.action === 'ff' ||
            input.action === 'propose'
          ) {
            for (const candidate of current.artifacts) {
              if (candidate.status !== 'unknown') {
                candidate.status = 'done';
                candidate.inProgress = false;
                candidate.missingDeps = [];
                candidate.existingOutputPaths = [candidate.outputPath];
              }
            }
          } else if (input.action === 'apply') {
            const tasks = current.artifacts.find(
              (candidate) => candidate.id === 'tasks',
            );
            if (tasks) {
              tasks.checklist = { completed: 3, total: 3 };
              tasks.inProgress = false;
            }
            current.taskProgress = { completed: 3, total: 3 };
          } else if (input.action === 'archive') {
            current.archived = true;
            for (const change of changesFor(input.taskId)) {
              if (change.name === current.changeName) {
                change.archived = true;
                change.status = 'archived';
              }
            }
          } else if (input.action === 'bulk-archive') {
            for (const change of changesFor(input.taskId)) {
              if (input.selectedChanges?.includes(change.name)) {
                change.archived = true;
                change.status = 'archived';
              }
            }
          }

          current.revision += 1;
          const succeeded = {
            ...running,
            state: 'succeeded' as const,
            completedAt: NOW,
            durationMs: 50,
          };
          current.activeRun = succeeded;
          const history = historyFor(input.taskId);
          history.runs[history.runs.length - 1] = succeeded;
          history.activeRun = null;
          history.latestRunLog = {
            runId,
            content: `Running official ${input.action} Action\nSucceeded\n`,
            truncated: false,
          };
          send(event, input.taskId, input.projectId, {
            type: 'snapshot',
            revision: current.revision,
            snapshot: copy(current),
          });
          send(event, input.taskId, input.projectId, {
            type: 'run-state',
            run: succeeded,
          });
          send(event, input.taskId, input.projectId, {
            type: 'output',
            runId,
            sequence: 2,
            text: 'Succeeded\n',
          });
          return { runId };
        },
      );

      replace(
        'openspec:answerInteraction',
        (
          event: Electron.IpcMainInvokeEvent,
          input: {
            taskId: string;
            projectId?: string;
            runId: string;
            answer: string;
          },
        ) => {
          runtime.calls.push({
            channel: 'openspec:answerInteraction',
            input,
          });
          const current = runtime.snapshots[input.taskId];
          const previous = current.activeRun;
          const succeeded = {
            runId: input.runId,
            action: previous?.action ?? ('onboard' as const),
            state: 'succeeded' as const,
            startedAt: previous?.startedAt ?? NOW,
            completedAt: NOW,
          };
          current.activeRun = succeeded;
          current.revision += 1;
          const history = historyFor(input.taskId);
          const index = history.runs.findIndex(
            (run) => run.runId === input.runId,
          );
          if (index >= 0) history.runs[index] = succeeded;
          history.activeRun = null;
          history.waitingInteraction = null;
          send(event, input.taskId, input.projectId, {
            type: 'run-state',
            run: succeeded,
          });
          send(event, input.taskId, input.projectId, {
            type: 'snapshot',
            revision: current.revision,
            snapshot: copy(current),
          });
        },
      );
      replace(
        'openspec:resumeAction',
        (
          event: Electron.IpcMainInvokeEvent,
          input: {
            taskId: string;
            projectId?: string;
            runId: string;
            confirmed?: boolean;
          },
        ) => {
          runtime.calls.push({ channel: 'openspec:resumeAction', input });
          const current = runtime.snapshots[input.taskId];
          const previous = current.activeRun;
          const succeeded = {
            runId: input.runId,
            action: previous?.action ?? ('continue' as const),
            state: 'succeeded' as const,
            startedAt: previous?.startedAt ?? NOW,
            completedAt: NOW,
            recoverable: true,
          };
          current.activeRun = succeeded;
          current.revision += 1;
          const history = historyFor(input.taskId);
          const index = history.runs.findIndex(
            (run) => run.runId === input.runId,
          );
          if (index >= 0) history.runs[index] = succeeded;
          history.activeRun = null;
          history.waitingInteraction = null;
          send(event, input.taskId, input.projectId, {
            type: 'run-state',
            run: succeeded,
          });
          send(event, input.taskId, input.projectId, {
            type: 'snapshot',
            revision: current.revision,
            snapshot: copy(current),
          });
          return { runId: input.runId };
        },
      );
      replace(
        'openspec:cancelAction',
        (
          _event: Electron.IpcMainInvokeEvent,
          taskId: string,
          runId: string,
          projectId?: string,
        ) => {
          runtime.calls.push({
            channel: 'openspec:cancelAction',
            input: { taskId, runId, projectId },
          });
        },
      );
    },
    fixture,
  );
}

async function launchFixture(
  fixture = defaultFixture(),
  existing?: Pick<OpenSpecE2EContext, 'tempDir' | 'userDataDir'>,
): Promise<OpenSpecE2EContext> {
  const tempDir =
    existing?.tempDir ?? mkdtempSync(path.join(tmpdir(), 'openspec-e2e-'));
  const userDataDir = existing?.userDataDir ?? path.join(tempDir, 'user-data');
  mkdirSync(userDataDir, { recursive: true });

  const app = await electron.launch({
    args: [
      desktopRoot,
      `--user-data-dir=${userDataDir}`,
      '--disable-gpu',
      '--disable-software-rasterizer',
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded');
  await installFixtureHandlers(app, fixture);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const skipSetup = page.getByRole('button', { name: 'Skip Setup' });
  if (
    await skipSetup
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await skipSetup.click();
    await expect(skipSetup).toBeHidden();
  }
  await expect(page.getByTestId(`task-card-${fixture.tasks[0].id}`)).toBeVisible({
    timeout: 20_000,
  });

  return { app, page, fixture, tempDir, userDataDir };
}

async function closeFixture(
  context: OpenSpecE2EContext,
  removeTemp = true,
): Promise<void> {
  await context.app.close();
  if (removeTemp) {
    rmSync(context.tempDir, { recursive: true, force: true });
  }
}

async function calls(context: OpenSpecE2EContext): Promise<MockCall[]> {
  return context.app.evaluate(() => {
    const runtime = (
      globalThis as typeof globalThis & {
        __openSpecE2E?: { calls: MockCall[] };
      }
    ).__openSpecE2E;
    return runtime?.calls ?? [];
  });
}

async function openTask(
  context: OpenSpecE2EContext,
  taskId: string,
): Promise<void> {
  await context.page.getByTestId(`task-card-${taskId}`).click();
}

test.describe('OpenSpec Spec mode', () => {
  test.describe.configure({ mode: 'serial' });

  test('creates a Spec task from the three-mode selector after live preflight', async () => {
    const context = await launchFixture();
    try {
      await expect(context.page.getByTestId('new-task-button')).toBeEnabled();
      await context.page.getByTestId('new-task-button').click();
      await expect(context.page.getByTestId('task-modal')).toBeVisible();

      await expect(
        context.page.getByTestId('development-mode-direct'),
      ).toBeVisible();
      await expect(
        context.page.getByTestId('development-mode-standard'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        context.page.getByTestId('development-mode-spec'),
      ).toBeVisible();

      await context.page.getByTestId('development-mode-spec').click();
      await expect(
        context.page.getByTestId('development-mode-spec'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(context.page.getByTestId('openspec-task-config')).toBeVisible();
      await expect(
        context.page.getByText('Pinned OpenSpec 1.6.0 is ready.'),
      ).toBeVisible();

      await context.page.locator('#create-openspec-schema').click();
      await context.page.getByRole('option', {
        name: 'Spec-driven + ADR (spec-driven-with-adr)',
      }).click();
      await context.page.locator('#create-openspec-change').fill('payment-flow');
      await context.page
        .locator('#create-description')
        .fill('Implement the payment flow using official OpenSpec artifacts.');
      await context.page.getByTestId('create-task-submit').click();
      await expect(context.page.getByTestId('task-modal')).toBeHidden();

      await expect
        .poll(async () => {
          const createCall = (await calls(context)).find(
            (entry) => entry.channel === 'task:create',
          );
          return createCall?.input;
        })
        .toMatchObject({
          projectId: PROJECT_ID,
          description:
            'Implement the payment flow using official OpenSpec artifacts.',
          metadata: {
            developmentMode: 'spec',
            workflowMode: 'balanced',
            openSpec: {
              formatVersion: 1,
              startAction: 'new',
              rootKind: 'project',
              schemaName: 'spec-driven-with-adr',
              changeName: 'payment-flow',
            },
          },
        });
    } finally {
      await closeFixture(context);
    }
  });

  test('previews the workflow and automatically advances planning, implementation, review, and Archive', async () => {
    const context = await launchFixture();
    try {
      await openTask(context, SPEC_TASK_ID);
      await expect(context.page.getByTestId('openspec-task-detail')).toBeVisible();
      await expect(context.page.getByTestId('openspec-workspace')).toBeVisible();

      const workflowStages = context.page.getByTestId(
        'openspec-workflow-stages',
      );
      await expect(workflowStages).toBeVisible();
      await expect(
        workflowStages.getByTestId('openspec-artifact-design'),
      ).toContainText('Waiting');
      await expect(
        workflowStages.getByTestId('openspec-artifact-specs'),
      ).toContainText('Ready');
      await expect(
        workflowStages.getByTestId('openspec-artifact-tasks'),
      ).toContainText('In progress');
      await expect(
        workflowStages.getByTestId('openspec-artifact-proposal'),
      ).toContainText('Complete');
      await expect(
        workflowStages.getByTestId('openspec-artifact-release-notes'),
      ).toContainText('Complete');

      const automaticAction = context.page.getByTestId(
        'openspec-auto-action',
      );
      await expect(automaticAction).toContainText('Continue planning');
      for (const command of [
        'new',
        'continue',
        'propose',
        'apply',
        'ff',
        'verify',
        'update',
        'sync',
        'onboard',
      ]) {
        await expect(
          context.page.getByTestId(`openspec-action-${command}`),
        ).toHaveCount(0);
      }

      await expect(
        context.page.getByTestId('openspec-preview-rendered'),
      ).toContainText('Official OpenSpec document');
      await expect(context.page.getByText('Blocked external link')).toHaveAttribute(
        'title',
        /External link blocked/,
      );
      await expect(
        context.page.getByText('Remote image blocked: Blocked diagram'),
      ).toBeVisible();

      await context.page.getByRole('tab', { name: 'Source' }).click();
      await expect(
        context.page.getByTestId('openspec-preview-source'),
      ).toContainText('# proposal');
      await context.page.getByRole('tab', { name: 'Diff' }).click();
      await expect(
        context.page.getByTestId('openspec-preview-diff'),
      ).toContainText('+# proposal');
      await context.page.getByRole('tab', { name: 'Context' }).click();
      await expect(
        context.page.getByTestId('openspec-action-context'),
      ).toContainText('openspec/');

      await context.page
        .getByRole('button', {
          name: 'Add optional guidance for the next run',
        })
        .click();
      await context.page
        .getByLabel('AI workflow guidance')
        .fill('Emphasize checkout edge cases.');

      await automaticAction.click();
      await expect(
        context.page.getByLabel('OpenSpec Action console'),
      ).toContainText('Running official continue Action');
      await expect(
        workflowStages.getByTestId('openspec-artifact-specs'),
      ).toContainText('Complete');
      await expect(
        workflowStages.getByTestId('openspec-artifact-design'),
      ).toContainText('Ready');

      await automaticAction.click();
      await expect(automaticAction).toContainText('Continue implementation');

      await automaticAction.click();
      await expect(
        context.page.getByTestId('openspec-artifact-tasks'),
      ).toContainText('3/3');
      await expect(automaticAction).toContainText('Review implementation');

      await automaticAction.click();
      await expect(automaticAction).toContainText('No action required');
      await expect(automaticAction).toBeDisabled();

      await context.page
        .getByRole('button', { name: 'More OpenSpec options' })
        .click();
      await context.page.getByTestId('openspec-action-archive').click();
      await expect(
        context.page.getByRole('heading', { name: 'Confirm Archive' }),
      ).toBeVisible();
      await context.page
        .getByRole('button', { name: 'Run official Archive' })
        .click();
      await expect(context.page.getByText('Archived', { exact: true })).toBeVisible();
      await context.page.getByRole('tab', { name: 'History' }).click();
      await expect(context.page.getByTestId('openspec-history')).toContainText(
        'checkout-flow',
      );

      const actions = (await calls(context))
        .filter((entry) => entry.channel === 'openspec:runAction')
        .map(
          (entry) =>
            (entry.input as { action: OpenSpecAction }).action,
        );
      expect(actions).toEqual([
        'continue',
        'continue',
        'apply',
        'verify',
        'archive',
      ]);
    } finally {
      await closeFixture(context);
    }
  });

  test('uses one automatic FF action and keeps Bulk Archive behind confirmation', async () => {
    const fixture = defaultFixture();
    fixture.snapshots[SPEC_TASK_ID] = snapshot(SPEC_TASK_ID, {
      artifacts: [
        artifact('proposal', 'done'),
        artifact('specs', 'blocked', {
          dependencies: ['proposal'],
          missingDeps: ['proposal-review'],
        }),
        artifact('design', 'blocked', {
          dependencies: ['proposal'],
          missingDeps: ['proposal-review'],
        }),
        artifact('tasks', 'done', {
          dependencies: ['specs', 'design'],
          checklist: { completed: 0, total: 3 },
          blocksApply: true,
        }),
      ],
      taskProgress: { completed: 0, total: 3 },
    });
    const context = await launchFixture(fixture);
    try {
      await openTask(context, SPEC_TASK_ID);
      await expect(context.page.getByTestId('openspec-workspace')).toBeVisible();

      const automaticAction = context.page.getByTestId(
        'openspec-auto-action',
      );
      await expect(automaticAction).toContainText('Complete planning');
      await automaticAction.click();
      await expect(automaticAction).toContainText('Start implementation');

      await context.page
        .getByRole('button', { name: 'More OpenSpec options' })
        .click();
      await context.page.getByTestId('openspec-action-bulk-archive').click();
      await expect(
        context.page.getByRole('heading', { name: 'Confirm Bulk Archive' }),
      ).toBeVisible();
      const bulkCheckboxes = context.page.getByRole('checkbox');
      await bulkCheckboxes.nth(0).click();
      await bulkCheckboxes.nth(1).click();
      await context.page
        .getByRole('button', { name: 'Run official Bulk Archive' })
        .click();
      await context.page.getByRole('tab', { name: 'History' }).click();
      await expect(context.page.getByTestId('openspec-history')).toContainText(
        'Archived changes',
      );

      const recorded = await calls(context);
      const actions = recorded
        .filter((entry) => entry.channel === 'openspec:runAction')
        .map(
          (entry) =>
            (entry.input as { action: OpenSpecAction }).action,
        );
      expect(actions).toEqual(['ff', 'bulk-archive']);
      expect(
        recorded.some(
          (entry) => entry.channel === 'openspec:validate',
        ),
      ).toBe(true);
      expect(
        recorded.find(
          (entry) =>
            entry.channel === 'openspec:runAction' &&
            (entry.input as { action: string }).action === 'bulk-archive',
        )?.input,
      ).toMatchObject({
        confirmed: true,
        selectedChanges: ['checkout-flow', 'search-flow'],
      });
    } finally {
      await closeFixture(context);
    }
  });

  test('restores an interrupted Action and isolates worktree, Store, Direct, and Standard views', async () => {
    const fixture = defaultFixture();
    const worktreeId = 'task-worktree';
    const storeId = 'task-store';
    const interruptedId = 'task-interrupted';
    const directId = 'task-direct';
    const standardId = 'task-standard';
    fixture.tasks = [
      task(worktreeId, 'spec', {
        title: 'Worktree Spec task',
        location: 'worktree',
        metadata: {
          ...task(worktreeId, 'spec').metadata,
          useWorktree: true,
        },
      }),
      task(storeId, 'spec', {
        title: 'Store Spec task',
        metadata: {
          ...task(storeId, 'spec').metadata,
          openSpec: {
            formatVersion: 1,
            startAction: 'new',
            rootKind: 'store',
            storeId: 'team-planning',
            schemaName: 'team-flow',
            changeName: 'store-change',
          },
        },
      }),
      task(interruptedId, 'spec', { title: 'Interrupted Spec task' }),
      task(directId, 'direct', { title: 'Direct regression task' }),
      task(standardId, 'standard', { title: 'Standard regression task' }),
    ];
    fixture.snapshots = {
      [worktreeId]: snapshot(worktreeId, {
        rootLabel: 'Worktree · task-worktree',
        schema: {
          name: 'team-flow',
          version: 7,
          description: 'Custom dynamic schema',
        },
        artifacts: [
          artifact('intent', 'done'),
          artifact('risk-register', 'ready', {
            dependencies: ['intent'],
          }),
          artifact('release-gate', 'blocked', {
            dependencies: ['risk-register'],
            missingDeps: ['risk-register'],
          }),
        ],
        actionContext: {
          planningHome: {
            kind: 'worktree',
            root: 'C:\\e2e\\worktrees\\task-worktree\\openspec',
          },
          sourceOfTruth: 'openspec/',
          linkedContext: ['src/worktree.ts'],
          allowedEditRoots: ['C:\\e2e\\worktrees\\task-worktree'],
          requiresAffectedAreaSelection: false,
          constraints: ['Never read the main workspace OpenSpec change.'],
        },
      }),
      [storeId]: snapshot(storeId, {
        rootKind: 'store',
        rootLabel: 'Store · team-planning',
        changeName: 'store-change',
        schema: {
          name: 'team-flow',
          version: 7,
          description: 'Store schema',
        },
        actionContext: {
          planningHome: {
            kind: 'store',
            root: 'C:\\e2e\\stores\\team-planning\\openspec',
          },
          sourceOfTruth: 'openspec/',
          linkedContext: ['C:\\e2e\\project'],
          allowedEditRoots: [
            'C:\\e2e\\stores\\team-planning',
            'C:\\e2e\\project',
          ],
          requiresAffectedAreaSelection: false,
          constraints: ['Store registry authorization is required.'],
        },
      }),
      [interruptedId]: snapshot(interruptedId, {
        activeRun: {
          runId: 'run-interrupted',
          action: 'continue',
          state: 'interrupted',
          startedAt: NOW,
          error: 'Application exited',
          recoverable: true,
        },
      }),
    };
    fixture.changes = {
      [worktreeId]: [
        {
          name: 'checkout-flow',
          completedTasks: 1,
          totalTasks: 3,
          status: 'active',
        },
      ],
      [storeId]: [
        {
          name: 'store-change',
          completedTasks: 0,
          totalTasks: 2,
          status: 'active',
        },
      ],
      [interruptedId]: [
        {
          name: 'checkout-flow',
          completedTasks: 1,
          totalTasks: 3,
          status: 'active',
        },
      ],
    };
    fixture.histories = {
      [worktreeId]: {
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        latestRunLog: null,
      },
      [storeId]: {
        runs: [],
        activeRun: null,
        waitingInteraction: null,
        latestRunLog: null,
      },
      [interruptedId]: {
        runs: [
          {
            runId: 'run-interrupted',
            action: 'continue',
            state: 'interrupted',
            startedAt: NOW,
            error: 'Application exited',
            recoverable: true,
          },
        ],
        activeRun: {
          runId: 'run-interrupted',
          action: 'continue',
          state: 'interrupted',
          startedAt: NOW,
          error: 'Application exited',
          recoverable: true,
        },
        waitingInteraction: null,
        latestRunLog: {
          runId: 'run-interrupted',
          content: 'Partial official Continue output',
          truncated: false,
        },
      },
    };

    let context = await launchFixture(fixture);
    try {
      await openTask(context, worktreeId);
      await expect(
        context.page.getByTestId('openspec-artifact-risk-register'),
      ).toBeVisible();
      await context.page.getByRole('tab', { name: 'Context' }).click();
      await expect(
        context.page.getByTestId('openspec-action-context'),
      ).toContainText('worktrees\\task-worktree');
      await context.page
        .getByTestId('openspec-task-detail')
        .getByRole('button', { name: 'Close', exact: true })
        .click();

      await openTask(context, storeId);
      await expect(
        context.page
          .getByTestId('openspec-workflow-stages')
          .getByText('team-flow'),
      ).toBeVisible();
      await context.page.getByRole('tab', { name: 'Context' }).click();
      await expect(
        context.page.getByTestId('openspec-action-context'),
      ).toContainText('stores\\team-planning');
      await context.page
        .getByTestId('openspec-task-detail')
        .getByRole('button', { name: 'Close', exact: true })
        .click();

      await openTask(context, interruptedId);
      await expect(
        context.page.getByText(
          'Continue was interrupted when Aperant exited.',
        ),
      ).toBeVisible();

      await closeFixture(context, false);
      context = await launchFixture(fixture, context);
      await openTask(context, interruptedId);
      await expect(
        context.page.getByText(
          'Continue was interrupted when Aperant exited.',
        ),
      ).toBeVisible();
      await context.page
        .getByRole('button', { name: 'Continue official Action' })
        .click();
      await expect(
        context.page.getByText(
          'Continue was interrupted when Aperant exited.',
        ),
      ).toBeHidden();
      await expect
        .poll(async () =>
          (await calls(context)).some(
            (entry) => entry.channel === 'openspec:resumeAction',
          ),
        )
        .toBe(true);

      await context.page
        .getByTestId('openspec-task-detail')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await openTask(context, directId);
      await expect(context.page.getByTestId('standard-task-detail')).toBeVisible();
      await expect(context.page.getByTestId('openspec-workspace')).toHaveCount(0);
      await context.page
        .getByTestId('standard-task-detail')
        .getByRole('button', { name: 'Close' })
        .first()
        .click();

      await openTask(context, standardId);
      await expect(context.page.getByTestId('standard-task-detail')).toBeVisible();
      await expect(context.page.getByTestId('openspec-workspace')).toHaveCount(0);
    } finally {
      await closeFixture(context);
    }
  });

  test('fails closed for a version mismatch and an Archive lock conflict', async () => {
    const fixture = defaultFixture();
    fixture.preflightValid = false;
    fixture.archiveConflict = true;
    const context = await launchFixture(fixture);
    try {
      await context.page.getByTestId('new-task-button').click();
      await context.page.getByTestId('development-mode-spec').click();
      await expect(
        context.page.getByText('OpenSpec version mismatch: expected 1.6.0.'),
      ).toBeVisible();
      await context.page
        .locator('#create-description')
        .fill('This task must not be created with the wrong runtime.');
      await context.page.getByTestId('create-task-submit').click();
      await expect(
        context.page.getByRole('alert'),
      ).toContainText('OpenSpec version mismatch');
      expect(
        (await calls(context)).some(
          (entry) => entry.channel === 'task:create',
        ),
      ).toBe(false);
      await context.page
        .getByTestId('task-modal')
        .getByRole('button', { name: 'Close', exact: true })
        .click();

      await openTask(context, SPEC_TASK_ID);
      await context.page
        .getByRole('button', { name: 'More OpenSpec options' })
        .click();
      await context.page.getByTestId('openspec-action-archive').click();
      await context.page
        .getByRole('button', { name: 'Run official Archive' })
        .click();
      await expect(context.page.getByText(/openspec_lock_conflict/)).toBeVisible();
      await expect(context.page.getByText('Archived', { exact: true })).toHaveCount(
        0,
      );
    } finally {
      await closeFixture(context);
    }
  });
});
