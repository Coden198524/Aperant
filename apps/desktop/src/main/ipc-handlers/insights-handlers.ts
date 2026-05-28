import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import {
  createAutocodeTask,
  type AutocodeTask,
  type AutocodeTaskMetadata,
} from "@autocode/core";
import { IPC_CHANNELS } from "../../shared/constants";
import type {
  IPCResult,
  InsightsSession,
  InsightsSessionSummary,
  InsightsModelConfig,
  ImageAttachment,
  Task,
  TaskMetadata,
} from "../../shared/types";
import { projectStore } from "../project-store";
import { insightsService } from "../insights-service";
import { safeSendToRenderer } from "./utils";
import { getActiveProviderFeatureSettings } from "./feature-settings-helper";
import type { ThinkingLevel } from "../../shared/types/settings";

function toDesktopTask(coreTask: AutocodeTask, projectId: string): Task {
  return {
    id: coreTask.id,
    specId: coreTask.specId,
    projectId,
    title: coreTask.title,
    description: coreTask.description,
    status: coreTask.status as Task["status"],
    subtasks: coreTask.subtasks,
    logs: [],
    metadata: coreTask.metadata as TaskMetadata | undefined,
    specsPath: coreTask.specsPath,
    createdAt: new Date(coreTask.createdAt),
    updatedAt: new Date(coreTask.updatedAt),
  };
}

/**
 * Read insights feature settings using per-provider resolution
 */
function getInsightsFeatureSettings(): InsightsModelConfig {
  const { model, thinkingLevel } = getActiveProviderFeatureSettings('insights');
  return {
    profileId: "balanced",
    model,
    thinkingLevel: thinkingLevel as ThinkingLevel,
  };
}

/**
 * Register all insights-related IPC handlers
 */
export function registerInsightsHandlers(getMainWindow: () => BrowserWindow | null): void {
  // ============================================
  // Insights Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_GET_SESSION,
    async (_, projectId: string): Promise<IPCResult<InsightsSession | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const session = insightsService.loadSession(projectId, project.path);
      return { success: true, data: session };
    }
  );

  ipcMain.on(
    IPC_CHANNELS.INSIGHTS_SEND_MESSAGE,
    async (_, projectId: string, message: string, modelConfig?: InsightsModelConfig, images?: ImageAttachment[]) => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        safeSendToRenderer(
          getMainWindow,
          IPC_CHANNELS.INSIGHTS_ERROR,
          projectId,
          "Project not found"
        );
        return;
      }

      // Get feature settings from Agent Settings and merge with provided config
      const featureSettings = getInsightsFeatureSettings();
      const configWithSettings: InsightsModelConfig = {
        // Start with feature settings as defaults
        ...featureSettings,
        // Override with any explicitly provided config
        ...modelConfig,
      };

      console.log("[Insights Handler] Using model config:", {
        model: configWithSettings.model,
        thinkingLevel: configWithSettings.thinkingLevel,
      });

      // Await the async sendMessage to ensure proper error handling and
      // that all async operations (like getProcessEnv) complete before
      // the handler returns. This fixes race conditions on Windows where
      // environment setup wouldn't complete before process spawn.
      try {
        await insightsService.sendMessage(projectId, project.path, message, configWithSettings, images);
      } catch (error) {
        // Errors during sendMessage (executor errors) are already emitted via
        // the 'error' event, but we catch here to prevent unhandled rejection
        // and ensure all error types are reported to the UI
        console.error("[Insights IPC] Error in sendMessage:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeSendToRenderer(
          getMainWindow,
          IPC_CHANNELS.INSIGHTS_ERROR,
          projectId,
          `Failed to send message: ${errorMessage}`
        );
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_CLEAR_SESSION,
    async (_, projectId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      insightsService.clearSession(projectId, project.path);
      return { success: true };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_CREATE_TASK,
    async (
      _,
      projectId: string,
      title: string,
      description: string,
      metadata?: TaskMetadata
    ): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      if (!project.autoBuildPath) {
        return { success: false, error: "Autocode not initialized for this project" };
      }

      try {
        const taskMetadata: TaskMetadata = {
          sourceType: "insights",
          ...metadata,
        };

        const coreTask = createAutocodeTask({
          projectRoot: project.path,
          dataDirName: project.autoBuildPath || ".autocode",
          title,
          description,
          metadata: taskMetadata as unknown as AutocodeTaskMetadata,
        });
        const task = toDesktopTask(coreTask, projectId);
        projectStore.invalidateTasksCache(projectId);

        return { success: true, data: task };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to create task",
        };
      }
    }
  );

  // List all sessions for a project
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_LIST_SESSIONS,
    async (_, projectId: string, includeArchived?: boolean): Promise<IPCResult<InsightsSessionSummary[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const sessions = insightsService.listSessions(project.path, includeArchived ?? false);
      return { success: true, data: sessions };
    }
  );

  // Delete multiple sessions
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_DELETE_SESSIONS,
    async (_, projectId: string, sessionIds: string[]): Promise<IPCResult<{ deletedIds: string[]; failedIds: string[] }>> => {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return { success: false, error: "No sessions specified" };
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const result = insightsService.deleteSessions(projectId, project.path, sessionIds);
      return {
        success: result.failedIds.length === 0,
        data: result,
        ...(result.failedIds.length > 0 && { error: `Failed to delete ${result.failedIds.length} session(s)` })
      };
    }
  );

  // Archive a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.archiveSession(projectId, project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to archive session" };
    }
  );

  // Archive multiple sessions
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_ARCHIVE_SESSIONS,
    async (_, projectId: string, sessionIds: string[]): Promise<IPCResult<{ archivedIds: string[]; failedIds: string[] }>> => {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return { success: false, error: "No sessions specified" };
      }

      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const result = insightsService.archiveSessions(projectId, project.path, sessionIds);
      return {
        success: result.failedIds.length === 0,
        data: result,
        ...(result.failedIds.length > 0 && { error: `Failed to archive ${result.failedIds.length} session(s)` })
      };
    }
  );

  // Unarchive a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_UNARCHIVE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.unarchiveSession(project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to unarchive session" };
    }
  );

  // Create a new session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_NEW_SESSION,
    async (_, projectId: string): Promise<IPCResult<InsightsSession>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const session = insightsService.createNewSession(projectId, project.path);
      return { success: true, data: session };
    }
  );

  // Switch to a different session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_SWITCH_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult<InsightsSession | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const session = insightsService.switchSession(projectId, project.path, sessionId);
      return { success: true, data: session };
    }
  );

  // Delete a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_DELETE_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.deleteSession(projectId, project.path, sessionId);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to delete session" };
    }
  );

  // Rename a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_RENAME_SESSION,
    async (_, projectId: string, sessionId: string, newTitle: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.renameSession(project.path, sessionId, newTitle);
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to rename session" };
    }
  );

  // Update model configuration for a session
  ipcMain.handle(
    IPC_CHANNELS.INSIGHTS_UPDATE_MODEL_CONFIG,
    async (
      _,
      projectId: string,
      sessionId: string,
      modelConfig: InsightsModelConfig
    ): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: "Project not found" };
      }

      const success = insightsService.updateSessionModelConfig(
        project.path,
        sessionId,
        modelConfig
      );
      if (success) {
        return { success: true };
      }
      return { success: false, error: "Failed to update model configuration" };
    }
  );

  // ============================================
  // Insights Event Forwarding (Service -> Renderer)
  // ============================================

  // Forward streaming chunks to renderer
  insightsService.on("stream-chunk", (projectId: string, chunk: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_STREAM_CHUNK, projectId, chunk);
  });

  // Forward status updates to renderer
  insightsService.on("status", (projectId: string, status: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_STATUS, projectId, status);
  });

  // Forward errors to renderer
  insightsService.on("error", (projectId: string, error: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_ERROR, projectId, error);
  });

  // Forward SDK rate limit events to renderer
  insightsService.on("sdk-rate-limit", (rateLimitInfo: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
  });

  // Forward session-updated events to renderer for real-time UI updates
  insightsService.on("session-updated", (projectId: string, session: unknown) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.INSIGHTS_SESSION_UPDATED, projectId, session);
  });
}
