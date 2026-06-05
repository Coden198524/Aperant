/**
 * Session Continuation
 * ====================
 *
 * Desktop adapter for core context-window continuation. The loop and merge
 * strategy live in @autocode/core; this file only supplies the desktop model
 * factory used to summarize the previous session before resuming.
 */

import { generateText } from 'ai';
import {
  AUTOCODE_SUMMARIZER_SYSTEM_PROMPT,
  buildAutocodeSummaryPrompt,
  limitAutocodeSummaryInput,
  rawTruncateAutocodeSessionMessages,
  runAutocodeContinuableSession,
} from '@autocode/core/runtime/agent-continuation';

import { runAgentSession } from './runner';
import type { RunnerOptions } from './runner';
import type { SessionConfig, SessionMessage, SessionResult, TokenUsage } from './types';

export interface ContinuationConfig {
  /** Maximum number of continuations (default 5) */
  maxContinuations?: number;
  /** Context window limit in tokens (from model metadata) */
  contextWindowLimit: number;
  /** API key for creating the summarization model */
  apiKey?: string;
  /** Base URL for the summarization model */
  baseURL?: string;
  /** OAuth token file path (for token refresh) */
  oauthTokenFilePath?: string;
}

export interface ContinuationResult extends SessionResult {
  /** Number of continuations performed (0 = no continuation needed) */
  continuationCount: number;
  /** Cumulative token usage across all continuations */
  cumulativeUsage: TokenUsage;
}

export async function runContinuableSession(
  config: SessionConfig,
  options: RunnerOptions = {},
  continuationConfig: ContinuationConfig,
): Promise<ContinuationResult> {
  return runAutocodeContinuableSession(
    config,
    options,
    { maxContinuations: continuationConfig.maxContinuations },
    {
      runSession: runAgentSession,
      summarizeMessages: (messages) => compactSessionMessages(
        messages,
        continuationConfig,
        config.abortSignal,
      ),
    },
  );
}

async function compactSessionMessages(
  messages: SessionMessage[],
  continuationConfig: ContinuationConfig,
  abortSignal?: AbortSignal,
): Promise<string> {
  const serialized = limitAutocodeSummaryInput(messages);

  if (abortSignal?.aborted) {
    return rawTruncateAutocodeSessionMessages(messages);
  }

  try {
    const { createProviderFromModelId } = await import('../providers/factory');
    const summarizerModel = createProviderFromModelId('claude-haiku-4-5-20251001', {
      apiKey: continuationConfig.apiKey,
      baseURL: continuationConfig.baseURL,
      oauthTokenFilePath: continuationConfig.oauthTokenFilePath,
    });

    const result = await generateText({
      model: summarizerModel,
      system: AUTOCODE_SUMMARIZER_SYSTEM_PROMPT,
      prompt: buildAutocodeSummaryPrompt(serialized),
      abortSignal,
    });

    if (result.text.trim()) {
      return result.text.trim();
    }
  } catch {
    // Fall back to raw truncation when summarization is unavailable.
  }

  return rawTruncateAutocodeSessionMessages(messages);
}
