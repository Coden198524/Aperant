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
import { foldRepeatedAutocodePromptLines } from '@autocode/core/runtime/prompt-context';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory, MemoryType, MemorySearchFilters } from '../types';
import {
  estimateTokens,
  formatMemoryContentForPrompt,
  isMemoryEligibleForAutomationContext,
  isMemoryEligibleForPromptContext,
} from '../retrieval/context-packer';
import { stripLowValueContextCostMemoryLines } from '../outcome-content';

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
const MAX_SEARCH_CONTEXT_COST_FILE_REFS = 4;
const MAX_SEARCH_CONTEXT_COST_FILE_REF_CHARS = 96;
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
    '上下文(?:过大|太大|太长|爆|满|超|长度|token)',
    'token\\s*(?:成本|消耗|用量|过高|太多)',
    '(?:少用|少耗|节约)\\s*token',
    '避免\\s*token\\s*(?:浪费|过高|太多)',
    '减少\\s*token',
    '降低\\s*token',
    '节省\\s*token',
    '压缩\\s*token',
    '减少上下文',
    '压缩上下文',
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
    '少读文件',
    '缩小文件范围',
    '避免(?:全量|全仓|大范围)扫描',
    '该先?(?:读|看|查|打开|检查)哪些文件',
    '哪些文件(?:需要|应该|要)?(?:读|看|查|打开|检查)',
    '先(?:读|看|查|打开|检查)哪些文件',
    '先(?:读|看|查|打开|检查)哪些入口',
    '从哪里开始(?:读|看|查|检查|改)',
    '入口文件',
    '入口在哪里',
  ].join('|'),
  'i',
);
const MEMORY_SEARCH_UNAVAILABLE_RESULT =
  'Memory search unavailable; inspect focused files next.';

// ============================================================
// INPUT SCHEMA
// ============================================================

const searchMemorySchema = z.object({
  query: z
    .string()
    .describe('Recall topic, e.g. auth errors, file access, token cost.'),
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
    .describe('Memory type filter.'),
  relatedFiles: z
    .array(z.string())
    .optional()
    .describe('Related file filter.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .default(DEFAULT_SEARCH_LIMIT)
    .describe('Limit 1-8; default 3.'),
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
      'Search memory for gotchas, decisions, file-prefetch patterns, token-cost lessons, and prior workflows. Use before broad file scans or uncertain changes.',
    inputSchema: searchMemorySchema,
    execute: async (input: SearchMemoryInput): Promise<string> => {
      const query = normalizeSearchQuery(input.query);
      if (!query) {
        return 'No memory search run: empty query.';
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
        recordAccess: false,
      };

      let searchResults: Memory[];
      try {
        searchResults = await searchMemoryWithUnavailableSignal(proxy, filters);
      } catch {
        return MEMORY_SEARCH_UNAVAILABLE_RESULT;
      }

      const memories = dedupeMemories(
        searchResults.filter(isMemoryEligibleForSearchMemoryResult),
      );

      if (memories.length === 0) {
        return formatNoSearchMemoryResults(types);
      }

      const result = formatSearchMemoryOutput(query, memories);
      void recordDisplayedSearchMemoryAccess(proxy, result.memories);
      return result.output;
    },
  });
}

function searchMemoryWithUnavailableSignal(
  proxy: WorkerObserverProxy,
  filters: MemorySearchFilters,
): Promise<Memory[]> {
  const searchMemoryOrThrow = (
    proxy as { searchMemoryOrThrow?: (filters: MemorySearchFilters) => Promise<Memory[]> }
  ).searchMemoryOrThrow;
  return typeof searchMemoryOrThrow === 'function'
    ? searchMemoryOrThrow.call(proxy, filters)
    : proxy.searchMemory(filters);
}

/**
 * Create a no-op stub `search_memory` tool for sessions without memory support.
 */
export function createSearchMemoryStub(): AITool<SearchMemoryInput, string> {
  return tool({
    description: 'Search memory (unavailable in this session).',
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

interface FormattedSearchMemoryOutput {
  output: string;
  memories: Memory[];
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
    return 'No relevant memories found; inspect focused files next.';
  }
  return `No relevant ${machineKinds.join('/')} memories found; inspect focused files next.`;
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
  const eligible = isMachineReadableSearchMemoryType(memory.type)
    ? isMemoryEligibleForAutomationContext(memory)
    : isMemoryEligibleForPromptContext(memory);
  return eligible && hasRenderableSearchMemoryContent(memory);
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

function formatSearchMemoryOutput(query: string, memories: Memory[]): FormattedSearchMemoryOutput {
  const header = formatSearchMemoryHeader(query, memories);
  const lines: string[] = [];
  const renderedMemories: Memory[] = [];
  let omitted = 0;

  for (const memory of memories) {
    const line = formatSearchMemoryResult(memory, lines.length + 1);
    const candidate = `${header}\n\n${[...lines, line].join('\n\n')}`;
    if (fitsSearchOutputBudget(candidate)) {
      lines.push(line);
      renderedMemories.push(memory);
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

  return {
    output: truncateTextToBudget(output, MAX_SEARCH_OUTPUT_CHARS, MAX_SEARCH_OUTPUT_TOKENS, { preserveTail: true }),
    memories: renderedMemories,
  };
}

function formatSearchMemoryHeader(query: string, memories: readonly Memory[]): string {
  if (memories.length > 0 && memories.every((memory) => isMachineReadableSearchMemoryType(memory.type))) {
    return 'Memory search results:';
  }

  return `Memory search results for "${truncateTextToBudget(
    query,
    MAX_SEARCH_QUERY_ECHO_CHARS,
    MAX_SEARCH_QUERY_ECHO_TOKENS,
    { preserveTail: true },
  )}":`;
}

async function recordDisplayedSearchMemoryAccess(
  proxy: WorkerObserverProxy,
  memories: readonly Memory[],
): Promise<void> {
  const seen = new Set<string>();
  const ids = memories
    .map((memory) => memory.id.trim())
    .filter((id) => {
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });

  await Promise.all(
    ids.map(async (id) => {
      try {
        await proxy.updateAccessCount(id);
      } catch {
        // Access feedback should not block the agent's memory search result.
      }
    }),
  );
}

function formatSearchMemoryResult(memory: Memory, index: number): string {
  const content = formatSearchMemoryContent(memory);
  const fileRef = shouldShowSearchMemoryFileRefs(memory)
    ? formatFileRefs(memory.relatedFiles, content)
    : '';
  const confidence = formatConfidenceHint(memory);
  return `${index}. [${memory.type}]${fileRef}${confidence}\n   ${content}`;
}

function shouldShowSearchMemoryFileRefs(memory: Memory): boolean {
  return !isMachineReadableSearchMemoryType(memory.type);
}

function formatSearchMemoryContent(memory: Memory): string {
  const promptContent = getSearchMemoryPromptContent(memory);
  const content = appendSearchMemoryMetadata(
    memory,
    promptContent,
  );
  return truncateTextToBudget(
    content,
    MAX_MEMORY_RESULT_CHARS,
    MAX_MEMORY_RESULT_TOKENS,
    { preserveTail: true },
  );
}

function hasRenderableSearchMemoryContent(memory: Memory): boolean {
  return getSearchMemoryPromptContent(memory).length > 0;
}

function getSearchMemoryPromptContent(memory: Memory): string {
  return memory.type === 'context_cost'
    ? foldRepeatedAutocodePromptLines(stripLowValueContextCostMemoryLines(memory.content))
    : formatMemoryContentForPrompt(memory, Number.MAX_SAFE_INTEGER).trim();
}

function appendSearchMemoryMetadata(memory: Memory, content: string): string {
  if (memory.type !== 'context_cost') {
    return content;
  }

  const relatedFiles = formatContextCostRelatedFiles(memory.relatedFiles, content);
  if (!relatedFiles) {
    return content;
  }
  return `${content} ${relatedFiles}`;
}

function formatContextCostRelatedFiles(files: readonly string[], content: string): string {
  const normalizedContent = normalizeToolTextForPathMatch(content);
  const unmentionedFiles = uniquePathRefs(files)
    .filter((file) => !isPathMentionedInText(file, normalizedContent));
  if (unmentionedFiles.length === 0) {
    return '';
  }

  const visible = unmentionedFiles
    .slice(0, MAX_SEARCH_CONTEXT_COST_FILE_REFS)
    .map((file) => truncatePathTail(file, MAX_SEARCH_CONTEXT_COST_FILE_REF_CHARS));
  const omitted = unmentionedFiles.length - visible.length;
  const omittedText = omitted > 0 ? ` (+${omitted} more)` : '';
  return `Related files: ${formatCompactSearchPathList(visible)}${omittedText}.`;
}

function formatCompactSearchPathList(paths: readonly string[]): string {
  const expanded = paths.join(', ');
  if (paths.length < 2) {
    return expanded;
  }

  const segments = paths.map(splitSearchPath);
  if (segments.some((parts) => parts.length < 2)) {
    return expanded;
  }

  const maxCommonDepth = Math.min(...segments.map((parts) => parts.length - 1));
  let commonDepth = 0;
  for (let index = 0; index < maxCommonDepth; index += 1) {
    const segment = segments[0][index].toLowerCase();
    if (!segments.every((parts) => parts[index].toLowerCase() === segment)) {
      break;
    }
    commonDepth += 1;
  }

  if (commonDepth === 0) {
    return expanded;
  }

  const commonDir = segments[0].slice(0, commonDepth).join('/');
  const tails = segments.map((parts) => parts.slice(commonDepth).join('/'));
  const compact = `${commonDir}/{${tails.join(', ')}}`;
  return compact.length < expanded.length ? compact : expanded;
}

function formatConfidenceHint(memory: Memory): string {
  return memory.confidence < 0.7
    ? ` [confidence: ${(memory.confidence * 100).toFixed(0)}%]`
    : '';
}

function formatFileRefs(files: readonly string[], content = ''): string {
  const normalizedContent = normalizeToolTextForPathMatch(content);
  const uniqueFiles = uniquePathRefs(files.map(normalizeToolPath))
    .filter((file) => !isPathMentionedInText(file, normalizedContent));
  if (uniqueFiles.length === 0) {
    return '';
  }

  const visibleFiles = uniqueFiles.slice(0, MAX_SEARCH_FILE_REFS);
  const visible = visibleFiles.map((file) => formatSearchFileRefChip(file, visibleFiles));
  const omitted = uniqueFiles.length - visible.length;
  if (omitted > 0) {
    visible.push(`+${omitted} more`);
  }

  return ` [${visible.join(', ')}]`;
}

function formatSearchFileRefChip(file: string, visibleFiles: readonly string[]): string {
  const fileName = getSearchFileName(file);
  if (countMatchingSearchFileNames(fileName, visibleFiles) <= 1) {
    return truncateText(fileName, MAX_SEARCH_FILE_REF_CHARS);
  }

  return truncatePathTail(
    getShortestUniqueSearchPathTail(file, visibleFiles),
    MAX_SEARCH_FILE_REF_CHARS,
  );
}

function countMatchingSearchFileNames(fileName: string, files: readonly string[]): number {
  const key = fileName.toLowerCase();
  return files.filter((file) => getSearchFileName(file).toLowerCase() === key).length;
}

function getShortestUniqueSearchPathTail(file: string, files: readonly string[]): string {
  const segments = splitSearchPath(file);
  if (segments.length <= 1) {
    return file;
  }

  const matchingFiles = files.filter(
    (candidate) => getSearchFileName(candidate).toLowerCase() === getSearchFileName(file).toLowerCase(),
  );
  for (let depth = 2; depth <= segments.length; depth += 1) {
    const tail = segments.slice(-depth).join('/');
    const tailKey = tail.toLowerCase();
    const isUnique = matchingFiles.every((candidate) => {
      if (candidate === file) {
        return true;
      }
      return splitSearchPath(candidate).slice(-depth).join('/').toLowerCase() !== tailKey;
    });
    if (isUnique) {
      return tail;
    }
  }

  return file;
}

function getSearchFileName(file: string): string {
  return splitSearchPath(file).pop() || file;
}

function splitSearchPath(path: string): string[] {
  return normalizeToolPath(path).split('/').filter(Boolean);
}

function isPathMentionedInText(path: string, normalizedText: string): boolean {
  if (!normalizedText) {
    return false;
  }
  const normalizedPath = normalizeToolTextForPathMatch(path);
  const fileName = normalizeToolTextForPathMatch(path.split('/').pop() || path);
  return normalizedText.includes(normalizedPath) ||
    (fileName.length > 0 && containsStandalonePathName(normalizedText, fileName));
}

function containsStandalonePathName(text: string, pathName: string): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escapeRegExp(pathName)}(?:$|[^a-z0-9_.-])`,
  ).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeToolTextForPathMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
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
