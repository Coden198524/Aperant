import type { Memory, UniversalPhase } from '@autocode/core';
import {
  DEFAULT_PACKING_CONFIG,
  MAX_PACKED_MEMORY_CITATION_CHARS,
  MAX_PACKED_MEMORY_CONTENT_CHARS,
  MAX_PACKED_MEMORY_FILE_REF_CHARS,
  MIN_PACKED_MEMORY_CONFIDENCE,
  estimateTokens,
  isMemoryEligibleForPromptContext as coreIsMemoryEligibleForPromptContext,
  packContext as corePackContext,
} from '@autocode/core/memory/retrieval';
import type { ContextPackingConfig } from '@autocode/core/memory/retrieval';

export {
  DEFAULT_PACKING_CONFIG,
  MAX_PACKED_MEMORY_CITATION_CHARS,
  MAX_PACKED_MEMORY_CONTENT_CHARS,
  MAX_PACKED_MEMORY_FILE_REF_CHARS,
  MIN_PACKED_MEMORY_CONFIDENCE,
  estimateTokens,
};
export type { ContextPackingConfig };

const MAX_PROMPT_CONTEXT_MEMORIES = 20;

export function packContext(
  memories: Memory[],
  phase: UniversalPhase,
  config?: ContextPackingConfig,
): string {
  return corePackContext(normalizePromptMemories(memories), phase, config);
}

export function isMemoryEligibleForPromptContext(memory: Memory): boolean {
  const normalized = normalizePromptMemory(memory);
  return normalized ? coreIsMemoryEligibleForPromptContext(normalized) : false;
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
    if (normalizedMemories.length >= MAX_PROMPT_CONTEXT_MEMORIES) {
      break;
    }
  }

  return normalizedMemories;
}

function normalizePromptMemory(memory: Memory): Memory | undefined {
  const id = normalizePromptText(memory.id);
  const content = normalizePromptText(memory.content);
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
    relatedFiles: normalizePromptTextList(memory.relatedFiles),
    relatedModules: normalizePromptTextList(memory.relatedModules),
    tags: normalizePromptTextList(memory.tags),
    citationText: normalizePromptText(memory.citationText),
  };
}

function normalizePromptText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePromptTextList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalizedValues: string[] = [];

  for (const value of values) {
    const normalized = normalizePromptText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

function normalizePromptConfidence(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}
