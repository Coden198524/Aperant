import { create } from 'zustand';
import type { FileNode } from '../../shared/types';

interface FileExplorerState {
  isOpen: boolean;
  expandedFolders: Set<string>;
  files: Map<string, FileNode[]>;  // Cache: dirPath -> files
  isLoading: Map<string, boolean>; // Loading state per directory
  error: string | null;

  // Actions
  toggle: () => void;
  open: () => void;
  close: () => void;
  toggleFolder: (path: string) => void;
  expandFolder: (path: string) => void;
  collapseFolder: (path: string) => void;
  loadDirectory: (dirPath: string) => Promise<FileNode[]>;
  refreshDirectory: (dirPath: string) => Promise<FileNode[]>;
  invalidateDirectories: (dirPaths: string[]) => void;
  setError: (error: string | null) => void;
  clearCache: () => void;

  // Selectors
  isExpanded: (path: string) => boolean;
  getFiles: (dirPath: string) => FileNode[] | undefined;
  isLoadingDir: (dirPath: string) => boolean;
  getAllExpandedFiles: () => Set<string>;
  getVisibleFiles: (rootPath: string) => FileNode[];
  computeVisibleItems: (rootPath: string) => { nodes: FileNode[]; count: number };
}

function normalizeExplorerPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return typeof window !== 'undefined' && window.platform?.isWindows
    ? normalized.toLowerCase()
    : normalized;
}

function isSameOrDescendantPath(candidatePath: string, parentPath: string): boolean {
  const candidate = normalizeExplorerPath(candidatePath);
  const parent = normalizeExplorerPath(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export const useFileExplorerStore = create<FileExplorerState>((set, get) => {
  const fetchDirectory = async (dirPath: string, useCache: boolean): Promise<FileNode[]> => {
    const state = get();

    if (useCache) {
      const cached = state.files.get(dirPath);
      if (cached) {
        return cached;
      }
    }

    set((currentState) => {
      const newLoading = new Map(currentState.isLoading);
      newLoading.set(dirPath, true);
      return { isLoading: newLoading, error: null };
    });

    try {
      const result = await window.electronAPI.listDirectory(dirPath);

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load directory');
      }

      set((currentState) => {
        const newFiles = new Map(currentState.files);
        newFiles.set(dirPath, result.data!);
        const newLoading = new Map(currentState.isLoading);
        newLoading.set(dirPath, false);
        return { files: newFiles, isLoading: newLoading };
      });

      return result.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      set((currentState) => {
        const newFiles = new Map(currentState.files);
        newFiles.delete(dirPath);
        const newLoading = new Map(currentState.isLoading);
        newLoading.set(dirPath, false);
        return { files: newFiles, isLoading: newLoading, error: errorMessage };
      });
      return [];
    }
  };

  return {
    isOpen: false,
    expandedFolders: new Set(),
    files: new Map(),
    isLoading: new Map(),
    error: null,

    toggle: () => {
      set((state) => ({ isOpen: !state.isOpen }));
    },

    open: () => {
      set({ isOpen: true });
    },

    close: () => {
      set({ isOpen: false });
    },

    toggleFolder: (path: string) => {
      set((state) => {
        const newExpanded = new Set(state.expandedFolders);
        if (newExpanded.has(path)) {
          newExpanded.delete(path);
        } else {
          newExpanded.add(path);
        }
        return { expandedFolders: newExpanded };
      });
    },

    expandFolder: (path: string) => {
      set((state) => {
        const newExpanded = new Set(state.expandedFolders);
        newExpanded.add(path);
        return { expandedFolders: newExpanded };
      });
    },

    collapseFolder: (path: string) => {
      set((state) => {
        const newExpanded = new Set(state.expandedFolders);
        newExpanded.delete(path);
        return { expandedFolders: newExpanded };
      });
    },

    loadDirectory: (dirPath: string): Promise<FileNode[]> => {
      return fetchDirectory(dirPath, true);
    },

    refreshDirectory: (dirPath: string): Promise<FileNode[]> => {
      return fetchDirectory(dirPath, false);
    },

    invalidateDirectories: (dirPaths: string[]) => {
      if (dirPaths.length === 0) return;

      set((state) => {
        const newFiles = new Map(state.files);
        const newLoading = new Map(state.isLoading);
        const newExpanded = new Set(state.expandedFolders);

        for (const dirPath of dirPaths) {
          for (const cachedPath of [...newFiles.keys()]) {
            if (isSameOrDescendantPath(cachedPath, dirPath)) {
              newFiles.delete(cachedPath);
            }
          }
          for (const loadingPath of [...newLoading.keys()]) {
            if (isSameOrDescendantPath(loadingPath, dirPath)) {
              newLoading.delete(loadingPath);
            }
          }
          for (const expandedPath of [...newExpanded.keys()]) {
            if (isSameOrDescendantPath(expandedPath, dirPath)) {
              newExpanded.delete(expandedPath);
            }
          }
        }

        return {
          files: newFiles,
          isLoading: newLoading,
          expandedFolders: newExpanded
        };
      });
    },

    setError: (error: string | null) => {
      set({ error });
    },

    clearCache: () => {
      set({ files: new Map(), expandedFolders: new Set() });
    },

    isExpanded: (path: string) => {
      return get().expandedFolders.has(path);
    },

    getFiles: (dirPath: string) => {
      return get().files.get(dirPath);
    },

    isLoadingDir: (dirPath: string) => {
      return get().isLoading.get(dirPath) ?? false;
    },

    getAllExpandedFiles: () => {
      return new Set(get().expandedFolders);
    },

    getVisibleFiles: (rootPath: string) => {
      const state = get();
      const result: FileNode[] = [];

      const collectVisibleNodes = (dirPath: string): void => {
        const nodes = state.files.get(dirPath);
        if (!nodes) return;

        for (const node of nodes) {
          result.push(node);
          // If this is an expanded directory, recursively collect its children
          if (node.isDirectory && state.expandedFolders.has(node.path)) {
            collectVisibleNodes(node.path);
          }
        }
      };

      collectVisibleNodes(rootPath);
      return result;
    },

    computeVisibleItems: (rootPath: string) => {
      const state = get();
      const nodes: FileNode[] = [];

      const collectVisibleNodes = (dirPath: string): void => {
        const dirNodes = state.files.get(dirPath);
        if (!dirNodes) return;

        for (const node of dirNodes) {
          nodes.push(node);
          // If this is an expanded directory, recursively collect its children
          if (node.isDirectory && state.expandedFolders.has(node.path)) {
            collectVisibleNodes(node.path);
          }
        }
      };

      collectVisibleNodes(rootPath);
      return { nodes, count: nodes.length };
    },
  };
});
