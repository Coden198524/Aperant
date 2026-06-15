/**
 * search_memory Agent Tool
 *
 * Allows agents to explicitly search the memory system during a session.
 * Sends an IPC request to the main thread's MemoryService and returns
 * formatted results.
 *
 * This tool is available only when a WorkerObserverProxy is injected.
 * Sessions without memory support get a no-op stub.
 */

import { tool } from 'ai';
import { z } from 'zod/v3';
import type { Tool as AITool } from 'ai';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory, MemoryType, MemorySearchFilters } from '../types';
import {
  estimateTokens,
  formatMemoryContentForPrompt,
  isMemoryEligibleForAutomationContext,
  isMemoryEligibleForPromptContext,
} from '../retrieval/context-packer';

const DEFAULT_SEARCH_LIMIT = 3;
const MAX_SEARCH_LIMIT = 8;
const MAX_MEMORY_RESULT_CHARS = 360;
const MAX_SEARCH_OUTPUT_CHARS = 1800;
const MAX_SEARCH_QUERY_ECHO_CHARS = 160;
const MAX_SEARCH_FILE_REFS = 3;
const MAX_SEARCH_FILE_REF_CHARS = 36;
const MAX_SEARCH_QUERY_CHARS = 360;
const MAX_SEARCH_RELATED_FILES = 8;
const MAX_SEARCH_RELATED_FILE_CHARS = 160;
const MAX_MEMORY_RESULT_TOKENS = Math.ceil(MAX_MEMORY_RESULT_CHARS / 4);
const MAX_SEARCH_OUTPUT_TOKENS = Math.ceil(MAX_SEARCH_OUTPUT_CHARS / 4);
const MAX_SEARCH_QUERY_ECHO_TOKENS = Math.ceil(MAX_SEARCH_QUERY_ECHO_CHARS / 4);
const SEARCH_RESULT_SIMILARITY_THRESHOLD = 0.82;
const MIN_SEARCH_RESULT_SIMILARITY_TOKEN_UNION = 6;
const CONTEXT_COST_SEARCH_QUERY_PATTERN = new RegExp(
  [
    'context window',
    'prompt tokens?',
    'input tokens?',
    'token usage',
    'token cost',
    'context cost',
    'high token',
    'reduce tokens?',
    'too many tokens?',
    'expensive context',
  ].join('|'),
  'i',
);
const LOCALIZED_CONTEXT_COST_SEARCH_QUERY_PATTERN = new RegExp(
  [
    '上下文窗口',
    '上下文成本',
    '上下文(?:过大|太大|爆|满|超|长度|token)',
    'token\\s*(?:成本|消耗|用量|过高|太多)',
    '减少\\s*token',
    '降低\\s*token',
    '节省\\s*token',
    '压缩\\s*token',
    '提示词\\s*token',
    '输入\\s*token',
  ].join('|'),
  'i',
);
const PREFETCH_PATTERN_SEARCH_QUERY_PATTERN = new RegExp(
  [
    'prefetch',
    'file access patterns?',
    'read together',
    'files? to (?:read|inspect|open|check)',
    '(?:which|what) files? (?:should i |do i need to |to )?(?:read|inspect|open|check)',
    '(?:read|inspect|open|check) first',
    'where to start',
    'entry points?',
  ].join('|'),
  'i',
);
const LOCALIZED_PREFETCH_PATTERN_SEARCH_QUERY_PATTERN = new RegExp(
  [
    '预取',
    '文件访问模式',
    '文件访问规律',
    '一起读',
    '该先?(?:读|看|打开|检查)哪些文件',
    '哪些文件(?:需要|应该|要)?(?:读|看|打开|检查)',
    '先(?:读|看|打开|检查)哪些文件',
    '从哪里开始(?:读|看|检查)',
    '入口文件',
  ].join('|'),
  'i',
);

// ============================================================
// INPUT SCHEMA
// ============================================================

const searchMemorySchema = z.object({
  query: z
    .string()
    .describe(
      'Search query describing what you are looking for (e.g., "how to handle auth errors", "file access patterns for auth module")',
    ),
  types: z
    .array(
      z.enum([
        'gotcha',
        'decision',
        'preference',
        'pattern',
        'requirement',
        'error_pattern',
        'module_insight',
        'prefetch_pattern',
        'work_state',
        'causal_dependency',
        'task_calibration',
        'e2e_observation',
        'dead_end',
        'work_unit_outcome',
        'workflow_recipe',
        'context_cost',
      ]),
    )
    .optional()
    .describe('Optional: filter by memory type(s)'),
  relatedFiles: z
    .array(z.string())
    .optional()
    .describe('Optional: filter memories related to specific files'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .default(DEFAULT_SEARCH_LIMIT)
    .describe('Maximum number of results to return (default 3, max 8)'),
});

type SearchMemoryInput = z.infer<typeof searchMemorySchema>;

// ============================================================
// FACTORY
// ============================================================

/**
 * Create a `search_memory` AI SDK tool bound to a WorkerObserverProxy.
 *
 * @param proxy - The worker-side memory IPC proxy
 * @param projectId - Project identifier for scoping results
 */
export function createSearchMemoryTool(
  proxy: WorkerObserverProxy,
  projectId: string,
): AITool<SearchMemoryInput, string> {
  return tool({
    description:
      'Search the persistent memory system for relevant context, gotchas, decisions, file prefetch/file access patterns, token/context cost lessons, and patterns from previous sessions. Use this when you are unsure how something was done before, need to know which files to inspect first, or want to check known pitfalls before making a change.',
    inputSchema: searchMemorySchema,
    execute: async (input: SearchMemoryInput): Promise<string> => {
      const query = normalizeSearchQuery(input.query);
      if (!query) {
        return 'No memory search run: provide a specific query.';
      }
      const types = inferSearchTypes(query, input.types as MemoryType[] | undefined);

      const filters: MemorySearchFilters = {
        query,
        types,
        relatedFiles: normalizeRelatedFiles(input.relatedFiles),
        limit: Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
        projectId,
        excludeDeprecated: true,
        promptContextOnly: shouldSearchPromptContextOnly(types),
        recordAccess: true,
      };

      const memories = dedupeMemories(
        (await proxy.searchMemory(filters)).filter(isMemoryEligibleForSearchMemoryResult),
      );

      if (memories.length === 0) {
        return formatNoSearchMemoryResults(types);
      }

      return formatSearchMemoryOutput(query, memories);
    },
  });
}

/**
 * Create a no-op stub `search_memory` tool for sessions without memory support.
 */
export function createSearchMemoryStub(): AITool<SearchMemoryInput, string> {
  return tool({
    description: 'Search the memory system (memory not available in this session).',
    inputSchema: searchMemorySchema,
    execute: async (_input: SearchMemoryInput): Promise<string> => {
      return 'Memory system not available in this session.';
    },
  });
}

function dedupeMemories(memories: Memory[]): Memory[] {
  const selected: SelectedSearchMemory[] = [];
  const keyToIndex = new Map<string, number>();
  for (const memory of memories) {
    const promptContent = formatSearchMemoryContent(memory);
    const key = normalizeContent(promptContent);
    if (!key) {
      continue;
    }
    const tokens = new Set(tokenizeContent(promptContent));
    const existingIndex = keyToIndex.get(key);
    if (existingIndex !== undefined) {
      if (isHigherQualitySearchMemory(memory, selected[existingIndex].memory)) {
        selected[existingIndex] = { memory, tokens, key };
      }
      continue;
    }

    const similarIndex = findSimilarSelectedSearchMemoryIndex(tokens, selected);
    if (similarIndex !== undefined) {
      if (isHigherQualitySearchMemory(memory, selected[similarIndex].memory)) {
        keyToIndex.delete(selected[similarIndex].key);
        keyToIndex.set(key, similarIndex);
        selected[similarIndex] = { memory, tokens, key };
      }
      continue;
    }
    keyToIndex.set(key, selected.length);
    selected.push({ memory, tokens, key });
  }
  return selected.map((item) => item.memory);
}

interface SelectedSearchMemory {
  memory: Memory;
  tokens: Set<string>;
  key: string;
}

function isHigherQualitySearchMemory(candidate: Memory, existing: Memory): boolean {
  return scoreSearchMemory(candidate) > scoreSearchMemory(existing);
}

function scoreSearchMemory(memory: Memory): number {
  const verifiedBoost = memory.userVerified ? 0.3 : 0;
  const pinnedBoost = memory.pinned ? 0.5 : 0;
  const accessBoost = Math.min(memory.accessCount || 0, 10) * 0.01;
  return memory.confidence + verifiedBoost + pinnedBoost + accessBoost;
}

function shouldSearchPromptContextOnly(types: MemoryType[] | undefined): boolean {
  return !types?.some(isMachineReadableSearchMemoryType);
}

function formatNoSearchMemoryResults(types: MemoryType[] | undefined): string {
  const machineKinds = uniqueInOrder(
    types
      ?.filter(isMachineReadableSearchMemoryType)
      .map(formatMachineSearchMemoryKind),
  );
  if (!machineKinds || machineKinds.length === 0) {
    return 'No relevant memories found for this query.';
  }
  return `No relevant ${machineKinds.join('/')} memories found; continue with focused inspection instead of repeating this search.`;
}

function inferSearchTypes(query: string, requestedTypes: MemoryType[] | undefined): MemoryType[] | undefined {
  const types = uniqueInOrder(requestedTypes);
  if (types) {
    return types;
  }

  const inferredTypes: MemoryType[] = [];
  if (isContextCostSearchQuery(query)) {
    inferredTypes.push('context_cost');
  }
  if (isPrefetchPatternSearchQuery(query)) {
    inferredTypes.push('prefetch_pattern');
  }
  return inferredTypes.length > 0 ? inferredTypes : undefined;
}

function isContextCostSearchQuery(query: string): boolean {
  return CONTEXT_COST_SEARCH_QUERY_PATTERN.test(query)
    || LOCALIZED_CONTEXT_COST_SEARCH_QUERY_PATTERN.test(query);
}

function isPrefetchPatternSearchQuery(query: string): boolean {
  return PREFETCH_PATTERN_SEARCH_QUERY_PATTERN.test(query)
    || LOCALIZED_PREFETCH_PATTERN_SEARCH_QUERY_PATTERN.test(query);
}

function isMemoryEligibleForSearchMemoryResult(memory: Memory): boolean {
  return isMachineReadableSearchMemoryType(memory.type)
    ? isMemoryEligibleForAutomationContext(memory)
    : isMemoryEligibleForPromptContext(memory);
}

function isMachineReadableSearchMemoryType(type: MemoryType): boolean {
  return type === 'prefetch_pattern' || type === 'context_cost';
}

function formatMachineSearchMemoryKind(type: MemoryType): string {
  switch (type) {
    case 'context_cost':
      return 'token-cost';
    case 'prefetch_pattern':
      return 'file-prefetch';
    default:
      return type;
  }
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9_\u3400-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeContent(content: string): string[] {
  const normalized = content.toLowerCase();
  const latinWords = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  return [...latinWords, ...cjkChars];
}

function findSimilarSelectedSearchMemoryIndex(
  tokens: Set<string>,
  selected: readonly SelectedSearchMemory[],
): number | undefined {
  if (tokens.size === 0) {
    return undefined;
  }

  for (let index = 0; index < selected.length; index += 1) {
    const seen = selected[index].tokens;
    const union = new Set([...tokens, ...seen]).size;
    if (union < MIN_SEARCH_RESULT_SIMILARITY_TOKEN_UNION) {
      continue;
    }
    const intersection = [...tokens].filter((token) => seen.has(token)).length;
    if (intersection / union >= SEARCH_RESULT_SIMILARITY_THRESHOLD) {
      return index;
    }
  }

  return undefined;
}

function normalizeSearchQuery(query: string): string {
  return truncateTextToBudget(
    query.replace(/\s+/g, ' ').trim(),
    MAX_SEARCH_QUERY_CHARS,
    Math.ceil(MAX_SEARCH_QUERY_CHARS / 4),
    { preserveTail: true },
  );
}

function normalizeRelatedFiles(files: string[] | undefined): string[] | undefined {
  if (!files) {
    return undefined;
  }

  return uniquePathRefs(
    files.map((file) => truncatePathTail(normalizeToolPath(file), MAX_SEARCH_RELATED_FILE_CHARS)),
  ).slice(0, MAX_SEARCH_RELATED_FILES);
}

function uniqueInOrder<T>(values: T[] | undefined): T[] | undefined {
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

function formatSearchMemoryOutput(query: string, memories: Memory[]): string {
  const header = `Memory search results for "${truncateTextToBudget(
    query,
    MAX_SEARCH_QUERY_ECHO_CHARS,
    MAX_SEARCH_QUERY_ECHO_TOKENS,
    { preserveTail: true },
  )}":`;
  const lines: string[] = [];
  let omitted = 0;

  for (const memory of memories) {
    const line = formatSearchMemoryResult(memory, lines.length + 1);
    const candidate = `${header}\n\n${[...lines, line].join('\n\n')}`;
    if (fitsSearchOutputBudget(candidate)) {
      lines.push(line);
    } else {
      omitted += 1;
    }
  }

  let output = `${header}\n\n${lines.join('\n\n')}`;
  if (omitted > 0) {
    const note = `... ${omitted} more memory result(s) omitted for output budget.`;
    const withNote = `${output}\n\n${note}`;
    if (fitsSearchOutputBudget(withNote)) {
      output = withNote;
    }
  }

  return truncateTextToBudget(output, MAX_SEARCH_OUTPUT_CHARS, MAX_SEARCH_OUTPUT_TOKENS, { preserveTail: true });
}

function formatSearchMemoryResult(memory: Memory, index: number): string {
  const fileRef = shouldShowSearchMemoryFileRefs(memory)
    ? formatFileRefs(memory.relatedFiles)
    : '';
  const confidence = formatConfidenceHint(memory);
  return `${index}. [${memory.type}]${fileRef}${confidence}\n   ${formatSearchMemoryContent(memory)}`;
}

function shouldShowSearchMemoryFileRefs(memory: Memory): boolean {
  return memory.type !== 'prefetch_pattern';
}

function formatSearchMemoryContent(memory: Memory): string {
  return truncateTextToBudget(
    formatMemoryContentForPrompt(memory, Number.MAX_SAFE_INTEGER),
    MAX_MEMORY_RESULT_CHARS,
    MAX_MEMORY_RESULT_TOKENS,
    { preserveTail: true },
  );
}

function formatConfidenceHint(memory: Memory): string {
  return memory.confidence < 0.7
    ? ` [confidence: ${(memory.confidence * 100).toFixed(0)}%]`
    : '';
}

function formatFileRefs(files: readonly string[]): string {
  const uniqueFiles = uniquePathRefs(files.map(normalizeToolPath));
  if (uniqueFiles.length === 0) {
    return '';
  }

  const visible = uniqueFiles
    .slice(0, MAX_SEARCH_FILE_REFS)
    .map((file) => truncateText(file.split(/[\\/]/).pop() || file, MAX_SEARCH_FILE_REF_CHARS));
  const omitted = uniqueFiles.length - visible.length;
  if (omitted > 0) {
    visible.push(`+${omitted} more`);
  }

  return ` [${visible.join(', ')}]`;
}

function uniquePathRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeToolPath(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function normalizeToolPath(path: string): string {
  let normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/$/, '');
}

function fitsSearchOutputBudget(text: string): boolean {
  return text.length <= MAX_SEARCH_OUTPUT_CHARS && estimateTokens(text) <= MAX_SEARCH_OUTPUT_TOKENS;
}

function truncatePathTail(path: string, maxChars: number): string {
  const normalized = path.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-Math.max(0, maxChars)).replace(/^\/+/, '');
}

function truncateTextToBudget(
  text: string,
  maxChars: number,
  maxTokens: number,
  options: { preserveTail?: boolean } = {},
): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0 || maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const charBounded = truncateText(compact, maxChars, options);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateText(compact, midpoint, options);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function truncateText(text: string, maxChars: number, options: { preserveTail?: boolean } = {}): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (options.preserveTail) {
    return truncateHeadTailText(compact, maxChars);
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncateHeadTailText(text: string, maxChars: number): string {
  const marker = ' ... [middle omitted] ... ';
  if (maxChars <= marker.length + 24) {
    return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }
  const budget = maxChars - marker.length;
  const headBudget = Math.ceil(budget * 0.62);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${text.slice(0, headBudget).trimEnd()}${marker}${text.slice(-tailBudget).trimStart()}`;
}
