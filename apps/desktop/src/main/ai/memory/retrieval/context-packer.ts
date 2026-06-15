export {
  DEFAULT_PACKING_CONFIG,
  MAX_PACKED_MEMORY_CITATION_CHARS,
  MAX_PACKED_MEMORY_CONTENT_CHARS,
  MAX_PACKED_MEMORY_FILE_REF_CHARS,
  MAX_PROMPT_CONTEXT_MEMORIES,
  MIN_PACKED_MEMORY_CONFIDENCE,
  estimateTokens,
  formatMemoryContentForPrompt,
  isMemoryEligibleForPromptContext,
  packContext,
} from '@autocode/core/memory/retrieval';
export type { ContextPackingConfig } from '@autocode/core/memory/retrieval';
