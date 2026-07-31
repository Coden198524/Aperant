import { ipcMain, type BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AnswerOpenSpecInteractionInput,
  GetOpenSpecArtifactDiffInput,
  OpenSpecPlanningReviewInput,
  OpenSpecPreflightInput,
  ReadOpenSpecArtifactInput,
  ResumeOpenSpecActionInput,
  RunOpenSpecActionInput,
  ValidateOpenSpecInput,
} from '../../shared/types';
import { OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE } from '../../shared/types';
import { isSpecDevelopmentTask } from '../../shared/utils/task-mode';
import type { AgentManager } from '../agent';
import { projectStore } from '../project-store';
import { OpenSpecService } from '../openspec/openspec-service';
import { persistOpenSpecTaskStatus } from '../openspec/openspec-task-status-persistence';
import { findTaskAndProject } from './task/shared';

const MAX_ID_LENGTH = 160;
const SAFE_CHANGE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

function requireId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value.includes('\0')
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireExpectedArtifactChangeName(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_CHANGE_NAME.test(value)) {
    throw new Error(
      `[${OPEN_SPEC_ARTIFACT_REFRESH_REQUIRED_ERROR_CODE}] ` +
      'OpenSpec artifact request expected change is invalid. ' +
      'Refresh the task and try again.',
    );
  }
  return value;
}

function resolveSpecTask(taskId: unknown, projectId?: unknown) {
  const safeTaskId = requireId(taskId, 'Task ID');
  const safeProjectId = projectId === undefined
    ? undefined
    : requireId(projectId, 'Project ID');
  const { task, project } = findTaskAndProject(safeTaskId, safeProjectId);
  if (!task || !project) {
    throw new Error('Task or project was not found.');
  }
  if (!isSpecDevelopmentTask(task)) {
    throw new Error('OpenSpec APIs are only available for Spec development mode tasks.');
  }
  if (task.projectId && task.projectId !== project.id) {
    throw new Error('Task does not belong to the requested project.');
  }
  return { task, project };
}

function removeOpenSpecHandlers(): void {
  for (const channel of [
    IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT,
    IPC_CHANNELS.OPEN_SPEC_SELECT_CHANGE,
    IPC_CHANNELS.OPEN_SPEC_RUN_ACTION,
    IPC_CHANNELS.OPEN_SPEC_CANCEL_ACTION,
    IPC_CHANNELS.OPEN_SPEC_ANSWER_INTERACTION,
    IPC_CHANNELS.OPEN_SPEC_READ_ARTIFACT,
    IPC_CHANNELS.OPEN_SPEC_GET_ARTIFACT_DIFF,
    IPC_CHANNELS.OPEN_SPEC_VALIDATE,
    IPC_CHANNELS.OPEN_SPEC_LIST_CHANGES,
    IPC_CHANNELS.OPEN_SPEC_PREFLIGHT,
    IPC_CHANNELS.OPEN_SPEC_GET_HISTORY,
    IPC_CHANNELS.OPEN_SPEC_READ_RUN_LOG,
    IPC_CHANNELS.OPEN_SPEC_RESUME_ACTION,
    IPC_CHANNELS.OPEN_SPEC_GET_PLANNING_REVIEW,
    IPC_CHANNELS.OPEN_SPEC_ACKNOWLEDGE_PLANNING_REVIEW,
    IPC_CHANNELS.OPEN_SPEC_RETRY_PLANNING_REVIEW,
  ]) {
    ipcMain.removeHandler(channel);
  }
}

export function registerOpenSpecHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null,
): OpenSpecService {
  removeOpenSpecHandlers();

  let service: OpenSpecService;
  service = new OpenSpecService(
    agentManager,
    (task, project, event) => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(
        IPC_CHANNELS.OPEN_SPEC_EVENT,
        task.id,
        event,
        project.id,
      );
    },
    (task, project, status, reviewReason) => {
      const runtime = service.runtimeStore.read(task, project);
      if (
        !persistOpenSpecTaskStatus(
          task,
          project,
          status,
          reviewReason,
          runtime,
        )
      ) {
        console.error(
          `[OpenSpec] Failed to persist task status "${status}" for ${task.id}.`,
        );
      }
      projectStore.invalidateTasksCache(project.id);
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        task.id,
        status,
        project.id,
        reviewReason,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT,
    async (_, taskId: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      return await service.getSnapshot(task, project);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_SELECT_CHANGE,
    async (_, taskId: string, changeName: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      return await service.selectChange(
        task,
        project,
        requireId(changeName, 'Change name'),
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_RUN_ACTION,
    async (_, input: RunOpenSpecActionInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec Action input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.runAction(task, project, input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_CANCEL_ACTION,
    async (_, taskId: string, runId: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      await service.cancelAction(task, project, requireId(runId, 'Run ID'));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_RESUME_ACTION,
    async (_, input: ResumeOpenSpecActionInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec resume input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.resumeAction(task, project, {
        ...input,
        runId: requireId(input.runId, 'Run ID'),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_ANSWER_INTERACTION,
    (_, input: AnswerOpenSpecInteractionInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec interaction input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      service.answerInteraction(task, project, input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_READ_ARTIFACT,
    async (_, input: ReadOpenSpecArtifactInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec artifact input is required.');
      }
      const expectedChangeName = requireExpectedArtifactChangeName(
        input.expectedChangeName,
      );
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.readArtifact(task, project, {
        ...input,
        expectedChangeName,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_GET_ARTIFACT_DIFF,
    async (_, input: GetOpenSpecArtifactDiffInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec artifact diff input is required.');
      }
      const expectedChangeName = requireExpectedArtifactChangeName(
        input.expectedChangeName,
      );
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.getArtifactDiff(task, project, {
        ...input,
        expectedChangeName,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_VALIDATE,
    async (_, input: ValidateOpenSpecInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec validation input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.validate(task, project, input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_LIST_CHANGES,
    async (_, taskId: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      return await service.listChanges(task, project);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_GET_HISTORY,
    async (_, taskId: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      return await service.getHistory(task, project);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_READ_RUN_LOG,
    async (_, taskId: string, runId: string, projectId?: string) => {
      const { task, project } = resolveSpecTask(taskId, projectId);
      return await service.readRunLog(task, project, requireId(runId, 'Run ID'));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_GET_PLANNING_REVIEW,
    async (_, input: OpenSpecPlanningReviewInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec planning review input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.getPlanningReview(task, project, {
        ...input,
        runId: requireId(input.runId, 'Run ID'),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_ACKNOWLEDGE_PLANNING_REVIEW,
    async (_, input: OpenSpecPlanningReviewInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec planning review input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.acknowledgePlanningReview(task, project, {
        ...input,
        runId: requireId(input.runId, 'Run ID'),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_RETRY_PLANNING_REVIEW,
    async (_, input: OpenSpecPlanningReviewInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec planning review input is required.');
      }
      const { task, project } = resolveSpecTask(input.taskId, input.projectId);
      return await service.retryPlanningReview(task, project, {
        ...input,
        runId: requireId(input.runId, 'Run ID'),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.OPEN_SPEC_PREFLIGHT,
    async (_, input: OpenSpecPreflightInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('OpenSpec preflight input is required.');
      }
      const projectId = requireId(input.projectId, 'Project ID');
      const project = projectStore.getProject(projectId);
      if (!project) {
        throw new Error('Project was not found.');
      }
      return await service.preflightProject(project, {
        ...input,
        projectId,
      });
    },
  );

  return service;
}
