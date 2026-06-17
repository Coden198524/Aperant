import { create } from 'zustand';
import type { GitHubSyncStatus } from '../../../shared/types';

interface SyncStatusState {
  currentProjectId: string | null;

  // Sync status
  syncStatus: GitHubSyncStatus | null;
  connectionError: string | null;

  // Actions
  setCurrentProjectId: (projectId: string | null) => void;
  setSyncStatus: (status: GitHubSyncStatus | null) => void;
  setConnectionError: (error: string | null) => void;
  clearSyncStatus: () => void;

  // Selectors
  isConnected: () => boolean;
  getRepoFullName: () => string | null;
}

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
  // Initial state
  currentProjectId: null,
  syncStatus: null,
  connectionError: null,

  // Actions
  setCurrentProjectId: (projectId) =>
    set((state) => {
      if (state.currentProjectId === projectId) {
        return { currentProjectId: projectId };
      }
      return {
        currentProjectId: projectId,
        syncStatus: null,
        connectionError: null
      };
    }),

  setSyncStatus: (syncStatus) => set({ syncStatus, connectionError: null }),

  setConnectionError: (connectionError) => set({ connectionError }),

  clearSyncStatus: () => set({
    syncStatus: null,
    connectionError: null
  }),

  // Selectors
  isConnected: () => {
    const { syncStatus } = get();
    return syncStatus?.connected ?? false;
  },

  getRepoFullName: () => {
    const { syncStatus } = get();
    return syncStatus?.repoFullName ?? null;
  }
}));

let githubConnectionRequestSeq = 0;

function beginGitHubConnectionScope(projectId: string): void {
  const store = useSyncStatusStore.getState();
  if (store.currentProjectId !== projectId) {
    store.setCurrentProjectId(projectId);
  }
}

function isCurrentGitHubConnectionRequest(projectId: string, requestSeq: number): boolean {
  const state = useSyncStatusStore.getState();
  return state.currentProjectId === projectId && githubConnectionRequestSeq === requestSeq;
}

/**
 * Check GitHub connection status
 */
export async function checkGitHubConnection(projectId: string): Promise<GitHubSyncStatus | null> {
  beginGitHubConnectionScope(projectId);
  const requestSeq = ++githubConnectionRequestSeq;
  const store = useSyncStatusStore.getState();

  try {
    const result = await window.electronAPI.checkGitHubConnection(projectId);
    if (!isCurrentGitHubConnectionRequest(projectId, requestSeq)) return null;

    if (result.success && result.data) {
      store.setSyncStatus(result.data);
      return result.data;
    } else {
      store.setConnectionError(result.error || 'Failed to check GitHub connection');
      return null;
    }
  } catch (error) {
    if (!isCurrentGitHubConnectionRequest(projectId, requestSeq)) return null;
    store.setConnectionError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}
