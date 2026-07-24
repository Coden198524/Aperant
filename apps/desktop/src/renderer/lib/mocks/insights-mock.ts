/**
 * Mock implementation for insights operations
 */

import { mockInsightsSessions } from './mock-data';
import type {
  ImageAttachment,
  InsightsModelConfig,
  InsightsPendingDocumentReference,
  InsightsTaskCreationRequest,
} from '../../../shared/types';

export const insightsMock = {
  getInsightsSession: async () => ({
    success: true,
    data: mockInsightsSessions.length > 0 ? {
      id: mockInsightsSessions[0].id,
      projectId: mockInsightsSessions[0].projectId,
      messages: [],
      createdAt: mockInsightsSessions[0].createdAt,
      updatedAt: mockInsightsSessions[0].updatedAt
    } : null
  }),

  listInsightsSessions: async (_projectId?: string, _includeArchived?: boolean) => ({
    success: true,
    data: mockInsightsSessions
  }),

  newInsightsSession: async (projectId: string) => {
    const newSession = {
      id: `session-${Date.now()}`,
      projectId,
      title: 'New conversation',
      messageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    mockInsightsSessions.unshift(newSession);
    return {
      success: true,
      data: {
        id: newSession.id,
        projectId: newSession.projectId,
        messages: [],
        createdAt: newSession.createdAt,
        updatedAt: newSession.updatedAt
      }
    };
  },

  switchInsightsSession: async (_projectId: string, sessionId: string) => {
    const session = mockInsightsSessions.find(s => s.id === sessionId);
    if (session) {
      return {
        success: true,
        data: {
          id: session.id,
          projectId: session.projectId,
          messages: [],
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        }
      };
    }
    return { success: false, error: 'Session not found' };
  },

  deleteInsightsSession: async (_projectId: string, sessionId: string) => {
    const index = mockInsightsSessions.findIndex(s => s.id === sessionId);
    if (index !== -1) {
      mockInsightsSessions.splice(index, 1);
      console.warn('[Browser Mock] Session deleted:', sessionId);
    }
    return { success: true };
  },

  deleteInsightsSessions: async (_projectId: string, sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      const index = mockInsightsSessions.findIndex(s => s.id === sessionId);
      if (index !== -1) {
        mockInsightsSessions.splice(index, 1);
      }
    }
    return { success: true, data: { deletedIds: sessionIds, failedIds: [] } };
  },

  archiveInsightsSession: async (_projectId: string, _sessionId: string) => {
    return { success: true };
  },

  archiveInsightsSessions: async (_projectId: string, sessionIds: string[]) => {
    return { success: true, data: { archivedIds: sessionIds, failedIds: [] } };
  },

  unarchiveInsightsSession: async (_projectId: string, _sessionId: string) => {
    return { success: true };
  },

  renameInsightsSession: async (_projectId: string, sessionId: string, newTitle: string) => {
    const session = mockInsightsSessions.find(s => s.id === sessionId);
    if (session) {
      session.title = newTitle;
      console.warn('[Browser Mock] Session renamed:', sessionId, 'to', newTitle);
    }
    return { success: true };
  },

  updateInsightsModelConfig: async (_projectId: string, _sessionId: string, _modelConfig: unknown) => {
    console.warn('[Browser Mock] updateInsightsModelConfig called');
    return { success: true };
  },

  sendInsightsMessage: async (
    projectId: string,
    message: string,
    _modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    documents?: InsightsPendingDocumentReference[],
    clientMessageId = `msg-${Date.now()}`,
  ) => {
    console.warn('[Browser Mock] sendInsightsMessage called');
    const now = new Date();
    const summary = mockInsightsSessions.find((item) => item.projectId === projectId);
    return {
      success: true,
      data: {
        clientMessageId,
        messageId: clientMessageId,
        session: {
          id: summary?.id ?? `session-${Date.now()}`,
          projectId,
          title: summary?.title ?? 'New conversation',
          messages: [{
            id: clientMessageId,
            role: 'user' as const,
            content: message,
            timestamp: now,
            images: images?.map((image) => ({ ...image, data: undefined })),
            documents: documents?.map((document) => ({
              id: document.id,
              filename: document.filename,
              path: document.path,
              ...(typeof document.size === 'number' ? { size: document.size } : {}),
            })),
          }],
          createdAt: summary?.createdAt ?? now,
          updatedAt: now,
        },
      },
    };
  },

  authorizeInsightsDocument: async () => ({
    success: false as const,
    error: 'Native file selection is available only in the desktop app.',
  }),

  clearInsightsSession: async () => ({ success: true }),

  createTaskFromInsights: async (
    _projectId: string,
    request: InsightsTaskCreationRequest,
  ) => ({
    success: true,
    data: {
      id: `task-${Date.now()}`,
      projectId: _projectId,
      specId: `00${Date.now()}-insights-task`,
      title: request.title,
      description: request.description,
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  onInsightsStreamChunk: () => () => {},
  onInsightsStatus: () => () => {},
  onInsightsError: () => () => {},
  onInsightsSessionUpdated: () => () => {}
};
