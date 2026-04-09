import { create } from 'zustand';
import type { YunxiaoIssue, YunxiaoIssueSyncResult, YunxiaoSyncStatus } from '../../shared/types';

interface YunxiaoIssuesState {
  issues: YunxiaoIssue[];
  syncStatus: YunxiaoSyncStatus | null;
  isLoading: boolean;
  isSyncing: boolean;
  error: string | null;
  selectedWorkItemId: string | null;

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
  issues: [],
  syncStatus: null,
  isLoading: false,
  isSyncing: false,
  error: null,
  selectedWorkItemId: null,

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

export async function checkYunxiaoIssueConnection(projectId: string): Promise<YunxiaoSyncStatus | null> {
  const store = useYunxiaoIssuesStore.getState();
  try {
    const result = await window.electronAPI.checkYunxiaoConnection(projectId);
    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to check Yunxiao connection');
      return null;
    }
    store.setSyncStatus(result.data);
    return result.data;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to check Yunxiao connection');
    return null;
  }
}

export async function loadYunxiaoIssues(projectId: string): Promise<void> {
  const store = useYunxiaoIssuesStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const result = await window.electronAPI.getYunxiaoIssues(projectId);
    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to load Yunxiao issues');
      return;
    }
    store.setIssues(result.data);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to load Yunxiao issues');
  } finally {
    store.setLoading(false);
  }
}

export async function syncYunxiaoIssues(projectId: string): Promise<YunxiaoIssueSyncResult | null> {
  const store = useYunxiaoIssuesStore.getState();
  store.setSyncing(true);
  store.setError(null);
  try {
    const result = await window.electronAPI.syncYunxiaoIssues(projectId);
    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to sync Yunxiao issues');
      return null;
    }
    store.setIssues(result.data.issues);
    return result.data;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to sync Yunxiao issues');
    return null;
  } finally {
    store.setSyncing(false);
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
  const store = useYunxiaoIssuesStore.getState();
  try {
    const result = await window.electronAPI.updateYunxiaoIssue(projectId, workItemId, updates);
    if (!result.success || !result.data) {
      store.setError(result.error || 'Failed to update Yunxiao issue');
      return false;
    }
    store.updateIssue(workItemId, result.data);
    return true;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to update Yunxiao issue');
    return false;
  }
}
