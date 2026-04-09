import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, YunxiaoWorkItem } from '../../shared/types';
import { AUTO_BUILD_PATHS, getSpecsDir, IPC_CHANNELS } from '../../shared/constants';

const {
  mockProjectStore,
  mockSafeSendToRenderer,
  mockUpsertYunxiaoIssuesFromWorkItems,
  mockGetYunxiaoEnvConfig,
  mockBuildSpecId,
  mockBuildYunxiaoTaskMetadata
} = vi.hoisted(() => ({
  mockProjectStore: {
    getProject: vi.fn(),
    getTasks: vi.fn(),
    invalidateTasksCache: vi.fn(),
    getProjects: vi.fn()
  },
  mockSafeSendToRenderer: vi.fn(),
  mockUpsertYunxiaoIssuesFromWorkItems: vi.fn(),
  mockGetYunxiaoEnvConfig: vi.fn(),
  mockBuildSpecId: vi.fn(),
  mockBuildYunxiaoTaskMetadata: vi.fn()
}));

vi.mock('../project-store', () => ({
  projectStore: mockProjectStore
}));

vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: mockSafeSendToRenderer
}));

vi.mock('../integrations/yunxiao-issues-store', () => ({
  upsertYunxiaoIssuesFromWorkItems: mockUpsertYunxiaoIssuesFromWorkItems
}));

vi.mock('../ipc-handlers/yunxiao-handlers', () => ({
  callYunxiaoTool: vi.fn(),
  formatYunxiaoError: vi.fn((error: unknown) => String(error)),
  getNumber: vi.fn(),
  getYunxiaoEnvConfig: mockGetYunxiaoEnvConfig,
  normalizeProjects: vi.fn(),
  normalizeWorkItems: vi.fn(),
  resolveWorkitemCategories: vi.fn((raw?: string, fallback: string = 'Task') => {
    const input = raw?.trim();
    if (!input) return [fallback];
    return input.split(',').map((item) => item.trim()).filter(Boolean);
  }),
  resolveOrganization: vi.fn(),
  toRecord: vi.fn(),
  withYunxiaoClient: vi.fn()
}));

vi.mock('../ipc-handlers/shared/spec-id', () => ({
  buildSpecId: mockBuildSpecId
}));

vi.mock('../ipc-handlers/yunxiao/metadata', () => ({
  buildYunxiaoTaskMetadata: mockBuildYunxiaoTaskMetadata
}));

vi.mock('../ipc-handlers/yunxiao/description', () => ({
  formatYunxiaoDescriptionContent: vi.fn((value: string) => value)
}));

vi.mock('../ipc-handlers/shared/sanitize', () => ({
  sanitizeText: vi.fn((value: string) => value?.trim() || ''),
  sanitizeUrl: vi.fn((value: string) => value?.trim() || '')
}));

import { YunxiaoAutoSyncService } from '../integrations/yunxiao-auto-sync';

describe('YunxiaoAutoSyncService', () => {
  let tempDir: string;
  let project: Project;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'aperant-yunxiao-sync-'));
    project = {
      id: 'project-1',
      name: 'Test Project',
      path: tempDir,
      autoBuildPath: '.auto-claude',
      settings: {} as Project['settings'],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    mockProjectStore.getProject.mockReturnValue(project);
    mockProjectStore.getTasks.mockReturnValue([] satisfies Task[]);
    mockProjectStore.invalidateTasksCache.mockReset();
    mockProjectStore.getProjects.mockReturnValue([project]);

    mockSafeSendToRenderer.mockReset();
    mockUpsertYunxiaoIssuesFromWorkItems.mockReset();
    mockUpsertYunxiaoIssuesFromWorkItems.mockReturnValue({
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0
    });

    mockGetYunxiaoEnvConfig.mockReset();
    mockGetYunxiaoEnvConfig.mockReturnValue({
      accessToken: 'token',
      enabled: true,
      autoSync: true,
      organizationId: 'org-1',
      projectId: 'space-1',
      workitemCategory: 'Task',
      toolsets: 'organization-management,project-management,workitem-management',
      mcpCommand: 'npx.cmd',
      mcpArgs: ['-y', 'alibabacloud-devops-mcp-server']
    });

    mockBuildSpecId.mockReset();
    mockBuildSpecId.mockReturnValue('001-yunxiao-task');

    mockBuildYunxiaoTaskMetadata.mockReset();
    mockBuildYunxiaoTaskMetadata.mockImplementation(({ workItemId, identifier, url }) => ({
      sourceType: 'yunxiao',
      yunxiaoWorkItemId: workItemId,
      yunxiaoIdentifier: identifier,
      yunxiaoUrl: url
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates backlog tasks for synced Yunxiao task items and refreshes the board', async () => {
    const service = new YunxiaoAutoSyncService();
    const serviceInternals = service as unknown as {
      fetchOpenBugItems: () => Promise<YunxiaoWorkItem[]>;
      fetchOpenTaskItems: () => Promise<YunxiaoWorkItem[]>;
    };
    service.setMainWindowGetter(() => null);

    const openTaskItem = {
      id: 'workitem-1',
      identifier: 'TASK-1',
      subject: 'Sync this Yunxiao task',
      description: 'Task details from Yunxiao',
      url: 'https://example.com/workitems/1',
      priority: 'High',
      status: {
        name: 'Open',
        displayName: 'Open'
      },
      workitemType: {
        name: 'Task',
        categoryId: 'Task'
      }
    } as YunxiaoWorkItem;

    vi.spyOn(serviceInternals, 'fetchOpenBugItems').mockResolvedValue([]);
    vi.spyOn(serviceInternals, 'fetchOpenTaskItems').mockResolvedValue([openTaskItem]);

    const result = await service.syncProjectNow(project.id);

    expect(result).toMatchObject({
      created: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      taskCreated: 1
    });
    expect(mockProjectStore.invalidateTasksCache).toHaveBeenCalledWith(project.id);
    expect(mockSafeSendToRenderer).toHaveBeenCalledWith(
      expect.any(Function),
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      '__tasks_refresh__',
      'backlog',
      project.id
    );

    const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
    const specDir = path.join(specsDir, '001-yunxiao-task');
    expect(existsSync(path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))).toBe(true);
    expect(existsSync(path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS))).toBe(true);

    const metadata = JSON.parse(readFileSync(path.join(specDir, 'task_metadata.json'), 'utf-8'));
    expect(metadata).toMatchObject({
      sourceType: 'yunxiao',
      yunxiaoWorkItemId: 'workitem-1',
      yunxiaoIdentifier: 'TASK-1',
      yunxiaoUrl: 'https://example.com/workitems/1'
    });
  });
});
