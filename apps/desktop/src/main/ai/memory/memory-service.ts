/**
 * MemoryService Implementation
 *
 * Implements the MemoryService interface against a libSQL database.
 * Handles store, search, BM25 pattern search, and convenience methods.
 */

import type { Client } from '@libsql/client';
import type {
  Memory,
  MemoryService,
  MemoryRecordEntry,
  MemorySearchFilters,
} from '@autocode/core';
import type { EmbeddingService } from './embedding-service';
import { buildMemoryContextualText } from './embedding-service';
import { rowToMemory } from './row-mapper';
import { searchBM25 } from './retrieval/bm25-search';
import { estimateTokens, isMemoryEligibleForPromptContext } from './retrieval/context-packer';
import type { RetrievalPipeline } from './retrieval/pipeline';

const MEMORY_STORE_CONTENT_MAX_CHARS = 2_000;
const MEMORY_STORE_CONTENT_MAX_TOKENS = 500;
const MEMORY_STORE_CITATION_TEXT_MAX_CHARS = 1_000;
const MEMORY_STORE_CITATION_TEXT_MAX_TOKENS = 250;
const MEMORY_STORE_CONTEXT_PREFIX_MAX_CHARS = 600;
const MEMORY_STORE_CONTEXT_PREFIX_MAX_TOKENS = 150;
const MEMORY_STORE_TAG_LIMIT = 20;
const MEMORY_STORE_TAG_MAX_CHARS = 64;
const MEMORY_STORE_TAG_MAX_TOKENS = 24;
const MEMORY_STORE_RELATED_FILE_LIMIT = 24;
const MEMORY_STORE_RELATED_FILE_MAX_CHARS = 220;
const MEMORY_STORE_RELATED_FILE_MAX_TOKENS = 56;
const MEMORY_STORE_RELATED_MODULE_LIMIT = 16;
const MEMORY_STORE_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_STORE_RELATED_MODULE_MAX_TOKENS = 32;
const MEMORY_SEARCH_QUERY_MAX_CHARS = 800;
const MEMORY_SEARCH_QUERY_MAX_TOKENS = 200;
const MEMORY_SEARCH_FILTER_RELATED_FILE_LIMIT = 16;
const MEMORY_SEARCH_FILTER_RELATED_FILE_MAX_CHARS = 220;
const MEMORY_SEARCH_FILTER_RELATED_FILE_MAX_TOKENS = 56;
const MEMORY_SEARCH_FILTER_RELATED_MODULE_LIMIT = 16;
const MEMORY_SEARCH_FILTER_RELATED_MODULE_MAX_CHARS = 96;
const MEMORY_SEARCH_FILTER_RELATED_MODULE_MAX_TOKENS = 32;
const MEMORY_STORE_OMISSION_MARKER = ' ... [memory middle omitted before storage] ... ';
const MEMORY_SEARCH_QUERY_OMISSION_MARKER = ' ... [memory query middle omitted for retrieval budget] ... ';
const DEFAULT_QUERY_SEARCH_RESULT_LIMIT = 8;
const DEFAULT_DIRECT_SEARCH_RESULT_LIMIT = 50;
const MAX_MEMORY_SEARCH_RESULT_LIMIT = 50;
const MAX_WORKFLOW_RECIPE_RESULT_LIMIT = 20;
const FILTERED_SEARCH_CANDIDATE_MULTIPLIER = 4;
const FILTERED_SEARCH_CANDIDATE_EXTRA = 8;
const FILTERED_SEARCH_CANDIDATE_CAP = 50;
const PATTERN_SEARCH_CANDIDATE_LIMIT = 6;

function getMemorySearchResultLimit(filters: MemorySearchFilters): number {
  return Math.max(
    0,
    filters.limit ?? (filters.query ? DEFAULT_QUERY_SEARCH_RESULT_LIMIT : DEFAULT_DIRECT_SEARCH_RESULT_LIMIT),
  );
}

function getMemorySearchCandidateLimit(filters: MemorySearchFilters): number {
  const resultLimit = getMemorySearchResultLimit(filters);
  if (!shouldExpandMemorySearchCandidates(filters) || resultLimit <= 0) {
    return resultLimit;
  }

  const expandedLimit = Math.max(
    resultLimit * FILTERED_SEARCH_CANDIDATE_MULTIPLIER,
    resultLimit + FILTERED_SEARCH_CANDIDATE_EXTRA,
  );
  const cap = Math.max(resultLimit, FILTERED_SEARCH_CANDIDATE_CAP);
  return Math.min(expandedLimit, cap);
}

function shouldExpandMemorySearchCandidates(filters: MemorySearchFilters): boolean {
  if (filters.promptContextOnly || filters.filter) {
    return true;
  }

  if (filters.query) {
    return Boolean(
      filters.types?.length ||
      filters.sources?.length ||
      filters.scope ||
      filters.relatedFiles?.length ||
      filters.relatedModules?.length ||
      filters.minConfidence !== undefined ||
      filters.excludeDeprecated,
    );
  }

  return Boolean(filters.relatedFiles?.length || filters.relatedModules?.length);
}

function getWorkflowRecipeSearchCandidateLimit(limit: number): number {
  const safeLimit = Math.max(0, limit);
  if (safeLimit <= 0) {
    return 0;
  }
  return Math.min(
    Math.max(
      safeLimit * FILTERED_SEARCH_CANDIDATE_MULTIPLIER,
      safeLimit + FILTERED_SEARCH_CANDIDATE_EXTRA,
    ),
    Math.max(safeLimit, FILTERED_SEARCH_CANDIDATE_CAP),
  );
}

// ============================================================
// MEMORY SERVICE IMPLEMENTATION
// ============================================================

export class MemoryServiceImpl implements MemoryService {
  constructor(
    private readonly db: Client,
    private readonly embeddingService: EmbeddingService,
    private readonly retrievalPipeline: RetrievalPipeline,
  ) {}

  /**
   * Store a memory entry in the database.
   * Inserts into memories, memories_fts, and memory_embeddings tables.
   * Returns the generated memory ID.
   */
  async store(entry: MemoryRecordEntry): Promise<string> {
    const normalizedEntry = normalizeMemoryRecordEntryForStorage(entry);

    const existingId = await this.findExistingMemoryId(normalizedEntry);
    if (existingId) {
      await this.updateAccessCount(existingId);
      return existingId;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const tags = JSON.stringify(normalizedEntry.tags ?? []);
    const relatedFiles = JSON.stringify(normalizedEntry.relatedFiles ?? []);
    const relatedModules = JSON.stringify(normalizedEntry.relatedModules ?? []);
    const provenanceSessionIds = JSON.stringify([]);
    const relations = JSON.stringify([]);
    const workUnitRef = normalizedEntry.workUnitRef ? JSON.stringify(normalizedEntry.workUnitRef) : null;

    try {
      // Build a temporary Memory-like object to generate contextual embedding
      const memoryForEmbedding: Memory = {
        id,
        type: normalizedEntry.type,
        content: normalizedEntry.content,
        confidence: normalizedEntry.confidence ?? 0.8,
        tags: normalizedEntry.tags ?? [],
        relatedFiles: normalizedEntry.relatedFiles ?? [],
        relatedModules: normalizedEntry.relatedModules ?? [],
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        scope: normalizedEntry.scope ?? 'global',
        source: normalizedEntry.source ?? 'agent_explicit',
        sessionId: normalizedEntry.sessionId ?? '',
        provenanceSessionIds: [],
        projectId: normalizedEntry.projectId,
        workUnitRef: normalizedEntry.workUnitRef,
        methodology: normalizedEntry.methodology,
        decayHalfLifeDays: normalizedEntry.decayHalfLifeDays,
        needsReview: normalizedEntry.needsReview,
        pinned: normalizedEntry.pinned,
        citationText: normalizedEntry.citationText,
        chunkType: normalizedEntry.chunkType,
        chunkStartLine: normalizedEntry.chunkStartLine,
        chunkEndLine: normalizedEntry.chunkEndLine,
        contextPrefix: normalizedEntry.contextPrefix,
        trustLevelScope: normalizedEntry.trustLevelScope,
      };

      const contextualText = buildMemoryContextualText(memoryForEmbedding);
      const embedding = await this.embeddingService.embed(contextualText, 1024);
      const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
      const modelId = this.embeddingService.getProvider();
      const embeddingModelId = `${modelId}-d1024`;

      await this.db.batch([
        // Insert into memories table
        {
          sql: `INSERT INTO memories (
            id, type, content, confidence, tags, related_files, related_modules,
            created_at, last_accessed_at, access_count,
            session_id, scope, work_unit_ref, methodology,
            source, relations, decay_half_life_days, provenance_session_ids,
            needs_review, pinned, citation_text,
            chunk_type, chunk_start_line, chunk_end_line, context_prefix,
            trust_level_scope, project_id, embedding_model_id
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, 0,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?
          )`,
          args: [
            id,
            normalizedEntry.type,
            normalizedEntry.content,
            normalizedEntry.confidence ?? 0.8,
            tags,
            relatedFiles,
            relatedModules,
            now,
            now,
            normalizedEntry.sessionId ?? null,
            normalizedEntry.scope ?? 'global',
            workUnitRef,
            normalizedEntry.methodology ?? null,
            normalizedEntry.source ?? 'agent_explicit',
            relations,
            normalizedEntry.decayHalfLifeDays ?? null,
            provenanceSessionIds,
            normalizedEntry.needsReview ? 1 : 0,
            normalizedEntry.pinned ? 1 : 0,
            normalizedEntry.citationText ?? null,
            normalizedEntry.chunkType ?? null,
            normalizedEntry.chunkStartLine ?? null,
            normalizedEntry.chunkEndLine ?? null,
            normalizedEntry.contextPrefix ?? null,
            normalizedEntry.trustLevelScope ?? 'personal',
            normalizedEntry.projectId,
            embeddingModelId,
          ],
        },
        // Insert into FTS5 table
        {
          sql: `INSERT INTO memories_fts (memory_id, content, tags, related_files)
                VALUES (?, ?, ?, ?)`,
          args: [
            id,
            normalizedEntry.content,
            (normalizedEntry.tags ?? []).join(' '),
            (normalizedEntry.relatedFiles ?? []).join(' '),
          ],
        },
        // Insert into memory_embeddings table
        {
          sql: `INSERT INTO memory_embeddings (memory_id, embedding, model_id, dims, created_at)
                VALUES (?, ?, ?, 1024, ?)`,
          args: [id, embeddingBlob, embeddingModelId, now],
        },
      ]);

      return id;
    } catch (error) {
      console.error('[MemoryService] Failed to store memory:', error);
      throw error;
    }
  }

  /**
   * Search memories using filters.
   * If a query string is provided, delegates to the retrieval pipeline.
   * Otherwise, performs a direct SQL query using type/scope/project filters.
   */
  async search(filters: MemorySearchFilters): Promise<Memory[]> {
    const normalizedFilters = normalizeMemorySearchFilters(filters);
    if (filters.query !== undefined && !normalizedFilters.query) {
      return [];
    }
    const resultLimit = getMemorySearchResultLimit(normalizedFilters);
    if (resultLimit <= 0) {
      return [];
    }

    try {
      let memories: Memory[];

      if (normalizedFilters.query) {
        // Use the retrieval pipeline for semantic search
        const result = await this.retrievalPipeline.search(normalizedFilters.query, {
          phase: normalizedFilters.phase ?? 'explore',
          projectId: normalizedFilters.projectId ?? '',
          maxResults: getMemorySearchCandidateLimit(normalizedFilters),
        });
        memories = result.memories;
      } else {
        // Direct SQL query using structural filters
        memories = await this.directSearch(normalizedFilters);
      }

      memories = this.applyStructuralPostFilters(memories, normalizedFilters);

      // Post-filter by minConfidence
      if (normalizedFilters.minConfidence !== undefined) {
        memories = memories.filter((m) => m.confidence >= (normalizedFilters.minConfidence ?? 0));
      }

      // Post-filter deprecated
      if (normalizedFilters.excludeDeprecated) {
        memories = memories.filter((m) => !m.deprecated);
      }

      if (normalizedFilters.promptContextOnly) {
        memories = memories.filter(isMemoryEligibleForPromptContext);
      }

      // Apply custom filter callback
      if (normalizedFilters.filter) {
        memories = memories.filter(normalizedFilters.filter);
      }

      // Sort
      if (normalizedFilters.sort === 'recency') {
        memories.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      } else if (normalizedFilters.sort === 'confidence') {
        memories.sort((a, b) => b.confidence - a.confidence);
      }
      // 'relevance' sort is preserved from pipeline order

      // Apply limit after all filtering. Query searches have an implicit default
      // limit from the retrieval pipeline, so preserve that even when we fetch
      // extra prompt-context candidates for quality filtering.
      if (memories.length > resultLimit) {
        memories = memories.slice(0, resultLimit);
      }

      if (normalizedFilters.recordAccess) {
        await this.markMemoriesAccessed(memories);
      }

      return memories;
    } catch (error) {
      console.error('[MemoryService] Failed to search memories:', error);
      return [];
    }
  }

  /**
   * Quick BM25-only pattern search.
   * Returns the single best match or null.
   * Used for fast lookups (e.g., StepInjectionDecider).
   */
  async searchByPattern(pattern: string, opts?: { projectId?: string; recordAccess?: boolean }): Promise<Memory | null> {
    const normalizedPattern = normalizeMemorySearchQuery(pattern);
    if (!normalizedPattern) {
      return null;
    }

    try {
      const results = await searchBM25(
        this.db,
        normalizedPattern,
        opts?.projectId ?? '',
        PATTERN_SEARCH_CANDIDATE_LIMIT,
      );
      if (results.length === 0) return null;

      const memoryIds = results.map((result) => result.memoryId);
      const placeholders = memoryIds.map(() => '?').join(', ');
      const row = await this.db.execute({
        sql: `SELECT * FROM memories WHERE id IN (${placeholders}) AND deprecated = 0`,
        args: memoryIds,
      });

      if (row.rows.length === 0) return null;
      const memoriesById = new Map(
        row.rows.map((memoryRow) => {
          const memory = rowToMemory(memoryRow as Record<string, unknown>);
          return [memory.id, memory] as const;
        }),
      );

      for (const result of results) {
        const memory = memoriesById.get(result.memoryId);
        if (memory && isMemoryEligibleForPromptContext(memory)) {
          if (opts?.recordAccess !== false) {
            await this.markMemoriesAccessed([memory]);
          }
          return memory;
        }
      }
      return null;
    } catch (error) {
      console.error('[MemoryService] searchByPattern failed:', error);
      return null;
    }
  }

  /**
   * Convenience method for /remember command and Teach panel.
   * Stores a user-taught preference with full confidence.
   */
  async insertUserTaught(content: string, projectId: string, tags: string[]): Promise<string> {
    return this.store({
      type: 'preference',
      content,
      projectId,
      tags,
      source: 'user_taught',
      confidence: 1.0,
      scope: 'global',
    });
  }

  /**
   * Search for workflow_recipe memories matching a task description.
   * Uses the retrieval pipeline with a type filter applied post-search.
   */
  async searchWorkflowRecipe(
    taskDescription: string,
    opts?: { limit?: number; projectId?: string; recordAccess?: boolean },
  ): Promise<Memory[]> {
    const normalizedTaskDescription = normalizeMemorySearchQuery(taskDescription);
    const limit = normalizeRequiredMemoryLimit(
      opts?.limit ?? 5,
      MAX_WORKFLOW_RECIPE_RESULT_LIMIT,
    );
    if (!normalizedTaskDescription || limit <= 0) {
      return [];
    }

    try {
      const result = await this.retrievalPipeline.search(normalizedTaskDescription, {
        phase: 'implement',
        projectId: opts?.projectId ?? '',
        maxResults: getWorkflowRecipeSearchCandidateLimit(limit),
      });

      // Filter to workflow_recipe type
      const recipes = result.memories.filter((m) =>
        m.type === 'workflow_recipe' && isMemoryEligibleForPromptContext(m)
      );
      const selectedRecipes = recipes.slice(0, limit);
      if (opts?.recordAccess !== false) {
        await this.markMemoriesAccessed(selectedRecipes);
      }
      return selectedRecipes;
    } catch (error) {
      console.error('[MemoryService] searchWorkflowRecipe failed:', error);
      return [];
    }
  }

  /**
   * Increment access_count and update last_accessed_at for a memory.
   */
  async updateAccessCount(memoryId: string): Promise<void> {
    try {
      await this.db.execute({
        sql: `UPDATE memories
              SET access_count = access_count + 1,
                  last_accessed_at = ?
              WHERE id = ?`,
        args: [new Date().toISOString(), memoryId],
      });
    } catch (error) {
      console.error('[MemoryService] updateAccessCount failed:', error);
    }
  }

  /**
   * Mark a memory as deprecated.
   */
  async deprecateMemory(memoryId: string): Promise<void> {
    try {
      await this.db.execute({
        sql: `UPDATE memories
              SET deprecated = 1, deprecated_at = ?
              WHERE id = ?`,
        args: [new Date().toISOString(), memoryId],
      });
    } catch (error) {
      console.error('[MemoryService] deprecateMemory failed:', error);
    }
  }

  /**
   * Mark a memory as user-verified and clear the needs_review flag.
   */
  async verifyMemory(memoryId: string): Promise<void> {
    await this.db.execute({
      sql: `UPDATE memories SET user_verified = 1, needs_review = 0 WHERE id = ?`,
      args: [memoryId],
    });
  }

  /**
   * Pin or unpin a memory.
   */
  async pinMemory(memoryId: string, pinned: boolean): Promise<void> {
    await this.db.execute({
      sql: `UPDATE memories SET pinned = ? WHERE id = ?`,
      args: [pinned ? 1 : 0, memoryId],
    });
  }

  /**
   * Permanently delete a memory and all associated records.
   */
  async deleteMemory(memoryId: string): Promise<void> {
    await this.db.batch([
      { sql: 'DELETE FROM memory_embeddings WHERE memory_id = ?', args: [memoryId] },
      { sql: 'DELETE FROM memories_fts WHERE memory_id = ?', args: [memoryId] },
      { sql: 'DELETE FROM memories WHERE id = ?', args: [memoryId] },
    ]);
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async directSearch(filters: MemorySearchFilters): Promise<Memory[]> {
    const conditions: string[] = ['1=1'];
    const args: (string | number | null)[] = [];

    if (filters.excludeDeprecated !== false) {
      conditions.push('deprecated = 0');
    }

    if (filters.projectId) {
      conditions.push('project_id = ?');
      args.push(filters.projectId);
    }

    if (filters.scope) {
      conditions.push('scope = ?');
      args.push(filters.scope);
    }

    if (filters.types && filters.types.length > 0) {
      const placeholders = filters.types.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
      args.push(...filters.types);
    }

    if (filters.sources && filters.sources.length > 0) {
      const placeholders = filters.sources.map(() => '?').join(', ');
      conditions.push(`source IN (${placeholders})`);
      args.push(...filters.sources);
    }

    if (filters.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      args.push(filters.minConfidence);
    }

    const orderBy =
      filters.sort === 'recency'
        ? 'created_at DESC'
        : filters.sort === 'confidence'
          ? 'confidence DESC'
          : 'last_accessed_at DESC';

    const limit = getMemorySearchCandidateLimit(filters);

    const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`;
    args.push(limit);

    const result = await this.db.execute({ sql, args });
    return result.rows.map((r) => rowToMemory(r as Record<string, unknown>));
  }

  private applyStructuralPostFilters(
    memories: Memory[],
    filters: MemorySearchFilters,
  ): Memory[] {
    return memories.filter((memory) => {
      if (filters.types?.length && !filters.types.includes(memory.type)) {
        return false;
      }
      if (filters.sources?.length && !filters.sources.includes(memory.source)) {
        return false;
      }
      if (filters.scope && memory.scope !== filters.scope) {
        return false;
      }
      if (filters.relatedFiles?.length && !hasRelatedFileOverlap(memory.relatedFiles, filters.relatedFiles)) {
        return false;
      }
      if (filters.relatedModules?.length && !hasNormalizedOverlap(memory.relatedModules, filters.relatedModules)) {
        return false;
      }
      return true;
    });
  }

  private async findExistingMemoryId(entry: MemoryRecordEntry): Promise<string | null> {
    try {
      const result = await this.db.execute({
        sql: `SELECT id FROM memories
              WHERE project_id = ?
                AND type = ?
                AND content = ?
                AND deprecated = 0
              LIMIT 1`,
        args: [entry.projectId, entry.type, entry.content],
      });
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return typeof row?.id === 'string' ? row.id : null;
    } catch {
      return null;
    }
  }

  private async markMemoriesAccessed(memories: Memory[]): Promise<void> {
    const ids = uniqueMemoryIds(memories);
    if (ids.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    try {
      await this.db.batch(
        ids.map((id) => ({
          sql: `UPDATE memories
                SET access_count = access_count + 1,
                    last_accessed_at = ?
                WHERE id = ?`,
          args: [now, id],
        })),
      );
    } catch (error) {
      console.error('[MemoryService] markMemoriesAccessed failed:', error);
    }
  }
}

function uniqueMemoryIds(memories: Memory[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const memory of memories) {
    const id = memory.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeMemorySearchFilters(filters: MemorySearchFilters): MemorySearchFilters {
  return {
    ...filters,
    query: filters.query === undefined ? undefined : normalizeMemorySearchQuery(filters.query),
    limit: normalizeOptionalMemoryLimit(filters.limit),
    minConfidence: normalizeMemoryMinConfidence(filters.minConfidence),
    types: uniqueMemoryFilterList(filters.types),
    sources: uniqueMemoryFilterList(filters.sources),
    relatedFiles: normalizeMemoryPathFilterList(filters.relatedFiles),
    relatedModules: normalizeMemoryTextFilterList(filters.relatedModules),
  };
}

function normalizeMemorySearchQuery(query: string): string | undefined {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return compactMemoryTextWithMarker(
    normalized,
    MEMORY_SEARCH_QUERY_MAX_CHARS,
    MEMORY_SEARCH_QUERY_MAX_TOKENS,
    MEMORY_SEARCH_QUERY_OMISSION_MARKER,
  );
}

function normalizeOptionalMemoryLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : normalizeRequiredMemoryLimit(limit, MAX_MEMORY_SEARCH_RESULT_LIMIT);
}

function normalizeRequiredMemoryLimit(limit: number, maxLimit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  const boundedMax = Number.isFinite(maxLimit) ? Math.max(0, Math.floor(maxLimit)) : 0;
  return Math.min(Math.max(0, Math.floor(limit)), boundedMax);
}

function normalizeMemoryMinConfidence(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(1, value);
}

function normalizeMemoryConfidence(value: unknown, fallback: number | undefined): number | undefined {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : undefined;
  if (numericValue === undefined || !Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numericValue));
}

function uniqueMemoryFilterList<T extends string>(values: T[] | undefined): T[] | undefined {
  if (!values) {
    return undefined;
  }

  const seen = new Set<T>();
  const unique: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function normalizeMemoryPathFilterList(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];
  for (const value of values) {
    const normalized = truncateMemoryPathTailToBudget(
      normalizeMemoryPathListItem(value),
      MEMORY_SEARCH_FILTER_RELATED_FILE_MAX_CHARS,
      MEMORY_SEARCH_FILTER_RELATED_FILE_MAX_TOKENS,
    );
    if (!normalized) {
      continue;
    }

    const key = normalizeFilterPath(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedValues.push(normalized);
    if (normalizedValues.length >= MEMORY_SEARCH_FILTER_RELATED_FILE_LIMIT) {
      break;
    }
  }
  return normalizedValues;
}

function normalizeMemoryTextFilterList(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];
  for (const value of values) {
    const normalized = compactMemoryListItem(
      value.replace(/\s+/g, ' ').trim(),
      MEMORY_SEARCH_FILTER_RELATED_MODULE_MAX_CHARS,
      MEMORY_SEARCH_FILTER_RELATED_MODULE_MAX_TOKENS,
    );
    if (!normalized) {
      continue;
    }

    const key = normalizeFilterValue(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedValues.push(normalized);
    if (normalizedValues.length >= MEMORY_SEARCH_FILTER_RELATED_MODULE_LIMIT) {
      break;
    }
  }
  return normalizedValues;
}

function hasNormalizedOverlap(values: string[], expected: string[]): boolean {
  const normalized = new Set(values.map(normalizeFilterValue));
  return expected.some((value) => normalized.has(normalizeFilterValue(value)));
}

function hasRelatedFileOverlap(values: string[], expected: string[]): boolean {
  const normalizedValues = values.map(normalizeFilterPath).filter(Boolean);
  const normalizedExpected = expected.map(normalizeFilterPath).filter(Boolean);

  return normalizedExpected.some((expectedPath) =>
    normalizedValues.some((valuePath) => pathsReferToSameFile(valuePath, expectedPath)),
  );
}

function normalizeFilterValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeFilterPath(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/$/, '');
}

function pathsReferToSameFile(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function normalizeMemoryRecordEntryForStorage(entry: MemoryRecordEntry): MemoryRecordEntry {
  return {
    ...entry,
    content: compactMemoryStorageText(
      entry.content,
      MEMORY_STORE_CONTENT_MAX_CHARS,
      MEMORY_STORE_CONTENT_MAX_TOKENS,
    ),
    confidence: normalizeMemoryConfidence(entry.confidence, undefined),
    tags: compactMemoryStringList(
      entry.tags,
      MEMORY_STORE_TAG_LIMIT,
      MEMORY_STORE_TAG_MAX_CHARS,
      MEMORY_STORE_TAG_MAX_TOKENS,
    ),
    relatedFiles: compactMemoryPathList(
      entry.relatedFiles,
      MEMORY_STORE_RELATED_FILE_LIMIT,
      MEMORY_STORE_RELATED_FILE_MAX_CHARS,
      MEMORY_STORE_RELATED_FILE_MAX_TOKENS,
    ),
    relatedModules: compactMemoryStringList(
      entry.relatedModules,
      MEMORY_STORE_RELATED_MODULE_LIMIT,
      MEMORY_STORE_RELATED_MODULE_MAX_CHARS,
      MEMORY_STORE_RELATED_MODULE_MAX_TOKENS,
      normalizeMemoryTextDedupeKey,
    ),
    citationText: compactOptionalMemoryStorageText(
      entry.citationText,
      MEMORY_STORE_CITATION_TEXT_MAX_CHARS,
      MEMORY_STORE_CITATION_TEXT_MAX_TOKENS,
    ),
    contextPrefix: compactOptionalMemoryStorageText(
      entry.contextPrefix,
      MEMORY_STORE_CONTEXT_PREFIX_MAX_CHARS,
      MEMORY_STORE_CONTEXT_PREFIX_MAX_TOKENS,
    ),
  };
}

function compactOptionalMemoryStorageText(
  value: string | undefined,
  maxChars: number,
  maxTokens: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return compactMemoryStorageText(value, maxChars, maxTokens);
}

function compactMemoryStorageText(value: string, maxChars: number, maxTokens: number): string {
  return compactMemoryTextWithMarker(value, maxChars, maxTokens, MEMORY_STORE_OMISSION_MARKER);
}

function compactMemoryTextWithMarker(value: string, maxChars: number, maxTokens: number, marker: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (normalized.length <= maxChars && estimateTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const charBounded = compactMemoryTextWithMarkerByChars(normalized, maxChars, marker);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactMemoryTextWithMarkerByChars(normalized, midpoint, marker);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactMemoryTextWithMarkerByChars(value: string, maxChars: number, marker: string): string {
  if (maxChars <= 0 || value.length <= maxChars) {
    return value.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }

  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * 0.55);
  const tailChars = Math.max(0, budget - headChars);
  return [
    value.slice(0, headChars).trimEnd(),
    effectiveMarker,
    tailChars > 0 ? value.slice(-tailChars).trimStart() : '',
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
