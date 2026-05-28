import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import {
  toAutocodeContextSearchResult,
  toAutocodeRendererMemory,
} from '@autocode/core';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  RendererMemory,
  ContextSearchResult,
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getMemoryService } from './memory-service-factory';

// ============================================================
// REGISTER HANDLERS
// ============================================================

/**
 * Register memory data handlers
 */
export function registerMemoryDataHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // Get all memories (sorted by recency)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET_MEMORIES,
    async (_, projectId: string, limit: number = 20): Promise<IPCResult<RendererMemory[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = await getMemoryService();
        const memories = await service.search({
          projectId,
          limit,
          sort: 'recency',
          excludeDeprecated: true,
        });
        return { success: true, data: memories.map(toAutocodeRendererMemory) };
      } catch {
        // Graceful degradation: return empty list if memory service is unavailable
        return { success: true, data: [] };
      }
    }
  );

  // Verify a memory (mark as user-verified)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_VERIFY,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.verifyMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to verify memory' };
      }
    }
  );

  // Pin/unpin a memory
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_PIN,
    async (_, memoryId: string, pinned: boolean): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.pinMemory(memoryId, pinned);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to pin memory' };
      }
    }
  );

  // Deprecate a memory (soft delete)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_DEPRECATE,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.deprecateMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to deprecate memory' };
      }
    }
  );

  // Delete a memory permanently
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_DELETE,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.deleteMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to delete memory' };
      }
    }
  );

  // Search memories
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_SEARCH_MEMORIES,
    async (_, projectId: string, query: string): Promise<IPCResult<ContextSearchResult[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = await getMemoryService();
        const memories = await service.search({
          query,
          projectId,
          limit: 20,
          excludeDeprecated: true,
        });
        return {
          success: true,
          data: memories.map(toAutocodeContextSearchResult),
        };
      } catch {
        // Graceful degradation: return empty list if memory service is unavailable
        return { success: true, data: [] };
      }
    }
  );
}
