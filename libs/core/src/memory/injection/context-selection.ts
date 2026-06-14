import { createHash } from 'node:crypto';

import type { Memory } from '../types.js';

export interface MemoryContextSelectionOptions {
  maxItems: number;
  minConfidence?: number;
  similarityThreshold?: number;
  seenContents?: string[];
  seenFingerprints?: Set<string>;
}

interface RankedMemory {
  memory: Memory;
  fingerprint: string;
  rank: number;
  score: number;
}

const DEFAULT_CONTEXT_SIMILARITY_THRESHOLD = 0.68;
const MIN_SIMILARITY_TOKEN_UNION = 6;

export function selectMemoryContextItems(
  memories: Memory[],
  options: MemoryContextSelectionOptions,
): Memory[] {
  if (options.maxItems <= 0 || memories.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const byFingerprint = new Map<string, RankedMemory>();

  memories.forEach((memory, rank) => {
    if (memory.deprecated || seenIds.has(memory.id)) {
      return;
    }
    if (memory.needsReview && !memory.userVerified && !memory.pinned) {
      return;
    }
    if (isStaleMemory(memory) && !memory.userVerified && !memory.pinned) {
      return;
    }
    const trustedOverride = memory.userVerified === true || memory.pinned === true;
    if (options.minConfidence !== undefined && memory.confidence < options.minConfidence && !trustedOverride) {
      return;
    }

    seenIds.add(memory.id);
    const fingerprint = getMemoryContentFingerprint(memory);
    if (!fingerprint || options.seenFingerprints?.has(fingerprint)) {
      return;
    }

    const candidate: RankedMemory = {
      memory,
      fingerprint,
      rank,
      score: scoreMemoryForContext(memory),
    };
    const existing = byFingerprint.get(fingerprint);
    if (!existing || candidate.score > existing.score) {
      byFingerprint.set(fingerprint, candidate);
    }
  });

  const similarityThreshold = options.similarityThreshold ?? DEFAULT_CONTEXT_SIMILARITY_THRESHOLD;
  const selected: RankedMemory[] = [];
  for (const candidate of [...byFingerprint.values()].sort((a, b) => b.score - a.score || a.rank - b.rank)) {
    if (selected.length >= options.maxItems) {
      break;
    }
    if (
      isTooSimilarToSelected(candidate.memory.content, selected, similarityThreshold) ||
      isTooSimilarToContent(candidate.memory.content, options.seenContents ?? [], similarityThreshold)
    ) {
      continue;
    }
    selected.push(candidate);
  }

  for (const item of selected) {
    options.seenFingerprints?.add(item.fingerprint);
    options.seenContents?.push(item.memory.content);
  }

  return selected.map((item) => item.memory);
}

function scoreMemoryForContext(memory: Memory): number {
  const verifiedBoost = memory.userVerified ? 0.3 : 0;
  const pinnedBoost = memory.pinned ? 0.5 : 0;
  const accessBoost = Math.min(memory.accessCount || 0, 10) * 0.01;
  return memory.confidence + verifiedBoost + pinnedBoost + accessBoost;
}

function getMemoryContentFingerprint(memory: Memory): string {
  const normalized = memory.content
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized ? createHash('sha256').update(normalized, 'utf8').digest('hex') : '';
}

function isTooSimilarToSelected(
  content: string,
  selected: readonly RankedMemory[],
  threshold: number,
): boolean {
  if (selected.length === 0 || threshold >= 1) {
    return false;
  }

  const contentTokens = new Set(tokenizeForSimilarity(content));
  if (contentTokens.size === 0) {
    return false;
  }

  for (const existing of selected) {
    if (isTooSimilarToTokens(contentTokens, existing.memory.content, threshold)) {
      return true;
    }
  }

  return false;
}

function isTooSimilarToContent(
  content: string,
  existingContents: readonly string[],
  threshold: number,
): boolean {
  if (existingContents.length === 0 || threshold >= 1) {
    return false;
  }

  const contentTokens = new Set(tokenizeForSimilarity(content));
  if (contentTokens.size === 0) {
    return false;
  }

  return existingContents.some((existingContent) => isTooSimilarToTokens(
    contentTokens,
    existingContent,
    threshold,
  ));
}

function isTooSimilarToTokens(
  contentTokens: Set<string>,
  existingContent: string,
  threshold: number,
): boolean {
  const existingTokens = new Set(tokenizeForSimilarity(existingContent));
  if (existingTokens.size === 0) {
    return false;
  }

  const union = new Set([...contentTokens, ...existingTokens]).size;
  if (union < MIN_SIMILARITY_TOKEN_UNION) {
    return false;
  }

  const intersection = [...contentTokens].filter((token) => existingTokens.has(token)).length;
  return intersection / union >= threshold;
}

function tokenizeForSimilarity(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinWords = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  return [...latinWords, ...cjkChars];
}

function isStaleMemory(memory: Memory): boolean {
  if (!memory.staleAt) {
    return false;
  }
  const timestamp = Date.parse(memory.staleAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}
