import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AnswerOpenSpecInteractionInput,
  ConfirmOpenSpecActionInput,
  GetOpenSpecArtifactDiffInput,
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
  ReadOpenSpecArtifactInput,
  ResumeOpenSpecActionInput,
  RunOpenSpecActionInput,
  ValidateOpenSpecInput,
} from '../../shared/types';

export interface OpenSpecRendererAPI {
  getOpenSpecSnapshot: (
    taskId: string,
    projectId?: string,
  ) => Promise<OpenSpecBoardSnapshot>;
  selectOpenSpecChange: (
    taskId: string,
    changeName: string,
    projectId?: string,
  ) => Promise<OpenSpecBoardSnapshot>;
  runOpenSpecAction: (
    input: RunOpenSpecActionInput,
  ) => Promise<{ runId: string }>;
  confirmOpenSpecAction: (
    input: ConfirmOpenSpecActionInput,
  ) => Promise<{ runId: string }>;
  cancelOpenSpecAction: (
    taskId: string,
    runId: string,
    projectId?: string,
  ) => Promise<void>;
  answerOpenSpecInteraction: (
    input: AnswerOpenSpecInteractionInput,
  ) => Promise<void>;
  readOpenSpecArtifact: (
    input: ReadOpenSpecArtifactInput,
  ) => Promise<OpenSpecArtifactContent>;
  getOpenSpecArtifactDiff: (
    input: GetOpenSpecArtifactDiffInput,
  ) => Promise<OpenSpecArtifactDiff>;
  validateOpenSpec: (
    input: ValidateOpenSpecInput,
  ) => Promise<OpenSpecValidationSummary>;
  listOpenSpecChanges: (
    taskId: string,
    projectId?: string,
  ) => Promise<OpenSpecChangeSummary[]>;
  preflightOpenSpec: (
    input: OpenSpecPreflightInput,
  ) => Promise<OpenSpecPreflightResult>;
  getOpenSpecHistory: (
    taskId: string,
    projectId?: string,
  ) => Promise<OpenSpecActionHistory>;
  readOpenSpecRunLog: (
    taskId: string,
    runId: string,
    projectId?: string,
  ) => Promise<OpenSpecRunLog>;
  resumeOpenSpecAction: (
    input: ResumeOpenSpecActionInput,
  ) => Promise<{ runId: string }>;
  getOpenSpecPlanningReview: (
    input: OpenSpecPlanningReviewInput,
  ) => Promise<OpenSpecPlanningReview>;
  acknowledgeOpenSpecPlanningReview: (
    input: OpenSpecPlanningReviewInput,
  ) => Promise<OpenSpecPlanningReviewSummary | null>;
  retryOpenSpecPlanningReview: (
    input: OpenSpecPlanningReviewInput,
  ) => Promise<OpenSpecPlanningReview>;
  onOpenSpecEvent: (
    taskId: string,
    callback: (event: OpenSpecRendererEvent) => void,
    projectId?: string,
  ) => () => void;
}

export const createOpenSpecAPI = (): OpenSpecRendererAPI => ({
  getOpenSpecSnapshot: (taskId, projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_GET_SNAPSHOT, taskId, projectId),

  selectOpenSpecChange: (taskId, changeName, projectId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.OPEN_SPEC_SELECT_CHANGE,
      taskId,
      changeName,
      projectId,
    ),

  runOpenSpecAction: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_RUN_ACTION, input),

  confirmOpenSpecAction: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_RUN_ACTION, {
      ...input,
      confirmed: true,
    }),

  cancelOpenSpecAction: (taskId, runId, projectId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.OPEN_SPEC_CANCEL_ACTION,
      taskId,
      runId,
      projectId,
    ),

  answerOpenSpecInteraction: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_ANSWER_INTERACTION, input),

  readOpenSpecArtifact: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_READ_ARTIFACT, input),

  getOpenSpecArtifactDiff: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_GET_ARTIFACT_DIFF, input),

  validateOpenSpec: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_VALIDATE, input),

  listOpenSpecChanges: (taskId, projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_LIST_CHANGES, taskId, projectId),

  preflightOpenSpec: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_PREFLIGHT, input),

  getOpenSpecHistory: (taskId, projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_GET_HISTORY, taskId, projectId),

  readOpenSpecRunLog: (taskId, runId, projectId) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.OPEN_SPEC_READ_RUN_LOG,
      taskId,
      runId,
      projectId,
    ),

  resumeOpenSpecAction: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_RESUME_ACTION, input),

  getOpenSpecPlanningReview: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_SPEC_GET_PLANNING_REVIEW, input),

  acknowledgeOpenSpecPlanningReview: (input) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.OPEN_SPEC_ACKNOWLEDGE_PLANNING_REVIEW,
      input,
    ),

  retryOpenSpecPlanningReview: (input) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.OPEN_SPEC_RETRY_PLANNING_REVIEW,
      input,
    ),

  onOpenSpecEvent: (taskId, callback, projectId) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      eventTaskId: string,
      event: OpenSpecRendererEvent,
      eventProjectId?: string,
    ): void => {
      if (
        eventTaskId === taskId &&
        (!projectId || projectId === eventProjectId)
      ) {
        callback(event);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.OPEN_SPEC_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.OPEN_SPEC_EVENT, handler);
  },
});
