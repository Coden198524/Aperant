import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../utils/atomic-file';
import type { Project, YunxiaoIssue, YunxiaoWorkItem, YunxiaoIssueSyncResult } from '../../shared/types';
import { formatYunxiaoDescriptionContent } from '../ipc-handlers/yunxiao/description';
import { sanitizeText, sanitizeUrl } from '../ipc-handlers/shared/sanitize';

interface YunxiaoIssueStoreFile {
  version: 1;
  updatedAt: string;
  lastSyncAt?: string;
  issues: YunxiaoIssue[];
}

const STORE_FILE_NAME = 'yunxiao-issues.json';

function getAutoBuildRoot(project: Project): string | null {
  const root = (project.autoBuildPath || '').trim();
  if (!root) return null;
  return path.join(project.path, root);
}

function getStoreFilePath(project: Project): string | null {
  const root = getAutoBuildRoot(project);
  if (!root) return null;
  return path.join(root, STORE_FILE_NAME);
}

function readStore(project: Project): YunxiaoIssueStoreFile {
  const filePath = getStoreFilePath(project);
  if (!filePath || !existsSync(filePath)) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      issues: []
    };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<YunxiaoIssueStoreFile>;
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : undefined,
      issues: issues.filter((issue) => typeof issue?.workItemId === 'string' && issue.workItemId.trim() !== '')
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      issues: []
    };
  }
}

function writeStore(project: Project, file: YunxiaoIssueStoreFile): void {
  const root = getAutoBuildRoot(project);
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const filePath = path.join(root, STORE_FILE_NAME);
  writeFileAtomicSync(filePath, JSON.stringify(file, null, 2));
}

function normalizeTags(tags?: string[]): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const normalized = tags
    .map((tag) => sanitizeText(String(tag), 50))
    .filter(Boolean);
  if (normalized.length === 0) return undefined;
  return Array.from(new Set(normalized));
}

function toIssueRecord(item: YunxiaoWorkItem, nowIso: string, existing?: YunxiaoIssue): YunxiaoIssue {
  const workItemId = sanitizeText(item.id || '', 120);
  const title = sanitizeText(item.subject || `Yunxiao ${workItemId}`, 500);
  const identifier = sanitizeText(item.identifier || workItemId, 120) || undefined;
  const statusName = sanitizeText(item.status?.displayName || item.status?.name || '', 120) || undefined;
  const priority = sanitizeText(item.priority || '', 120) || undefined;
  const assigneeName = sanitizeText(item.assignedTo?.name || '', 120) || undefined;
  const creatorName = sanitizeText(item.creator?.name || '', 120) || undefined;
  const spaceId = sanitizeText(item.space?.id || '', 120) || undefined;
  const spaceName = sanitizeText(item.space?.name || '', 200) || undefined;
  const url = sanitizeUrl(item.url || '') || undefined;
  const description = formatYunxiaoDescriptionContent(item.description || '');

  return {
    id: `yunxiao-${workItemId}`,
    workItemId,
    identifier,
    title,
    description,
    statusName,
    priority,
    assigneeName,
    creatorName,
    spaceId,
    spaceName,
    url,
    gmtCreate: item.gmtCreate,
    gmtModified: item.gmtModified,
    syncedAt: nowIso,
    localCategory: existing?.localCategory,
    localSeverity: existing?.localSeverity,
    localTags: normalizeTags(existing?.localTags),
    localAnalysis: existing?.localAnalysis
  };
}

function isIssueEqualWithoutSyncTime(a: YunxiaoIssue, b: YunxiaoIssue): boolean {
  const { syncedAt: _aSyncedAt, ...aComparable } = a;
  const { syncedAt: _bSyncedAt, ...bComparable } = b;
  return JSON.stringify(aComparable) === JSON.stringify(bComparable);
}

export function listYunxiaoIssues(project: Project): YunxiaoIssue[] {
  const file = readStore(project);
  return [...file.issues].sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
}

export function upsertYunxiaoIssuesFromWorkItems(
  project: Project,
  openBugItems: YunxiaoWorkItem[]
): YunxiaoIssueSyncResult {
  const file = readStore(project);
  const existingByWorkItemId = new Map<string, YunxiaoIssue>();
  for (const issue of file.issues) {
    existingByWorkItemId.set(issue.workItemId, issue);
  }

  const nowIso = new Date().toISOString();
  const nextIssues: YunxiaoIssue[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of openBugItems) {
    const workItemId = sanitizeText(item.id || '', 120);
    if (!workItemId) {
      skipped += 1;
      continue;
    }

    const existing = existingByWorkItemId.get(workItemId);
    const normalized = toIssueRecord(item, nowIso, existing);
    nextIssues.push(normalized);

    if (!existing) {
      created += 1;
      continue;
    }

    if (!isIssueEqualWithoutSyncTime(existing, normalized)) {
      updated += 1;
    }
  }

  const incomingIds = new Set(nextIssues.map((issue) => issue.workItemId));
  const removed = file.issues.reduce((count, issue) => (
    incomingIds.has(issue.workItemId) ? count : count + 1
  ), 0);

  const sortedIssues = nextIssues.sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
  writeStore(project, {
    version: 1,
    updatedAt: nowIso,
    lastSyncAt: nowIso,
    issues: sortedIssues
  });

  return {
    issues: sortedIssues,
    created,
    updated,
    removed,
    skipped
  };
}

export function updateYunxiaoIssueLocalFields(
  project: Project,
  workItemId: string,
  updates: {
    localCategory?: string;
    localSeverity?: 'low' | 'medium' | 'high' | 'critical';
    localTags?: string[];
    localAnalysis?: string;
  }
): YunxiaoIssue | null {
  const targetWorkItemId = sanitizeText(workItemId, 120);
  if (!targetWorkItemId) return null;

  const file = readStore(project);
  const issueIndex = file.issues.findIndex((issue) => issue.workItemId === targetWorkItemId);
  if (issueIndex === -1) return null;

  const existing = file.issues[issueIndex];
  const next: YunxiaoIssue = { ...existing };

  if (Object.prototype.hasOwnProperty.call(updates, 'localCategory')) {
    next.localCategory = sanitizeText(updates.localCategory || '', 50) || undefined;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'localSeverity')) {
    next.localSeverity = updates.localSeverity;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'localTags')) {
    next.localTags = normalizeTags(updates.localTags);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'localAnalysis')) {
    next.localAnalysis = sanitizeText(updates.localAnalysis || '', 20000, true) || undefined;
  }

  const nowIso = new Date().toISOString();
  file.issues[issueIndex] = next;
  file.updatedAt = nowIso;
  writeStore(project, file);

  return next;
}
