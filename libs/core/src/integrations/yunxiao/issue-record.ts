import { sanitizeText, sanitizeUrl } from '../../security/sanitize.js';
import { formatYunxiaoDescriptionContent } from './description.js';
import { isClosedAutocodeYunxiaoStatus } from './status.js';

export interface AutocodeYunxiaoUserLike {
  id?: string;
  name?: string;
}

export interface AutocodeYunxiaoStatusLike {
  id?: string;
  name?: string;
  displayName?: string;
}

export interface AutocodeYunxiaoSpaceLike {
  id?: string;
  name?: string;
}

export interface AutocodeYunxiaoWorkItemTypeLike {
  id?: string;
  name?: string;
  categoryId?: string;
}

export interface AutocodeYunxiaoWorkItemLike {
  id?: string;
  identifier?: string;
  subject?: string;
  description?: unknown;
  categoryId?: string;
  status?: AutocodeYunxiaoStatusLike;
  priority?: string;
  workitemType?: AutocodeYunxiaoWorkItemTypeLike;
  assignedTo?: AutocodeYunxiaoUserLike;
  creator?: AutocodeYunxiaoUserLike;
  space?: AutocodeYunxiaoSpaceLike;
  gmtCreate?: number;
  gmtModified?: number;
  url?: string;
}

export type AutocodeYunxiaoIssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AutocodeYunxiaoIssueRecord {
  id: string;
  workItemId: string;
  identifier?: string;
  title: string;
  description?: string;
  statusName?: string;
  priority?: string;
  assigneeName?: string;
  creatorName?: string;
  spaceId?: string;
  spaceName?: string;
  url?: string;
  gmtCreate?: number;
  gmtModified?: number;
  syncedAt: string;
  localCategory?: string;
  localSeverity?: AutocodeYunxiaoIssueSeverity;
  localTags?: string[];
  localAnalysis?: string;
}

export function normalizeAutocodeYunxiaoTags(tags?: string[]): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) {
    return undefined;
  }

  const normalized = tags
    .map((tag) => sanitizeText(String(tag), 50))
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

export function toAutocodeYunxiaoIssueRecord(
  item: AutocodeYunxiaoWorkItemLike,
  nowIso: string,
  existing?: AutocodeYunxiaoIssueRecord
): AutocodeYunxiaoIssueRecord {
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
    localTags: normalizeAutocodeYunxiaoTags(existing?.localTags),
    localAnalysis: existing?.localAnalysis,
  };
}

export function areAutocodeYunxiaoIssuesEqualWithoutSyncTime(
  a: AutocodeYunxiaoIssueRecord,
  b: AutocodeYunxiaoIssueRecord
): boolean {
  const { syncedAt: _aSyncedAt, ...aComparable } = a;
  const { syncedAt: _bSyncedAt, ...bComparable } = b;
  return JSON.stringify(aComparable) === JSON.stringify(bComparable);
}

export function isAutocodeClosedOrResolvedYunxiaoWorkItem(item: AutocodeYunxiaoWorkItemLike): boolean {
  return isClosedAutocodeYunxiaoStatus(item.status?.displayName)
    || isClosedAutocodeYunxiaoStatus(item.status?.name);
}

export function buildAutocodeYunxiaoTaskDescription(item: AutocodeYunxiaoWorkItemLike): string {
  const safeTitle = sanitizeText(item.subject || `Yunxiao ${item.id || ''}`, 500);
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
