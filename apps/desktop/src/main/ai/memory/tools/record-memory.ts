/**
 * record_memory Agent Tool
 *
 * Allows agents to explicitly record a memory during a session.
 * Posts to the main thread's MemoryService via IPC.
 */

import { tool } from 'ai';
import { z } from 'zod/v3';
import type { Tool as AITool } from 'ai';
import type { WorkerObserverProxy } from '../ipc/worker-observer-proxy';
import type { Memory, MemoryType, MemoryRecordEntry } from '../types';
import { isMemoryEligibleForPromptContext, MIN_PACKED_MEMORY_CONFIDENCE } from '../retrieval/context-packer';

const LOW_VALUE_MEMORY_PATTERNS = [
  /^Efficient token usage\b/i,
  /^High token usage per step\b/i,
  /^Completed quickly with few steps\b/i,
  /^Many steps required\b/i,
  /^Used diverse set of tools\b/i,
  /^(?:task|implementation|session|work|subtask)\s+(?:completed|finished|done|succeeded)\b/i,
  /^completed successfully\b/i,
  /^all tests passed\b/i,
  /^no issues found\b/i,
] as const;
const DUPLICATE_MEMORY_SEARCH_LIMIT = 4;
const DUPLICATE_MEMORY_SIMILARITY_THRESHOLD = 0.82;
const MIN_DUPLICATE_MEMORY_TOKEN_UNION = 6;
const MAX_RECORD_MEMORY_RELATED_FILES = 12;
const MAX_RECORD_MEMORY_RELATED_MODULES = 12;
const MAX_RECORD_MEMORY_FILE_REF_CHARS = 160;
const MAX_RECORD_MEMORY_MODULE_CHARS = 96;

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
    .describe(
      'Type of memory: gotcha=pitfall to avoid, decision=architectural choice, pattern=reusable approach, error_pattern=recurring error, module_insight=non-obvious module behavior, dead_end=failed approach, causal_dependency=file coupling, requirement=constraint',
    ),
  content: z
    .string()
    .min(10)
    .max(500)
    .describe(
      'The memory content. Be specific and actionable. Example: "Always call refreshToken() before making API calls in auth.ts; the token expires after 15 minutes of inactivity"',
    ),
  relatedFiles: z
    .array(z.string())
    .optional()
    .describe('Absolute paths to files this memory relates to'),
  relatedModules: z
    .array(z.string())
    .optional()
    .describe('Module names this memory relates to (e.g., ["auth", "token"])'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.8)
    .describe('Confidence in this memory (0.0-1.0, default 0.8)'),
});

type RecordMemoryInput = z.infer<typeof recordMemorySchema>;

export function createRecordMemoryTool(
  proxy: WorkerObserverProxy,
  projectId: string,
  sessionId: string,
): AITool<RecordMemoryInput, string> {
  return tool({
    description:
      'Record a concise persistent memory for future sessions. Use this only for non-obvious, reusable gotchas, decisions, recurring errors, file couplings, or failed approaches. Do not record generic completion status, test success, or token usage notes.',
    inputSchema: recordMemorySchema,
    execute: async (input: RecordMemoryInput): Promise<string> => {
      const content = normalizeRecordMemoryContent(input.content);
      const confidence = input.confidence ?? 0.8;
      if (content.length < 10 || confidence < MIN_PACKED_MEMORY_CONFIDENCE || isLowValueMemoryContent(content)) {
        return 'Memory skipped: record only reusable project-specific gotchas, decisions, recurring errors, file couplings, or failed approaches.';
      }

      const duplicate = await findDuplicateMemory(proxy, projectId, content);
      if (duplicate) {
        return `Memory skipped: similar memory already exists (id: ${duplicate.id.slice(0, 8)}).`;
      }

      const entry: MemoryRecordEntry = {
        type: input.type as MemoryType,
        content,
        relatedFiles: normalizeRelatedFiles(input.relatedFiles),
        relatedModules: normalizeRelatedModules(input.relatedModules),
        confidence,
        source: 'agent_explicit',
        projectId,
        sessionId,
        needsReview: false,
        scope: 'module',
      };

      const id = await proxy.recordMemory(entry);

      if (!id) {
        return 'Memory noted locally, but could not be persisted.';
      }

      return `Memory recorded (id: ${id.slice(0, 8)}).`;
    },
  });
}

function normalizeRecordMemoryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function isLowValueMemoryContent(content: string): boolean {
  return LOW_VALUE_MEMORY_PATTERNS.some((pattern) => pattern.test(content));
}

async function findDuplicateMemory(
  proxy: WorkerObserverProxy,
  projectId: string,
  content: string,
): Promise<Memory | null> {
  const memories = await proxy.searchMemory({
    query: content,
    projectId,
    limit: DUPLICATE_MEMORY_SEARCH_LIMIT,
    excludeDeprecated: true,
    promptContextOnly: true,
  });

  return memories
    .filter(isMemoryEligibleForPromptContext)
    .find((memory) => isDuplicateMemoryContent(content, memory.content)) ?? null;
}

function isDuplicateMemoryContent(content: string, existingContent: string): boolean {
  const normalized = normalizeMemoryContent(content);
  const existingNormalized = normalizeMemoryContent(existingContent);
  if (!normalized || !existingNormalized) {
    return false;
  }
  if (normalized === existingNormalized) {
    return true;
  }

  const tokens = new Set(tokenizeMemoryContent(content));
  const existingTokens = new Set(tokenizeMemoryContent(existingContent));
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
  return uniqueInOrder(
    files
      .map((file) => truncatePathTail(
        file.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/'),
        MAX_RECORD_MEMORY_FILE_REF_CHARS,
      ))
      .filter(Boolean),
  ).slice(0, MAX_RECORD_MEMORY_RELATED_FILES);
}

function normalizeRelatedModules(modules: string[] | undefined): string[] {
  if (!modules) {
    return [];
  }
  return uniqueInOrder(
    modules
      .map((module) => truncateHeadTailText(
        module.replace(/\s+/g, ' ').trim(),
        MAX_RECORD_MEMORY_MODULE_CHARS,
      ))
      .filter(Boolean),
  ).slice(0, MAX_RECORD_MEMORY_RELATED_MODULES);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
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

export function createRecordMemoryStub(): AITool<RecordMemoryInput, string> {
  return tool({
    description: 'Record a memory (memory not available in this session).',
    inputSchema: recordMemorySchema,
    execute: async (_input: RecordMemoryInput): Promise<string> => {
      return 'Memory noted locally, but memory persistence is unavailable in this session.';
    },
  });
}
