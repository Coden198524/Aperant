import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'fs';
import {
  getAutocodeProjectIndexPath,
  toAutocodeRendererMemory,
} from '@autocode/core';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  ProjectContextData,
  ProjectIndex,
  RendererMemory,
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { buildMemoryStatus } from './memory-status-handlers';
import { getMemoryService } from './memory-service-factory';
import { runProjectIndexer } from '../../ai/project/project-indexer';

// ============================================================
// HELPERS
// ============================================================

/**
 * Load project index from file
 */
function loadProjectIndex(projectPath: string, dataDirName?: string): ProjectIndex | null {
  const indexPath = getAutocodeProjectIndexPath(projectPath, dataDirName);
  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const content = readFileSync(indexPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

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
        // Load project index
        const projectIndex = loadProjectIndex(project.path, project.autoBuildPath);

        // Build memory status (libSQL-based)
        const memoryStatus = await buildMemoryStatus();

        // Load recent memories from memory service
        const recentMemories = await loadRecentMemories(projectId);

        return {
          success: true,
          data: {
            projectIndex,
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

  // Refresh project index
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_REFRESH_INDEX,
    async (_, projectId: string): Promise<IPCResult<ProjectIndex>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const indexOutputPath = getAutocodeProjectIndexPath(project.path, project.autoBuildPath);

        // Run the TypeScript project indexer (replaces Python subprocess)
        const projectIndex = runProjectIndexer(project.path, indexOutputPath);

        return { success: true, data: projectIndex };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to refresh project index'
        };
      }
    }
  );
}
