import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  YunxiaoProject,
  YunxiaoWorkItem,
  YunxiaoImportResult,
  YunxiaoSyncStatus
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

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
  checkYunxiaoConnection: (projectId: string) => Promise<IPCResult<YunxiaoSyncStatus>>;
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

  checkYunxiaoConnection: (projectId: string): Promise<IPCResult<YunxiaoSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.YUNXIAO_CHECK_CONNECTION, projectId)
});

