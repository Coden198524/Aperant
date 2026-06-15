/**
 * Retrieval Pipeline Orchestrator
 *
 * Main entry point. Ties together all retrieval stages:
 *   1. Parallel candidate generation (BM25 + Dense + Graph)
 *   2. Weighted RRF fusion
 *   2b. Graph neighborhood boost
 *   3. Cross-encoder reranking (top 20 → top 8)
 *   4. Phase-aware context packing
 */

import type { Client } from '@libsql/client';
import type { Memory, UniversalPhase } from '@autocode/core';
import type { EmbeddingService } from '../embedding-service';
import { rowToMemory } from '../row-mapper';
import { detectQueryType, QUERY_TYPE_WEIGHTS } from './query-classifier';
import { searchBM25 } from './bm25-search';
import { searchDense } from './dense-search';
import { searchGraph } from './graph-search';
import { weightedRRF } from './rrf-fusion';
import { applyGraphNeighborhoodBoost } from './graph-boost';
import { Reranker } from './reranker';
import { estimateTokens, packContext } from './context-packer';

export const MAX_RETRIEVAL_QUERY_CHARS = 800;
export const MAX_RETRIEVAL_QUERY_TOKENS = 200;
const RETRIEVAL_QUERY_OMISSION_MARKER = ' ... [query middle omitted for retrieval budget] ... ';
const DEFAULT_RETRIEVAL_MAX_RESULTS = 8;
const DEFAULT_BM25_CANDIDATE_LIMIT = 20;
const DEFAULT_DENSE_CANDIDATE_LIMIT = 30;
const DEFAULT_GRAPH_CANDIDATE_LIMIT = 15;
const DEFAULT_FETCH_CANDIDATE_LIMIT = 20;

// ============================================================
// TYPES
// ============================================================

export interface RetrievalConfig {
  phase: UniversalPhase;
  projectId: string;
  recentFiles?: string[];
  recentToolCalls?: string[];
  maxResults?: number;
}

export interface RetrievalResult {
  memories: Memory[];
  formattedContext: string;
}

// ============================================================
// PIPELINE CLASS
// ============================================================

export class RetrievalPipeline {
  constructor(
    private readonly db: Client,
    private readonly embeddingService: EmbeddingService,
    private readonly reranker: Reranker,
  ) {}

  /**
   * Run the complete retrieval pipeline for a query.
   *
   * @param query - Search query text
   * @param config - Phase, project, and context configuration
   */
  async search(query: string, config: RetrievalConfig): Promise<RetrievalResult> {
    const compactQuery = compactRetrievalQuery(query);
    const maxResults = normalizeRetrievalMaxResults(config.maxResults);
    if (!compactQuery || maxResults <= 0) {
      return { memories: [], formattedContext: '' };
    }

    const queryType = detectQueryType(compactQuery, config.recentToolCalls);
    const weights = QUERY_TYPE_WEIGHTS[queryType];
    const candidateLimits = getRetrievalCandidateLimits(maxResults);

    // Stage 1: Parallel candidate generation from all three paths
    const [bm25Results, denseResults, graphResults] = await Promise.all([
      searchBM25(this.db, compactQuery, config.projectId, candidateLimits.bm25),
      searchDense(this.db, compactQuery, this.embeddingService, config.projectId, 256, candidateLimits.dense),
      searchGraph(this.db, config.recentFiles ?? [], config.projectId, candidateLimits.graph),
    ]);

    // Stage 2a: Weighted RRF fusion (application-side — no SQL FULL OUTER JOIN)
    const fused = weightedRRF([
      {
        results: bm25Results.map((r) => ({ memoryId: r.memoryId })),
        weight: weights.fts,
        name: 'bm25',
      },
      {
        results: denseResults.map((r) => ({ memoryId: r.memoryId })),
        weight: weights.dense,
        name: 'dense',
      },
      {
        results: graphResults.map((r) => ({ memoryId: r.memoryId })),
        weight: weights.graph,
        name: 'graph',
      },
    ]);

    // Stage 2b: Graph neighborhood boost
    const boosted = await applyGraphNeighborhoodBoost(
      this.db,
      fused,
      config.projectId,
    );

    // Fetch full memory records for top candidates
    const topCandidateIds = boosted.slice(0, candidateLimits.fetch).map((r) => r.memoryId);
    const memories = await this.fetchMemories(topCandidateIds, candidateLimits.fetch);

    if (memories.length === 0) {
      return { memories: [], formattedContext: '' };
    }

    // Stage 3: Cross-encoder reranking (top 20 → top maxResults)
    const reranked = await this.reranker.rerank(
      compactQuery,
      memories.map((m) => ({
        memoryId: m.id,
        content: `[${m.type}] ${m.relatedFiles.join(', ')}: ${m.content}`,
      })),
      maxResults,
    );

    // Re-order memories by reranker score
    const rerankedMemories = reranked
      .map((r) => memories.find((m) => m.id === r.memoryId))
      .filter((m): m is Memory => m !== undefined);

    // Stage 4: Phase-aware context packing
    const formattedContext = packContext(rerankedMemories, config.phase);

    return { memories: rerankedMemories, formattedContext };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async fetchMemories(ids: string[], limit: number): Promise<Memory[]> {
    const normalizedIds = normalizeMemoryFetchIds(ids, limit);
    if (normalizedIds.length === 0) return [];

    const placeholders = normalizedIds.map(() => '?').join(',');

    try {
      const result = await this.db.execute({
        sql: `SELECT * FROM memories WHERE id IN (${placeholders}) AND deprecated = 0`,
        args: normalizedIds,
      });

      // Preserve the order from the ids array (RRF ranking order)
      const byId = new Map<string, Memory>();
      for (const row of result.rows) {
        const memory = rowToMemory(row as Record<string, unknown>);
        byId.set(memory.id, memory);
      }

      return normalizedIds.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
    } catch {
      return [];
    }
  }
}

export function compactRetrievalQuery(query: string): string {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (
    normalized.length <= MAX_RETRIEVAL_QUERY_CHARS &&
    estimateTokens(normalized) <= MAX_RETRIEVAL_QUERY_TOKENS
  ) {
    return normalized;
  }

  const charBounded = compactRetrievalQueryByChars(normalized, MAX_RETRIEVAL_QUERY_CHARS);
  if (estimateTokens(charBounded) <= MAX_RETRIEVAL_QUERY_TOKENS) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(MAX_RETRIEVAL_QUERY_CHARS, normalized.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactRetrievalQueryByChars(normalized, midpoint);
    if (estimateTokens(candidate) <= MAX_RETRIEVAL_QUERY_TOKENS) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactRetrievalQueryByChars(normalized: string, maxChars: number): string {
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }

  const marker = RETRIEVAL_QUERY_OMISSION_MARKER;
  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * 0.62);
  const tailChars = Math.max(0, budget - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    effectiveMarker,
    tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '',
  ].join('');
}

function normalizeRetrievalMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) {
    return DEFAULT_RETRIEVAL_MAX_RESULTS;
  }
  if (!Number.isFinite(maxResults)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxResults));
}

export function normalizeMemoryFetchIds(ids: string[], limit: number): string[] {
  if (!Number.isFinite(limit)) {
    return [];
  }
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit <= 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedIds: string[] = [];
  for (const id of ids) {
    const normalized = id.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedIds.push(normalized);
    if (normalizedIds.length >= boundedLimit) {
      break;
    }
  }
  return normalizedIds;
}

interface RetrievalCandidateLimits {
  bm25: number;
  dense: number;
  graph: number;
  fetch: number;
}

function getRetrievalCandidateLimits(maxResults: number): RetrievalCandidateLimits {
  const fetch = getRetrievalFetchCandidateLimit(maxResults);

  return {
    bm25: Math.min(DEFAULT_BM25_CANDIDATE_LIMIT, fetch),
    dense: Math.min(
      DEFAULT_DENSE_CANDIDATE_LIMIT,
      Math.max(fetch, maxResults + 10, Math.ceil(fetch * 1.5)),
    ),
    graph: Math.min(
      DEFAULT_GRAPH_CANDIDATE_LIMIT,
      Math.max(maxResults, Math.ceil(fetch * 0.75)),
    ),
    fetch,
  };
}

function getRetrievalFetchCandidateLimit(maxResults: number): number {
  if (maxResults >= DEFAULT_RETRIEVAL_MAX_RESULTS) {
    return DEFAULT_FETCH_CANDIDATE_LIMIT;
  }

  const scaledLimit = Math.max(maxResults, maxResults * 4, maxResults + 6);
  return Math.min(DEFAULT_FETCH_CANDIDATE_LIMIT, scaledLimit);
}
