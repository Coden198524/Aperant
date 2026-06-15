/**
 * record_memory Agent Tool
 *
 * Allows agents to explicitly record a memory during a session.
 * Posts to the main thread's MemoryService via IPC.
 */

import { tool } from 'ai';
import { z } from 'zod/v3';
import type { Tool as AITool } from 'ai';
import { foldRepeatedAutocodePromptLines } from '@autocode/core/runtime/prompt-context';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory, MemoryType, MemoryRecordEntry } from '../types';
import { estimateTokens, isMemoryEligibleForPromptContext, MIN_PACKED_MEMORY_CONFIDENCE } from '../retrieval/context-packer';
import { stripLowValueMemoryLines } from '../outcome-content';

const DUPLICATE_MEMORY_SEARCH_LIMIT = 4;
const DUPLICATE_MEMORY_SIMILARITY_THRESHOLD = 0.82;
const MIN_DUPLICATE_MEMORY_TOKEN_UNION = 6;
const MAX_DUPLICATE_MEMORY_QUERY_CHARS = 260;
const MAX_DUPLICATE_MEMORY_QUERY_TOKENS = 80;
const MAX_RECORD_MEMORY_RELATED_FILES = 12;
const MAX_RECORD_MEMORY_RELATED_MODULES = 12;
const MAX_RECORD_MEMORY_FILE_REF_CHARS = 160;
const MAX_RECORD_MEMORY_MODULE_CHARS = 96;
const SKIPPED_LOW_VALUE_MEMORY_RESULT = 'Memory skipped: not reusable.';

const recordMemorySchema = z.object({
  type: z
    .enum([
      'gotcha',
      'decision',
      'pattern',
      'error_pattern',
      'module_insight',
      'dead_end',
      'causal_dependency',
      'requirement',
    ])
    .describe('Closest reusable memory kind.'),
  content: z
    .string()
    .min(10)
    .max(500)
    .describe('Reusable lesson; no status, test success, or tool echo.'),
  relatedFiles: z
    .array(z.string())
    .optional()
    .describe('Related file paths.'),
  relatedModules: z
    .array(z.string())
    .optional()
    .describe('Related module names.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.8)
    .describe('Confidence 0-1; default .8.'),
});

type RecordMemoryInput = z.infer<typeof recordMemorySchema>;

export function createRecordMemoryTool(
  proxy: WorkerObserverProxy,
  projectId: string,
  sessionId: string,
): AITool<RecordMemoryInput, string> {
  return tool({
    description:
      'Record reusable project memory: non-obvious gotcha, decision, recurring error, file coupling, or failed approach. Never record status, tests, token notes, or memory/search echoes.',
    inputSchema: recordMemorySchema,
    execute: async (input: RecordMemoryInput): Promise<string> => {
      const content = normalizeRecordMemoryContent(
        stripLowValueMemoryLines(input.content),
      );
      const confidence = input.confidence ?? 0.8;
      if (content.length < 10 || confidence < MIN_PACKED_MEMORY_CONFIDENCE) {
        return SKIPPED_LOW_VALUE_MEMORY_RESULT;
      }

      const duplicate = await findDuplicateMemory(proxy, projectId, content);
      if (duplicate) {
        return `Memory skipped: duplicate (${duplicate.id.slice(0, 8)}).`;
      }

      const relatedFiles = normalizeRelatedFiles(input.relatedFiles);
      const relatedModules = normalizeRelatedModules(input.relatedModules, relatedFiles);

      const entry: MemoryRecordEntry = {
        type: input.type as MemoryType,
        content,
        relatedFiles,
        relatedModules,
        confidence,
        source: 'agent_explicit',
        projectId,
        sessionId,
        needsReview: false,
        scope: 'module',
      };

      let id: string | null | undefined;
      try {
        id = await proxy.recordMemory(entry);
      } catch {
        id = undefined;
      }

      if (!id) {
        return 'Memory not persisted.';
      }

      return `Memory recorded (${id.slice(0, 8)}).`;
    },
  });
}

function normalizeRecordMemoryContent(content: string): string {
  return foldRepeatedAutocodePromptLines(content).replace(/\s+/g, ' ').trim();
}

async function findDuplicateMemory(
  proxy: WorkerObserverProxy,
  projectId: string,
  content: string,
): Promise<Memory | null> {
  const query = compactDuplicateMemoryQuery(content);
  let memories: Memory[];
  try {
    memories = await proxy.searchMemory({
      query,
      projectId,
      limit: DUPLICATE_MEMORY_SEARCH_LIMIT,
      excludeDeprecated: true,
      promptContextOnly: true,
    });
  } catch {
    return null;
  }

  return memories
    .filter(isMemoryEligibleForPromptContext)
    .find((memory) => isDuplicateMemoryContent(content, memory.content)) ?? null;
}

function compactDuplicateMemoryQuery(content: string): string {
  return truncateHeadTailTextToBudget(
    content,
    MAX_DUPLICATE_MEMORY_QUERY_CHARS,
    MAX_DUPLICATE_MEMORY_QUERY_TOKENS,
  );
}

function isDuplicateMemoryContent(content: string, existingContent: string): boolean {
  const comparableContent = stripLowValueMemoryLines(content);
  const comparableExistingContent = stripLowValueMemoryLines(existingContent);
  const normalized = normalizeMemoryContent(comparableContent);
  const existingNormalized = normalizeMemoryContent(comparableExistingContent);
  if (!normalized || !existingNormalized) {
    return false;
  }
  if (normalized === existingNormalized) {
    return true;
  }

  const tokens = new Set(tokenizeMemoryContent(comparableContent));
  const existingTokens = new Set(tokenizeMemoryContent(comparableExistingContent));
  const union = new Set([...tokens, ...existingTokens]).size;
  if (union < MIN_DUPLICATE_MEMORY_TOKEN_UNION) {
    return false;
  }

  const intersection = [...tokens].filter((token) => existingTokens.has(token)).length;
  return intersection / union >= DUPLICATE_MEMORY_SIMILARITY_THRESHOLD;
}

function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9_\u3400-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeMemoryContent(content: string): string[] {
  const normalized = content.toLowerCase();
  const latinWords = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
  const cjkChars = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  return [...latinWords, ...cjkChars];
}

function normalizeRelatedFiles(files: string[] | undefined): string[] {
  if (!files) {
    return [];
  }
  return uniqueInOrderBy(
    files
      .map((file) => truncatePathTail(
        normalizeToolPath(file),
        MAX_RECORD_MEMORY_FILE_REF_CHARS,
      ))
      .filter(Boolean),
    (file) => file.toLowerCase(),
  ).slice(0, MAX_RECORD_MEMORY_RELATED_FILES);
}

function normalizeRelatedModules(
  modules: string[] | undefined,
  relatedFiles: readonly string[] = [],
): string[] {
  if (!modules) {
    return [];
  }
  const relatedFileRefs = getRelatedFileRefs(relatedFiles);
  return uniqueInOrderBy(
    modules
      .map((module) => truncateHeadTailText(
        module.replace(/\s+/g, ' ').trim(),
        MAX_RECORD_MEMORY_MODULE_CHARS,
      ))
      .filter((module) => Boolean(module) && !isRedundantRelatedModule(module, relatedFileRefs)),
    (module) => module.toLowerCase(),
  ).slice(0, MAX_RECORD_MEMORY_RELATED_MODULES);
}

interface RelatedFileRefs {
  paths: Set<string>;
  fileNames: Set<string>;
  fileStems: Set<string>;
}

function getRelatedFileRefs(files: readonly string[]): RelatedFileRefs {
  const paths = new Set<string>();
  const fileNames = new Set<string>();
  const fileStems = new Set<string>();
  for (const file of files) {
    const normalized = normalizeToolPath(file);
    if (!normalized) {
      continue;
    }
    const pathKey = normalized.toLowerCase();
    paths.add(pathKey);

    const fileName = normalized.split('/').pop()?.toLowerCase();
    if (!fileName) {
      continue;
    }
    fileNames.add(fileName);
    const stem = stripKnownFileExtension(fileName);
    if (stem) {
      fileStems.add(stem);
    }
  }
  return { paths, fileNames, fileStems };
}

function isRedundantRelatedModule(module: string, relatedFileRefs: RelatedFileRefs): boolean {
  const modulePath = normalizeToolPath(module).toLowerCase();
  const moduleKey = module.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!moduleKey) {
    return true;
  }

  return relatedFileRefs.paths.has(modulePath) ||
    relatedFileRefs.fileNames.has(moduleKey) ||
    relatedFileRefs.fileStems.has(moduleKey);
}

function stripKnownFileExtension(fileName: string): string {
  return fileName.replace(
    /\.(?:cjs|cts|d\.ts|e2e\.ts|js|jsx|mjs|mts|spec\.ts|test\.ts|ts|tsx)$/i,
    '',
  );
}

function uniqueInOrderBy(values: readonly string[], getKey: (value: string) => string): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
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

function truncatePathTail(path: string, maxChars: number): string {
  const normalized = path.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-Math.max(0, maxChars)).replace(/^\/+/, '');
}

function truncateHeadTailText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  const marker = '...[omitted]...';
  if (marker.length >= maxChars - 2) {
    return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }
  const budget = maxChars - marker.length;
  const headBudget = Math.ceil(budget * 0.45);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${compact.slice(0, headBudget).trimEnd()}${marker}${compact.slice(-tailBudget).trimStart()}`;
}

function truncateHeadTailTextToBudget(text: string, maxChars: number, maxTokens: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0 || maxChars <= 0 || maxTokens <= 0) {
    return '';
  }

  const charBounded = truncateHeadTailText(compact, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = truncateHeadTailText(compact, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

export function createRecordMemoryStub(): AITool<RecordMemoryInput, string> {
  return tool({
    description: 'Record memory (unavailable in this session).',
    inputSchema: recordMemorySchema,
    execute: async (_input: RecordMemoryInput): Promise<string> => {
      return 'Memory not persisted.';
    },
  });
}
