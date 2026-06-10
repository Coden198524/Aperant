import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import {
  areAutocodeYunxiaoIssuesEqualWithoutSyncTime as isIssueEqualWithoutSyncTime,
  normalizeAutocodeYunxiaoTags as normalizeTags,
  toAutocodeYunxiaoIssueRecord as toIssueRecord,
} from '@autocode/core/integrations/yunxiao';
import { writeFileAtomicSync } from '../utils/atomic-file';
import type { Project, YunxiaoIssue, YunxiaoWorkItem, YunxiaoIssueSyncResult } from '../../shared/types';
import { sanitizeText } from '../ipc-handlers/shared/sanitize';

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

  if (Object.hasOwn(updates, 'localCategory')) {
    next.localCategory = sanitizeText(updates.localCategory || '', 50) || undefined;
  }
  if (Object.hasOwn(updates, 'localSeverity')) {
    next.localSeverity = updates.localSeverity;
  }
  if (Object.hasOwn(updates, 'localTags')) {
    next.localTags = normalizeTags(updates.localTags);
  }
  if (Object.hasOwn(updates, 'localAnalysis')) {
    next.localAnalysis = sanitizeText(updates.localAnalysis || '', 20000, true) || undefined;
  }

  const nowIso = new Date().toISOString();
  file.issues[issueIndex] = next;
  file.updatedAt = nowIso;
  writeStore(project, file);

  return next;
}
