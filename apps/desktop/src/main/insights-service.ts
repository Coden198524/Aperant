import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type {
  InsightsSession,
  InsightsSessionSummary,
  InsightsChatMessage,
  InsightsModelConfig,
  InsightsDocumentRequest,
  InsightsSendMessageAcknowledgement,
  InsightsSuggestedTask,
  InsightsTaskCreationRequest,
  ImageAttachment,
  IPCResult,
} from '../shared/types';
import {
  MAX_IMAGES_PER_TASK,
  MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS,
  MAX_INSIGHTS_DOCUMENT_REFERENCES,
} from '../shared/constants';
import { InsightsConfig } from './insights/config';
import { InsightsPaths } from './insights/paths';
import { SessionStorage } from './insights/session-storage';
import { SessionManager } from './insights/session-manager';
import { InsightsExecutor } from './insights/insights-executor';
import { normalizeInsightsDocumentReferences } from './insights/document-references';
import {
  InsightsDocumentCapabilityManager,
  insightsDocumentCapabilities,
} from './insights/document-capabilities';

function normalizeInsightsClientMessageId(value: unknown): string {
  if (typeof value === 'string' && /^[\p{L}\p{N}_.-]{1,128}$/u.test(value)) {
    return value;
  }
  return `msg-${randomUUID()}`;
}

/**
 * Service for AI-powered codebase insights chat
 *
 * This service coordinates between multiple specialized modules:
 * - InsightsConfig: Manages configuration and environment
 * - InsightsPaths: Provides consistent path resolution
 * - SessionStorage: Handles filesystem persistence
 * - SessionManager: Manages session lifecycle and cache
 * - InsightsExecutor: Executes Python insights runner
 */
export class InsightsService extends EventEmitter {
  private config: InsightsConfig;
  private paths: InsightsPaths;
  private storage: SessionStorage;
  private sessionManager: SessionManager;
  private executor: InsightsExecutor;

  constructor(
    private readonly documentCapabilities: InsightsDocumentCapabilityManager = insightsDocumentCapabilities,
  ) {
    super();

    // Initialize modules
    this.config = new InsightsConfig();
    this.paths = new InsightsPaths();
    this.storage = new SessionStorage(this.paths);
    this.sessionManager = new SessionManager(this.storage, this.paths);
    this.executor = new InsightsExecutor(this.config);

    // Forward executor events
    this.executor.on('status', (projectId, status) => {
      this.emit('status', projectId, status);
    });
    this.executor.on('stream-chunk', (projectId, chunk) => {
      this.emit('stream-chunk', projectId, chunk);
    });
    this.executor.on('error', (projectId, error) => {
      this.emit('error', projectId, error);
    });
    this.executor.on('sdk-rate-limit', (info) => {
      this.emit('sdk-rate-limit', info);
    });
  }

  /**
   * Configure paths for Python and autocode source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.config.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * Load current session from disk or cache
   */
  loadSession(projectId: string, projectPath: string): InsightsSession | null {
    return this.sessionManager.loadSession(projectId, projectPath);
  }

  /**
   * List all sessions for a project
   */
  listSessions(projectPath: string, includeArchived = false): InsightsSessionSummary[] {
    return this.sessionManager.listSessions(projectPath, includeArchived);
  }

  /**
   * Create a new session
   */
  createNewSession(projectId: string, projectPath: string): InsightsSession {
    return this.sessionManager.createNewSession(projectId, projectPath);
  }

  /**
   * Switch to a different session
   */
  switchSession(projectId: string, projectPath: string, sessionId: string): InsightsSession | null {
    return this.sessionManager.switchSession(projectId, projectPath, sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(projectId: string, projectPath: string, sessionId: string): boolean {
    return this.sessionManager.deleteSession(projectId, projectPath, sessionId);
  }

  /**
   * Archive a session
   */
  archiveSession(projectId: string, projectPath: string, sessionId: string): boolean {
    return this.sessionManager.archiveSession(projectId, projectPath, sessionId);
  }

  /**
   * Unarchive a session
   */
  unarchiveSession(projectPath: string, sessionId: string): boolean {
    return this.sessionManager.unarchiveSession(projectPath, sessionId);
  }

  /**
   * Delete multiple sessions
   */
  deleteSessions(projectId: string, projectPath: string, sessionIds: string[]): { deletedIds: string[]; failedIds: string[] } {
    return this.sessionManager.deleteSessions(projectId, projectPath, sessionIds);
  }

  /**
   * Archive multiple sessions
   */
  archiveSessions(projectId: string, projectPath: string, sessionIds: string[]): { archivedIds: string[]; failedIds: string[] } {
    return this.sessionManager.archiveSessions(projectId, projectPath, sessionIds);
  }

  /**
   * Rename a session
   */
  renameSession(projectPath: string, sessionId: string, newTitle: string): boolean {
    return this.sessionManager.renameSession(projectPath, sessionId, newTitle);
  }

  /**
   * Clear current session (delete messages but keep the session)
   */
  clearSession(projectId: string, projectPath: string): void {
    this.sessionManager.clearSession(projectId, projectPath);
  }

  /**
   * Resolve a persisted task suggestion without changing the active session.
   */
  resolveTaskSuggestion(
    projectId: string,
    projectPath: string,
    request: InsightsTaskCreationRequest,
  ): InsightsSuggestedTask | null {
    const session = this.sessionManager.loadSessionById(
      projectId,
      projectPath,
      request.sessionId,
    );
    if (!session || session.projectId !== projectId) return null;

    const suggestion = this.findTaskSuggestion(session, request);
    return suggestion ? structuredClone(suggestion) : null;
  }

  /**
   * Persist the task created from a suggestion and notify the active renderer.
   */
  markTaskSuggestionCreated(
    projectId: string,
    projectPath: string,
    request: InsightsTaskCreationRequest,
    taskId: string,
  ): InsightsSession | null {
    const loadedSession = this.sessionManager.loadSessionById(
      projectId,
      projectPath,
      request.sessionId,
    );
    if (!loadedSession || loadedSession.projectId !== projectId) return null;

    const session = structuredClone(loadedSession);
    const suggestion = this.findTaskSuggestion(session, request);
    if (!suggestion) return null;
    if (suggestion.taskId && suggestion.taskId !== taskId) return null;

    suggestion.taskId = taskId;
    session.updatedAt = new Date();
    this.sessionManager.saveSessionById(projectPath, session);
    this.emit('session-updated', projectId, session);
    return session;
  }

  private findTaskSuggestion(
    session: InsightsSession,
    request: InsightsTaskCreationRequest,
  ): InsightsSuggestedTask | null {
    const requestedMessage = session.messages.find((message) => message.id === request.messageId);
    const indexedSuggestion = requestedMessage?.suggestedTasks?.[request.taskIndex];

    if (!request.suggestionId) {
      return indexedSuggestion ?? null;
    }
    if (indexedSuggestion?.id === request.suggestionId) {
      return indexedSuggestion;
    }

    for (const message of session.messages) {
      const matchingSuggestion = message.suggestedTasks?.find(
        (suggestion) => suggestion.id === request.suggestionId,
      );
      if (matchingSuggestion) return matchingSuggestion;
    }
    return null;
  }

  /**
   * Validate and persist a user message, then start the streamed AI response.
   */
  async sendMessage(
    projectId: string,
    projectPath: string,
    message: string,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[],
    documents?: InsightsDocumentRequest[],
    documentSenderId?: number,
    clientMessageId?: string,
  ): Promise<IPCResult<InsightsSendMessageAcknowledgement>> {
    // Guard: cap images to MAX_IMAGES_PER_TASK
    if (images && images.length > MAX_IMAGES_PER_TASK) {
      images = images.slice(0, MAX_IMAGES_PER_TASK);
    }
    const requestedDocumentCount = Array.isArray(documents) ? documents.length : 0;
    if (requestedDocumentCount > MAX_INSIGHTS_DOCUMENT_REFERENCES) {
      const error = `A maximum of ${MAX_INSIGHTS_DOCUMENT_REFERENCES} local file paths can be referenced per message.`;
      this.emit('error', projectId, error);
      return { success: false, error };
    }
    const requestedPathCharacters = Array.isArray(documents)
      ? documents.reduce((total, document) => (
          total + (typeof document?.path === 'string' ? document.path.length : 0)
        ), 0)
      : 0;
    if (requestedPathCharacters > MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS) {
      const error = `Referenced local file paths exceed the ${MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS}-character message limit.`;
      this.emit('error', projectId, error);
      return { success: false, error };
    }
    const normalizedDocuments = normalizeInsightsDocumentReferences(
      documents,
      projectPath,
      typeof documentSenderId === 'number'
        ? {
            projectId,
            senderId: documentSenderId,
            capabilities: this.documentCapabilities,
          }
        : undefined,
    );
    if (normalizedDocuments.length !== requestedDocumentCount) {
      const error = 'One or more referenced file paths are invalid or inaccessible. Please remove them and try again.';
      this.emit('error', projectId, error);
      return { success: false, error };
    }
    const documentNames = normalizedDocuments.map((document) => document.filename);
    const safeMessage = typeof message === 'string' ? message : '';
    let effectiveMessage = safeMessage.trim();
    if (!effectiveMessage && documentNames.length > 0) {
      effectiveMessage = `Please inspect the referenced local file(s): ${documentNames.join(', ')}`;
    } else if (!effectiveMessage && images?.length) {
      effectiveMessage = 'Please review the attached image reference(s).';
    }
    if (!effectiveMessage) {
      const error = 'A message or attachment is required.';
      this.emit('error', projectId, error);
      return { success: false, error };
    }

    // Only an accepted message may cancel the active run or create/persist a session.
    this.executor.cancelSession(projectId);
    let session = this.sessionManager.loadSession(projectId, projectPath);
    if (!session) {
      session = this.sessionManager.createNewSession(projectId, projectPath);
    }

    // Auto-generate title from the first message or attachment names.
    if (session.messages.length === 0 && session.title === 'New Conversation') {
      session.title = this.storage.generateTitle(effectiveMessage);
    }

    // Add user message. Document entries contain paths only, never file contents.
    const persistImages = images?.map(img => ({
      ...img,
      data: undefined
    }));
    const acceptedClientMessageId = normalizeInsightsClientMessageId(clientMessageId);
    const acceptedMessageId = session.messages.some(
      (existingMessage) => existingMessage.id === acceptedClientMessageId,
    )
      ? `msg-${randomUUID()}`
      : acceptedClientMessageId;
    const userMessage: InsightsChatMessage = {
      id: acceptedMessageId,
      role: 'user',
      content: safeMessage,
      timestamp: new Date(),
      images: persistImages && persistImages.length > 0 ? persistImages : undefined,
      documents: normalizedDocuments.length > 0 ? normalizedDocuments : undefined,
    };
    session.messages.push(userMessage);
    session.updatedAt = new Date();
    this.sessionManager.saveSession(projectPath, session);

    // Build conversation history for context
    // Add notation when images are present so the AI has context
    // For historical messages (all but the last), use past tense to avoid confusion
    const conversationHistory = session.messages.map((m, index) => {
      const imageCount = m.images?.length ?? 0;
      const messageDocuments = (m.documents ?? []).filter((document) => (
        typeof document.path === 'string' && document.path.length > 0
      ));
      const isLastMessage = index === session.messages.length - 1;
      let imageNotation = '';
      if (imageCount > 0 && m.role === 'user') {
        imageNotation = isLastMessage
          ? `\n[User attached ${imageCount} image(s)]`
          : `\n[User previously attached ${imageCount} image(s) - not visible in this context]`;
      }
      let documentNotation = '';
      if (messageDocuments.length > 0 && m.role === 'user') {
        const paths = messageDocuments.map((document) => JSON.stringify(document.path)).join(', ');
        documentNotation = isLastMessage
          ? `\n[User referenced local file path(s) for this question: ${paths}]`
          : `\n[User previously referenced local file path(s): ${paths}. External-file read authorization applies only to the message where the file was referenced.]`;
      }
      return {
        role: m.role,
        content: m.content + imageNotation + documentNotation,
      };
    });

    // Use provided modelConfig or fall back to session's config
    const configToUse = modelConfig || session.modelConfig;

    // Freeze the acknowledgement before the asynchronous executor can append
    // an assistant response to this mutable session object.
    const acceptedSession = structuredClone(session);
    // Start model execution on the next event-loop turn. This lets the
    // ipcMain.handle acknowledgement be delivered before any status/stream
    // events can create renderer-side state for a brand-new session.
    setImmediate(() => {
      void this.executor.execute(
        projectId,
        projectPath,
        effectiveMessage,
        conversationHistory,
        configToUse,
        images,
        normalizedDocuments,
      ).then((result) => {
        const assistantMessage: InsightsChatMessage = {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: result.fullResponse,
          timestamp: new Date(),
          suggestedTasks: result.suggestedTasks,
          toolsUsed: result.toolsUsed.length > 0 ? result.toolsUsed : undefined
        };

        session.messages.push(assistantMessage);
        session.updatedAt = new Date();
        this.sessionManager.saveSession(projectPath, session);

        // Emit session-updated event for real-time UI updates
        this.emit('session-updated', projectId, session);
      }).catch((error) => {
        // Error already emitted by executor
        console.error('[InsightsService] Error executing insights:', error);
      });
    });

    return {
      success: true,
      data: {
        clientMessageId: acceptedClientMessageId,
        messageId: acceptedMessageId,
        session: acceptedSession,
      },
    };
  }

  /**
   * Update model configuration for a session
   */
  updateSessionModelConfig(projectPath: string, sessionId: string, modelConfig: InsightsModelConfig): boolean {
    return this.sessionManager.updateSessionModelConfig(projectPath, sessionId, modelConfig);
  }
}

// Singleton instance
export const insightsService = new InsightsService();
