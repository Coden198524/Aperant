import { create } from 'zustand';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatMessage,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsToolUsage,
  InsightsModelConfig,
  InsightsPendingDocumentReference,
  InsightsTaskCreationRequest,
  Task,
  ImageAttachment
} from '../../shared/types';

interface ToolUsage {
  name: string;
  input?: string;
}

interface InsightsState {
  currentProjectId: string | null;

  // Data
  session: InsightsSession | null;
  sessions: InsightsSessionSummary[]; // List of all sessions
  status: InsightsChatStatus;
  pendingMessage: string;
  streamingContent: string; // Accumulates streaming response
  streamingTasks: NonNullable<InsightsChatMessage['suggestedTasks']>; // Accumulates task suggestions during streaming
  currentTool: ToolUsage | null; // Currently executing tool
  toolsUsed: InsightsToolUsage[]; // Tools used during current response
  isLoadingSessions: boolean;
  showArchived: boolean; // Whether to include archived sessions in listings
  pendingImages: ImageAttachment[]; // Images pending attachment to next message
  pendingDocuments: InsightsPendingDocumentReference[]; // Local paths pending reference in the next message

  // Actions
  setCurrentProjectId: (projectId: string | null) => void;
  setSession: (session: InsightsSession | null) => void;
  setSessions: (sessions: InsightsSessionSummary[]) => void;
  setStatus: (status: InsightsChatStatus) => void;
  setPendingMessage: (message: string) => void;
  addMessage: (message: InsightsChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  appendStreamingContent: (content: string) => void;
  clearStreamingContent: () => void;
  setCurrentTool: (tool: ToolUsage | null) => void;
  addToolUsage: (tool: ToolUsage) => void;
  clearToolsUsed: () => void;
  addStreamingTasks: (tasks: NonNullable<InsightsChatMessage['suggestedTasks']>) => void;
  finalizeStreamingMessage: () => void;
  clearSession: () => void;
  setLoadingSessions: (loading: boolean) => void;
  setShowArchived: (showArchived: boolean) => void;
  setPendingImages: (images: ImageAttachment[]) => void;
  setPendingDocuments: (documents: InsightsPendingDocumentReference[]) => void;
}

const initialStatus: InsightsChatStatus = {
  phase: 'idle',
  message: ''
};

// Distinguishes chat scopes even when both happen to have `session === null`.
// This prevents an acknowledgement from an older no-session epoch from being
// applied after the user switched away and later returned to an empty chat.
let insightsChatScopeGeneration = 0;

function sessionScopeKey(session: InsightsSession | null): string {
  return session ? `${session.projectId}\0${session.id}` : 'no-session';
}

export const useInsightsStore = create<InsightsState>((set, _get) => ({
  // Initial state
  currentProjectId: null,
  session: null,
  sessions: [],
  status: initialStatus,
  pendingMessage: '',
  streamingContent: '',
  streamingTasks: [],
  currentTool: null,
  toolsUsed: [],
  isLoadingSessions: false,
  showArchived: false,
  pendingImages: [],
  pendingDocuments: [],

  // Actions
  setCurrentProjectId: (projectId) =>
    set((state) => {
      if (state.currentProjectId === projectId) {
        return { currentProjectId: projectId };
      }

      insightsChatScopeGeneration += 1;

      return {
        currentProjectId: projectId,
        session: null,
        sessions: [],
        status: initialStatus,
        pendingMessage: '',
        streamingContent: '',
        streamingTasks: [],
        currentTool: null,
        toolsUsed: [],
        isLoadingSessions: false,
        pendingImages: [],
        pendingDocuments: [],
      };
    }),

  setSession: (session) =>
    set((state) => {
      if (sessionScopeKey(state.session) !== sessionScopeKey(session)) {
        insightsChatScopeGeneration += 1;
      }
      return { session };
    }),

  setSessions: (sessions) => set({ sessions }),

  setStatus: (status) => set({ status }),

  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  setShowArchived: (showArchived) => set({ showArchived }),

  setPendingMessage: (message) => set({ pendingMessage: message }),

  addMessage: (message) =>
    set((state) => {
      if (!state.session) {
        // Create new session if none exists
        return {
          session: {
            id: `session-${Date.now()}`,
            projectId: state.currentProjectId ?? '',
            messages: [message],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        };
      }

      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, message],
          updatedAt: new Date()
        }
      };
    }),

  updateLastAssistantMessage: (content) =>
    set((state) => {
      if (!state.session || state.session.messages.length === 0) return state;

      const messages = [...state.session.messages];
      const lastIndex = messages.length - 1;
      const lastMessage = messages[lastIndex];

      if (lastMessage.role === 'assistant') {
        messages[lastIndex] = { ...lastMessage, content };
      }

      return {
        session: {
          ...state.session,
          messages,
          updatedAt: new Date()
        }
      };
    }),

  appendStreamingContent: (content) =>
    set((state) => ({
      streamingContent: state.streamingContent + content
    })),

  clearStreamingContent: () => set({ streamingContent: '', streamingTasks: [] }),

  setCurrentTool: (tool) => set({ currentTool: tool }),

  addToolUsage: (tool) =>
    set((state) => ({
      toolsUsed: [
        ...state.toolsUsed,
        {
          name: tool.name,
          input: tool.input,
          timestamp: new Date()
        }
      ]
    })),

  clearToolsUsed: () => set({ toolsUsed: [] }),

  addStreamingTasks: (tasks) =>
    set((state) => ({
      streamingTasks: [...state.streamingTasks, ...tasks]
    })),

  finalizeStreamingMessage: () =>
    set((state) => {
      const content = state.streamingContent;
      const toolsUsed = state.toolsUsed.length > 0 ? [...state.toolsUsed] : undefined;
      const suggestedTasks = state.streamingTasks.length > 0 ? [...state.streamingTasks] : undefined;

      if (!content && !suggestedTasks && !toolsUsed) {
        return { streamingContent: '', streamingTasks: [], toolsUsed: [] };
      }

      const newMessage: InsightsChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: new Date(),
        suggestedTasks,
        toolsUsed
      };

      if (!state.session) {
        return {
          streamingContent: '',
          streamingTasks: [],
          toolsUsed: [],
          session: {
            id: `session-${Date.now()}`,
            projectId: state.currentProjectId ?? '',
            messages: [newMessage],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        };
      }

      return {
        streamingContent: '',
        streamingTasks: [],
        toolsUsed: [],
        session: {
          ...state.session,
          messages: [...state.session.messages, newMessage],
          updatedAt: new Date()
        }
      };
    }),

  clearSession: () => {
    insightsChatScopeGeneration += 1;
    set({
      session: null,
      status: initialStatus,
      pendingMessage: '',
      streamingContent: '',
      streamingTasks: [],
      currentTool: null,
      toolsUsed: [],
      pendingImages: [],
      pendingDocuments: [],
    });
  },

  setPendingImages: (images) => set({ pendingImages: images }),

  setPendingDocuments: (documents) => set({ pendingDocuments: documents })
}));

// Helper functions
let insightsSessionsRequestSeq = 0;
let insightsSessionRequestSeq = 0;

function beginInsightsProjectScope(projectId: string): void {
  const store = useInsightsStore.getState();
  if (store.currentProjectId !== projectId) {
    store.setCurrentProjectId(projectId);
  }
}

function isCurrentInsightsProject(projectId: string): boolean {
  return useInsightsStore.getState().currentProjectId === projectId;
}

function isCurrentInsightsRequest(
  projectId: string,
  requestSeq: number,
  getLatestRequestSeq: () => number
): boolean {
  return isCurrentInsightsProject(projectId) && getLatestRequestSeq() === requestSeq;
}

export async function loadInsightsSessions(projectId: string, includeArchived?: boolean): Promise<void> {
  beginInsightsProjectScope(projectId);
  const requestSeq = ++insightsSessionsRequestSeq;
  const store = useInsightsStore.getState();
  store.setLoadingSessions(true);

  // Use explicit parameter if provided, otherwise read from store
  const archived = includeArchived ?? store.showArchived;

  try {
    const result = await window.electronAPI.listInsightsSessions(projectId, archived);
    if (!isCurrentInsightsRequest(projectId, requestSeq, () => insightsSessionsRequestSeq)) return;

    if (result.success && result.data) {
      store.setSessions(result.data);
    } else {
      store.setSessions([]);
    }
  } finally {
    if (isCurrentInsightsRequest(projectId, requestSeq, () => insightsSessionsRequestSeq)) {
      store.setLoadingSessions(false);
    }
  }
}

export async function loadInsightsSession(projectId: string, includeArchived?: boolean): Promise<void> {
  beginInsightsProjectScope(projectId);
  const requestSeq = ++insightsSessionRequestSeq;
  const result = await window.electronAPI.getInsightsSession(projectId);
  if (!isCurrentInsightsRequest(projectId, requestSeq, () => insightsSessionRequestSeq)) return;

  if (result.success && result.data) {
    useInsightsStore.getState().setSession(result.data);
  } else {
    useInsightsStore.getState().setSession(null);
  }
  // Also load the sessions list
  await loadInsightsSessions(projectId, includeArchived);
}

function createInsightsClientMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendMessage(
  projectId: string,
  message: string,
  modelConfig?: InsightsModelConfig,
  images?: ImageAttachment[],
  documents?: InsightsPendingDocumentReference[],
): Promise<boolean> {
  beginInsightsProjectScope(projectId);
  const store = useInsightsStore.getState();
  const session = store.session;
  const sessionIdAtSend = session?.id ?? null;
  const scopeGenerationAtSend = insightsChatScopeGeneration;
  const clientMessageId = createInsightsClientMessageId();
  const sentImageIds = new Set(images?.map((image) => image.id) ?? []);
  const sentDocumentIds = new Set(documents?.map((document) => document.id) ?? []);

  // Keep the draft and attachments until main confirms that validation and
  // persistence succeeded. Executor failures happen after this boundary.
  store.clearStreamingContent();
  store.clearToolsUsed(); // Clear tools from previous response
  store.setStatus({
    phase: 'thinking',
    message: 'Processing your message...'
  });

  // Use provided modelConfig, or fall back to session's config
  const configToUse = modelConfig || session?.modelConfig;

  try {
    const result = await window.electronAPI.sendInsightsMessage(
      projectId,
      message,
      configToUse,
      images,
      documents,
      clientMessageId,
    );
    const latest = useInsightsStore.getState();
    const scopeIsCurrent = latest.currentProjectId === projectId &&
      (latest.session?.id ?? null) === sessionIdAtSend &&
      insightsChatScopeGeneration === scopeGenerationAtSend;
    if (!scopeIsCurrent) return false;

    if (
      !result.success ||
      !result.data ||
      result.data.clientMessageId !== clientMessageId ||
      result.data.session.projectId !== projectId ||
      (sessionIdAtSend !== null && result.data.session.id !== sessionIdAtSend) ||
      !result.data.session.messages.some((item) => item.id === result.data?.messageId)
    ) {
      latest.setStatus({
        phase: 'error',
        error: result.error || 'The message was not accepted. Please try again.',
      });
      return false;
    }

    const acceptedSession = result.data.session;
    useInsightsStore.setState((state) => {
      if (
        state.currentProjectId !== projectId ||
        (state.session?.id ?? null) !== sessionIdAtSend ||
        insightsChatScopeGeneration !== scopeGenerationAtSend
      ) {
        return state;
      }

      const currentSession = state.session;
      if (!currentSession) {
        return {
          session: acceptedSession,
          pendingMessage: '',
          pendingImages: state.pendingImages.filter((image) => !sentImageIds.has(image.id)),
          pendingDocuments: state.pendingDocuments.filter(
            (document) => !sentDocumentIds.has(document.id),
          ),
        };
      }

      const acceptedMessageIds = new Set(
        acceptedSession.messages.map((acceptedMessage) => acceptedMessage.id),
      );
      const messagesAddedAfterAcceptance = currentSession.messages.filter(
        (currentMessage) => !acceptedMessageIds.has(currentMessage.id),
      );
      return {
        session: {
          ...currentSession,
          ...acceptedSession,
          messages: [...acceptedSession.messages, ...messagesAddedAfterAcceptance],
          updatedAt: messagesAddedAfterAcceptance.length > 0
            ? currentSession.updatedAt
            : acceptedSession.updatedAt,
        },
        pendingMessage: '',
        pendingImages: state.pendingImages.filter((image) => !sentImageIds.has(image.id)),
        pendingDocuments: state.pendingDocuments.filter(
          (document) => !sentDocumentIds.has(document.id),
        ),
      };
    });
    return true;
  } catch (error) {
    const latest = useInsightsStore.getState();
    if (
      latest.currentProjectId === projectId &&
      (latest.session?.id ?? null) === sessionIdAtSend &&
      insightsChatScopeGeneration === scopeGenerationAtSend
    ) {
      latest.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : 'Failed to send message.',
      });
    }
    return false;
  }
}

export async function clearSession(projectId: string, includeArchived?: boolean): Promise<void> {
  const result = await window.electronAPI.clearInsightsSession(projectId);
  if (result.success) {
    if (!isCurrentInsightsProject(projectId)) return;
    useInsightsStore.getState().clearSession();
    // Reload sessions list and current session
    await loadInsightsSession(projectId, includeArchived);
  }
}

export async function newSession(projectId: string): Promise<void> {
  beginInsightsProjectScope(projectId);
  const result = await window.electronAPI.newInsightsSession(projectId);
  if (result.success && result.data && isCurrentInsightsProject(projectId)) {
    useInsightsStore.getState().setSession(result.data);
    useInsightsStore.getState().setPendingImages([]);
    useInsightsStore.getState().setPendingDocuments([]);
    // Reload sessions list
    await loadInsightsSessions(projectId);
  }
}

export async function switchSession(projectId: string, sessionId: string): Promise<void> {
  const result = await window.electronAPI.switchInsightsSession(projectId, sessionId);
  if (result.success && result.data && isCurrentInsightsProject(projectId)) {
    useInsightsStore.getState().setSession(result.data);
    // Reset streaming state when switching sessions
    useInsightsStore.getState().clearStreamingContent();
    useInsightsStore.getState().clearToolsUsed();
    useInsightsStore.getState().setCurrentTool(null);
    useInsightsStore.getState().setStatus({ phase: 'idle', message: '' });
    useInsightsStore.getState().setPendingImages([]);
    useInsightsStore.getState().setPendingDocuments([]);
  }
}

export async function deleteSession(projectId: string, sessionId: string, includeArchived?: boolean): Promise<boolean> {
  const result = await window.electronAPI.deleteInsightsSession(projectId, sessionId);
  if (result.success) {
    // Reload sessions list and current session
    await loadInsightsSession(projectId, includeArchived);
    return true;
  }
  return false;
}

export async function renameSession(projectId: string, sessionId: string, newTitle: string): Promise<boolean> {
  const result = await window.electronAPI.renameInsightsSession(projectId, sessionId, newTitle);
  if (result.success) {
    // Reload sessions list to reflect the change
    await loadInsightsSessions(projectId);
    return true;
  }
  return false;
}

export async function deleteSessions(projectId: string, sessionIds: string[]): Promise<{ success: boolean; failedIds?: string[] }> {
  const result = await window.electronAPI.deleteInsightsSessions(projectId, sessionIds);
  if (result.success) {
    return { success: true, failedIds: result.data?.failedIds };
  }
  return { success: false, failedIds: result.data?.failedIds };
}

export async function archiveSession(projectId: string, sessionId: string): Promise<boolean> {
  const result = await window.electronAPI.archiveInsightsSession(projectId, sessionId);
  return result.success;
}

export async function archiveSessions(projectId: string, sessionIds: string[]): Promise<{ success: boolean; failedIds?: string[] }> {
  const result = await window.electronAPI.archiveInsightsSessions(projectId, sessionIds);
  if (result.success) {
    return { success: true, failedIds: result.data?.failedIds };
  }
  return { success: false, failedIds: result.data?.failedIds };
}

export async function unarchiveSession(projectId: string, sessionId: string): Promise<boolean> {
  const result = await window.electronAPI.unarchiveInsightsSession(projectId, sessionId);
  return result.success;
}

export async function updateModelConfig(projectId: string, sessionId: string, modelConfig: InsightsModelConfig): Promise<boolean> {
  const result = await window.electronAPI.updateInsightsModelConfig(projectId, sessionId, modelConfig);
  if (result.success) {
    // Update local session state
    const store = useInsightsStore.getState();
    if (store.currentProjectId === projectId && store.session?.id === sessionId) {
      store.setSession({
        ...store.session,
        modelConfig,
        updatedAt: new Date()
      });
    }
    // Reload sessions list to reflect the change
    await loadInsightsSessions(projectId);
    return true;
  }
  return false;
}

export async function createTaskFromSuggestion(
  projectId: string,
  request: InsightsTaskCreationRequest
): Promise<Task | null> {
  const result = await window.electronAPI.createTaskFromInsights(
    projectId,
    request
  );

  if (result.success && result.data) {
    const createdTask = result.data;
    useInsightsStore.setState((state) => {
      if (state.session?.id !== request.sessionId) return {};

      let didUpdate = false;
      const messages = state.session.messages.map((message) => ({
        ...message,
        suggestedTasks: message.suggestedTasks?.map((suggestion, taskIndex) => {
          const matchesSuggestionId = Boolean(
            request.suggestionId && suggestion.id === request.suggestionId,
          );
          const matchesLegacyPosition = !request.suggestionId &&
            message.id === request.messageId &&
            taskIndex === request.taskIndex;
          if (!matchesSuggestionId && !matchesLegacyPosition) return suggestion;

          didUpdate = true;
          return { ...suggestion, taskId: createdTask.id };
        }),
      }));

      if (!didUpdate) return {};
      return {
        session: {
          ...state.session,
          messages,
          updatedAt: new Date(),
        },
      };
    });
    return result.data;
  }
  return null;
}

// IPC listener setup - call this once when the app initializes
export function setupInsightsListeners(): () => void {
  const store = useInsightsStore.getState;

  // Listen for streaming chunks
  const unsubStreamChunk = window.electronAPI.onInsightsStreamChunk(
    (projectId, chunk: InsightsStreamChunk) => {
      if (!isCurrentInsightsProject(projectId)) return;

      switch (chunk.type) {
        case 'text':
          if (chunk.content) {
            store().appendStreamingContent(chunk.content);
            store().setCurrentTool(null); // Clear tool when receiving text
            store().setStatus({
              phase: 'streaming',
              message: 'Receiving response...'
            });
          }
          break;
        case 'tool_start':
          if (chunk.tool) {
            store().setCurrentTool({
              name: chunk.tool.name,
              input: chunk.tool.input
            });
            // Record this tool usage for history
            store().addToolUsage({
              name: chunk.tool.name,
              input: chunk.tool.input
            });
            store().setStatus({
              phase: 'streaming',
              message: `Using ${chunk.tool.name}...`
            });
          }
          break;
        case 'tool_end':
          store().setCurrentTool(null);
          break;
        case 'task_suggestion':
          // Accumulate task suggestions — they'll be included when 'done' finalizes the message
          store().setCurrentTool(null);
          if (chunk.suggestedTasks) {
            store().addStreamingTasks(chunk.suggestedTasks);
          }
          break;
        case 'done':
          // Finalize any remaining content
          store().setCurrentTool(null);
          store().finalizeStreamingMessage();
          store().setStatus({
            phase: 'complete',
            message: ''
          });
          break;
        case 'error':
          store().setCurrentTool(null);
          store().setStatus({
            phase: 'error',
            error: chunk.error
          });
          break;
      }
    }
  );

  // Listen for status updates
  const unsubStatus = window.electronAPI.onInsightsStatus((projectId, status) => {
    if (!isCurrentInsightsProject(projectId)) return;
    store().setStatus(status);
  });

  // Listen for errors
  const unsubError = window.electronAPI.onInsightsError((projectId, error) => {
    if (!isCurrentInsightsProject(projectId)) return;
    store().setStatus({
      phase: 'error',
      error
    });
  });

  // Listen for session updates (e.g., after assistant message saved with auto-generated title)
  const unsubSessionUpdated = window.electronAPI.onInsightsSessionUpdated(
    (projectId, session: InsightsSession) => {
      if (!isCurrentInsightsProject(projectId)) return;

      // Update current session if it matches
      const currentSession = store().session;
      if (currentSession?.id === session.id) {
        store().setSession(session);
      }
      // Also refresh sessions list for sidebar
      loadInsightsSessions(session.projectId).catch((err) => {
        console.error('Failed to refresh sessions list after update:', err);
      });
    }
  );

  // Return cleanup function
  return () => {
    unsubStreamChunk();
    unsubStatus();
    unsubError();
    unsubSessionUpdated();
  };
}
