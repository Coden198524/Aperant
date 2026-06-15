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
import { stripLowValueMemoryLines } from '../outcome-content.js';

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
export const MAX_PROMPT_CONTEXT_MEMORIES = 20;
const PACKED_MEMORY_TRUNCATION_HEAD_RATIO = 0.65;
const PACKED_MEMORY_HEADER = '## Relevant Context from Memory';
const MIN_COMPACT_MEMORY_CONTENT_TOKENS = 12;
const MIN_COMPACT_MEMORY_TOTAL_TOKENS = 18;
const MAX_PACKED_MEMORY_FILE_CONTEXT_REFS = 2;
const MAX_PREFETCH_PATTERN_PROMPT_FILES = 4;

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
  const packingConfig = normalizePackingConfig(config ?? DEFAULT_PACKING_CONFIG[phase]);
  const { totalBudget, allocation } = packingConfig;
  const headerTokens = estimateTokens(`${PACKED_MEMORY_HEADER}\n\n`);
  if (totalBudget <= headerTokens) {
    return '';
  }

  // Group memories by type
  const byType = groupByType(memories);

  // Compute per-type token budgets
  const typeBudgets = computeTypeBudgets(totalBudget, allocation);

  // Pack each type's memories within its budget
  const state: PackState = {
    sections: [],
    tokensUsed: headerTokens,
    globallyIncluded: [],
  };

  for (const [memoryType, budget] of typeBudgets) {
    const typeMemories = byType.get(memoryType) ?? [];
    if (typeMemories.length === 0) continue;

    const remaining = totalBudget - state.tokensUsed;
    const effectiveBudget = Math.min(budget, remaining);
    if (effectiveBudget <= 0) break;

    packTypeMemories(
      typeMemories,
      effectiveBudget,
      totalBudget,
      memoryType,
      state,
    );

    if (state.tokensUsed >= totalBudget) break;
  }

  // Reclaim unused allocation from missing or sparse types before considering
  // unallocated memory types. This keeps phase-prioritized memories useful
  // without letting them exceed the total prompt budget.
  for (const memoryType of typeBudgets.keys()) {
    const typeMemories = byType.get(memoryType) ?? [];
    if (typeMemories.length === 0) continue;

    const remaining = totalBudget - state.tokensUsed;
    if (remaining <= 0) break;

    packTypeMemories(
      typeMemories,
      remaining,
      totalBudget,
      memoryType,
      state,
    );
  }

  // Include any memory types not in the allocation map (use remaining budget)
  const allocatedTypes = new Set(typeBudgets.keys());
  for (const [memoryType, typeMemories] of byType) {
    if (allocatedTypes.has(memoryType)) continue;
    if (isDefaultPromptExcludedMemoryType(memoryType)) continue;

    const remaining = totalBudget - state.tokensUsed;
    if (remaining <= 0) break;

    packTypeMemories(
      typeMemories,
      remaining,
      totalBudget,
      memoryType,
      state,
    );
  }

  if (state.sections.length === 0) return '';

  return `${PACKED_MEMORY_HEADER}\n\n${state.sections.join('\n\n')}`;
}

// ============================================================
// PRIVATE HELPERS
// ============================================================

function groupByType(memories: Memory[]): Map<MemoryType, Memory[]> {
  const map = new Map<MemoryType, Memory[]>();
  for (const m of normalizePromptMemories(memories)) {
    if (!isNormalizedMemoryEligibleForMemoryUse(m)) {
      continue;
    }
    const group = map.get(m.type) ?? [];
    if (group.length >= MAX_PROMPT_CONTEXT_MEMORIES) {
      continue;
    }
    group.push(m);
    map.set(m.type, group);
  }
  return map;
}

function isDefaultPromptExcludedMemoryType(memoryType: MemoryType): boolean {
  return memoryType === 'prefetch_pattern' || memoryType === 'context_cost';
}

export function isMemoryEligibleForPromptContext(memory: Memory): boolean {
  const normalized = normalizePromptMemory(memory);
  if (!normalized) {
    return false;
  }
  return (
    !isDefaultPromptExcludedMemoryType(normalized.type) &&
    isNormalizedMemoryEligibleForMemoryUse(normalized)
  );
}

export function isMemoryEligibleForAutomationContext(memory: Memory): boolean {
  const normalized = normalizePromptMemory(memory);
  if (!normalized) {
    return false;
  }
  return isNormalizedMemoryEligibleForMemoryUse(normalized);
}

export function formatMemoryContentForPrompt(
  memory: Memory,
  maxChars = MAX_PACKED_MEMORY_CONTENT_CHARS,
): string {
  return truncateText(getMemoryPromptContent(memory), maxChars);
}

function isNormalizedMemoryEligibleForMemoryUse(memory: Memory): boolean {
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

interface PackState {
  sections: string[];
  tokensUsed: number;
  globallyIncluded: string[];
}

function packTypeMemories(
  memories: Memory[],
  budget: number,
  totalBudget: number,
  memoryType: MemoryType,
  state: PackState,
): void {
  let typeTokensUsed = 0;
  const included: string[] = []; // prompt content strings for MMR dedup
  const oversized: Memory[] = [];

  for (const memory of memories) {
    const dedupeContent = getMemoryPromptContent(memory);
    // Global diversity: avoid injecting the same lesson again under a
    // different memory type once it has already been packed for this prompt.
    if (isTooSimilar(dedupeContent, state.globallyIncluded)) continue;

    const formatted = formatMemory(memory, memoryType);
    const tokens = estimateTokens(formatted);
    const separatorTokens = state.sections.length === 0 ? 0 : estimateTokens('\n\n');
    const availableTokens = Math.min(
      budget - typeTokensUsed,
      totalBudget - state.tokensUsed - separatorTokens,
    );

    if (availableTokens <= 0) {
      break;
    }

    if (tokens > availableTokens) {
      oversized.push(memory);
      continue;
    }

    // MMR diversity: skip if too similar to already-included memories
    if (isTooSimilar(dedupeContent, included)) continue;

    packFormattedMemory(formatted, dedupeContent, tokens, separatorTokens, state);
    included.push(dedupeContent);
    typeTokensUsed += separatorTokens + tokens;
  }

  for (const memory of oversized) {
    const dedupeContent = getMemoryPromptContent(memory);
    if (isTooSimilar(dedupeContent, state.globallyIncluded)) continue;
    if (isTooSimilar(dedupeContent, included)) continue;

    const separatorTokens = state.sections.length === 0 ? 0 : estimateTokens('\n\n');
    const availableTokens = Math.min(
      budget - typeTokensUsed,
      totalBudget - state.tokensUsed - separatorTokens,
    );
    const formatted = formatMemoryWithinTokenBudget(memory, memoryType, availableTokens);
    if (!formatted) {
      continue;
    }

    const tokens = estimateTokens(formatted);
    if (tokens > availableTokens) {
      continue;
    }

    packFormattedMemory(formatted, dedupeContent, tokens, separatorTokens, state);
    included.push(dedupeContent);
    typeTokensUsed += separatorTokens + tokens;
  }
}

function packFormattedMemory(
  formatted: string,
  dedupeContent: string,
  tokens: number,
  separatorTokens: number,
  state: PackState,
): void {
  state.sections.push(formatted);
  state.globallyIncluded.push(dedupeContent);
  state.tokensUsed += separatorTokens + tokens;
}

interface FormatMemoryOptions {
  contentMaxChars?: number;
  citationMaxChars?: number;
  fileRefMaxChars?: number;
  includeCitation?: boolean;
  includeFileContext?: boolean;
  includeConfidence?: boolean;
}

function formatMemory(
  memory: Memory,
  memoryType: MemoryType,
  options: FormatMemoryOptions = {},
): string {
  const {
    contentMaxChars = MAX_PACKED_MEMORY_CONTENT_CHARS,
    citationMaxChars = MAX_PACKED_MEMORY_CITATION_CHARS,
    fileRefMaxChars = MAX_PACKED_MEMORY_FILE_REF_CHARS,
    includeCitation = true,
    includeFileContext = true,
    includeConfidence = true,
  } = options;
  const typeLabel = formatTypeLabel(memoryType);
  const promptContent = getMemoryPromptContent(memory);
  const content = truncateText(promptContent, contentMaxChars);
  const citation = includeCitation &&
    memory.citationText &&
    !isRedundantCitation(memory.citationText, promptContent)
    ? `[^ Memory: ${truncateText(memory.citationText, citationMaxChars)}]`
    : '';

  const fileContext = includeFileContext
    ? formatMemoryFileContext(memory.relatedFiles, `${content} ${citation}`, fileRefMaxChars)
    : '';

  const confidence =
    includeConfidence && memory.confidence < 0.7
      ? ` [confidence: ${(memory.confidence * 100).toFixed(0)}%]`
      : '';

  return [
    `**${typeLabel}**${fileContext}${confidence}`,
    content,
    citation,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatMemoryFileContext(
  files: readonly string[],
  content: string,
  fileRefMaxChars: number,
): string {
  const visibleFiles = files
    .filter((file) => !isPromptPathMentionedInText(file, content))
    .slice(0, MAX_PACKED_MEMORY_FILE_CONTEXT_REFS)
    .map((file) => truncatePathTail(file, fileRefMaxChars));
  return visibleFiles.length > 0 ? ` (${visibleFiles.join(', ')})` : '';
}

function isPromptPathMentionedInText(path: string, text: string): boolean {
  const normalizedText = normalizePromptTextForPathMatch(text);
  if (!normalizedText) {
    return false;
  }

  const normalizedPath = normalizePromptTextForPathMatch(path);
  const fileName = normalizePromptTextForPathMatch(path.split('/').pop() ?? path);
  return normalizedText.includes(normalizedPath) ||
    (fileName.length > 0 && containsStandalonePromptPathName(normalizedText, fileName));
}

function containsStandalonePromptPathName(text: string, pathName: string): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escapePromptRegExp(pathName)}(?:$|[^a-z0-9_.-])`,
  ).test(text);
}

function escapePromptRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePromptTextForPathMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRedundantCitation(citationText: string, promptContent: string): boolean {
  const normalizedCitation = normalizeForSimilarity(citationText);
  const normalizedContent = normalizeForSimilarity(promptContent);
  if (!normalizedCitation || !normalizedContent) {
    return false;
  }
  if (normalizedCitation === normalizedContent) {
    return true;
  }
  return isTooSimilar(citationText, [promptContent]);
}

function formatMemoryWithinTokenBudget(
  memory: Memory,
  memoryType: MemoryType,
  tokenBudget: number,
): string | undefined {
  if (tokenBudget < MIN_COMPACT_MEMORY_TOTAL_TOKENS) {
    return undefined;
  }

  const attempts: FormatMemoryOptions[] = [
    {
      contentMaxChars: Math.floor(MAX_PACKED_MEMORY_CONTENT_CHARS * 0.7),
      citationMaxChars: Math.floor(MAX_PACKED_MEMORY_CITATION_CHARS * 0.6),
      fileRefMaxChars: Math.floor(MAX_PACKED_MEMORY_FILE_REF_CHARS * 0.7),
    },
    {
      contentMaxChars: Math.floor(MAX_PACKED_MEMORY_CONTENT_CHARS * 0.5),
      citationMaxChars: 0,
      fileRefMaxChars: Math.floor(MAX_PACKED_MEMORY_FILE_REF_CHARS * 0.5),
      includeCitation: false,
    },
    {
      contentMaxChars: Math.floor(MAX_PACKED_MEMORY_CONTENT_CHARS * 0.35),
      includeCitation: false,
      includeFileContext: false,
    },
  ];

  for (const options of attempts) {
    const formatted = formatMemory(memory, memoryType, options);
    if (estimateTokens(formatted) <= tokenBudget) {
      return formatted;
    }
  }

  const typeLabel = formatTypeLabel(memoryType);
  const header = `**${typeLabel}**`;
  const contentTokenBudget = tokenBudget - estimateTokens(`${header}\n`);
  if (contentTokenBudget < MIN_COMPACT_MEMORY_CONTENT_TOKENS) {
    return undefined;
  }

  const content = truncateTextToTokenBudget(
    getMemoryPromptContent(memory),
    contentTokenBudget,
    MAX_PACKED_MEMORY_CONTENT_CHARS,
  );
  if (!content) {
    return undefined;
  }

  const formatted = `${header}\n${content}`;
  return estimateTokens(formatted) <= tokenBudget ? formatted : undefined;
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

function getMemoryPromptContent(memory: Memory): string {
  if (memory.type === 'prefetch_pattern') {
    return formatPrefetchPatternForPrompt(memory) ?? stripLowValueMemoryLines(memory.content);
  }
  return stripLowValueMemoryLines(memory.content);
}

function formatPrefetchPatternForPrompt(memory: Memory): string | undefined {
  const parsed = parsePrefetchPatternContent(memory.content);
  const alwaysReadFiles = parsed?.alwaysReadFiles ?? [];
  const frequentlyReadFiles = parsed?.frequentlyReadFiles ?? [];
  const lines: string[] = [];

  if (alwaysReadFiles.length > 0) {
    lines.push(`Always prefetch: ${formatPrefetchFileList(alwaysReadFiles)}`);
  }
  if (frequentlyReadFiles.length > 0) {
    lines.push(`Prefetch together: ${formatPrefetchFileList(frequentlyReadFiles)}`);
  }
  if (lines.length === 0 && memory.relatedFiles.length > 0) {
    lines.push(`Prefetch candidates: ${formatPrefetchFileList(memory.relatedFiles)}`);
  }

  return lines.length > 0 ? lines.join('; ') : undefined;
}

interface ParsedPrefetchPatternContent {
  alwaysReadFiles: string[];
  frequentlyReadFiles: string[];
}

function parsePrefetchPatternContent(content: string): ParsedPrefetchPatternContent | undefined {
  try {
    const parsed = JSON.parse(content) as {
      alwaysReadFiles?: unknown;
      frequentlyReadFiles?: unknown;
    };
    const alwaysReadFiles = parsePrefetchFileArray(parsed.alwaysReadFiles);
    return {
      alwaysReadFiles,
      frequentlyReadFiles: excludePromptPaths(
        parsePrefetchFileArray(parsed.frequentlyReadFiles),
        alwaysReadFiles,
      ),
    };
  } catch {
    return undefined;
  }
}

function parsePrefetchFileArray(value: unknown): string[] {
  return Array.isArray(value)
    ? normalizePromptPathList(value)
    : [];
}

function excludePromptPaths(files: readonly string[], excludedFiles: readonly string[]): string[] {
  const excludedKeys = new Set(excludedFiles.map((file) => file.toLowerCase()));
  return files.filter((file) => !excludedKeys.has(file.toLowerCase()));
}

function formatPrefetchFileList(files: readonly string[]): string {
  const uniqueFiles = normalizePromptPathList(files);
  const visible = uniqueFiles
    .slice(0, MAX_PREFETCH_PATTERN_PROMPT_FILES)
    .map((file) => truncatePathTail(file, MAX_PACKED_MEMORY_FILE_REF_CHARS));
  const omitted = Math.max(0, uniqueFiles.length - visible.length);
  return `${visible.join(', ')}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
}

function truncatePathTail(path: string, maxChars: number): string {
  const normalized = normalizePromptPath(path) ?? '';
  if (maxChars <= 0) {
    return '';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-maxChars).replace(/^\/+/, '');
}

function truncateTextToTokenBudget(
  text: string,
  maxTokens: number,
  maxChars: number,
): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact || maxTokens <= 0 || maxChars <= 0) {
    return '';
  }

  const initial = truncateText(compact, Math.min(maxChars, compact.length));
  if (estimateTokens(initial) <= maxTokens) {
    return initial;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateText(compact, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
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
 * Rough token estimation for prompt budgeting.
 * Latin text is usually close to 4 characters per token, while CJK text is
 * often much denser. Use a conservative mixed-script estimate so localized
 * memory content does not silently exceed the intended context budget.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let latinLikeChars = 0;
  let cjkChars = 0;
  let otherNonAsciiChars = 0;

  for (const char of text) {
    if (isCjkPromptChar(char)) {
      cjkChars += 1;
      continue;
    }
    if (char.charCodeAt(0) <= 0x7f) {
      latinLikeChars += 1;
      continue;
    }
    otherNonAsciiChars += 1;
  }

  return Math.ceil((latinLikeChars / 4) + cjkChars + (otherNonAsciiChars / 2));
}

function isCjkPromptChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function normalizePackingConfig(config: ContextPackingConfig): ContextPackingConfig {
  const totalBudget = Number.isFinite(config.totalBudget)
    ? Math.max(0, Math.floor(config.totalBudget))
    : 0;
  const allocation: Partial<Record<MemoryType, number>> = {};
  let allocationTotal = 0;

  for (const [type, ratio] of Object.entries(config.allocation ?? {}) as [MemoryType, number][]) {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      continue;
    }
    const normalizedRatio = Math.min(1, ratio);
    allocation[type] = normalizedRatio;
    allocationTotal += normalizedRatio;
  }

  if (allocationTotal > 1) {
    for (const type of Object.keys(allocation) as MemoryType[]) {
      allocation[type] = (allocation[type] ?? 0) / allocationTotal;
    }
  }

  return { totalBudget, allocation };
}

function normalizePromptMemories(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  const normalizedMemories: Memory[] = [];

  for (const memory of memories) {
    const normalized = normalizePromptMemory(memory);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }

    seen.add(normalized.id);
    normalizedMemories.push(normalized);
  }

  return normalizedMemories;
}

function normalizePromptMemory(memory: Memory): Memory | undefined {
  const id = normalizePromptText(memory.id);
  const rawContent = memory.type === 'context_cost'
    ? memory.content
    : stripLowValueMemoryLines(memory.content);
  const content = normalizePromptText(rawContent);
  if (!id || !content) {
    return undefined;
  }

  const confidence = normalizePromptConfidence(memory.confidence);
  if (confidence === undefined && !memory.userVerified && !memory.pinned) {
    return undefined;
  }

  return {
    ...memory,
    id,
    content,
    confidence: confidence ?? 0,
    relatedFiles: normalizePromptPathList(memory.relatedFiles),
    relatedModules: normalizePromptTextList(memory.relatedModules),
    tags: normalizePromptTextList(memory.tags),
    citationText: normalizePromptText(memory.citationText),
  };
}

function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePromptTextList(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];

  for (const value of values) {
    const normalized = typeof value === 'string' ? normalizePromptText(value) : undefined;
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

function normalizePromptPathList(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];

  for (const value of values) {
    const normalized = typeof value === 'string'
      ? normalizePromptPath(value)
      : undefined;
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

function normalizePromptPath(value: string): string | undefined {
  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePromptConfidence(value: unknown): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value as number));
}
