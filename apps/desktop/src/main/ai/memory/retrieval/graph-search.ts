/**
 * Knowledge Graph Search
 *
 * Three retrieval sub-paths:
 *   1. File-scoped: memories tagged to recently-accessed files
 *   2. Co-access: memories for files co-accessed with recent files
 *   3. Closure neighbors: memories for files 1-hop away in the dependency graph
 */

import type { Client } from '@libsql/client';

const CO_ACCESS_NEIGHBOR_LIMIT = 10;
const CO_ACCESS_MEMORY_LIMIT = 5;
const CLOSURE_NEIGHBOR_LIMIT = 15;
const CLOSURE_MEMORY_LIMIT = 3;
const MAX_GRAPH_RECENT_FILES = 32;

export interface GraphSearchResult {
  memoryId: string;
  graphScore: number;
  reason: 'co_access' | 'closure_neighbor' | 'file_scoped';
}

/**
 * Search memories using knowledge graph traversal.
 *
 * @param db - libSQL client
 * @param recentFiles - File paths recently accessed by the agent
 * @param projectId - Scope search to this project
 * @param limit - Maximum number of deduplicated results to return
 */
export async function searchGraph(
  db: Client,
  recentFiles: string[],
  projectId: string,
  limit: number = 15,
): Promise<GraphSearchResult[]> {
  const results: GraphSearchResult[] = [];
  const boundedLimit = normalizeSearchLimit(limit);
  const normalizedRecentFiles = normalizeRecentFiles(recentFiles);

  if (boundedLimit <= 0 || normalizedRecentFiles.length === 0) return results;

  // Path 1: File-scoped memories (directly tagged to recent files)
  await collectFileScopedMemories(db, normalizedRecentFiles, projectId, results, boundedLimit);

  // Path 2: Co-access neighbors (files frequently co-accessed with recent files)
  await collectCoAccessMemories(db, normalizedRecentFiles, projectId, results, boundedLimit);

  // Path 3: Closure table 1-hop neighbors (structural dependencies)
  await collectClosureNeighborMemories(db, normalizedRecentFiles, projectId, results, boundedLimit);

  // Deduplicate — keep highest-scored entry per memoryId
  const seen = new Map<string, GraphSearchResult>();
  for (const r of results) {
    const existing = seen.get(r.memoryId);
    if (!existing || r.graphScore > existing.graphScore) {
      seen.set(r.memoryId, r);
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.graphScore - a.graphScore)
    .slice(0, boundedLimit);
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.floor(limit));
}

function normalizeRecentFiles(recentFiles: string[]): string[] {
  const seen = new Set<string>();
  const normalizedFiles: string[] = [];
  for (const file of recentFiles) {
    const normalized = file.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedFiles.push(normalized);
    if (normalizedFiles.length >= MAX_GRAPH_RECENT_FILES) {
      break;
    }
  }
  return normalizedFiles;
}

function getGraphSubQueryLimit(defaultLimit: number, searchLimit: number): number {
  return Math.max(1, Math.min(defaultLimit, searchLimit));
}

function normalizeGraphId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGraphScore(value: unknown): number | undefined {
  const normalized = typeof value === 'number' ? value : undefined;
  return normalized !== undefined && Number.isFinite(normalized) ? normalized : undefined;
}

// ============================================================
// SUB-PATH HELPERS
// ============================================================

async function collectFileScopedMemories(
  db: Client,
  recentFiles: string[],
  projectId: string,
  results: GraphSearchResult[],
  limit: number,
): Promise<void> {
  try {
    const placeholders = recentFiles.map(() => '?').join(',');
    const fileScoped = await db.execute({
      sql: `SELECT DISTINCT m.id FROM memories m
        WHERE m.project_id = ?
          AND m.deprecated = 0
          AND EXISTS (
            SELECT 1 FROM json_each(m.related_files) je
            WHERE je.value IN (${placeholders})
          )
        LIMIT ?`,
      args: [projectId, ...recentFiles, limit],
    });

    for (const row of fileScoped.rows) {
      const memoryId = normalizeGraphId(row.id);
      if (!memoryId) {
        continue;
      }
      results.push({
        memoryId,
        graphScore: 0.8,
        reason: 'file_scoped',
      });
    }
  } catch {
    // json_each may not be available in all libSQL versions — skip gracefully
  }
}

async function collectCoAccessMemories(
  db: Client,
  recentFiles: string[],
  projectId: string,
  results: GraphSearchResult[],
  limit: number,
): Promise<void> {
  try {
    const placeholders = recentFiles.map(() => '?').join(',');
    const neighborLimit = getGraphSubQueryLimit(CO_ACCESS_NEIGHBOR_LIMIT, limit);
    const memoryLimit = getGraphSubQueryLimit(CO_ACCESS_MEMORY_LIMIT, limit);
    const coAccess = await db.execute({
      sql: `SELECT DISTINCT file_b AS neighbor, weight
        FROM observer_co_access_edges
        WHERE file_a IN (${placeholders})
          AND project_id = ?
          AND weight > 0.3
        ORDER BY weight DESC
        LIMIT ?`,
      args: [...recentFiles, projectId, neighborLimit],
    });

    for (const row of coAccess.rows) {
      const neighbor = normalizeGraphId(row.neighbor);
      const weight = normalizeGraphScore(row.weight);
      if (!neighbor || weight === undefined) {
        continue;
      }

      // Get memories for this co-accessed file
      const neighborMemories = await db.execute({
        sql: `SELECT id FROM memories
          WHERE project_id = ?
            AND deprecated = 0
            AND related_files LIKE ?
          LIMIT ?`,
        args: [projectId, `%${neighbor}%`, memoryLimit],
      });

      for (const m of neighborMemories.rows) {
        const memoryId = normalizeGraphId(m.id);
        if (!memoryId) {
          continue;
        }
        results.push({
          memoryId,
          graphScore: weight * 0.7,
          reason: 'co_access',
        });
      }
    }
  } catch {
    // Skip if observer_co_access_edges is empty or query fails
  }
}

async function collectClosureNeighborMemories(
  db: Client,
  recentFiles: string[],
  projectId: string,
  results: GraphSearchResult[],
  limit: number,
): Promise<void> {
  try {
    const placeholders = recentFiles.map(() => '?').join(',');
    const neighborLimit = getGraphSubQueryLimit(CLOSURE_NEIGHBOR_LIMIT, limit);
    const memoryLimit = getGraphSubQueryLimit(CLOSURE_MEMORY_LIMIT, limit);
    const closureNeighbors = await db.execute({
      sql: `SELECT DISTINCT gc.descendant_id
        FROM graph_closure gc
        JOIN graph_nodes gn ON gc.ancestor_id = gn.id
        WHERE gn.file_path IN (${placeholders})
          AND gn.project_id = ?
          AND gc.depth = 1
        LIMIT ?`,
      args: [...recentFiles, projectId, neighborLimit],
    });

    for (const row of closureNeighbors.rows) {
      const nodeId = normalizeGraphId(row.descendant_id);
      if (!nodeId) {
        continue;
      }

      const nodeMemories = await db.execute({
        sql: `SELECT id FROM memories
          WHERE project_id = ?
            AND deprecated = 0
            AND target_node_id = ?
          LIMIT ?`,
        args: [projectId, nodeId, memoryLimit],
      });

      for (const m of nodeMemories.rows) {
        const memoryId = normalizeGraphId(m.id);
        if (!memoryId) {
          continue;
        }
        results.push({
          memoryId,
          graphScore: 0.6,
          reason: 'closure_neighbor',
        });
      }
    }
  } catch {
    // Skip if graph tables are empty or query fails
  }
}
