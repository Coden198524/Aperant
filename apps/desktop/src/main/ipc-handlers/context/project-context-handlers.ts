import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import {
  toAutocodeRendererMemory,
} from '@autocode/core';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  ProjectContextData,
  RendererMemory,
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { buildMemoryStatus } from './memory-status-handlers';
import { getMemoryService } from './memory-service-factory';

// ============================================================
// HELPERS
// ============================================================

/**
 * Load recent memories from the MemoryService with graceful degradation.
 */
async function loadRecentMemories(projectId: string): Promise<RendererMemory[]> {
  try {
    const service = await getMemoryService();
    const memories = await service.search({
      projectId,
      limit: 20,
      sort: 'recency',
      excludeDeprecated: true,
      recordAccess: false,
    });
    return memories.map(toAutocodeRendererMemory);
  } catch {
    // Memory service unavailable — return empty list
    return [];
  }
}

// ============================================================
// REGISTER HANDLERS
// ============================================================

/**
 * Register project context handlers
 */
export function registerProjectContextHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // Get full project context
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET,
    async (_, projectId: string): Promise<IPCResult<ProjectContextData>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        // Build memory status (libSQL-based)
        const memoryStatus = await buildMemoryStatus();

        // Load recent memories from memory service
        const recentMemories = await loadRecentMemories(projectId);

        return {
          success: true,
          data: {
            projectIndex: null,
            memoryStatus,
            memoryState: null,
            recentMemories,
            isLoading: false
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load project context'
        };
      }
    }
  );

}
