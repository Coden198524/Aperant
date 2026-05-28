import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { AUTOCODE_PROJECT_DATA_DIR_NAME, createImportedAutocodeTask } from '@autocode/core';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  Project,
  YunxiaoAutoFixConfig,
  YunxiaoAutoFixQueueItem,
  YunxiaoAnalyzePreviewProgress,
  YunxiaoAnalyzePreviewResult,
  YunxiaoIssue,
  YunxiaoProposedBatch,
  YunxiaoWorkItem,
} from '../../shared/types';
import type { ModelShorthand, ThinkingLevel } from '@autocode/core';
import { getAutocodeYunxiaoDir } from '@autocode/core/project/data-paths';
import type { GitHubIssue } from '../ai/runners/github/duplicate-detector';
import { BatchProcessor } from '../ai/runners/github/batch-processor';
import { AgentManager } from '../agent';
import { projectStore } from '../project-store';
import { listYunxiaoIssues } from '../integrations/yunxiao-issues-store';
import { isClosedYunxiaoStatus } from '../../shared/utils/yunxiao-status';
import { getActiveProviderFeatureSettings } from './feature-settings-helper';
import { sanitizeText, sanitizeUrl } from './shared/sanitize';
import { buildYunxiaoTaskMetadata } from './yunxiao/metadata';
import { formatYunxiaoDescriptionContent } from './yunxiao/description';
import {
  callYunxiaoTool,
  getYunxiaoEnvConfig,
  normalizeErrorText,
  normalizeWorkItems,
  resolveOrganization,
  withYunxiaoClient,
} from './yunxiao-handlers';
import { createIPCCommunicators } from './github/utils/ipc-communicator';

interface YunxiaoAutoFixProgress {
  phase: 'fetching' | 'creating_spec' | 'complete';
  workItemId: string;
  progress: number;
  message: string;
}

interface PersistedYunxiaoBatch {
  batch_id: string;
  primary_work_item_id: string;
  theme: string;
  reasoning: string;
  confidence: number;
  validated: boolean;
  issue_count: number;
  common_themes: string[];
  issues: Array<{
    work_item_id: string;
    identifier?: string;
    title: string;
    labels: string[];
    similarity_to_primary: number;
  }>;
  created_at: string;
  updated_at: string;
}

const projectAutoFixChains = new Map<string, Promise<void>>();

function getYunxiaoDir(project: Project): string {
  return getAutocodeYunxiaoDir(project.path, project.autoBuildPath);
}

function getQueueDir(project: Project): string {
  return path.join(getYunxiaoDir(project), 'issues');
}

function getBatchesDir(project: Project): string {
  return path.join(getYunxiaoDir(project), 'batches');
}

function toSafeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getDefaultAutoFixConfig(): YunxiaoAutoFixConfig {
  const { model, thinkingLevel } = getActiveProviderFeatureSettings('utility');
  return {
    enabled: false,
    requireHumanApproval: true,
    model: model || 'gpt-5.4',
    thinkingLevel: thinkingLevel || 'medium',
  };
}

function getAutoFixConfig(project: Project): YunxiaoAutoFixConfig {
  const defaults = getDefaultAutoFixConfig();
  const configPath = path.join(getYunxiaoDir(project), 'config.json');

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    return {
      enabled: parsed.auto_fix_enabled === true,
      requireHumanApproval: parsed.require_human_approval !== false,
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : defaults.model,
      thinkingLevel: typeof parsed.thinking_level === 'string' && parsed.thinking_level.trim()
        ? parsed.thinking_level
        : defaults.thinkingLevel,
    };
  } catch {
    return defaults;
  }
}

function saveAutoFixConfig(project: Project, config: YunxiaoAutoFixConfig): void {
  const yunxiaoDir = getYunxiaoDir(project);
  fs.mkdirSync(yunxiaoDir, { recursive: true });
  fs.writeFileSync(
    path.join(yunxiaoDir, 'config.json'),
    JSON.stringify({
      auto_fix_enabled: config.enabled,
      require_human_approval: config.requireHumanApproval,
      model: config.model,
      thinking_level: config.thinkingLevel,
    }, null, 2),
    'utf-8'
  );
}

function getAutoFixQueue(project: Project): YunxiaoAutoFixQueueItem[] {
  const queueDir = getQueueDir(project);

  try {
    return fs.readdirSync(queueDir)
      .filter((file) => file.startsWith('autofix_') && file.endsWith('.json'))
      .flatMap((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(queueDir, file), 'utf-8')) as Record<string, unknown>;
          return [{
            workItemId: String(data.work_item_id || ''),
            identifier: typeof data.identifier === 'string' ? data.identifier : undefined,
            title: String(data.title || ''),
            status: (data.status as YunxiaoAutoFixQueueItem['status']) || 'pending',
            specId: typeof data.spec_id === 'string' ? data.spec_id : undefined,
            error: typeof data.error === 'string' ? data.error : undefined,
            createdAt: String(data.created_at || new Date(0).toISOString()),
            updatedAt: String(data.updated_at || new Date(0).toISOString()),
          }];
        } catch {
          return [];
        }
      })
      .filter((item) => item.workItemId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}

function getQueueItem(project: Project, workItemId: string): YunxiaoAutoFixQueueItem | null {
  return getAutoFixQueue(project).find((item) => item.workItemId === workItemId) || null;
}

function saveQueueItem(project: Project, item: YunxiaoAutoFixQueueItem): YunxiaoAutoFixQueueItem {
  const queueDir = getQueueDir(project);
  fs.mkdirSync(queueDir, { recursive: true });

  const existing = getQueueItem(project, item.workItemId);
  const now = new Date().toISOString();
  const next: YunxiaoAutoFixQueueItem = {
    ...existing,
    ...item,
    createdAt: item.createdAt || existing?.createdAt || now,
    updatedAt: now,
  };

  fs.writeFileSync(
    path.join(queueDir, `autofix_${toSafeFileToken(item.workItemId)}.json`),
    JSON.stringify({
      work_item_id: next.workItemId,
      identifier: next.identifier,
      title: next.title,
      status: next.status,
      spec_id: next.specId,
      error: next.error,
      created_at: next.createdAt,
      updated_at: next.updatedAt,
    }, null, 2),
    'utf-8'
  );

  return next;
}

function getSavedBatches(project: Project): YunxiaoProposedBatch[] {
  const batchesDir = getBatchesDir(project);

  try {
    return fs.readdirSync(batchesDir)
      .filter((file) => file.startsWith('batch_') && file.endsWith('.json'))
      .flatMap((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(batchesDir, file), 'utf-8')) as PersistedYunxiaoBatch;
          return [{
            batchId: data.batch_id,
            primaryWorkItemId: data.primary_work_item_id,
            theme: data.theme,
            reasoning: data.reasoning,
            confidence: data.confidence,
            validated: data.validated,
            issueCount: data.issue_count,
            commonThemes: data.common_themes ?? [],
            issues: (data.issues ?? []).map((issue) => ({
              workItemId: issue.work_item_id,
              identifier: issue.identifier,
              title: issue.title,
              labels: issue.labels ?? [],
              similarityToPrimary: issue.similarity_to_primary,
            })),
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function saveApprovedBatches(project: Project, approvedBatches: YunxiaoProposedBatch[]): void {
  const batchesDir = getBatchesDir(project);
  fs.mkdirSync(batchesDir, { recursive: true });

  for (const batch of approvedBatches) {
    const batchId = batch.batchId || `batch-${Date.now()}-${toSafeFileToken(batch.primaryWorkItemId)}`;
    const now = new Date().toISOString();
    const payload: PersistedYunxiaoBatch = {
      batch_id: batchId,
      primary_work_item_id: batch.primaryWorkItemId,
      theme: batch.theme,
      reasoning: batch.reasoning,
      confidence: batch.confidence,
      validated: batch.validated,
      issue_count: batch.issueCount,
      common_themes: batch.commonThemes,
      issues: batch.issues.map((issue) => ({
        work_item_id: issue.workItemId,
        identifier: issue.identifier,
        title: issue.title,
        labels: issue.labels,
        similarity_to_primary: issue.similarityToPrimary,
      })),
      created_at: now,
      updated_at: now,
    };

    fs.writeFileSync(
      path.join(batchesDir, `batch_${toSafeFileToken(batchId)}.json`),
      JSON.stringify(payload, null, 2),
      'utf-8'
    );
  }
}

function getTrackedWorkItemIds(project: Project): Set<string> {
  const tracked = new Set<string>();

  for (const item of getAutoFixQueue(project)) {
    tracked.add(item.workItemId);
  }

  for (const batch of getSavedBatches(project)) {
    for (const issue of batch.issues) {
      tracked.add(issue.workItemId);
    }
  }

  for (const task of projectStore.getTasks(project.id)) {
    const singleId = task.metadata?.yunxiaoWorkItemId;
    if (singleId) tracked.add(singleId);
    for (const workItemId of task.metadata?.yunxiaoWorkItemIds ?? []) {
      tracked.add(workItemId);
    }
  }

  return tracked;
}

function getOpenIssues(project: Project): YunxiaoIssue[] {
  return listYunxiaoIssues(project).filter((issue) => !isClosedYunxiaoStatus(issue.statusName));
}

function getAnalyzeSettings(): { model: ModelShorthand; thinkingLevel: ThinkingLevel } {
  const { model, thinkingLevel } = getActiveProviderFeatureSettings('utility');
  return {
    model: (model || 'gpt-5.4') as ModelShorthand,
    thinkingLevel: (thinkingLevel || 'medium') as ThinkingLevel,
  };
}

function getIssueLabels(issue: YunxiaoIssue): string[] {
  return [
    issue.localCategory,
    issue.localSeverity,
    issue.priority,
    issue.statusName,
    issue.spaceName,
    ...(issue.localTags ?? []),
  ]
    .map((value) => sanitizeText(value || '', 80))
    .filter(Boolean);
}

function toBatchProcessorIssue(issue: YunxiaoIssue, ordinal: number): GitHubIssue {
  return {
    number: ordinal,
    title: issue.title,
    body: sanitizeText(issue.description || '', 2000, true) || undefined,
    labels: getIssueLabels(issue).map((name) => ({ name })),
    state: issue.statusName,
  };
}

async function fetchWorkItemDetail(project: Project, workItemId: string): Promise<YunxiaoWorkItem> {
  const config = getYunxiaoEnvConfig(project);
  if (!config) {
    throw new Error('No Yunxiao access token configured');
  }

  const safeWorkItemId = sanitizeText(workItemId, 120);
  if (!safeWorkItemId) {
    throw new Error('Missing Yunxiao work item id');
  }

  return withYunxiaoClient(config, async (client) => {
    const org = await resolveOrganization(client, config);
    const raw = await callYunxiaoTool<unknown>(client, 'get_work_item', {
      organizationId: org.organizationId,
      workItemId: safeWorkItemId,
    });
    const item = normalizeWorkItems([raw])[0];
    if (!item?.id) {
      throw new Error('Yunxiao work item not found');
    }
    return item;
  });
}

function buildTaskDescription(item: YunxiaoWorkItem): string {
  const safeTitle = sanitizeText(item.subject || `Yunxiao ${item.id}`, 500);
  const safeIdentifier = sanitizeText(item.identifier || item.id || '', 120);
  const formattedDescription = formatYunxiaoDescriptionContent(item.description || '');
  const safeStatus = sanitizeText(item.status?.displayName || item.status?.name || '', 120);
  const safePriority = sanitizeText(item.priority || '', 120);
  const safeUrl = sanitizeUrl(item.url || '');

  return `# ${safeTitle}

**Yunxiao Work Item:** ${safeIdentifier}
${safeUrl ? `**Link:** ${safeUrl}` : ''}
${safePriority ? `**Priority:** ${safePriority}` : ''}
${safeStatus ? `**Status:** ${safeStatus}` : ''}

## Description

${formattedDescription}
`;
}

async function createAndStartSpecForWorkItem(
  project: Project,
  agentManager: AgentManager,
  item: YunxiaoWorkItem
): Promise<YunxiaoAutoFixQueueItem> {
  if (!project.autoBuildPath) {
    throw new Error('Project not initialized');
  }

  if (!item.id) {
    throw new Error('Missing Yunxiao work item id');
  }

  const safeTitle = sanitizeText(item.subject || `Yunxiao ${item.id}`, 500);
  const safeIdentifier = sanitizeText(item.identifier || item.id, 120);
  const safeUrl = sanitizeUrl(item.url || '');
  const description = buildTaskDescription(item);

  const metadata = buildYunxiaoTaskMetadata({
    workItemId: sanitizeText(item.id, 120),
    identifier: safeIdentifier,
    url: safeUrl || undefined,
    workitemTypeName: item.workitemType?.name,
    workitemCategoryId: item.workitemType?.categoryId || item.categoryId,
    workitemCategoryName: item.workitemType?.name,
  });

  const now = new Date().toISOString();
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
    now,
  });

  agentManager.startSpecCreation(task.specId, project.path, description, task.specsPath, metadata);

  return {
    workItemId: sanitizeText(item.id, 120),
    identifier: safeIdentifier || undefined,
    title: safeTitle,
    status: 'completed',
    specId: task.specId,
    createdAt: now,
    updatedAt: now,
  };
}

async function enqueueProjectAutoFix<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = projectAutoFixChains.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  projectAutoFixChains.set(projectId, chain);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (projectAutoFixChains.get(projectId) === chain) {
      projectAutoFixChains.delete(projectId);
    }
  }
}

async function startAutoFix(
  project: Project,
  workItemId: string,
  mainWindow: BrowserWindow,
  agentManager: AgentManager
): Promise<YunxiaoAutoFixQueueItem> {
  const { sendProgress, sendComplete, sendError } = createIPCCommunicators<YunxiaoAutoFixProgress, YunxiaoAutoFixQueueItem>(
    mainWindow,
    {
      progress: IPC_CHANNELS.YUNXIAO_AUTOFIX_PROGRESS,
      error: IPC_CHANNELS.YUNXIAO_AUTOFIX_ERROR,
      complete: IPC_CHANNELS.YUNXIAO_AUTOFIX_COMPLETE,
    },
    project.id
  );

  const safeWorkItemId = sanitizeText(workItemId, 120);
  if (!safeWorkItemId) {
    throw new Error('Missing Yunxiao work item id');
  }

  return enqueueProjectAutoFix(project.id, async () => {
    const existing = getQueueItem(project, safeWorkItemId);
    if (existing && existing.status !== 'failed') {
      sendComplete(existing);
      return existing;
    }

    const tracked = getTrackedWorkItemIds(project);
    if (tracked.has(safeWorkItemId) && !existing) {
      const linkedIssue = getOpenIssues(project).find((issue) => issue.workItemId === safeWorkItemId);
      const alreadyTracked: YunxiaoAutoFixQueueItem = {
        workItemId: safeWorkItemId,
        identifier: linkedIssue?.identifier,
        title: linkedIssue?.title || safeWorkItemId,
        status: 'failed',
        error: 'Yunxiao issue is already tracked by an existing task or batch',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const saved = saveQueueItem(project, alreadyTracked);
      sendError({ workItemId: safeWorkItemId, error: saved.error || 'Yunxiao issue is already tracked' });
      return saved;
    }

    const localIssue = getOpenIssues(project).find((issue) => issue.workItemId === safeWorkItemId);
    const pending = saveQueueItem(project, {
      workItemId: safeWorkItemId,
      identifier: localIssue?.identifier,
      title: localIssue?.title || safeWorkItemId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    try {
      sendProgress({
        phase: 'fetching',
        workItemId: safeWorkItemId,
        progress: 20,
        message: `Fetching Yunxiao issue ${localIssue?.identifier || safeWorkItemId}...`,
      });

      const detail = await fetchWorkItemDetail(project, safeWorkItemId);

      saveQueueItem(project, {
        ...pending,
        identifier: sanitizeText(detail.identifier || pending.identifier || safeWorkItemId, 120) || undefined,
        title: sanitizeText(detail.subject || pending.title || safeWorkItemId, 500),
        status: 'creating_spec',
      });

      sendProgress({
        phase: 'creating_spec',
        workItemId: safeWorkItemId,
        progress: 70,
        message: 'Creating spec and starting issue workflow...',
      });

      const completed = saveQueueItem(project, await createAndStartSpecForWorkItem(project, agentManager, detail));

      sendProgress({
        phase: 'complete',
        workItemId: safeWorkItemId,
        progress: 100,
        message: 'Yunxiao auto-fix task created',
      });
      sendComplete(completed);
      return completed;
    } catch (error) {
      const failed = saveQueueItem(project, {
        ...pending,
        status: 'failed',
        error: normalizeErrorText(error),
      });
      sendError({ workItemId: safeWorkItemId, error: failed.error || 'Failed to start Yunxiao auto-fix' });
      return failed;
    }
  });
}

function buildAnalyzeResult(
  issues: YunxiaoIssue[],
  trackedIds: Set<string>,
  suggestions: Awaited<ReturnType<BatchProcessor['groupIssues']>>
): YunxiaoAnalyzePreviewResult {
  const untrackedIssues = issues.filter((issue) => !trackedIds.has(issue.workItemId));
  const issueMap = new Map(untrackedIssues.map((issue) => [issue.workItemId, issue]));
  const syntheticMap = new Map<number, YunxiaoIssue>();

  untrackedIssues.forEach((issue, index) => {
    syntheticMap.set(index + 1, issue);
  });

  const batchSuggestions = suggestions.filter((entry) => entry.issueNumbers.length > 1);
  const singleSuggestions = suggestions.filter((entry) => entry.issueNumbers.length === 1);

  return {
    success: true,
    totalIssues: issues.length,
    analyzedIssues: untrackedIssues.length,
    alreadyTracked: issues.length - untrackedIssues.length,
    proposedBatches: batchSuggestions.map((entry) => {
      const primary = syntheticMap.get(entry.issueNumbers[0] || 0);
      const resolvedIssues = entry.issueNumbers
        .map((number) => syntheticMap.get(number))
        .filter((issue): issue is YunxiaoIssue => Boolean(issue))
        .map((issue) => ({
          workItemId: issue.workItemId,
          identifier: issue.identifier,
          title: issue.title,
          labels: getIssueLabels(issue),
          similarityToPrimary: entry.confidence,
        }));

      return {
        primaryWorkItemId: primary?.workItemId || resolvedIssues[0]?.workItemId || '',
        theme: entry.theme,
        reasoning: entry.reasoning,
        confidence: entry.confidence,
        validated: false,
        issueCount: resolvedIssues.length,
        commonThemes: entry.theme ? [entry.theme] : [],
        issues: resolvedIssues,
      };
    }).filter((batch) => batch.primaryWorkItemId && batch.issues.length > 1),
    singleIssues: singleSuggestions.flatMap((entry) => {
      const issue = syntheticMap.get(entry.issueNumbers[0] || 0);
      if (!issue || !issueMap.has(issue.workItemId)) return [];
      return [{
        workItemId: issue.workItemId,
        identifier: issue.identifier,
        title: issue.title,
        labels: getIssueLabels(issue),
      }];
    }),
    message: `Analyzed ${untrackedIssues.length} Yunxiao issues`,
  };
}

export function registerYunxiaoAutoFixHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_GET_CONFIG,
    async (_event, projectId: string): Promise<YunxiaoAutoFixConfig | null> => {
      const project = projectStore.getProject(projectId);
      return project ? getAutoFixConfig(project) : null;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_SAVE_CONFIG,
    async (_event, projectId: string, config: YunxiaoAutoFixConfig): Promise<boolean> => {
      const project = projectStore.getProject(projectId);
      if (!project) return false;
      saveAutoFixConfig(project, config);
      return true;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_GET_QUEUE,
    async (_event, projectId: string): Promise<YunxiaoAutoFixQueueItem[]> => {
      const project = projectStore.getProject(projectId);
      return project ? getAutoFixQueue(project) : [];
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_CHECK_NEW,
    async (_event, projectId: string): Promise<Array<{ workItemId: string }>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return [];

      const config = getAutoFixConfig(project);
      if (!config.enabled) return [];

      const trackedIds = getTrackedWorkItemIds(project);
      return getOpenIssues(project)
        .filter((issue) => !trackedIds.has(issue.workItemId))
        .map((issue) => ({ workItemId: issue.workItemId }));
    }
  );

  ipcMain.on(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_START,
    async (_event, projectId: string, workItemId: string) => {
      const project = projectStore.getProject(projectId);
      const mainWindow = getMainWindow();
      if (!project || !mainWindow) return;

      await startAutoFix(project, workItemId, mainWindow, agentManager);
    }
  );

  ipcMain.on(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW,
    async (_event, projectId: string, workItemIds?: string[], maxIssues?: number) => {
      const project = projectStore.getProject(projectId);
      const mainWindow = getMainWindow();
      if (!project || !mainWindow) return;

      const { sendProgress, sendComplete, sendError } = createIPCCommunicators<YunxiaoAnalyzePreviewProgress, YunxiaoAnalyzePreviewResult>(
        mainWindow,
        {
          progress: IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_PROGRESS,
          error: IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_ERROR,
          complete: IPC_CHANNELS.YUNXIAO_AUTOFIX_ANALYZE_PREVIEW_COMPLETE,
        },
        projectId
      );

      try {
        sendProgress({
          phase: 'analyzing',
          progress: 10,
          message: '正在分析云效问题...',
        });

        let issues = getOpenIssues(project);
        if (Array.isArray(workItemIds) && workItemIds.length > 0) {
          const allowed = new Set(workItemIds.map((value) => sanitizeText(value, 120)).filter(Boolean));
          issues = issues.filter((issue) => allowed.has(issue.workItemId));
        }
        if (maxIssues && maxIssues > 0) {
          issues = issues.slice(0, maxIssues);
        }

        const trackedIds = getTrackedWorkItemIds(project);
        const sourceIssues = issues
          .filter((issue) => !trackedIds.has(issue.workItemId))
          .map((issue, index) => toBatchProcessorIssue(issue, index + 1));

        const { model, thinkingLevel } = getAnalyzeSettings();
        const batchProcessor = new BatchProcessor({ model, thinkingLevel });
        const suggestions = sourceIssues.length > 0
          ? await batchProcessor.groupIssues(sourceIssues)
          : [];

        sendComplete(buildAnalyzeResult(issues, trackedIds, suggestions));
      } catch (error) {
        sendError(normalizeErrorText(error));
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_AUTOFIX_APPROVE_BATCHES,
    async (
      _event,
      projectId: string,
      approvedBatches: YunxiaoProposedBatch[]
    ): Promise<{ success: boolean; error?: string }> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        saveApprovedBatches(project, approvedBatches);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: normalizeErrorText(error),
        };
      }
    }
  );
}
