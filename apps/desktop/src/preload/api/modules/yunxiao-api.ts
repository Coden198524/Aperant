import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  YunxiaoProject,
  YunxiaoWorkItem,
  YunxiaoIssue,
  YunxiaoAutoFixConfig,
  YunxiaoAutoFixQueueItem,
  YunxiaoAnalyzePreviewProgress,
  YunxiaoAnalyzePreviewResult,
  YunxiaoProposedBatch,
  YunxiaoImportResult,
  YunxiaoIssueSyncResult,
  YunxiaoSyncStatus
} from '../../../shared/types';
import { createIpcListener, invokeIpc, sendIpc, type IpcListenerCleanup } from './ipc-utils';

/**
 * Yunxiao Integration API operations
 */
export interface YunxiaoAPI {
  getYunxiaoProjects: (projectId: string, organizationId?: string) => Promise<IPCResult<YunxiaoProject[]>>;
  getYunxiaoWorkItems: (
    projectId: string,
    organizationId?: string,
    spaceId?: string,
    category?: string
  ) => Promise<IPCResult<YunxiaoWorkItem[]>>;
  importYunxiaoWorkItems: (
    projectId: string,
    workItemIds: string[],
    options?: { organizationId?: string; spaceId?: string; category?: string }
  ) => Promise<IPCResult<YunxiaoImportResult>>;
  getYunxiaoIssues: (projectId: string) => Promise<IPCResult<YunxiaoIssue[]>>;
  syncYunxiaoIssues: (projectId: string) => Promise<IPCResult<YunxiaoIssueSyncResult>>;
  updateYunxiaoIssue: (
    projectId: string,
    workItemId: string,
    updates: {
      localCategory?: string;
      localSeverity?: 'low' | 'medium' | 'high' | 'critical';
      localTags?: string[];
      localAnalysis?: string;
    }
  ) => Promise<IPCResult<YunxiaoIssue>>;
  analyzeYunxiaoIssue: (projectId: string, workItemId: string) => Promise<IPCResult<string>>;
  checkYunxiaoConnection: (projectId: string) => Promise<IPCResult<YunxiaoSyncStatus>>;
  loadYunxiaoImage: (projectId: string, imageUrl: string, workItemId?: string) => Promise<IPCResult<string>>;
  getYunxiaoAutoFixConfig: (projectId: string) => Promise<YunxiaoAutoFixConfig | null>;
  saveYunxiaoAutoFixConfig: (projectId: string, config: YunxiaoAutoFixConfig) => Promise<boolean>;
  getYunxiaoAutoFixQueue: (projectId: string) => Promise<YunxiaoAutoFixQueueItem[]>;
  checkNewYunxiaoIssues: (projectId: string) => Promise<Array<{ workItemId: string }>>;
  startYunxiaoAutoFix: (projectId: string, workItemId: string) => void;
  analyzeYunxiaoIssuesPreview: (projectId: string, workItemIds?: string[], maxIssues?: number) => void;
  approveYunxiaoIssueBatches: (
    projectId: string,
    approvedBatches: YunxiaoProposedBatch[]
  ) => Promise<{ success: boolean; error?: string }>;
  onYunxiaoAutoFixProgress: (
    callback: (projectId: string, progress: {
      workItemId: string;
      progress: number;
      message: string;
      phase: 'fetching' | 'creating_spec' | 'complete';
    }) => void
  ) => IpcListenerCleanup;
  onYunxiaoAutoFixComplete: (
    callback: (projectId: string, result: YunxiaoAutoFixQueueItem) => void
  ) => IpcListenerCleanup;
  onYunxiaoAutoFixError: (
    callback: (projectId: string, error: { workItemId?: string; error: string }) => void
  ) => IpcListenerCleanup;
  onYunxiaoAnalyzePreviewProgress: (
    callback: (projectId: string, progress: YunxiaoAnalyzePreviewProgress) => void
  ) => IpcListenerCleanup;
  onYunxiaoAnalyzePreviewComplete: (
    callback: (projectId: string, result: YunxiaoAnalyzePreviewResult) => void
  ) => IpcListenerCleanup;
  onYunxiaoAnalyzePreviewError: (
    callback: (projectId: string, error: { error: string }) => void
  ) => IpcListenerCleanup;
}

/**
 * Creates the Yunxiao Integration API implementation
 */
export const createYunxiaoAPI = (): YunxiaoAPI => ({
  getYunxiaoProjects: (projectId: string, organizationId?: string): Promise<IPCResult<YunxiaoProject[]>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_GET_PROJECTS, projectId, organizationId),

  getYunxiaoWorkItems: (
    projectId: string,
    organizationId?: string,
    spaceId?: string,
    category?: string
  ): Promise<IPCResult<YunxiaoWorkItem[]>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_GET_WORK_ITEMS, projectId, organizationId, spaceId, category),

  importYunxiaoWorkItems: (
    projectId: string,
    workItemIds: string[],
    options?: { organizationId?: string; spaceId?: string; category?: string }
  ): Promise<IPCResult<YunxiaoImportResult>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_IMPORT_WORK_ITEMS, projectId, workItemIds, options),

  getYunxiaoIssues: (projectId: string): Promise<IPCResult<YunxiaoIssue[]>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_GET_ISSUES, projectId),

  syncYunxiaoIssues: (projectId: string): Promise<IPCResult<YunxiaoIssueSyncResult>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_SYNC_ISSUES, projectId),

  updateYunxiaoIssue: (
    projectId: string,
    workItemId: string,
    updates: {
      localCategory?: string;
      localSeverity?: 'low' | 'medium' | 'high' | 'critical';
      localTags?: string[];
      localAnalysis?: string;
    }
  ): Promise<IPCResult<YunxiaoIssue>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_UPDATE_ISSUE, projectId, workItemId, updates),

  analyzeYunxiaoIssue: (projectId: string, workItemId: string): Promise<IPCResult<string>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_ANALYZE_ISSUE, projectId, workItemId),

  checkYunxiaoConnection: (projectId: string): Promise<IPCResult<YunxiaoSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_CHECK_CONNECTION, projectId),

  loadYunxiaoImage: (projectId: string, imageUrl: string, workItemId?: string): Promise<IPCResult<string>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_LOAD_IMAGE, projectId, imageUrl, workItemId),

  getYunxiaoAutoFixConfig: (projectId: string): Promise<YunxiaoAutoFixConfig | null> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_GET_CONFIG, projectId),

  saveYunxiaoAutoFixConfig: (projectId: string, config: YunxiaoAutoFixConfig): Promise<boolean> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_SAVE_CONFIG, projectId, config),

  getYunxiaoAutoFixQueue: (projectId: string): Promise<YunxiaoAutoFixQueueItem[]> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_GET_QUEUE, projectId),

  checkNewYunxiaoIssues: (projectId: string): Promise<Array<{ workItemId: string }>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_CHECK_NEW, projectId),

  startYunxiaoAutoFix: (projectId: string, workItemId: string): void =>
    sendIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_START, projectId, workItemId),

  analyzeYunxiaoIssuesPreview: (projectId: string, workItemIds?: string[], maxIssues?: number): void =>
    sendIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW, projectId, workItemIds, maxIssues),

  approveYunxiaoIssueBatches: (
    projectId: string,
    approvedBatches: YunxiaoProposedBatch[]
  ): Promise<{ success: boolean; error?: string }> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_AUTOFIX_APPROVE_BATCHES, projectId, approvedBatches),

  onYunxiaoAutoFixProgress: (
    callback: (projectId: string, progress: {
      workItemId: string;
      progress: number;
      message: string;
      phase: 'fetching' | 'creating_spec' | 'complete';
    }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_PROGRESS, callback),

  onYunxiaoAutoFixComplete: (
    callback: (projectId: string, result: YunxiaoAutoFixQueueItem) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_COMPLETE, callback),

  onYunxiaoAutoFixError: (
    callback: (projectId: string, error: { workItemId?: string; error: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_ERROR, callback),

  onYunxiaoAnalyzePreviewProgress: (
    callback: (projectId: string, progress: YunxiaoAnalyzePreviewProgress) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_PROGRESS, callback),

  onYunxiaoAnalyzePreviewComplete: (
    callback: (projectId: string, result: YunxiaoAnalyzePreviewResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_COMPLETE, callback),

  onYunxiaoAnalyzePreviewError: (
    callback: (projectId: string, error: { error: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_ERROR, callback)
});
