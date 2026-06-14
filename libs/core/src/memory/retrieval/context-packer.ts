/**
 * Phase-Aware Context Packer
 *
 * Packs retrieved memories into a formatted string respecting:
 *   - Per-phase token budgets
 *   - Per-type allocation ratios
 *   - MMR diversity filtering (skip near-duplicates with Jaccard > 0.85)
 *   - Citation chips: [^ Memory: citationText]
 */

import type { Memory, MemoryType, UniversalPhase } from '../types.js';

// ============================================================
// TYPES & CONFIG
// ============================================================

export interface ContextPackingConfig {
  totalBudget: number;
  allocation: Partial<Record<MemoryType, number>>;
}

export const DEFAULT_PACKING_CONFIG: Record<UniversalPhase, ContextPackingConfig> = {
  define: {
    totalBudget: 800,
    allocation: {
      workflow_recipe: 0.30,
      requirement: 0.20,
      decision: 0.20,
      dead_end: 0.15,
      task_calibration: 0.10,
    },
  },
  implement: {
    totalBudget: 900,
    allocation: {
      gotcha: 0.30,
      error_pattern: 0.25,
      causal_dependency: 0.15,
      pattern: 0.15,
      dead_end: 0.10,
    },
  },
  validate: {
    totalBudget: 800,
    allocation: {
      error_pattern: 0.30,
      requirement: 0.25,
      e2e_observation: 0.25,
      work_unit_outcome: 0.15,
    },
  },
  refine: {
    totalBudget: 700,
    allocation: {
      error_pattern: 0.35,
      gotcha: 0.25,
      dead_end: 0.20,
      pattern: 0.15,
    },
  },
  explore: {
    totalBudget: 700,
    allocation: {
      module_insight: 0.40,
      decision: 0.25,
      pattern: 0.20,
      causal_dependency: 0.15,
    },
  },
  reflect: {
    totalBudget: 500,
    allocation: {
      work_unit_outcome: 0.40,
      task_calibration: 0.35,
      dead_end: 0.15,
    },
  },
};

export const MAX_PACKED_MEMORY_CONTENT_CHARS = 420;
export const MAX_PACKED_MEMORY_CITATION_CHARS = 120;
export const MAX_PACKED_MEMORY_FILE_REF_CHARS = 80;
export const MIN_PACKED_MEMORY_CONFIDENCE = 0.55;
const PACKED_MEMORY_TRUNCATION_HEAD_RATIO = 0.65;

// ============================================================
// MAIN EXPORT
// ============================================================

/**
 * Pack memories into a formatted context string respecting token budgets.
 *
 * @param memories - Retrieved and reranked memories (already in priority order)
 * @param phase - Current agent phase for budget/allocation selection
 * @param config - Override default config for testing
 */
export function packContext(
  memories: Memory[],
  phase: UniversalPhase,
  config?: ContextPackingConfig,
): string {
  const packingConfig = config ?? DEFAULT_PACKING_CONFIG[phase];
  const { totalBudget, allocation } = packingConfig;

  // Group memories by type
  const byType = groupByType(memories);

  // Compute per-type token budgets
  const typeBudgets = computeTypeBudgets(totalBudget, allocation);

  // Pack each type's memories within its budget
  const sections: string[] = [];
  let totalUsed = 0;
  const globallyIncluded: string[] = [];

  for (const [memoryType, budget] of typeBudgets) {
    const typeMemories = byType.get(memoryType) ?? [];
    if (typeMemories.length === 0) continue;

    const remaining = totalBudget - totalUsed;
    const effectiveBudget = Math.min(budget, remaining);
    if (effectiveBudget <= 0) break;

    const { packed, tokensUsed } = packTypeMemories(
      typeMemories,
      effectiveBudget,
      memoryType,
      globallyIncluded,
    );

    if (packed.length > 0) {
      sections.push(...packed);
      totalUsed += tokensUsed;
    }

    if (totalUsed >= totalBudget) break;
  }

  // Include any memory types not in the allocation map (use remaining budget)
  const allocatedTypes = new Set(typeBudgets.keys());
  for (const [memoryType, typeMemories] of byType) {
    if (allocatedTypes.has(memoryType)) continue;

    const remaining = totalBudget - totalUsed;
    if (remaining <= 0) break;

    const { packed, tokensUsed } = packTypeMemories(
      typeMemories,
      remaining,
      memoryType,
      globallyIncluded,
    );

    if (packed.length > 0) {
      sections.push(...packed);
      totalUsed += tokensUsed;
    }
  }

  if (sections.length === 0) return '';

  return `## Relevant Context from Memory\n\n${sections.join('\n\n')}`;
}

// ============================================================
// PRIVATE HELPERS
// ============================================================

function groupByType(memories: Memory[]): Map<MemoryType, Memory[]> {
  const map = new Map<MemoryType, Memory[]>();
  for (const m of memories) {
    if (!isMemoryEligibleForPromptContext(m)) {
      continue;
    }
    const group = map.get(m.type) ?? [];
    group.push(m);
    map.set(m.type, group);
  }
  return map;
}

export function isMemoryEligibleForPromptContext(memory: Memory): boolean {
  if (memory.deprecated) {
    return false;
  }
  if (isStaleMemory(memory) && !memory.pinned && !memory.userVerified) {
    return false;
  }
  if (memory.needsReview && !memory.userVerified && !memory.pinned) {
    return false;
  }
  return memory.confidence >= MIN_PACKED_MEMORY_CONFIDENCE || memory.userVerified === true || memory.pinned === true;
}

function isStaleMemory(memory: Memory): boolean {
  if (!memory.staleAt) {
    return false;
  }
  const timestamp = Date.parse(memory.staleAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function computeTypeBudgets(
  totalBudget: number,
  allocation: Partial<Record<MemoryType, number>>,
): Map<MemoryType, number> {
  const budgets = new Map<MemoryType, number>();
  for (const [type, ratio] of Object.entries(allocation) as [MemoryType, number][]) {
    budgets.set(type, Math.floor(totalBudget * ratio));
  }
  return budgets;
}

interface PackResult {
  packed: string[];
  tokensUsed: number;
}

function packTypeMemories(
  memories: Memory[],
  budget: number,
  memoryType: MemoryType,
  globallyIncluded: string[],
): PackResult {
  const packed: string[] = [];
  let tokensUsed = 0;
  const included: string[] = []; // content strings for MMR dedup

  for (const memory of memories) {
    // Global diversity: avoid injecting the same lesson again under a
    // different memory type once it has already been packed for this prompt.
    if (isTooSimilar(memory.content, globallyIncluded)) continue;

    const formatted = formatMemory(memory, memoryType);
    const tokens = estimateTokens(formatted);

    if (tokensUsed + tokens > budget) {
      continue;
    }

    // MMR diversity: skip if too similar to already-included memories
    if (isTooSimilar(memory.content, included)) continue;

    packed.push(formatted);
    included.push(memory.content);
    globallyIncluded.push(memory.content);
    tokensUsed += tokens;
  }

  return { packed, tokensUsed };
}

function formatMemory(memory: Memory, memoryType: MemoryType): string {
  const typeLabel = formatTypeLabel(memoryType);
  const citation = memory.citationText
    ? `[^ Memory: ${truncateText(memory.citationText, MAX_PACKED_MEMORY_CITATION_CHARS)}]`
    : '';

  const fileContext =
    memory.relatedFiles.length > 0
      ? ` (${memory.relatedFiles
          .slice(0, 2)
          .map((file) => truncateText(file, MAX_PACKED_MEMORY_FILE_REF_CHARS))
          .join(', ')})`
      : '';

  const confidence =
    memory.confidence < 0.7 ? ` [confidence: ${(memory.confidence * 100).toFixed(0)}%]` : '';

  return [
    `**${typeLabel}**${fileContext}${confidence}`,
    truncateText(memory.content, MAX_PACKED_MEMORY_CONTENT_CHARS),
    citation,
  ]
    .filter(Boolean)
    .join('\n');
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  const marker = '... [memory middle omitted] ...';
  if (marker.length >= maxChars - 2) {
    return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const budget = maxChars - marker.length;
  const headLength = Math.ceil(budget * PACKED_MEMORY_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    compact.slice(0, headLength).trimEnd(),
    marker,
    tailLength > 0 ? compact.slice(-tailLength).trimStart() : '',
  ].join('');
}

function formatTypeLabel(type: MemoryType): string {
  const labels: Record<MemoryType, string> = {
    gotcha: 'Gotcha',
    decision: 'Decision',
    preference: 'Preference',
    pattern: 'Pattern',
    requirement: 'Requirement',
    error_pattern: 'Error Pattern',
    module_insight: 'Module Insight',
    prefetch_pattern: 'Prefetch Pattern',
    work_state: 'Work State',
    causal_dependency: 'Causal Dependency',
    task_calibration: 'Task Calibration',
    e2e_observation: 'E2E Observation',
    dead_end: 'Dead End',
    work_unit_outcome: 'Work Unit Outcome',
    workflow_recipe: 'Workflow Recipe',
    context_cost: 'Context Cost',
  };
  return labels[type] ?? type;
}

/**
 * Check if new content is too similar to any already-included content.
 * Uses simple Jaccard similarity on word sets as a lightweight MMR proxy.
 * Threshold: 0.85 similarity triggers skip.
 */
function isTooSimilar(content: string, included: string[]): boolean {
  if (included.length === 0) return false;

  const normalizedContent = normalizeForSimilarity(content);
  const newWords = new Set(tokenize(content));
  if (newWords.size === 0 && !normalizedContent) return false;

  for (const existingContent of included) {
    const normalizedExisting = normalizeForSimilarity(existingContent);
    if (normalizedContent && normalizedContent === normalizedExisting) {
      return true;
    }

    const existingWords = new Set(tokenize(existingContent));
    if (newWords.size === 0 || existingWords.size === 0) {
      continue;
    }
    const intersection = [...newWords].filter((w) => existingWords.has(w)).length;
    const union = new Set([...newWords, ...existingWords]).size;
    const jaccard = union === 0 ? 0 : intersection / union;

    if (jaccard > 0.85) return true;
  }

  return false;
}

function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinWords = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  return [...latinWords, ...cjkChars];
}

/**
 * Rough token estimation: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
