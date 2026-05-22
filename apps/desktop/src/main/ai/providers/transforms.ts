/**
 * Per-Provider Transforms Layer
 *
 * Normalizes provider-specific differences for the Vercel AI SDK integration:
 * - Thinking token normalization (Anthropic budgetTokens vs OpenAI reasoning)
 * - Tool ID format differences across providers
 * - Prompt caching thresholds (Anthropic 1024-4096 token minimums)
 * - Adaptive thinking for Opus 4.6 (both max_thinking_tokens AND effort_level)
 *
 * See apps/desktop/src/main/ai/providers/transforms.ts for the TypeScript implementation.
 */

import type { SupportedProvider } from '@autocode/core';
import type { ThinkingLevel, EffortLevel } from '@autocode/core';
import {
  THINKING_BUDGET_MAP,
  EFFORT_LEVEL_MAP,
  ADAPTIVE_THINKING_MODELS,
} from '@autocode/core';

// ============================================
// Thinking Token Transforms
// ============================================

/** Provider-specific thinking configuration for Vercel AI SDK */
export interface ThinkingConfig {
  /** Anthropic: budgetTokens for extended thinking */
  budgetTokens?: number;
  /** OpenAI: reasoning effort level (low/medium/high) */
  reasoningEffort?: string;
  /** Adaptive model effort level (Opus 4.6) */
  effortLevel?: EffortLevel;
}

/**
 * Check if a model supports adaptive thinking via effort level.
 *
 * Adaptive models (e.g., Opus 4.6) support both max_thinking_tokens AND
 * effort_level for effort-based routing.
 *
 * Ported from phase_config.py is_adaptive_model()
 *
 * @param modelId - Full model ID (e.g., 'claude-opus-4-6')
 * @returns True if the model supports adaptive thinking
 */
export function isAdaptiveModel(modelId: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(modelId);
}

/**
 * Get thinking-related kwargs for a model based on its type.
 *
 * For adaptive models (Opus 4.6): returns both budgetTokens and effortLevel.
 * For other Anthropic models: returns only budgetTokens.
 *
 * Ported from phase_config.py get_thinking_kwargs_for_model()
 *
 * @param modelId - Full model ID (e.g., 'claude-opus-4-6')
 * @param thinkingLevel - Thinking level (low, medium, high)
 * @returns Thinking configuration with budget and optional effort level
 */
export function getThinkingKwargsForModel(
  modelId: string,
  thinkingLevel: ThinkingLevel,
): { maxThinkingTokens: number; effortLevel?: EffortLevel } {
  const result: { maxThinkingTokens: number; effortLevel?: EffortLevel } = {
    maxThinkingTokens: THINKING_BUDGET_MAP[thinkingLevel],
  };

  if (isAdaptiveModel(modelId)) {
    result.effortLevel = (EFFORT_LEVEL_MAP[thinkingLevel] ?? 'medium') as EffortLevel;
  }

  return result;
}

/**
 * Transform thinking configuration for a specific provider.
 *
 * Different providers handle "thinking" differently:
 * - Anthropic: uses budgetTokens with extended thinking API
 * - OpenAI: uses reasoning_effort parameter (low/medium/high)
 * - Others: may not support thinking at all
 *
 * @param provider - Target AI provider
 * @param modelId - Full model ID
 * @param thinkingLevel - Desired thinking level
 * @returns Provider-normalized thinking configuration
 */
export function transformThinkingConfig(
  provider: SupportedProvider,
  modelId: string,
  thinkingLevel: ThinkingLevel,
): ThinkingConfig {
  switch (provider) {
    case 'anthropic': {
      const config: ThinkingConfig = {
        budgetTokens: THINKING_BUDGET_MAP[thinkingLevel],
      };
      if (isAdaptiveModel(modelId)) {
        config.effortLevel = (EFFORT_LEVEL_MAP[thinkingLevel] ?? 'medium') as EffortLevel;
      }
      return config;
    }

    case 'openai':
    case 'openai-compatible':
    case 'azure': {
      // OpenAI reasoning models use effort-based reasoning
      return {
        reasoningEffort: thinkingLevel,
      };
    }

    case 'deepseek': {
      return {
        reasoningEffort: thinkingLevel === 'xhigh' ? 'max' : 'high',
      };
    }

    default:
      // Providers without thinking support return empty config
      return {};
  }
}

// ============================================
// Tool ID Format Transforms
// ============================================

/** Regex for valid Anthropic tool IDs (alphanumeric, underscores, hyphens) */
const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Regex for valid OpenAI tool IDs (alphanumeric, underscores, hyphens, max 64 chars) */
const OPENAI_TOOL_ID_MAX_LENGTH = 64;

/**
 * Normalize a tool ID for a specific provider's format requirements.
 *
 * Different providers have different tool ID constraints:
 * - Anthropic: alphanumeric, underscores, hyphens
 * - OpenAI: alphanumeric, underscores, hyphens, max 64 chars
 * - Others: pass through as-is
 *
 * @param provider - Target AI provider
 * @param toolId - Original tool ID
 * @returns Provider-compatible tool ID
 */
export function normalizeToolId(provider: SupportedProvider, toolId: string): string {
  switch (provider) {
    case 'anthropic': {
      if (ANTHROPIC_TOOL_ID_RE.test(toolId)) return toolId;
      // Replace invalid characters with underscores
      return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    case 'openai':
    case 'openai-compatible':
    case 'deepseek':
    case 'azure': {
      // Sanitize and truncate to max length
      const sanitized = toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
      return sanitized.length > OPENAI_TOOL_ID_MAX_LENGTH
        ? sanitized.slice(0, OPENAI_TOOL_ID_MAX_LENGTH)
        : sanitized;
    }

    default:
      return toolId;
  }
}

// ============================================
// Prompt Caching Transforms
// ============================================

/**
 * Prompt caching minimum token thresholds per provider.
 *
 * Anthropic requires content blocks to meet minimum token counts
 * for prompt caching to activate:
 * - Tool definitions: 1024 tokens minimum
 * - System prompts: 1024 tokens minimum
 * - Conversation messages: 2048 tokens minimum for first cache point,
 *   4096 tokens for subsequent
 */
export const PROMPT_CACHE_THRESHOLDS = {
  anthropic: {
    /** Minimum tokens for tool definition caching */
    toolDefinitions: 1024,
    /** Minimum tokens for system prompt caching */
    systemPrompt: 1024,
    /** Minimum tokens for first conversation cache breakpoint */
    firstBreakpoint: 2048,
    /** Minimum tokens for subsequent conversation cache breakpoints */
    subsequentBreakpoint: 4096,
  },
  openai: {
    /** Minimum tokens for tool definition caching (OpenAI requires 1024+) */
    toolDefinitions: 1024,
    /** Minimum tokens for system prompt caching (OpenAI requires 1024+) */
    systemPrompt: 1024,
    /** Minimum tokens for first conversation cache breakpoint */
    firstBreakpoint: 1024,
    /** Minimum tokens for subsequent conversation cache breakpoints */
    subsequentBreakpoint: 1024,
  },
} as const;

/** Content types that can be cache-tagged */
export type CacheableContentType = 'toolDefinitions' | 'systemPrompt' | 'firstBreakpoint' | 'subsequentBreakpoint';

/**
 * Check if a content block meets the minimum token threshold for prompt caching.
 *
 * @param provider - Target AI provider
 * @param contentType - Type of content being cached
 * @param estimatedTokens - Estimated token count of the content
 * @returns True if the content meets caching thresholds
 */
export function meetsCacheThreshold(
  provider: SupportedProvider,
  contentType: CacheableContentType,
  estimatedTokens: number,
): boolean {
  if (provider !== 'anthropic' && provider !== 'openai') {
    // Only Anthropic and OpenAI have explicit caching thresholds
    return false;
  }

  const thresholds = PROMPT_CACHE_THRESHOLDS[provider];
  const threshold = thresholds[contentType];
  return estimatedTokens >= threshold;
}

/**
 * Determine which cache breakpoints to apply for a conversation.
 *
 * Returns an array of message indices that should receive cache_control
 * ephemeral tags, based on cumulative token counts meeting thresholds.
 *
 * @param provider - Target AI provider
 * @param messageTokenCounts - Array of estimated token counts per message
 * @returns Array of message indices eligible for cache breakpoints
 */
export function getCacheBreakpoints(
  provider: SupportedProvider,
  messageTokenCounts: number[],
): number[] {
  if (provider !== 'anthropic' && provider !== 'openai') return [];

  const breakpoints: number[] = [];
  let cumulativeTokens = 0;
  const thresholds = PROMPT_CACHE_THRESHOLDS[provider];
  const { firstBreakpoint, subsequentBreakpoint } = thresholds;
  let nextThreshold = firstBreakpoint;

  for (let i = 0; i < messageTokenCounts.length; i++) {
    cumulativeTokens += messageTokenCounts[i];
    if (cumulativeTokens >= nextThreshold) {
      breakpoints.push(i);
      nextThreshold = cumulativeTokens + subsequentBreakpoint;
    }
  }

  return breakpoints;
}

// ============================================
// Legacy Thinking Level Sanitization
// ============================================

/** Valid thinking level values */
const VALID_THINKING_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/** Mapping from legacy/removed thinking levels to valid ones */
const LEGACY_THINKING_LEVEL_MAP: Record<string, ThinkingLevel> = {
  ultrathink: 'high',
  none: 'low',
};

/**
 * Validate and sanitize a thinking level string.
 *
 * Maps legacy values (e.g., 'ultrathink') to valid equivalents and falls
 * back to 'medium' for unknown values.
 *
 * Ported from phase_config.py sanitize_thinking_level()
 *
 * @param thinkingLevel - Raw thinking level string
 * @returns A valid ThinkingLevel
 */
export function sanitizeThinkingLevel(thinkingLevel: string): ThinkingLevel {
  if (VALID_THINKING_LEVELS.has(thinkingLevel)) {
    return thinkingLevel as ThinkingLevel;
  }

  return LEGACY_THINKING_LEVEL_MAP[thinkingLevel] ?? 'medium';
}
