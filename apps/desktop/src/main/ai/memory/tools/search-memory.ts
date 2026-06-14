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
import { isMemoryEligibleForPromptContext } from '../retrieval/context-packer';

const DEFAULT_SEARCH_LIMIT = 3;
const MAX_SEARCH_LIMIT = 8;
const MAX_MEMORY_RESULT_CHARS = 360;
const MAX_SEARCH_OUTPUT_CHARS = 1800;
const MAX_SEARCH_QUERY_ECHO_CHARS = 160;
const MAX_SEARCH_FILE_REFS = 3;
const MAX_SEARCH_FILE_REF_CHARS = 36;
const SEARCH_RESULT_SIMILARITY_THRESHOLD = 0.82;
const MIN_SEARCH_RESULT_SIMILARITY_TOKEN_UNION = 6;

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
      'Search the persistent memory system for relevant context, gotchas, decisions, and patterns from previous sessions. Use this when you are unsure how something was done before, or to check for known pitfalls before making a change.',
    inputSchema: searchMemorySchema,
    execute: async (input: SearchMemoryInput): Promise<string> => {
      const query = normalizeSearchQuery(input.query);
      if (!query) {
        return 'No memory search run: provide a specific query.';
      }

      const filters: MemorySearchFilters = {
        query,
        types: uniqueInOrder(input.types as MemoryType[] | undefined),
        relatedFiles: normalizeRelatedFiles(input.relatedFiles),
        limit: Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
        projectId,
        excludeDeprecated: true,
        promptContextOnly: true,
      };

      const memories = dedupeMemories(
        (await proxy.searchMemory(filters)).filter(isMemoryEligibleForPromptContext),
      );

      if (memories.length === 0) {
        return 'No relevant memories found for this query.';
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

function dedupeMemories<T extends { content: string }>(memories: T[]): T[] {
  const seenNormalized = new Set<string>();
  const seenTokenSets: Set<string>[] = [];
  const result: T[] = [];
  for (const memory of memories) {
    const key = normalizeContent(memory.content);
    if (!key || seenNormalized.has(key)) {
      continue;
    }
    const tokens = new Set(tokenizeContent(memory.content));
    if (isSimilarToSeenSearchResult(tokens, seenTokenSets)) {
      continue;
    }
    seenNormalized.add(key);
    seenTokenSets.push(tokens);
    result.push(memory);
  }
  return result;
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

function isSimilarToSeenSearchResult(
  tokens: Set<string>,
  seenTokenSets: readonly Set<string>[],
): boolean {
  if (tokens.size === 0) {
    return false;
  }

  for (const seen of seenTokenSets) {
    const union = new Set([...tokens, ...seen]).size;
    if (union < MIN_SEARCH_RESULT_SIMILARITY_TOKEN_UNION) {
      continue;
    }
    const intersection = [...tokens].filter((token) => seen.has(token)).length;
    if (intersection / union >= SEARCH_RESULT_SIMILARITY_THRESHOLD) {
      return true;
    }
  }

  return false;
}

function normalizeSearchQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function normalizeRelatedFiles(files: string[] | undefined): string[] | undefined {
  if (!files) {
    return undefined;
  }

  const normalized = files
    .map((file) => file.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/'))
    .filter(Boolean);
  return uniqueInOrder(normalized);
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
  const header = `Memory search results for "${truncateText(
    query,
    MAX_SEARCH_QUERY_ECHO_CHARS,
    { preserveTail: true },
  )}":`;
  const lines: string[] = [];
  let omitted = 0;

  for (const memory of memories) {
    const line = formatSearchMemoryResult(memory, lines.length + 1);
    const candidate = `${header}\n\n${[...lines, line].join('\n\n')}`;
    if (candidate.length <= MAX_SEARCH_OUTPUT_CHARS) {
      lines.push(line);
    } else {
      omitted += 1;
    }
  }

  let output = `${header}\n\n${lines.join('\n\n')}`;
  if (omitted > 0) {
    const note = `... ${omitted} more memory result(s) omitted for output budget.`;
    const withNote = `${output}\n\n${note}`;
    if (withNote.length <= MAX_SEARCH_OUTPUT_CHARS) {
      output = withNote;
    }
  }

  return truncateText(output, MAX_SEARCH_OUTPUT_CHARS, { preserveTail: true });
}

function formatSearchMemoryResult(memory: Memory, index: number): string {
  const fileRef = formatFileRefs(memory.relatedFiles);
  const confidence = `(confidence: ${(memory.confidence * 100).toFixed(0)}%)`;
  return `${index}. [${memory.type}]${fileRef} ${confidence}\n   ${truncateText(
    memory.content,
    MAX_MEMORY_RESULT_CHARS,
    { preserveTail: true },
  )}`;
}

function formatFileRefs(files: readonly string[]): string {
  if (files.length === 0) {
    return '';
  }

  const visible = files
    .slice(0, MAX_SEARCH_FILE_REFS)
    .map((file) => truncateText(file.split(/[\\/]/).pop() || file, MAX_SEARCH_FILE_REF_CHARS));
  const omitted = files.length - visible.length;
  if (omitted > 0) {
    visible.push(`+${omitted} more`);
  }

  return ` [${visible.join(', ')}]`;
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
