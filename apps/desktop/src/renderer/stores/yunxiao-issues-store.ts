import { create } from 'zustand';
import type { YunxiaoIssue, YunxiaoIssueSyncResult, YunxiaoSyncStatus } from '../../shared/types';

interface YunxiaoIssuesState {
  currentProjectId: string | null;
  issues: YunxiaoIssue[];
  syncStatus: YunxiaoSyncStatus | null;
  isLoading: boolean;
  isSyncing: boolean;
  error: string | null;
  selectedWorkItemId: string | null;

  setCurrentProjectId: (projectId: string | null) => void;
  setIssues: (issues: YunxiaoIssue[]) => void;
  setSyncStatus: (status: YunxiaoSyncStatus | null) => void;
  setLoading: (loading: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  setError: (error: string | null) => void;
  selectIssue: (workItemId: string | null) => void;
  updateIssue: (workItemId: string, updates: Partial<YunxiaoIssue>) => void;
  clear: () => void;

  getSelectedIssue: () => YunxiaoIssue | null;
}

export const useYunxiaoIssuesStore = create<YunxiaoIssuesState>((set, get) => ({
  currentProjectId: null,
  issues: [],
  syncStatus: null,
  isLoading: false,
  isSyncing: false,
  error: null,
  selectedWorkItemId: null,

  setCurrentProjectId: (projectId) =>
    set((state) => {
      if (state.currentProjectId === projectId) {
        return { currentProjectId: projectId };
      }

      return {
        currentProjectId: projectId,
        issues: [],
        syncStatus: null,
        isLoading: false,
        isSyncing: false,
        error: null,
        selectedWorkItemId: null
      };
    }),

  setIssues: (issues) => set({ issues, error: null }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setLoading: (isLoading) => set({ isLoading }),
  setSyncing: (isSyncing) => set({ isSyncing }),
  setError: (error) => set({ error }),
  selectIssue: (selectedWorkItemId) => set({ selectedWorkItemId }),
  updateIssue: (workItemId, updates) => set((state) => ({
    issues: state.issues.map((issue) => (
      issue.workItemId === workItemId ? { ...issue, ...updates } : issue
    ))
  })),
  clear: () => set({
    currentProjectId: null,
    issues: [],
    syncStatus: null,
    isLoading: false,
    isSyncing: false,
    error: null,
    selectedWorkItemId: null
  }),

  getSelectedIssue: () => {
    const { issues, selectedWorkItemId } = get();
    return issues.find((issue) => issue.workItemId === selectedWorkItemId) || null;
  }
}));

let yunxiaoConnectionRequestSeq = 0;
let yunxiaoIssuesRequestSeq = 0;
let yunxiaoSyncRequestSeq = 0;

function beginYunxiaoProjectScope(projectId: string): void {
  const store = useYunxiaoIssuesStore.getState();
  if (store.currentProjectId !== projectId) {
    store.setCurrentProjectId(projectId);
  }
}

function isCurrentYunxiaoRequest(
  projectId: string,
  requestSeq: number,
  getLatestRequestSeq: () => number
): boolean {
  const state = useYunxiaoIssuesStore.getState();
  return state.currentProjectId === projectId && getLatestRequestSeq() === requestSeq;
}

export async function checkYunxiaoIssueConnection(projectId: string): Promise<YunxiaoSyncStatus | null> {
  beginYunxiaoProjectScope(projectId);
  const requestSeq = ++yunxiaoConnectionRequestSeq;
  const store = useYunxiaoIssuesStore.getState();
  try {
    const result = await window.electronAPI.checkYunxiaoConnection(projectId);
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoConnectionRequestSeq)) return null;

    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to check Yunxiao connection');
      return null;
    }
    store.setSyncStatus(result.data);
    return result.data;
  } catch (error) {
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoConnectionRequestSeq)) return null;
    store.setError(error instanceof Error ? error.message : 'Failed to check Yunxiao connection');
    return null;
  }
}

export async function loadYunxiaoIssues(projectId: string): Promise<void> {
  beginYunxiaoProjectScope(projectId);
  const requestSeq = ++yunxiaoIssuesRequestSeq;
  const store = useYunxiaoIssuesStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const result = await window.electronAPI.getYunxiaoIssues(projectId);
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoIssuesRequestSeq)) return;

    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to load Yunxiao issues');
      return;
    }
    store.setIssues(result.data);
  } catch (error) {
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoIssuesRequestSeq)) return;
    store.setError(error instanceof Error ? error.message : 'Failed to load Yunxiao issues');
  } finally {
    if (isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoIssuesRequestSeq)) {
      store.setLoading(false);
    }
  }
}

export async function syncYunxiaoIssues(projectId: string): Promise<YunxiaoIssueSyncResult | null> {
  beginYunxiaoProjectScope(projectId);
  const requestSeq = ++yunxiaoSyncRequestSeq;
  const store = useYunxiaoIssuesStore.getState();
  store.setSyncing(true);
  store.setError(null);
  try {
    const result = await window.electronAPI.syncYunxiaoIssues(projectId);
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoSyncRequestSeq)) return null;

    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to sync Yunxiao issues');
      return null;
    }
    store.setIssues(result.data.issues);
    return result.data;
  } catch (error) {
    if (!isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoSyncRequestSeq)) return null;
    store.setError(error instanceof Error ? error.message : 'Failed to sync Yunxiao issues');
    return null;
  } finally {
    if (isCurrentYunxiaoRequest(projectId, requestSeq, () => yunxiaoSyncRequestSeq)) {
      store.setSyncing(false);
    }
  }
}

export async function saveYunxiaoIssueLocalFields(
  projectId: string,
  workItemId: string,
  updates: {
    localCategory?: string;
    localSeverity?: 'low' | 'medium' | 'high' | 'critical';
    localTags?: string[];
    localAnalysis?: string;
  }
): Promise<boolean> {
  beginYunxiaoProjectScope(projectId);
  const store = useYunxiaoIssuesStore.getState();
  try {
    const result = await window.electronAPI.updateYunxiaoIssue(projectId, workItemId, updates);
    if (useYunxiaoIssuesStore.getState().currentProjectId !== projectId) return false;

    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to update Yunxiao issue');
      return false;
    }
    store.updateIssue(workItemId, result.data);
    return true;
  } catch (error) {
    if (useYunxiaoIssuesStore.getState().currentProjectId !== projectId) return false;
    store.setError(error instanceof Error ? error.message : 'Failed to update Yunxiao issue');
    return false;
  }
}
