/**
 * Graph Neighborhood Boost
 *
 * Boosts candidates that share file-graph neighborhoods with top-ranked
 * memories, while bounding legacy/dirty inputs before SQL construction.
 */

import type { Client } from '@libsql/client';
import type { RankedResult } from './rrf-fusion';
import {
  getGraphFileReferenceMatchArgs,
  getGraphFileReferenceMatchSql,
} from '../graph/file-ref-match';

const GRAPH_BOOST_FACTOR = 0.3;
const MAX_GRAPH_BOOST_CANDIDATES = 50;
const MAX_GRAPH_BOOST_TOP_FILES = 64;
const MAX_GRAPH_BOOST_FILES_PER_MEMORY = 24;

/**
 * Apply graph neighborhood boost to candidates below the top-K cut.
 *
 * @param db - libSQL client
 * @param rankedCandidates - Results from weightedRRF, sorted by descending score
 * @param projectId - Scope to this project
 * @param topK - Number of top results to use as reference anchors
 */
export async function applyGraphNeighborhoodBoost(
  db: Client,
  rankedCandidates: RankedResult[],
  projectId: string,
  topK: number = 10,
): Promise<RankedResult[]> {
  const candidates = normalizeRankedCandidates(rankedCandidates);
  const anchorLimit = normalizeTopK(topK, candidates.length);
  if (candidates.length === 0 || anchorLimit <= 0 || candidates.length <= anchorLimit) return candidates;

  const allIds = candidates.map((r) => r.memoryId);
  const placeholders = allIds.map(() => '?').join(',');

  let relatedFilesMap: Map<string, string[]>;
  try {
    const memoriesResult = await db.execute({
      sql: `SELECT id, related_files FROM memories WHERE id IN (${placeholders})`,
      args: allIds,
    });

    relatedFilesMap = new Map();
    for (const row of memoriesResult.rows) {
      const memoryId = normalizeMemoryId(row.id);
      if (!memoryId) {
        continue;
      }
      relatedFilesMap.set(memoryId, parseRelatedFiles(row.related_files));
    }
  } catch {
    return candidates;
  }

  const topFiles: string[] = [];
  const topFileKeys = new Set<string>();
  for (const candidate of candidates.slice(0, anchorLimit)) {
    const files = relatedFilesMap.get(candidate.memoryId) ?? [];
    for (const file of files) {
      const key = normalizeFilePathKey(file);
      if (topFileKeys.has(key)) {
        continue;
      }

      topFileKeys.add(key);
      topFiles.push(file);
      if (topFiles.length >= MAX_GRAPH_BOOST_TOP_FILES) {
        break;
      }
    }
    if (topFiles.length >= MAX_GRAPH_BOOST_TOP_FILES) {
      break;
    }
  }

  if (topFiles.length === 0) return candidates;

  const neighborFileKeys = new Set<string>();
  try {
    const fileMatchArgs = getGraphFileReferenceMatchArgs(topFiles);
    if (fileMatchArgs.length === 0) return candidates;

    const filePlaceholders = fileMatchArgs.map(() => '?').join(',');
    const neighbors = await db.execute({
      sql: `SELECT DISTINCT gn2.file_path
        FROM graph_closure gc
        JOIN graph_nodes gn ON gc.ancestor_id = gn.id
        JOIN graph_nodes gn2 ON gc.descendant_id = gn2.id
        WHERE ${getGraphFileReferenceMatchSql('gn.file_path')} IN (${filePlaceholders})
          AND gn.project_id = ?
          AND gc.depth = 1
          AND gn2.file_path IS NOT NULL`,
      args: [...fileMatchArgs, projectId],
    });

    for (const row of neighbors.rows) {
      const filePath = normalizeFilePath(row.file_path);
      if (filePath) {
        neighborFileKeys.add(normalizeFilePathKey(filePath));
      }
    }
  } catch {
    return candidates;
  }

  if (neighborFileKeys.size === 0) return candidates;

  const boosted: RankedResult[] = candidates.map((candidate, rank) => {
    if (rank < anchorLimit) return candidate;

    const candidateFiles = relatedFilesMap.get(candidate.memoryId) ?? [];
    const neighborOverlap = candidateFiles.filter((file) => {
      const key = normalizeFilePathKey(file);
      return neighborFileKeys.has(key) && !topFileKeys.has(key);
    }).length;
    if (neighborOverlap === 0) return candidate;

    const boostAmount = GRAPH_BOOST_FACTOR * (neighborOverlap / Math.max(topFiles.length, 1));
    return { ...candidate, score: candidate.score + boostAmount };
  });

  return boosted.sort((a, b) => b.score - a.score);
}

function normalizeRankedCandidates(candidates: RankedResult[]): RankedResult[] {
  const seen = new Set<string>();
  const normalized: RankedResult[] = [];

  for (const candidate of candidates) {
    const memoryId = normalizeMemoryId(candidate.memoryId);
    if (!memoryId || seen.has(memoryId) || !Number.isFinite(candidate.score)) {
      continue;
    }

    seen.add(memoryId);
    normalized.push({ ...candidate, memoryId });
    if (normalized.length >= MAX_GRAPH_BOOST_CANDIDATES) {
      break;
    }
  }

  return normalized;
}

function normalizeTopK(topK: number, candidateCount: number): number {
  if (!Number.isFinite(topK)) {
    return 0;
  }
  return Math.max(0, Math.min(candidateCount, Math.floor(topK)));
}

function normalizeMemoryId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseRelatedFiles(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const files: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const normalized = normalizeFilePath(item);
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      files.push(normalized);
      if (files.length >= MAX_GRAPH_BOOST_FILES_PER_MEMORY) {
        break;
      }
    }
    return files;
  } catch {
    return [];
  }
}

function normalizeFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFilePathKey(value: string): string {
  return value.toLowerCase();
}
