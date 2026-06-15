/**
 * Shared memory row mapping.
 *
 * Keeps legacy database rows bounded and normalized before they enter retrieval,
 * prompt packing, or UI-facing memory results.
 */

import {
  isAutocodeMemoryScope,
  isAutocodeMemorySource,
  isAutocodeMemoryType,
} from '@autocode/core';
import type {
  Memory,
  MemoryRelation,
  MemoryScope,
  MemorySource,
  MemoryType,
  WorkUnitRef,
} from '@autocode/core';
import { estimateTokens } from './retrieval/context-packer';

const MEMORY_ROW_CONTENT_MAX_CHARS = 2_000;
const MEMORY_ROW_CONTENT_MAX_TOKENS = 500;
const MEMORY_ROW_CITATION_TEXT_MAX_CHARS = 1_000;
const MEMORY_ROW_CITATION_TEXT_MAX_TOKENS = 250;
const MEMORY_ROW_CONTEXT_PREFIX_MAX_CHARS = 600;
const MEMORY_ROW_CONTEXT_PREFIX_MAX_TOKENS = 150;
const MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_CHARS = 96;
const MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_TOKENS = 24;
const MEMORY_ROW_WORK_UNIT_LABEL_MAX_CHARS = 300;
const MEMORY_ROW_WORK_UNIT_LABEL_MAX_TOKENS = 75;
const MEMORY_ROW_WORK_UNIT_HIERARCHY_LIMIT = 8;
const MEMORY_ROW_WORK_UNIT_HIERARCHY_MAX_CHARS = 120;
const MEMORY_ROW_WORK_UNIT_HIERARCHY_MAX_TOKENS = 32;
const MEMORY_ROW_TAG_LIMIT = 20;
const MEMORY_ROW_TAG_MAX_CHARS = 64;
const MEMORY_ROW_TAG_MAX_TOKENS = 24;
const MEMORY_ROW_RELATED_FILE_LIMIT = 24;
const MEMORY_ROW_RELATED_FILE_MAX_CHARS = 220;
const MEMORY_ROW_RELATED_FILE_MAX_TOKENS = 56;
const MEMORY_ROW_RELATED_MODULE_LIMIT = 16;
const MEMORY_ROW_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_ROW_RELATED_MODULE_MAX_TOKENS = 32;
const MEMORY_ROW_OMISSION_MARKER = ' ... [memory middle omitted before storage] ... ';
const MEMORY_ROW_EPOCH_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const MEMORY_ROW_ID_LIST_LIMIT = 64;
const MEMORY_ROW_ID_MAX_CHARS = 128;
const MEMORY_ROW_ID_MAX_TOKENS = 48;
const MEMORY_ROW_RELATION_LIMIT = 16;
const MEMORY_RELATION_TYPES = new Set<MemoryRelation['relationType']>([
  'required_with',
  'conflicts_with',
  'validates',
  'supersedes',
  'derived_from',
]);
const MEMORY_CHUNK_TYPES = new Set<NonNullable<Memory['chunkType']>>([
  'function',
  'class',
  'module',
  'prose',
]);

export function rowToMemory(row: Record<string, unknown>): Memory {
  const tags = compactMemoryStringList(
    parseJsonStringArray(row.tags),
    MEMORY_ROW_TAG_LIMIT,
    MEMORY_ROW_TAG_MAX_CHARS,
    MEMORY_ROW_TAG_MAX_TOKENS,
    normalizeMemoryTextDedupeKey,
  ) ?? [];
  const relatedFiles = compactMemoryPathList(
    parseJsonStringArray(row.related_files),
    MEMORY_ROW_RELATED_FILE_LIMIT,
    MEMORY_ROW_RELATED_FILE_MAX_CHARS,
    MEMORY_ROW_RELATED_FILE_MAX_TOKENS,
  ) ?? [];
  const relatedModules = compactMemoryStringList(
    parseJsonStringArray(row.related_modules),
    MEMORY_ROW_RELATED_MODULE_LIMIT,
    MEMORY_ROW_RELATED_MODULE_MAX_CHARS,
    MEMORY_ROW_RELATED_MODULE_MAX_TOKENS,
    normalizeMemoryTextDedupeKey,
  ) ?? [];
  const provenanceSessionIds = compactMemoryStringList(
    parseJsonStringArray(row.provenance_session_ids),
    MEMORY_ROW_ID_LIST_LIMIT,
    MEMORY_ROW_ID_MAX_CHARS,
    MEMORY_ROW_ID_MAX_TOKENS,
  ) ?? [];
  const impactedNodeIds = compactMemoryStringList(
    parseJsonStringArray(row.impacted_node_ids),
    MEMORY_ROW_ID_LIST_LIMIT,
    MEMORY_ROW_ID_MAX_CHARS,
    MEMORY_ROW_ID_MAX_TOKENS,
  ) ?? [];
  const createdAt = normalizeRequiredMemoryTimestamp(row.created_at, MEMORY_ROW_EPOCH_TIMESTAMP);
  const lastAccessedAt = normalizeRequiredMemoryTimestamp(row.last_accessed_at, createdAt);

  return {
    id: normalizeRequiredMemoryText(row.id),
    type: normalizeMemoryType(row.type),
    content: compactMemoryRowText(row.content, MEMORY_ROW_CONTENT_MAX_CHARS, MEMORY_ROW_CONTENT_MAX_TOKENS),
    confidence: normalizeMemoryConfidence(row.confidence, 0.8) ?? 0.8,
    tags,
    relatedFiles,
    relatedModules,
    createdAt,
    lastAccessedAt,
    accessCount: normalizeNonNegativeMemoryInteger(row.access_count) ?? 0,
    scope: normalizeMemoryScope(row.scope),
    source: normalizeMemorySource(row.source),
    sessionId: normalizeOptionalMemoryText(row.session_id) ?? '',
    commitSha: normalizeOptionalMemoryText(row.commit_sha),
    provenanceSessionIds,
    targetNodeId: normalizeOptionalMemoryText(row.target_node_id),
    impactedNodeIds,
    relations: parseJsonMemoryRelations(row.relations),
    decayHalfLifeDays: normalizePositiveMemoryNumber(row.decay_half_life_days),
    needsReview: normalizeMemoryBoolean(row.needs_review),
    userVerified: normalizeMemoryBoolean(row.user_verified),
    citationText: compactOptionalMemoryRowText(
      row.citation_text,
      MEMORY_ROW_CITATION_TEXT_MAX_CHARS,
      MEMORY_ROW_CITATION_TEXT_MAX_TOKENS,
    ),
    pinned: normalizeMemoryBoolean(row.pinned),
    deprecated: normalizeMemoryBoolean(row.deprecated),
    deprecatedAt: normalizeOptionalMemoryTimestamp(row.deprecated_at),
    staleAt: normalizeOptionalMemoryTimestamp(row.stale_at),
    projectId: normalizeRequiredMemoryText(row.project_id),
    trustLevelScope: normalizeOptionalMemoryText(row.trust_level_scope),
    chunkType: normalizeMemoryChunkType(row.chunk_type),
    chunkStartLine: normalizeNonNegativeMemoryInteger(row.chunk_start_line),
    chunkEndLine: normalizeNonNegativeMemoryInteger(row.chunk_end_line),
    contextPrefix: compactOptionalMemoryRowText(
      row.context_prefix,
      MEMORY_ROW_CONTEXT_PREFIX_MAX_CHARS,
      MEMORY_ROW_CONTEXT_PREFIX_MAX_TOKENS,
    ),
    embeddingModelId: normalizeOptionalMemoryText(row.embedding_model_id),
    workUnitRef: parseJsonWorkUnitRef(row.work_unit_ref),
    methodology: compactOptionalMemoryMetadataText(
      row.methodology,
      MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_CHARS,
      MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_TOKENS,
    ),
  };
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonStringArray(val: unknown): string[] {
  const parsed = parseJson<unknown>(val, []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === 'string');
}

function parseJsonMemoryRelations(val: unknown): MemoryRelation[] {
  const parsed = parseJson<unknown>(val, []);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const byKey = new Map<string, RankedMemoryRelation>();
  parsed.forEach((item, rank) => {
    if (!isRecord(item) || !isMemoryRelationType(item.relationType)) {
      return;
    }

    const targetMemoryId = compactOptionalMemoryMetadataText(
      item.targetMemoryId,
      MEMORY_ROW_ID_MAX_CHARS,
      MEMORY_ROW_ID_MAX_TOKENS,
    );
    const targetFilePath = normalizeOptionalMemoryRelationPath(item.targetFilePath);
    if (!targetMemoryId && !targetFilePath) {
      return;
    }

    const relation: MemoryRelation = {
      relationType: item.relationType,
      confidence: normalizeMemoryConfidence(item.confidence, 0.8) ?? 0.8,
      autoExtracted: item.autoExtracted === true,
    };
    if (targetMemoryId) {
      relation.targetMemoryId = targetMemoryId;
    }
    if (targetFilePath) {
      relation.targetFilePath = targetFilePath;
    }

    const key = getMemoryRelationDedupeKey(relation);
    const existing = byKey.get(key);
    if (!existing || isHigherPriorityMemoryRelation(relation, existing.relation)) {
      const relationForStorage = existing
        ? {
            ...relation,
            targetMemoryId: existing.relation.targetMemoryId ?? relation.targetMemoryId,
            targetFilePath: existing.relation.targetFilePath ?? relation.targetFilePath,
          }
        : relation;
      byKey.set(key, {
        relation: relationForStorage,
        rank: existing?.rank ?? rank,
      });
    }
  });

  return [...byKey.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MEMORY_ROW_RELATION_LIMIT)
    .map((item) => item.relation);
}

interface RankedMemoryRelation {
  relation: MemoryRelation;
  rank: number;
}

function isHigherPriorityMemoryRelation(candidate: MemoryRelation, existing: MemoryRelation): boolean {
  if (candidate.confidence !== existing.confidence) {
    return candidate.confidence > existing.confidence;
  }
  return existing.autoExtracted && !candidate.autoExtracted;
}

function getMemoryRelationDedupeKey(relation: MemoryRelation): string {
  return [
    relation.relationType,
    normalizeMemoryTextDedupeKey(relation.targetMemoryId ?? ''),
    normalizeFilterPath(relation.targetFilePath ?? ''),
  ].join(':');
}

function normalizeMemoryConfidence(value: unknown, fallback: number | undefined): number | undefined {
  const numericValue = toFiniteMemoryNumber(value);
  if (numericValue === undefined) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numericValue));
}

function normalizeMemoryType(value: unknown): MemoryType {
  return typeof value === 'string' && isAutocodeMemoryType(value) ? value : 'gotcha';
}

function normalizeMemoryScope(value: unknown): MemoryScope {
  return typeof value === 'string' && isAutocodeMemoryScope(value) ? value : 'global';
}

function normalizeMemorySource(value: unknown): MemorySource {
  return typeof value === 'string' && isAutocodeMemorySource(value) ? value : 'agent_explicit';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoryRelationType(value: unknown): value is MemoryRelation['relationType'] {
  return typeof value === 'string' && MEMORY_RELATION_TYPES.has(value as MemoryRelation['relationType']);
}

function normalizeRequiredMemoryText(value: unknown): string {
  return normalizeOptionalMemoryText(value) ?? '';
}

function normalizeRequiredMemoryTimestamp(value: unknown, fallback: string): string {
  return normalizeOptionalMemoryTimestamp(value) ?? fallback;
}

function normalizeOptionalMemoryTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeOptionalMemoryText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalMemoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeMemoryPathListItem(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalMemoryRelationPath(value: unknown): string | undefined {
  const normalized = normalizeOptionalMemoryPath(value);
  if (!normalized) {
    return undefined;
  }
  return truncateMemoryPathTailToBudget(
    normalized,
    MEMORY_ROW_RELATED_FILE_MAX_CHARS,
    MEMORY_ROW_RELATED_FILE_MAX_TOKENS,
  );
}

function normalizeMemoryBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }
  return false;
}

function parseJsonWorkUnitRef(value: unknown): WorkUnitRef | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const methodology = compactOptionalMemoryMetadataText(
    parsed.methodology,
    MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_CHARS,
    MEMORY_ROW_WORK_UNIT_METHODOLOGY_MAX_TOKENS,
  );
  const label = compactOptionalMemoryMetadataText(
    parsed.label,
    MEMORY_ROW_WORK_UNIT_LABEL_MAX_CHARS,
    MEMORY_ROW_WORK_UNIT_LABEL_MAX_TOKENS,
  );
  if (!methodology || !label || !Array.isArray(parsed.hierarchy)) {
    return undefined;
  }

  const hierarchy = compactMemoryStringList(
    parsed.hierarchy.filter((item): item is string => typeof item === 'string'),
    MEMORY_ROW_WORK_UNIT_HIERARCHY_LIMIT,
    MEMORY_ROW_WORK_UNIT_HIERARCHY_MAX_CHARS,
    MEMORY_ROW_WORK_UNIT_HIERARCHY_MAX_TOKENS,
    normalizeMemoryTextDedupeKey,
  ) ?? [];
  if (hierarchy.length === 0) {
    return undefined;
  }

  return { methodology, hierarchy, label };
}

function normalizeMemoryChunkType(value: unknown): Memory['chunkType'] | undefined {
  return typeof value === 'string' && MEMORY_CHUNK_TYPES.has(value as NonNullable<Memory['chunkType']>)
    ? (value as Memory['chunkType'])
    : undefined;
}

function normalizeNonNegativeMemoryInteger(value: unknown): number | undefined {
  const numericValue = toFiniteMemoryNumber(value);
  if (numericValue === undefined || numericValue < 0) {
    return undefined;
  }
  return Math.floor(numericValue);
}

function normalizePositiveMemoryNumber(value: unknown): number | undefined {
  const numericValue = toFiniteMemoryNumber(value);
  return numericValue !== undefined && numericValue > 0 ? numericValue : undefined;
}

function toFiniteMemoryNumber(value: unknown): number | undefined {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : undefined;
  return numericValue !== undefined && Number.isFinite(numericValue) ? numericValue : undefined;
}

function compactMemoryRowText(value: unknown, maxChars: number, maxTokens: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return compactMemoryText(value, maxChars, maxTokens);
}

function compactOptionalMemoryRowText(value: unknown, maxChars: number, maxTokens: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return compactMemoryText(value, maxChars, maxTokens);
}

function compactOptionalMemoryMetadataText(value: unknown, maxChars: number, maxTokens: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const compacted = compactMemoryListItem(value, maxChars, maxTokens);
  return compacted || undefined;
}

function compactMemoryText(value: string, maxChars: number, maxTokens: number): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (normalized.length <= maxChars && estimateTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const charBounded = compactMemoryTextByChars(normalized, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemoryTextByChars(normalized, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemoryTextByChars(normalized: string, maxChars: number): string {
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  const marker = MEMORY_ROW_OMISSION_MARKER;
  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * 0.55);
  const tailChars = Math.max(0, budget - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    effectiveMarker,
    tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '',
  ].join('');
}

function compactMemoryStringList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  maxItemTokens: number,
  getDedupeKey: (value: string) => string = identityMemoryTextDedupeKey,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const compactedItem = compactMemoryListItem(value, maxItemChars, maxItemTokens);
    if (!compactedItem) {
      continue;
    }

    const key = getDedupeKey(compactedItem);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    compacted.push(compactedItem);
    if (compacted.length >= Math.max(0, limit)) {
      break;
    }
  }

  return compacted;
}

function identityMemoryTextDedupeKey(value: string): string {
  return value;
}

function normalizeMemoryTextDedupeKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function compactMemoryPathList(
  values: string[] | undefined,
  limit: number,
  maxItemChars: number,
  maxItemTokens: number,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const normalized = normalizeMemoryPathListItem(value);
    if (!normalized) {
      continue;
    }

    const compactedPath = truncateMemoryPathTailToBudget(normalized, maxItemChars, maxItemTokens);
    const key = normalizeFilterPath(compactedPath);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    compacted.push(compactedPath);
    if (compacted.length >= Math.max(0, limit)) {
      break;
    }
  }

  return compacted;
}

function normalizeMemoryPathListItem(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function compactMemoryListItem(value: string, maxChars: number, maxTokens: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (normalized.length <= maxChars && estimateTokens(normalized) <= maxTokens) {
    return normalized;
  }
  const charBounded = compactMemoryListItemByChars(normalized, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemoryListItemByChars(normalized, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemoryListItemByChars(normalized: string, maxChars: number): string {
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  const marker = '...[omitted]...';
  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * 0.6);
  const tailChars = Math.max(0, budget - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}${effectiveMarker}${normalized.slice(-tailChars).trimStart()}`;
}

function truncateMemoryPathTailToBudget(path: string, maxChars: number, maxTokens: number): string {
  const charBounded = truncateMemoryPathTail(path, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, path.trim().length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateMemoryPathTail(path, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function truncateMemoryPathTail(path: string, maxChars: number): string {
  const normalized = path.trim();
  if (maxChars <= 0) {
    return '';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-maxChars).replace(/^\/+/, '');
}

function normalizeFilterPath(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/$/, '');
}
