/**
 * Per-provider transform helpers.
 *
 * Normalizes provider-specific differences for host runtime integrations:
 * thinking token options, tool ID format constraints, and prompt caching
 * thresholds.
 */

import {
  ADAPTIVE_THINKING_MODELS,
  EFFORT_LEVEL_MAP,
  THINKING_BUDGET_MAP,
  normalizeThinkingLevel,
  type EffortLevel,
  type ThinkingLevel,
} from '../config/types.js';
import { SupportedProvider as SupportedProviderValue, type SupportedProvider } from './types.js';

// ============================================
// Thinking Token Transforms
// ============================================

/** Provider-specific thinking configuration for AI SDK adapters. */
export interface ThinkingConfig {
  /** Anthropic: budgetTokens for extended thinking */
  budgetTokens?: number;
  /** OpenAI-compatible providers: effort level */
  reasoningEffort?: string;
  /** Adaptive Anthropic models: effort level */
  effortLevel?: EffortLevel;
}

/**
 * Check if a model supports adaptive thinking via effort level.
 */
export function isAdaptiveModel(modelId: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(modelId);
}

/**
 * Get thinking-related kwargs for a model based on its type.
 */
export function getThinkingKwargsForModel(
  modelId: string,
  thinkingLevel: ThinkingLevel,
): { maxThinkingTokens: number; effortLevel?: EffortLevel } {
  const normalizedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  const result: { maxThinkingTokens: number; effortLevel?: EffortLevel } = {
    maxThinkingTokens: THINKING_BUDGET_MAP[normalizedThinkingLevel],
  };

  if (isAdaptiveModel(modelId)) {
    result.effortLevel = EFFORT_LEVEL_MAP[normalizedThinkingLevel] as EffortLevel;
  }

  return result;
}

/**
 * Transform thinking configuration for a specific provider.
 */
export function transformThinkingConfig(
  provider: SupportedProvider,
  modelId: string,
  thinkingLevel: ThinkingLevel,
): ThinkingConfig {
  const normalizedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  switch (provider) {
    case SupportedProviderValue.Anthropic: {
      const config: ThinkingConfig = {
        budgetTokens: THINKING_BUDGET_MAP[normalizedThinkingLevel],
      };
      if (isAdaptiveModel(modelId)) {
        config.effortLevel = EFFORT_LEVEL_MAP[normalizedThinkingLevel] as EffortLevel;
      }
      return config;
    }

    case SupportedProviderValue.OpenAI:
    case SupportedProviderValue.OpenAICompatible:
    case SupportedProviderValue.Azure:
      return {
        reasoningEffort: normalizedThinkingLevel,
      };

    case SupportedProviderValue.DeepSeek:
      return {
        reasoningEffort: normalizedThinkingLevel === 'xhigh' ? 'xhigh' : 'high',
      };

    default:
      return {};
  }
}

// ============================================
// Tool ID Format Transforms
// ============================================

/** Regex for valid Anthropic tool IDs (alphanumeric, underscores, hyphens). */
const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** OpenAI-compatible tool IDs are capped at 64 characters. */
const OPENAI_TOOL_ID_MAX_LENGTH = 64;

/**
 * Normalize a tool ID for a specific provider's format requirements.
 */
export function normalizeToolId(provider: SupportedProvider, toolId: string): string {
  switch (provider) {
    case SupportedProviderValue.Anthropic:
      if (ANTHROPIC_TOOL_ID_RE.test(toolId)) return toolId;
      return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');

    case SupportedProviderValue.OpenAI:
    case SupportedProviderValue.OpenAICompatible:
    case SupportedProviderValue.DeepSeek:
    case SupportedProviderValue.Azure: {
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
    /** Minimum tokens for tool definition caching */
    toolDefinitions: 1024,
    /** Minimum tokens for system prompt caching */
    systemPrompt: 1024,
    /** Minimum tokens for first conversation cache breakpoint */
    firstBreakpoint: 1024,
    /** Minimum tokens for subsequent conversation cache breakpoints */
    subsequentBreakpoint: 1024,
  },
} as const;

/** Content types that can be cache-tagged. */
export type CacheableContentType =
  | 'toolDefinitions'
  | 'systemPrompt'
  | 'firstBreakpoint'
  | 'subsequentBreakpoint';

/**
 * Check if a content block meets the minimum token threshold for prompt caching.
 */
export function meetsCacheThreshold(
  provider: SupportedProvider,
  contentType: CacheableContentType,
  estimatedTokens: number,
): boolean {
  if (provider !== SupportedProviderValue.Anthropic && provider !== SupportedProviderValue.OpenAI) {
    return false;
  }

  const thresholds = PROMPT_CACHE_THRESHOLDS[provider];
  const threshold = thresholds[contentType];
  return estimatedTokens >= threshold;
}

/**
 * Determine which cache breakpoints to apply for a conversation.
 */
export function getCacheBreakpoints(
  provider: SupportedProvider,
  messageTokenCounts: number[],
): number[] {
  if (provider !== SupportedProviderValue.Anthropic && provider !== SupportedProviderValue.OpenAI) {
    return [];
  }

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

/**
 * Validate and sanitize a thinking level string.
 */
export function sanitizeThinkingLevel(thinkingLevel: string): ThinkingLevel {
  return normalizeThinkingLevel(thinkingLevel);
}
