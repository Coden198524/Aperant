import { create } from 'zustand';
import type {
  ProjectIndex,
  MemorySystemStatus,
  MemorySystemState,
  RendererMemory,
  ContextSearchResult
} from '../../shared/types';

interface ContextState {
  currentProjectId: string | null;

  // Deprecated project-index compatibility state
  projectIndex: ProjectIndex | null;
  indexLoading: boolean;
  indexError: string | null;

  // Memory Status
  memoryStatus: MemorySystemStatus | null;
  memoryState: MemorySystemState | null;
  memoryLoading: boolean;
  memoryError: string | null;

  // Recent Memories
  recentMemories: RendererMemory[];
  memoriesLoading: boolean;

  // Search
  searchResults: ContextSearchResult[];
  searchLoading: boolean;
  searchQuery: string;

  // Actions
  setCurrentProjectId: (projectId: string | null) => void;
  setProjectIndex: (index: ProjectIndex | null) => void;
  setIndexLoading: (loading: boolean) => void;
  setIndexError: (error: string | null) => void;
  setMemoryStatus: (status: MemorySystemStatus | null) => void;
  setMemoryState: (state: MemorySystemState | null) => void;
  setMemoryLoading: (loading: boolean) => void;
  setMemoryError: (error: string | null) => void;
  setRecentMemories: (memories: RendererMemory[]) => void;
  setMemoriesLoading: (loading: boolean) => void;
  setSearchResults: (results: ContextSearchResult[]) => void;
  setSearchLoading: (loading: boolean) => void;
  setSearchQuery: (query: string) => void;
  clearAll: () => void;
}

export const useContextStore = create<ContextState>((set) => ({
  currentProjectId: null,

  // Deprecated project-index compatibility state
  projectIndex: null,
  indexLoading: false,
  indexError: null,

  // Memory Status
  memoryStatus: null,
  memoryState: null,
  memoryLoading: false,
  memoryError: null,

  // Recent Memories
  recentMemories: [],
  memoriesLoading: false,

  // Search
  searchResults: [],
  searchLoading: false,
  searchQuery: '',

  // Actions
  setCurrentProjectId: (projectId) =>
    set((state) => {
      if (state.currentProjectId === projectId) {
        return { currentProjectId: projectId };
      }

      return {
        currentProjectId: projectId,
        projectIndex: null,
        indexLoading: false,
        indexError: null,
        memoryStatus: null,
        memoryState: null,
        memoryLoading: false,
        memoryError: null,
        recentMemories: [],
        memoriesLoading: false,
        searchResults: [],
        searchLoading: false,
        searchQuery: ''
      };
    }),
  setProjectIndex: (index) => set({ projectIndex: index }),
  setIndexLoading: (loading) => set({ indexLoading: loading }),
  setIndexError: (error) => set({ indexError: error }),
  setMemoryStatus: (status) => set({ memoryStatus: status }),
  setMemoryState: (state) => set({ memoryState: state }),
  setMemoryLoading: (loading) => set({ memoryLoading: loading }),
  setMemoryError: (error) => set({ memoryError: error }),
  setRecentMemories: (memories) => set({ recentMemories: memories }),
  setMemoriesLoading: (loading) => set({ memoriesLoading: loading }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchLoading: (loading) => set({ searchLoading: loading }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  clearAll: () =>
    set({
      currentProjectId: null,
      projectIndex: null,
      indexLoading: false,
      indexError: null,
      memoryStatus: null,
      memoryState: null,
      memoryLoading: false,
      memoryError: null,
      recentMemories: [],
      memoriesLoading: false,
      searchResults: [],
      searchLoading: false,
      searchQuery: ''
    })
}));

let projectContextRequestSeq = 0;
let memorySearchRequestSeq = 0;
let recentMemoriesRequestSeq = 0;

function beginContextProjectScope(projectId: string): void {
  const store = useContextStore.getState();
  if (store.currentProjectId !== projectId) {
    store.setCurrentProjectId(projectId);
  }
}

function isCurrentContextRequest(
  projectId: string,
  requestSeq: number,
  getLatestRequestSeq: () => number
): boolean {
  const state = useContextStore.getState();
  return state.currentProjectId === projectId && getLatestRequestSeq() === requestSeq;
}

/**
 * Load project context (legacy project-index placeholder + memory status)
 */
export async function loadProjectContext(projectId: string): Promise<void> {
  beginContextProjectScope(projectId);
  const requestSeq = ++projectContextRequestSeq;
  const store = useContextStore.getState();
  store.setIndexLoading(true);
  store.setMemoryLoading(true);
  store.setIndexError(null);
  store.setMemoryError(null);

  try {
    const result = await window.electronAPI.getProjectContext(projectId);
    if (!isCurrentContextRequest(projectId, requestSeq, () => projectContextRequestSeq)) return;

    if (result.success && result.data) {
      store.setProjectIndex(result.data.projectIndex);
      store.setMemoryStatus(result.data.memoryStatus);
      store.setMemoryState(result.data.memoryState);
      store.setRecentMemories(result.data.recentMemories || []);
    } else {
      store.setIndexError(result.error || 'Failed to load project context');
    }
  } catch (error) {
    if (!isCurrentContextRequest(projectId, requestSeq, () => projectContextRequestSeq)) return;
    store.setIndexError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    if (isCurrentContextRequest(projectId, requestSeq, () => projectContextRequestSeq)) {
      store.setIndexLoading(false);
      store.setMemoryLoading(false);
    }
  }
}

/**
 * Search memories using semantic search
 */
export async function searchMemories(
  projectId: string,
  query: string
): Promise<void> {
  beginContextProjectScope(projectId);
  const requestSeq = ++memorySearchRequestSeq;
  const store = useContextStore.getState();
  store.setSearchQuery(query);

  if (!query.trim()) {
    store.setSearchResults([]);
    return;
  }

  store.setSearchLoading(true);

  try {
    const result = await window.electronAPI.searchMemories(projectId, query);
    if (!isCurrentContextRequest(projectId, requestSeq, () => memorySearchRequestSeq)) return;

    if (result.success && result.data) {
      store.setSearchResults(result.data);
    } else {
      store.setSearchResults([]);
    }
  } catch (_error) {
    if (!isCurrentContextRequest(projectId, requestSeq, () => memorySearchRequestSeq)) return;
    store.setSearchResults([]);
  } finally {
    if (isCurrentContextRequest(projectId, requestSeq, () => memorySearchRequestSeq)) {
      store.setSearchLoading(false);
    }
  }
}

/**
 * Load recent memories
 */
export async function loadRecentMemories(
  projectId: string,
  limit: number = 20
): Promise<void> {
  beginContextProjectScope(projectId);
  const requestSeq = ++recentMemoriesRequestSeq;
  const store = useContextStore.getState();
  store.setMemoriesLoading(true);

  try {
    const result = await window.electronAPI.getRecentMemories(projectId, limit);
    if (!isCurrentContextRequest(projectId, requestSeq, () => recentMemoriesRequestSeq)) return;

    if (result.success && result.data) {
      store.setRecentMemories(result.data);
    }
  } catch (_error) {
    // Silently fail - memories are optional
  } finally {
    if (isCurrentContextRequest(projectId, requestSeq, () => recentMemoriesRequestSeq)) {
      store.setMemoriesLoading(false);
    }
  }
}

/**
 * Verify a memory (mark as user-verified)
 */
export async function verifyMemory(memoryId: string): Promise<boolean> {
  try {
    const result = await window.electronAPI.verifyMemory(memoryId);
    if (result.success) {
      const store = useContextStore.getState();
      store.setRecentMemories(
        store.recentMemories.map((m) =>
          m.id === memoryId ? { ...m, userVerified: true, needsReview: false } : m
        )
      );
    }
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Pin/unpin a memory
 */
export async function pinMemory(memoryId: string, pinned: boolean): Promise<boolean> {
  try {
    const result = await window.electronAPI.pinMemory(memoryId, pinned);
    if (result.success) {
      const store = useContextStore.getState();
      store.setRecentMemories(
        store.recentMemories.map((m) =>
          m.id === memoryId ? { ...m, pinned } : m
        )
      );
    }
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Deprecate a memory (soft delete)
 */
export async function deprecateMemory(memoryId: string): Promise<boolean> {
  try {
    const result = await window.electronAPI.deprecateMemory(memoryId);
    if (result.success) {
      const store = useContextStore.getState();
      store.setRecentMemories(
        store.recentMemories.filter((m) => m.id !== memoryId)
      );
    }
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Delete a memory permanently
 */
export async function deleteMemory(memoryId: string): Promise<boolean> {
  try {
    const result = await window.electronAPI.deleteMemory(memoryId);
    if (result.success) {
      const store = useContextStore.getState();
      store.setRecentMemories(
        store.recentMemories.filter((m) => m.id !== memoryId)
      );
    }
    return result.success;
  } catch {
    return false;
  }
}
