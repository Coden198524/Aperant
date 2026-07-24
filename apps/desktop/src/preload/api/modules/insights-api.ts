import { webUtils } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import {
  MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH,
  MAX_INSIGHTS_DOCUMENT_REFERENCES,
  MAX_INSIGHTS_REFERENCE_PATH_LENGTH,
} from '../../../shared/constants';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsModelConfig,
  InsightsDocumentAuthorization,
  InsightsDocumentRequest,
  InsightsPendingDocumentReference,
  InsightsSendMessageAcknowledgement,
  InsightsTaskCreationRequest,
  ImageAttachment,
  Task,
  IPCResult
} from '../../../shared/types';
import { createIpcListener, invokeIpc, IpcListenerCleanup } from './ipc-utils';

/**
 * Insights API operations
 */
export interface InsightsAPI {
  // Operations
  getInsightsSession: (projectId: string) => Promise<IPCResult<InsightsSession | null>>;
  authorizeInsightsDocument: (
    projectId: string,
    file: File,
  ) => Promise<IPCResult<InsightsDocumentAuthorization>>;
  sendInsightsMessage: (
    projectId: string,
    message: string,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    documents?: InsightsPendingDocumentReference[],
    clientMessageId?: string,
  ) => Promise<IPCResult<InsightsSendMessageAcknowledgement>>;
  clearInsightsSession: (projectId: string) => Promise<IPCResult>;
  createTaskFromInsights: (
    projectId: string,
    request: InsightsTaskCreationRequest
  ) => Promise<IPCResult<Task>>;
  listInsightsSessions: (projectId: string, includeArchived?: boolean) => Promise<IPCResult<InsightsSessionSummary[]>>;
  newInsightsSession: (projectId: string) => Promise<IPCResult<InsightsSession>>;
  switchInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult<InsightsSession | null>>;
  deleteInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  deleteInsightsSessions: (projectId: string, sessionIds: string[]) => Promise<IPCResult<{ deletedIds: string[]; failedIds: string[] }>>;
  archiveInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  archiveInsightsSessions: (projectId: string, sessionIds: string[]) => Promise<IPCResult<{ archivedIds: string[]; failedIds: string[] }>>;
  unarchiveInsightsSession: (projectId: string, sessionId: string) => Promise<IPCResult>;
  renameInsightsSession: (projectId: string, sessionId: string, newTitle: string) => Promise<IPCResult>;
  updateInsightsModelConfig: (projectId: string, sessionId: string, modelConfig: InsightsModelConfig) => Promise<IPCResult>;

  // Event Listeners
  onInsightsStreamChunk: (
    callback: (projectId: string, chunk: InsightsStreamChunk) => void
  ) => IpcListenerCleanup;
  onInsightsStatus: (
    callback: (projectId: string, status: InsightsChatStatus) => void
  ) => IpcListenerCleanup;
  onInsightsError: (
    callback: (projectId: string, error: string) => void
  ) => IpcListenerCleanup;
  onInsightsSessionUpdated: (
    callback: (projectId: string, session: InsightsSession) => void
  ) => IpcListenerCleanup;
}

function documentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Strictly project pending references onto the only fields accepted by main. */
export function sanitizeInsightsDocumentsForIpc(value: unknown): InsightsDocumentRequest[] {
  if (!Array.isArray(value)) return [];

  const sanitized: InsightsDocumentRequest[] = [];
  for (let index = 0; index < value.length && sanitized.length < MAX_INSIGHTS_DOCUMENT_REFERENCES; index += 1) {
    const candidate = documentRecord(value[index]);
    if (!candidate) continue;

    const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!path || path.length > MAX_INSIGHTS_REFERENCE_PATH_LENGTH || path.includes('\0')) continue;

    const rawId = typeof candidate.id === 'string' ? candidate.id : '';
    const id = /^[\p{L}\p{N}_.-]{1,128}$/u.test(rawId)
      ? rawId
      : `document-reference-${index + 1}`;
    const authorizationToken = typeof candidate.authorizationToken === 'string' &&
      candidate.authorizationToken.length > 0 &&
      candidate.authorizationToken.length <= MAX_INSIGHTS_DOCUMENT_AUTHORIZATION_TOKEN_LENGTH &&
      !candidate.authorizationToken.includes('\0')
      ? candidate.authorizationToken
      : undefined;

    sanitized.push({
      id,
      path,
      ...(authorizationToken ? { authorizationToken } : {}),
    });
  }
  return sanitized;
}

/**
 * Creates the Insights API implementation
 */
export const createInsightsAPI = (): InsightsAPI => ({
  // Operations
  getInsightsSession: (projectId: string): Promise<IPCResult<InsightsSession | null>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_GET_SESSION, projectId),

  authorizeInsightsDocument: async (
    projectId: string,
    file: File,
  ): Promise<IPCResult<InsightsDocumentAuthorization>> => {
    try {
      // Electron's webUtils accepts genuine native File objects and rejects
      // renderer-forged plain objects. No raw-path authorization API is exposed.
      const filePath = webUtils.getPathForFile(file);
      if (
        !filePath ||
        filePath.length > MAX_INSIGHTS_REFERENCE_PATH_LENGTH ||
        filePath.includes('\0')
      ) {
        return { success: false, error: 'Could not resolve the selected local file.' };
      }
      return invokeIpc(IPC_CHANNELS.INSIGHTS_AUTHORIZE_DOCUMENT, projectId, filePath);
    } catch {
      return { success: false, error: 'Could not resolve the selected local file.' };
    }
  },

  sendInsightsMessage: (
    projectId: string,
    message: string,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    documents?: InsightsPendingDocumentReference[],
    clientMessageId?: string,
  ): Promise<IPCResult<InsightsSendMessageAcknowledgement>> =>
    invokeIpc(
      IPC_CHANNELS.INSIGHTS_SEND_MESSAGE,
      projectId,
      message,
      modelConfig,
      images,
      sanitizeInsightsDocumentsForIpc(documents),
      clientMessageId,
    ),

  clearInsightsSession: (projectId: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_CLEAR_SESSION, projectId),

  createTaskFromInsights: (
    projectId: string,
    request: InsightsTaskCreationRequest
  ): Promise<IPCResult<Task>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_CREATE_TASK, projectId, request),

  listInsightsSessions: (projectId: string, includeArchived?: boolean): Promise<IPCResult<InsightsSessionSummary[]>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_LIST_SESSIONS, projectId, includeArchived),

  newInsightsSession: (projectId: string): Promise<IPCResult<InsightsSession>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_NEW_SESSION, projectId),

  switchInsightsSession: (projectId: string, sessionId: string): Promise<IPCResult<InsightsSession | null>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_SWITCH_SESSION, projectId, sessionId),

  deleteInsightsSession: (projectId: string, sessionId: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_DELETE_SESSION, projectId, sessionId),

  deleteInsightsSessions: (projectId: string, sessionIds: string[]): Promise<IPCResult<{ deletedIds: string[]; failedIds: string[] }>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_DELETE_SESSIONS, projectId, sessionIds),

  archiveInsightsSession: (projectId: string, sessionId: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSION, projectId, sessionId),

  archiveInsightsSessions: (projectId: string, sessionIds: string[]): Promise<IPCResult<{ archivedIds: string[]; failedIds: string[] }>> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSIONS, projectId, sessionIds),

  unarchiveInsightsSession: (projectId: string, sessionId: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_UNARCHIVE_SESSION, projectId, sessionId),

  renameInsightsSession: (projectId: string, sessionId: string, newTitle: string): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_RENAME_SESSION, projectId, sessionId, newTitle),

  updateInsightsModelConfig: (projectId: string, sessionId: string, modelConfig: InsightsModelConfig): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.INSIGHTS_UPDATE_MODEL_CONFIG, projectId, sessionId, modelConfig),

  // Event Listeners
  onInsightsStreamChunk: (
    callback: (projectId: string, chunk: InsightsStreamChunk) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.INSIGHTS_STREAM_CHUNK, callback),

  onInsightsStatus: (
    callback: (projectId: string, status: InsightsChatStatus) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.INSIGHTS_STATUS, callback),

  onInsightsError: (
    callback: (projectId: string, error: string) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.INSIGHTS_ERROR, callback),

  onInsightsSessionUpdated: (
    callback: (projectId: string, session: InsightsSession) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.INSIGHTS_SESSION_UPDATED, callback)
});
