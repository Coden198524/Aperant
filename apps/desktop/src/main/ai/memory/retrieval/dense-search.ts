/**
 * Dense Vector Search
 *
 * Attempts libsql's native vector_distance_cos() for cosine similarity search.
 * Falls back to JS-side cosine similarity if the native query fails (e.g. when
 * embeddings are stored as plain BLOBs rather than F32_BLOB typed columns).
 */

import type { Client } from '@libsql/client';
import type { EmbeddingService } from '../embedding-service';

export interface DenseResult {
  memoryId: string;
  distance: number;
}

/**
 * Search memories using dense vector similarity.
 *
 * Attempts sqlite-vec vector_distance_cos first; falls back to JS-side
 * cosine similarity if the extension query fails.
 *
 * @param db - libSQL client
 * @param query - Query text to embed and search with
 * @param embeddingService - Service for computing query embedding
 * @param projectId - Scope search to this project
 * @param dims - Embedding dimension: 256 for fast candidate gen, 1024 for precision
 * @param limit - Maximum number of results to return
 */
export async function searchDense(
  db: Client,
  query: string,
  embeddingService: EmbeddingService,
  projectId: string,
  dims: 256 | 1024 = 256,
  limit: number = 30,
): Promise<DenseResult[]> {
  const boundedLimit = normalizeSearchLimit(limit);
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  if (!normalizedQuery || boundedLimit <= 0) {
    return [];
  }

  const queryEmbedding = await embeddingService.embed(normalizedQuery, dims);

  // Attempt libsql native vector_distance_cos query.
  // Falls back to JS-side cosine similarity if the query fails.
  try {
    const embeddingBlob = serializeEmbedding(queryEmbedding);

    const result = await db.execute({
      sql: `SELECT me.memory_id, vector_distance_cos(me.embedding, ?) AS distance
        FROM memory_embeddings me
        JOIN memories m ON me.memory_id = m.id
        WHERE m.project_id = ?
          AND m.deprecated = 0
          AND me.dims = ?
        ORDER BY distance ASC
        LIMIT ?`,
      args: [embeddingBlob, projectId, dims, boundedLimit],
    });

    return result.rows.flatMap((r) => {
      const memoryId = normalizeResultId(r.memory_id);
      const distance = normalizeFiniteNumber(r.distance);
      return memoryId && distance !== undefined ? [{ memoryId, distance }] : [];
    });
  } catch {
    // Native vector query failed — use JS-side cosine similarity
    return searchDenseJsFallback(db, queryEmbedding, projectId, dims, boundedLimit);
  }
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.floor(limit));
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

/**
 * JS-side cosine similarity fallback.
 * Fetches all embeddings for the project and computes similarity in-process.
 * Suitable for small datasets; for large datasets sqlite-vec is strongly preferred.
 */
async function searchDenseJsFallback(
  db: Client,
  queryEmbedding: number[],
  projectId: string,
  dims: number,
  limit: number,
): Promise<DenseResult[]> {
  const result = await db.execute({
    sql: `SELECT me.memory_id, me.embedding
      FROM memory_embeddings me
      JOIN memories m ON me.memory_id = m.id
      WHERE m.project_id = ?
        AND m.deprecated = 0
        AND me.dims = ?`,
    args: [projectId, dims],
  });

  const scored: DenseResult[] = [];

  for (const row of result.rows) {
    const memoryId = normalizeResultId(row.memory_id);
    const rawEmbedding = row.embedding;
    if (!memoryId || !rawEmbedding) continue;

    const storedEmbedding = deserializeEmbedding(rawEmbedding);
    if (!storedEmbedding) {
      continue;
    }

    const distance = cosineDistance(queryEmbedding, storedEmbedding);
    if (!Number.isFinite(distance)) {
      continue;
    }

    scored.push({
      memoryId,
      distance,
    });
  }

  return scored.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

// ============================================================
// EMBEDDING SERIALIZATION HELPERS
// ============================================================

function serializeEmbedding(embedding: number[]): Buffer {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

function deserializeEmbedding(value: unknown): number[] | undefined {
  const view = toEmbeddingBuffer(value);
  if (!view || view.length === 0 || view.length % 4 !== 0) {
    return undefined;
  }

  const result: number[] = [];
  for (let i = 0; i < view.length; i += 4) {
    const item = view.readFloatLE(i);
    if (!Number.isFinite(item)) {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function toEmbeddingBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

/**
 * Cosine distance (1 - cosine similarity).
 * Returns 0.0 for identical vectors, 2.0 for opposite vectors.
 */
function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1.0;
  return 1 - dot / denom;
}
