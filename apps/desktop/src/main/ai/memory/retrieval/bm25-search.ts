/**
 * BM25 / FTS5 Search
 *
 * Uses SQLite FTS5 MATCH syntax with BM25 scoring.
 * FTS5 is used in ALL modes (local and cloud) — NOT Tantivy.
 */

import type { Client } from '@libsql/client';

export interface BM25Result {
  memoryId: string;
  bm25Score: number;
}

/**
 * Search memories using FTS5 BM25 full-text search.
 *
 * Note: FTS5 bm25() returns negative values (lower = better match).
 * Results are ordered ascending (most negative first = best match).
 *
 * @param db - libSQL client
 * @param query - User query string (FTS5 MATCH syntax)
 * @param projectId - Scope search to this project
 * @param limit - Maximum number of results to return
 */
export async function searchBM25(
  db: Client,
  query: string,
  projectId: string,
  limit: number = 100,
): Promise<BM25Result[]> {
  const boundedLimit = normalizeSearchLimit(limit);
  if (boundedLimit <= 0) {
    return [];
  }

  try {
    // Sanitize query for FTS5: wrap in quotes if it contains special chars
    const sanitizedQuery = sanitizeFtsQuery(query);
    if (!sanitizedQuery) {
      return [];
    }

    const result = await db.execute({
      sql: `SELECT m.id, bm25(memories_fts) AS bm25_score
        FROM memories_fts
        JOIN memories m ON memories_fts.memory_id = m.id
        WHERE memories_fts MATCH ?
          AND m.project_id = ?
          AND m.deprecated = 0
        ORDER BY bm25_score
        LIMIT ?`,
      args: [sanitizedQuery, projectId, boundedLimit],
    });

    return result.rows.flatMap((r) => {
      const memoryId = normalizeResultId(r.id);
      const bm25Score = normalizeFiniteNumber(r.bm25_score);
      return memoryId && bm25Score !== undefined ? [{ memoryId, bm25Score }] : [];
    });
  } catch {
    // FTS5 MATCH can fail on malformed queries — return empty result gracefully
    return [];
  }
}

function normalizeResultId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  const normalized = typeof value === 'number' ? value : undefined;
  return normalized !== undefined && Number.isFinite(normalized) ? normalized : undefined;
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.floor(limit));
}

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * FTS5 special characters: " ( ) * : ^ + -
 * If query contains special chars beyond word boundaries, quote the whole thing.
 */
function sanitizeFtsQuery(query: string): string | undefined {
  const trimmed = query.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;

  // If already looks like a valid FTS5 query with operators, pass through
  if (/^["(]/.test(trimmed)) return trimmed;

  // Simple word-only query: safe to pass through
  if (/^[\w\s]+$/.test(trimmed)) return trimmed;

  // Otherwise: quote the phrase to prevent FTS5 parse errors
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}
