import type { BrowserWindow } from 'electron';
import { AUTOCODE_PROJECT_DATA_DIR_NAME, createImportedAutocodeTask } from '@autocode/core';
import {
  buildAutocodeYunxiaoTaskDescription,
  isAutocodeClosedOrResolvedYunxiaoWorkItem,
} from '@autocode/core/integrations/yunxiao';
import type { Project, YunxiaoIssueSyncResult, YunxiaoWorkItem } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants';
import { projectStore } from '../project-store';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { upsertYunxiaoIssuesFromWorkItems } from './yunxiao-issues-store';
import {
  callYunxiaoTool,
  formatYunxiaoError,
  getNumber,
  getYunxiaoEnvConfig,
  normalizeProjects,
  normalizeWorkItems,
  resolveOrganization,
  resolveWorkitemCategories,
  toRecord,
  withYunxiaoClient
} from '../ipc-handlers/yunxiao-handlers';
import { buildYunxiaoTaskMetadata } from '../ipc-handlers/yunxiao/metadata';
import { sanitizeText, sanitizeUrl } from '../ipc-handlers/shared/sanitize';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WORKITEM_PAGES = 30;
const WORKITEMS_PER_PAGE = 200;
const TASK_REFRESH_SENTINEL = '__tasks_refresh__';

interface ProjectSyncResult extends YunxiaoIssueSyncResult {
  taskCreated: number;
}

function getTrackedYunxiaoTaskIds(project: Project): Set<string> {
  const tracked = new Set<string>();

  for (const task of projectStore.getTasks(project.id)) {
    const singleId = task.metadata?.yunxiaoWorkItemId;
    if (singleId) tracked.add(singleId);

    for (const workItemId of task.metadata?.yunxiaoWorkItemIds ?? []) {
      tracked.add(workItemId);
    }
  }

  return tracked;
}

function createBacklogTaskFromYunxiaoItem(project: Project, item: YunxiaoWorkItem): string {
  if (!project.autoBuildPath) {
    throw new Error('Project not initialized');
  }
  if (!item.id) {
    throw new Error('Missing Yunxiao work item id');
  }

  const safeTitle = sanitizeText(item.subject || `Yunxiao ${item.id}`, 500);
  const safeIdentifier = sanitizeText(item.identifier || item.id, 120);
  const safeUrl = sanitizeUrl(item.url || '');
  const description = buildAutocodeYunxiaoTaskDescription(item);

  const metadata = buildYunxiaoTaskMetadata({
    workItemId: sanitizeText(item.id, 120),
    identifier: safeIdentifier,
    url: safeUrl || undefined,
    workitemTypeName: item.workitemType?.name,
    workitemCategoryId: item.workitemType?.categoryId || item.categoryId,
    workitemCategoryName: item.workitemType?.name
  });

  const task = createImportedAutocodeTask({
    projectRoot: project.path,
    dataDirName: project.autoBuildPath || AUTOCODE_PROJECT_DATA_DIR_NAME,
    title: safeTitle,
    description,
    fallbackSlug: 'yunxiao',
    metadata,
    requirements: {
      workflow_type: 'feature',
    },
  });

  return task.specId;
}

export class YunxiaoAutoSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly syncingProjects = new Set<string>();
  private readonly intervalMs: number;
  private getMainWindow: (() => BrowserWindow | null) | null = null;

  constructor(intervalMs = DEFAULT_SYNC_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  setMainWindowGetter(getMainWindow: () => BrowserWindow | null): void {
    this.getMainWindow = getMainWindow;
  }

  start(): void {
    if (this.timer) return;

    void this.runSyncCycle('startup');
    this.timer = setInterval(() => {
      void this.runSyncCycle('interval');
    }, this.intervalMs);
    console.warn(`[YunxiaoAutoSync] started (interval=${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.warn('[YunxiaoAutoSync] stopped');
  }

  async syncProjectNow(projectId: string): Promise<ProjectSyncResult | null> {
    const project = projectStore.getProject(projectId);
    if (!project) return null;
    return this.syncProject(project, { force: true, trigger: 'manual' });
  }

  private async runSyncCycle(trigger: 'startup' | 'interval'): Promise<void> {
    if (this.running) {
      console.warn(`[YunxiaoAutoSync] skip ${trigger} cycle (previous cycle still running)`);
      return;
    }
    this.running = true;

    try {
      const projects = projectStore.getProjects();
      for (const project of projects) {
        await this.syncProject(project, { trigger });
      }
    } catch (error) {
      console.warn('[YunxiaoAutoSync] cycle failed:', error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async syncProject(
    project: Project,
    options: { force?: boolean; trigger: 'startup' | 'interval' | 'manual' }
  ): Promise<ProjectSyncResult | null> {
    if (this.syncingProjects.has(project.id)) return null;
    if (!project.autoBuildPath) return null;

    const config = getYunxiaoEnvConfig(project);
    if (!config?.accessToken) return null;
    if (!config.enabled) return null;
    if (!options.force && !config.autoSync) return null;

    this.syncingProjects.add(project.id);
    try {
      const bugItems = await this.fetchOpenBugItems(config);
      const issueResult = upsertYunxiaoIssuesFromWorkItems(project, bugItems);

      const trackedTaskIds = getTrackedYunxiaoTaskIds(project);
      const openTaskItems = await this.fetchOpenTaskItems(config);
      let taskCreated = 0;

      for (const item of openTaskItems) {
        if (!item.id || trackedTaskIds.has(item.id)) {
          continue;
        }

        createBacklogTaskFromYunxiaoItem(project, item);
        trackedTaskIds.add(item.id);
        taskCreated += 1;
      }

      if (taskCreated > 0) {
        projectStore.invalidateTasksCache(project.id);
        if (this.getMainWindow) {
          safeSendToRenderer(
            this.getMainWindow,
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            TASK_REFRESH_SENTINEL,
            'backlog',
            project.id
          );
        }
      }

      if (issueResult.created > 0 || issueResult.updated > 0 || issueResult.removed > 0 || options.trigger === 'manual') {
        if (this.getMainWindow) {
          safeSendToRenderer(
            this.getMainWindow,
            IPC_CHANNELS.YUNXIAO_ISSUES_UPDATED,
            project.id
          );
        }
      }
      if (issueResult.created > 0 || issueResult.updated > 0 || issueResult.removed > 0 || taskCreated > 0) {
        console.warn(
          `[YunxiaoAutoSync] trigger=${options.trigger} project=${project.id} issuesCreated=${issueResult.created} issuesUpdated=${issueResult.updated} issuesRemoved=${issueResult.removed} issuesSkipped=${issueResult.skipped} tasksCreated=${taskCreated}`
        );
      }
      return {
        ...issueResult,
        taskCreated
      };
    } catch (error) {
      console.warn(
        `[YunxiaoAutoSync] project=${project.id} sync failed: ${formatYunxiaoError(error, 'workitems')}`
      );
      return null;
    } finally {
      this.syncingProjects.delete(project.id);
    }
  }

  private async fetchOpenBugItems(
    config: NonNullable<ReturnType<typeof getYunxiaoEnvConfig>>
  ): Promise<YunxiaoWorkItem[]> {
    return withYunxiaoClient(config, async (client) => {
      const org = await resolveOrganization(client, config);
      let spaceId = config.projectId;
      if (!spaceId) {
        const projectsRaw = await callYunxiaoTool<unknown>(client, 'search_projects', {
          organizationId: org.organizationId,
          page: 1,
          perPage: 20,
          orderBy: 'gmtCreate',
          sort: 'desc'
        });
        const projects = normalizeProjects(projectsRaw);
        spaceId = projects[0]?.id;
        if (!spaceId) {
          return [];
        }
      }

      const merged = new Map<string, YunxiaoWorkItem>();
      let page = 1;
      while (page <= MAX_WORKITEM_PAGES) {
        const raw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
          organizationId: org.organizationId,
          category: 'Bug',
          spaceId,
          page,
          perPage: WORKITEMS_PER_PAGE,
          sort: 'desc',
          orderBy: 'gmtModified',
          includeDetails: true
        });
        const items = normalizeWorkItems(raw);
        if (items.length === 0) {
          break;
        }

        for (const item of items) {
          if (!item.id || isAutocodeClosedOrResolvedYunxiaoWorkItem(item)) continue;
          if (!merged.has(item.id)) {
            merged.set(item.id, item);
          }
        }

        const pagination = toRecord(toRecord(raw)?.['pagination']);
        const total = getNumber(pagination, 'total');
        if (total !== undefined && page * WORKITEMS_PER_PAGE >= total) {
          break;
        }
        if (items.length < WORKITEMS_PER_PAGE) {
          break;
        }
        page += 1;
      }

      return Array.from(merged.values()).sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
    });
  }

  private async fetchOpenTaskItems(
    config: NonNullable<ReturnType<typeof getYunxiaoEnvConfig>>
  ): Promise<YunxiaoWorkItem[]> {
    return withYunxiaoClient(config, async (client) => {
      const org = await resolveOrganization(client, config);
      let spaceId = config.projectId;
      if (!spaceId) {
        const projectsRaw = await callYunxiaoTool<unknown>(client, 'search_projects', {
          organizationId: org.organizationId,
          page: 1,
          perPage: 20,
          orderBy: 'gmtCreate',
          sort: 'desc'
        });
        const projects = normalizeProjects(projectsRaw);
        spaceId = projects[0]?.id;
        if (!spaceId) {
          return [];
        }
      }

      const categories = Array.from(new Set([
        ...resolveWorkitemCategories(config.workitemCategory, 'Task'),
        'Task',
        'Req'
      ])).filter((category) => category !== 'Bug');
      if (categories.length === 0) {
        return [];
      }

      const merged = new Map<string, YunxiaoWorkItem>();
      for (const category of categories) {
        let page = 1;
        while (page <= MAX_WORKITEM_PAGES) {
          const raw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
            organizationId: org.organizationId,
            category,
            spaceId,
            page,
            perPage: WORKITEMS_PER_PAGE,
            sort: 'desc',
            orderBy: 'gmtModified',
            includeDetails: true
          });
          const items = normalizeWorkItems(raw);
          if (items.length === 0) {
            break;
          }

          for (const item of items) {
            if (!item.id || isAutocodeClosedOrResolvedYunxiaoWorkItem(item)) continue;
            if (!merged.has(item.id)) {
              merged.set(item.id, item);
            }
          }

          const pagination = toRecord(toRecord(raw)?.['pagination']);
          const total = getNumber(pagination, 'total');
          if (total !== undefined && page * WORKITEMS_PER_PAGE >= total) {
            break;
          }
          if (items.length < WORKITEMS_PER_PAGE) {
            break;
          }
          page += 1;
        }
      }

      return Array.from(merged.values()).sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
    });
  }
}

let yunxiaoAutoSyncService: YunxiaoAutoSyncService | null = null;

export function getYunxiaoAutoSyncService(): YunxiaoAutoSyncService {
  if (!yunxiaoAutoSyncService) {
    yunxiaoAutoSyncService = new YunxiaoAutoSyncService();
  }
  return yunxiaoAutoSyncService;
}
