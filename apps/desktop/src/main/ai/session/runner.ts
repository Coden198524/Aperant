/**
 * Session Runner
 * ==============
 *
 * Core agent session runtime. Replaces Python's `run_agent_session()`.
 *
 * Uses Vercel AI SDK v6:
 * - `streamText()` with `stopWhen: stepCountIs(N)` for agentic looping
 * - `prepareStep` callback for between-step memory injection (optional)
 * - `onStepFinish` callbacks for progress tracking
 * - `fullStream` for text-delta, tool-call, tool-result, reasoning events
 *
 * Handles:
 * - Token refresh mid-session (catch 401 -> reactive refresh -> retry)
 * - Cancellation via AbortSignal
 * - Structured SessionResult with usage, outcome, messages
 * - Memory-aware step limits via calibration factor
 */

import { streamText, stepCountIs, Output } from 'ai';
import type { Tool as AITool } from 'ai';
import type { LanguageModelV3ToolCall } from '@ai-sdk/provider';
import type { WorkerObserverProxy } from '../memory/ipc/worker-observer-proxy';
import { StepMemoryState } from '../memory/injection/step-memory-state';
import { buildMemoryAwareStopCondition } from '../memory/injection/memory-stop-condition';

import {
  MAX_AUTOCODE_WRITE_TOOL_INPUT_FAILURES_PER_SESSION as MAX_WRITE_TOOL_INPUT_FAILURES_PER_SESSION,
  buildAutocodeWriteToolInputCorrectionPrompt as buildWriteToolInputCorrectionPrompt,
  buildProviderModelCreationPlan,
  parseAutocodeProviderModelInvocationRoutes,
  buildThinkingProviderOptions,
  estimateAutocodeStreamPartSize as estimateStreamPartSize,
  estimateAutocodeTokenUsageFromSession as estimateTokenUsageFromSession,
  extractAutocodeCompletedSubtaskIdFromEvent as extractCompletedSubtaskIdFromEvent,
  extractAutocodeCompletedSubtaskIdFromToolResult as extractCompletedSubtaskIdFromToolResult,
  getAutocodeWriteToolInputFailure as getWriteToolInputFailure,
  isAutocodeCompletionStreamPart as isCompletionStreamPart,
  isAutocodeOpenAIResponsesTransport as isOpenAIResponsesTransport,
  normalizeAutocodeTokenUsage as normalizeTokenUsage,
  repairAutocodeWriteToolInput as repairWriteToolInput,
  type AutocodeStreamPartLike,
} from '@autocode/core';
import {
  createAutocodeAgentSessionRunner,
  type AutocodeAgentSessionRunner,
} from '@autocode/core/runtime/agent-session-runner';
import { createStreamHandler } from './stream-handler';
import type { FullStreamPart } from './stream-handler';
import { classifyError, isAuthenticationError, isRateLimitError, isModelNotFoundError } from './error-classifier';
import { ProgressTracker } from './progress-tracker';
import { CODEX_OAUTH_RESPONSES_TRANSPORT } from '../agent/provider-transport';
import type {
  SessionConfig,
  SessionResult,
  SessionOutcome,
  SessionError,
  SessionEventCallback,
  TokenUsage,
  SessionMessage,
} from './types';
import type { QueueResolvedAuth } from '../auth/types';
import { debugLog } from '../../../shared/utils/debug-logger';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of auth refresh retries before giving up */
const MAX_AUTH_RETRIES = 1;

/** Additional retries for an OpenSpec request that fails before producing output. */
const MAX_OPENSPEC_TRANSIENT_RETRIES = 5;

/** Fail over promptly when the caller provides a replay-safe alternate transport. */
const MAX_OPENSPEC_TRANSIENT_RETRIES_BEFORE_FALLBACK = 2;

/** Initial OpenSpec retry delay; subsequent attempts use exponential backoff. */
const OPENSPEC_TRANSIENT_RETRY_BASE_DELAY_MS = 2_000;

/** Keep a single retry delay bounded while still tolerating a short provider incident. */
const OPENSPEC_TRANSIENT_RETRY_MAX_DELAY_MS = 20_000;

const OPENSPEC_TRANSIENT_ERROR_CODES = new Set([
  'rate_limited',
  'network_error',
  'temporarily_unavailable',
]);

/** Default max steps if not specified in config - safety backstop for spinning agents */
const DEFAULT_MAX_STEPS = 160;

/** Context window usage threshold (80%) for reactive compaction warning */
const CONTEXT_WINDOW_THRESHOLD = 0.80;

/** Context window usage threshold (88%) for hard abort - triggers continuation */
const CONTEXT_WINDOW_ABORT_THRESHOLD = 0.88;

/** Unique reason string for context-window aborts (used in catch to distinguish from user cancel) */
const CONTEXT_WINDOW_ABORT_REASON = '__context_window_exhausted__';

/** Agent types that should receive a convergence nudge when 75% of steps are used.
 *  These are agents that must write file-based output (verdict/report) to be useful. */
const CONVERGENCE_NUDGE_AGENT_TYPES = new Set<string>([
  'qa_reviewer', 'qa_fixer',
  'mmo_qa_reviewer', 'mmo_qa_fixer',
  'spec_critic', 'spec_validation',
  'pr_reviewer', 'pr_finding_validator',
]);

/** Timeout for post-stream result promises (result.text, result.totalUsage).
 *  Some providers (e.g., OpenAI Codex) may not properly resolve these promises
 *  after the stream closes. 10 seconds is generous - these should resolve instantly
 *  since the stream has already been fully consumed. */
const POST_STREAM_TIMEOUT_MS = 10_000;

/** Inactivity timeout for the stream consumption loop.
 *  If no stream parts arrive within this period, the stream is aborted.
 *  Protects against providers that accept the request but never send data
 *  (observed with OpenAI Codex via chatgpt.com/backend-api/codex/responses). */
const STREAM_INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes - increased for complex planning tasks

/** Buffer reasoning deltas before memory observation to avoid one IPC message per tiny stream chunk. */
const MEMORY_REASONING_OBSERVATION_FLUSH_CHARS = 1_800;

type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

class SessionAttemptError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly retrySafe: boolean,
    readonly source: 'provider' | 'local' = 'provider',
  ) {
    super(readSessionAttemptErrorMessage(originalError));
    this.name = 'SessionAttemptError';
  }
}

function readSessionAttemptErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Agent session attempt failed';
}

function startSessionAttempt<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new SessionAttemptError(error, true);
  }
}

function isStreamInactivityTimeoutAttempt(error: SessionAttemptError): boolean {
  return Boolean(
    error.originalError &&
    typeof error.originalError === 'object' &&
    (error.originalError as { code?: unknown }).code === 'stream_timeout',
  );
}

function shouldRetryOpenSpecTransientError(
  config: Pick<SessionConfig, 'agentType'>,
  error: unknown,
  sessionError: SessionError,
  retryCount: number,
  retryLimit = MAX_OPENSPEC_TRANSIENT_RETRIES,
): error is SessionAttemptError {
  return config.agentType === 'openspec' &&
    error instanceof SessionAttemptError &&
    error.source === 'provider' &&
    error.retrySafe &&
    !isStreamInactivityTimeoutAttempt(error) &&
    sessionError.retryable &&
    OPENSPEC_TRANSIENT_ERROR_CODES.has(sessionError.code) &&
    retryCount < retryLimit;
}

function canFallbackAfterProviderFailure(
  config: Pick<SessionConfig, 'agentType' | 'abortSignal'>,
  error: unknown,
  sessionError: SessionError,
  allowAfterProgress: boolean,
): error is SessionAttemptError {
  const canResumeAfterProgress =
    allowAfterProgress &&
    sessionError.retryable &&
    OPENSPEC_TRANSIENT_ERROR_CODES.has(sessionError.code);

  return config.agentType === 'openspec' &&
    !config.abortSignal?.aborted &&
    error instanceof SessionAttemptError &&
    error.source === 'provider' &&
    sessionError.code !== 'aborted' &&
    sessionError.code !== 'tool_execution_error' &&
    (error.retrySafe || canResumeAfterProgress);
}

function canReplaySessionAfterProviderError(
  config: Pick<SessionConfig, 'agentType'>,
  error: unknown,
): boolean {
  return config.agentType !== 'openspec' ||
    (
      error instanceof SessionAttemptError &&
      error.source === 'provider' &&
      error.retrySafe
    );
}

async function waitForOpenSpecRetry(delayMs: number, abortSignal?: AbortSignal): Promise<boolean> {
  if (abortSignal?.aborted) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (shouldRetry: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', handleAbort);
      resolve(shouldRetry);
    };
    const handleAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    abortSignal?.addEventListener('abort', handleAbort, { once: true });
    if (abortSignal?.aborted) handleAbort();
  });
}

async function repairMalformedToolCall(options: {
  toolCall: LanguageModelV3ToolCall;
}): Promise<LanguageModelV3ToolCall | null> {
  if (options.toolCall.toolName !== 'Write') {
    return null;
  }

  const repairedInput = repairWriteToolInput(options.toolCall.input);
  if (!repairedInput) {
    return null;
  }

  return {
    ...options.toolCall,
    input: repairedInput,
  };
}

// =============================================================================
// Runner Options
// =============================================================================

/**
 * Memory context for active injection into the agent loop.
 * When provided, `runAgentSession()` uses `prepareStep` to inject
 * memory-derived context between agent steps.
 */
export interface MemorySessionContext {
  /** Worker-side proxy for main-thread memory operations */
  proxy: WorkerObserverProxy;
  /** Pre-computed calibration factor for step limit adjustment (from getCalibrationFactor()) */
  calibrationFactor?: number;
}

/**
 * Options for `runAgentSession()` beyond the core SessionConfig.
 */
export interface RunnerOptions {
  /** Callback for streaming events (text, tool calls, progress) */
  onEvent?: SessionEventCallback;
  /** Callback to refresh auth token on 401; returns new API key or null */
  onAuthRefresh?: () => Promise<string | null>;
  /**
   * Optional factory to recreate the model with a fresh token after auth refresh.
   * If provided, called after a successful onAuthRefresh to replace the stale model.
   * Without this, the retry uses the old model instance (which carries the revoked token).
   */
  onModelRefresh?: (newToken: string) => import('ai').LanguageModel;
  /** Tools resolved for this session (from client factory) */
  tools?: Record<string, AITool>;
  /**
   * Optional memory context. When provided, enables active injection via
   * `prepareStep` (between-step gotcha injection, scratchpad reflection,
   * search short-circuit) and calibrated step limits.
   */
  memoryContext?: MemorySessionContext;
  /**
   * Called when an account switch is needed (429 rate limit, 401 auth failure, or 404 model not found).
   * Returns new resolved auth from the next account in the global priority queue, or null.
   * The caller (orchestration layer) provides this by calling resolveAuthFromQueue()
   * with the failed account excluded.
   */
  onAccountSwitch?: (failedAccountId: string, error: SessionError) => Promise<QueueResolvedAuth | null>;
  /** Current account ID from the priority queue (needed for account-switch retry) */
  currentAccountId?: string;
  /**
   * Optional alternate transport for a provider failure. By default it is
   * invoked only before any model output, tool call, or completed step.
   * Returning null preserves the original provider error.
   */
  onProviderFailureFallback?: (context: {
    originalError: unknown;
    sessionError: SessionError;
    outcome: SessionOutcome;
  }) => Promise<SessionResult | null>;
  /**
   * Allow the provider fallback to resume an OpenSpec Action after the API
   * attempt has already produced output or executed tools. Enable this only
   * when the fallback can inspect persisted workspace state and continue
   * without replaying completed mutations.
   */
  allowProviderFailureFallbackAfterProgress?: boolean;
}

// =============================================================================
// runAgentSession
// =============================================================================

/**
 * Run an agent session using AI SDK v6 `streamText()`.
 *
 * This is the main entry point for executing an agent. It:
 * 1. Configures `streamText()` with tools, system prompt, and stop conditions
 * 2. Processes the full stream for events (text, tool calls, reasoning)
 * 3. Tracks progress via `ProgressTracker`
 * 4. Handles auth failures with token refresh + retry
 * 5. Returns a structured `SessionResult`
 *
 * @param config - Session configuration (model, prompts, tools, limits)
 * @param options - Runner options (event callback, auth refresh)
 * @returns SessionResult with outcome, usage, messages, and error info
 */
export async function runAgentSession(
  config: SessionConfig,
  options: RunnerOptions = {},
): Promise<SessionResult> {
  const {
    onEvent,
    onAuthRefresh,
    onModelRefresh,
    tools,
    memoryContext,
    onAccountSwitch,
    currentAccountId,
    onProviderFailureFallback,
    allowProviderFailureFallbackAfterProgress = false,
  } = options;
  const startTime = Date.now();
  const sessionId = config.sessionId ?? crypto.randomUUID();
  const openSpecTransientRetryLimit = onProviderFailureFallback
    ? MAX_OPENSPEC_TRANSIENT_RETRIES_BEFORE_FALLBACK
    : MAX_OPENSPEC_TRANSIENT_RETRIES;

  let authRetries = 0;
  let transientRetries = 0;
  let activeConfig = config;
  let activeAccountId = currentAccountId;

  // Retry loop for auth refresh and account switching
  while (authRetries <= MAX_AUTH_RETRIES) {
    try {
      const result = await executeStream(
        activeConfig,
        tools,
        onEvent,
        memoryContext,
        sessionId,
        Boolean(onProviderFailureFallback),
        allowProviderFailureFallbackAfterProgress,
      );
      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const classifiedError = error instanceof SessionAttemptError
        ? error.originalError
        : error;
      const { sessionError, outcome } = classifyError(classifiedError);

      // Account-switch on rate limit (429), auth failure (401), or model not found (404)
      // This enables cross-provider fallback via the global priority queue
      if (
        (
          isRateLimitError(classifiedError) ||
          isAuthenticationError(classifiedError) ||
          isModelNotFoundError(classifiedError)
        ) &&
        canReplaySessionAfterProviderError(activeConfig, error) &&
        onAccountSwitch &&
        activeAccountId &&
        authRetries < MAX_AUTH_RETRIES
      ) {
        authRetries++;

        // Log the reason for switching
        const errorType = isRateLimitError(classifiedError)
          ? 'rate limit'
          : isAuthenticationError(classifiedError)
            ? 'authentication failure'
            : 'model not found';
        console.warn(`[SessionRunner] ${errorType} detected, attempting to switch accounts...`);

        const newAuth = await onAccountSwitch(activeAccountId, sessionError);
        if (newAuth) {
          debugLog(`[SessionRunner] Switching to account ${newAuth.accountId} with model ${newAuth.resolvedModelId}`);

          // Switch to new account - dynamic import to avoid circular deps
          const { createProvider } = await import('../providers/factory');
          const switchedProviderTransport = resolveAccountSwitchProviderTransport(newAuth, activeConfig);
          activeConfig = {
            ...activeConfig,
            model: createProvider({
              config: {
                provider: newAuth.resolvedProvider,
                apiKey: newAuth.apiKey,
                baseURL: newAuth.baseURL,
                headers: newAuth.headers,
                oauthTokenFilePath: newAuth.oauthTokenFilePath,
              },
              modelId: newAuth.resolvedModelId,
              invocationRoutes: activeConfig.providerModelInvocationRoutes,
            }),
            provider: newAuth.resolvedProvider,
            providerTransport: switchedProviderTransport,
            previousResponseId: undefined,
            providerResponseIdFields: undefined,
            providerResponsePersistence: undefined,
            providerFallback: undefined,
          };
          activeAccountId = newAuth.accountId;
          continue;
        }
        // No more accounts available - fall through to legacy retry
      }

      // Legacy auth refresh (single-provider token refresh)
      if (
        isAuthenticationError(classifiedError) &&
        canReplaySessionAfterProviderError(activeConfig, error) &&
        authRetries < MAX_AUTH_RETRIES &&
        onAuthRefresh
      ) {
        authRetries++;
        const newToken = await onAuthRefresh();
        if (!newToken) {
          return buildErrorResult(
            'auth_failure',
            sessionError,
            startTime,
            sessionId,
          );
        }
        if (onModelRefresh) {
          activeConfig = { ...activeConfig, model: onModelRefresh(newToken) };
        }
        continue;
      }

      if (shouldRetryOpenSpecTransientError(
        activeConfig,
        error,
        sessionError,
        transientRetries,
        openSpecTransientRetryLimit,
      )) {
        const retryNumber = transientRetries + 1;
        const delayMs = Math.min(
          OPENSPEC_TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** transientRetries,
          OPENSPEC_TRANSIENT_RETRY_MAX_DELAY_MS,
        );
        transientRetries = retryNumber;
        onEvent?.({
          type: 'text-delta',
          text:
            `[Provider] Temporarily unavailable. Retrying automatically in ` +
            `${Math.ceil(delayMs / 1_000)}s (${retryNumber}/${openSpecTransientRetryLimit}).\n`,
        });
        console.warn(
          `[SessionRunner] OpenSpec provider request failed before producing output; ` +
          `retrying in ${delayMs}ms (${retryNumber}/${openSpecTransientRetryLimit}): ` +
          sessionError.message,
        );
        const shouldContinue = await waitForOpenSpecRetry(delayMs, activeConfig.abortSignal);
        if (!shouldContinue) {
          return buildErrorResult(
            'cancelled',
            {
              code: 'aborted',
              message: 'Session was cancelled',
              retryable: false,
            },
            startTime,
            sessionId,
          );
        }
        continue;
      }

      if (
        onProviderFailureFallback &&
        canFallbackAfterProviderFailure(
          activeConfig,
          error,
          sessionError,
          allowProviderFailureFallbackAfterProgress,
        )
      ) {
        try {
          const fallbackResult = await onProviderFailureFallback({
            originalError: classifiedError,
            sessionError,
            outcome,
          });
          if (fallbackResult) {
            return {
              ...fallbackResult,
              durationMs: Date.now() - startTime,
            };
          }
        } catch (fallbackError) {
          console.warn(
            '[SessionRunner] Replay-safe provider fallback failed:',
            fallbackError,
          );
        }
      }

      // Non-retryable error or retries exhausted
      return buildErrorResult(outcome, sessionError, startTime, sessionId);
    }
  }

  // Should not reach here, but guard against it
  return buildErrorResult(
    'auth_failure',
    {
      code: 'auth_failure',
      message: 'Authentication failed after retries',
      retryable: false,
    },
    startTime,
    sessionId,
  );
}

function resolveAccountSwitchProviderTransport(
  auth: QueueResolvedAuth,
  config: Pick<SessionConfig, 'providerModelInvocationRoutes'>,
): string | undefined {
  try {
    const plan = buildProviderModelCreationPlan({
      provider: auth.resolvedProvider,
      apiKey: auth.apiKey,
      baseURL: auth.baseURL,
      headers: auth.headers,
      oauthTokenFilePath: auth.oauthTokenFilePath,
    }, auth.resolvedModelId, {
      invocationRoutes: parseAutocodeProviderModelInvocationRoutes(config.providerModelInvocationRoutes),
    });
    return `${auth.resolvedProvider}.${plan.invocation.method}`;
  } catch {
    return auth.resolvedProvider;
  }
}
// =============================================================================
// Stream Execution
// =============================================================================

// =============================================================================
// Memory Injection Helpers
// =============================================================================

/**
 * Number of initial steps to skip before starting memory injection.
 * The agent needs time to process the initial context before injections are useful.
 */
const MEMORY_INJECTION_WARMUP_STEPS = 6;

/** Minimum gap between memory injections. Keeps repeated reminders from bloating context. */
const MEMORY_INJECTION_INTERVAL_STEPS = 6;

/** Maximum active memory injections per session. Bounds cumulative context growth in long tool loops. */
const MEMORY_INJECTION_MAX_PER_SESSION = 3;

/** Stop active memory injection once the context window is moderately full. */
const MEMORY_INJECTION_CONTEXT_THRESHOLD = 0.55;

/** Default output token limits by phase. */
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const PHASE_MAX_OUTPUT_TOKENS: Partial<Record<NonNullable<SessionConfig['phase']>, number>> = {
  spec: 16_000,
  planning: 16_000,
  coding: 12_000,
  qa: 8_000,
};

const AGENT_MAX_OUTPUT_TOKENS: Partial<Record<string, number>> = {
  spec_orchestrator: 16_000,
  mmo_spec_orchestrator: 16_000,
  spec_writer: 16_000,
  planner: 16_000,
  build_orchestrator: 16_000,
  mmo_build_orchestrator: 16_000,
  mmo_system_designer: 16_000,
  mmo_engine_architect: 16_000,
  coder: 12_000,
  mmo_engine_programmer: 12_000,
  mmo_rendering_engineer: 12_000,
  mmo_animation_engineer: 12_000,
  mmo_asset_pipeline_engineer: 12_000,
  mmo_world_streaming_engineer: 12_000,
  mmo_tools_engineer: 12_000,
  mmo_build_release_engineer: 12_000,
  mmo_engine_performance_engineer: 12_000,
  mmo_server_authority_engineer: 12_000,
  mmo_network_sync_engineer: 12_000,
  mmo_client_gameplay_engineer: 12_000,
  mmo_data_persistence_engineer: 12_000,
  mmo_security_anticheat_engineer: 12_000,
  mmo_liveops_engineer: 12_000,
  direct_task: 32_000,
  qa_reviewer: 8_000,
  qa_fixer: 8_000,
  mmo_qa_reviewer: 8_000,
  mmo_qa_fixer: 8_000,
  commit_message: 2_000,
  pr_template_filler: 4_000,
  merge_resolver: 8_000,
};

function resolveMaxOutputTokens(config: SessionConfig): number {
  return AGENT_MAX_OUTPUT_TOKENS[config.agentType]
    ?? (config.phase ? PHASE_MAX_OUTPUT_TOKENS[config.phase] : undefined)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

// =============================================================================
// Stream Execution
// =============================================================================

/**
 * Execute the AI SDK streamText call and process the full stream.
 *
 * @returns Partial SessionResult (without durationMs, added by caller)
 */
async function executeStream(
  config: SessionConfig,
  tools: Record<string, AITool> | undefined,
  onEvent: SessionEventCallback | undefined,
  memoryContext: MemorySessionContext | undefined,
  sessionId: string,
  providerFailureFallbackEnabled: boolean,
  allowProviderFailureFallbackAfterProgress: boolean,
): Promise<Omit<SessionResult, 'durationMs'>> {
  const baseMaxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS;

  // Apply calibration-adjusted step limit if memory context is available
  const stopCondition = memoryContext
    ? buildMemoryAwareStopCondition(baseMaxSteps, memoryContext.calibrationFactor)
    : stepCountIs(baseMaxSteps);

  const maxSteps = baseMaxSteps; // Keep for outcome detection
  const progressTracker = new ProgressTracker();
  const messages: SessionMessage[] = [...config.initialMessages];
  let streamedCompletionChars = 0;
  let streamedContextChars = 0;

  // Context window guard: track prompt tokens per step
  const contextWindowLimit = config.contextWindowLimit ?? 0;
  let lastPromptTokens = 0;
  let contextWindowWarningInjected = false;

  // Dedicated abort controller for context window exhaustion.
  // Merged with user's abort signal so either can stop the stream.
  const contextWindowAbortController = new AbortController();

  // Stream inactivity abort: fires if the stream produces no data for too long.
  // Protects against providers (e.g., OpenAI Codex) that accept the request but
  // never send stream chunks, which would hang the worker thread indefinitely.
  const streamInactivityController = new AbortController();
  const STREAM_INACTIVITY_REASON = '__stream_inactivity_timeout__';

  const signals: AbortSignal[] = [
    contextWindowAbortController.signal,
    streamInactivityController.signal,
  ];
  if (config.abortSignal) signals.push(config.abortSignal);
  const mergedAbortSignal = AbortSignal.any(signals);

  // Per-step state for memory injection (only allocated when memory is active)
  const stepMemoryState = memoryContext ? new StepMemoryState() : null;
  let lastMemoryInjectionStep = 0;
  let memoryInjectionCount = 0;
  let currentStepNumber = 0;
  let memoryReasoningBuffer = '';
  let memoryReasoningBufferStep = 0;
  let writeToolInputFailureCount = 0;
  const writeToolInputFailureCallIds = new Set<string>();
  let writeToolInputCorrectionPrompt: string | undefined;
  const completedSubtaskIds = new Set<string>();
  const pendingCompletedSubtaskToolCalls = new Map<string, string>();

  // Convergence nudge: track whether we've already nudged the agent to wrap up
  let convergenceNudgeInjected = false;

  const flushMemoryReasoningBuffer = () => {
    if (!memoryContext || !stepMemoryState || !memoryReasoningBuffer.trim()) {
      memoryReasoningBuffer = '';
      return;
    }
    memoryContext.proxy.onReasoning(memoryReasoningBuffer, memoryReasoningBufferStep);
    memoryReasoningBuffer = '';
  };

  const bufferMemoryReasoning = (text: string) => {
    if (!memoryContext || !stepMemoryState) {
      return;
    }
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) {
      return;
    }
    if (memoryReasoningBuffer && memoryReasoningBufferStep !== currentStepNumber) {
      flushMemoryReasoningBuffer();
    }
    memoryReasoningBufferStep = currentStepNumber;
    memoryReasoningBuffer = memoryReasoningBuffer
      ? `${memoryReasoningBuffer} ${compact}`
      : compact;
    if (memoryReasoningBuffer.length >= MEMORY_REASONING_OBSERVATION_FLUSH_CHARS) {
      flushMemoryReasoningBuffer();
    }
  };

  // Build the event callback that also feeds the progress tracker
  const emitEvent: SessionEventCallback = (event) => {
    // Feed progress tracker
    progressTracker.processEvent(event);
    const completedSubtaskId = extractCompletedSubtaskIdFromEvent(event, pendingCompletedSubtaskToolCalls);
    if (completedSubtaskId) {
      completedSubtaskIds.add(completedSubtaskId);
    }
    // Track tool calls in memory state for injection decisions
    if (stepMemoryState && event.type === 'tool-call') {
      stepMemoryState.recordToolCall(event.toolName, event.args);
      // Also notify the observer proxy fire-and-forget
      memoryContext?.proxy.onToolCall(event.toolName, event.args, currentStepNumber);
    }
    if (stepMemoryState && event.type === 'tool-result') {
      memoryContext?.proxy.onToolResult(event.toolName, event.result, currentStepNumber);
    }
    if (stepMemoryState && event.type === 'thinking-delta' && event.text.trim()) {
      bufferMemoryReasoning(event.text);
    }
    // Track prompt tokens for context window guard
    if (event.type === 'step-finish') {
      flushMemoryReasoningBuffer();
      lastPromptTokens = event.usage.promptTokens;
      memoryContext?.proxy.onTokenUsage?.(
        event.usage.promptTokens,
        event.stepNumber,
        contextWindowLimit,
      );
      const usagePct = contextWindowLimit > 0
        ? ((lastPromptTokens / contextWindowLimit) * 100).toFixed(1)
        : 'N/A';
      debugLog(`[SessionRunner] Context Window: ${lastPromptTokens.toLocaleString()} / ${contextWindowLimit.toLocaleString()} tokens (${usagePct}%)`);
    }
    // Forward to external listener
    onEvent?.(event);
  };

  const streamHandler = createStreamHandler(emitEvent, sessionId);

  // Build messages array for AI SDK (system prompt is separate)
  const aiMessages = config.initialMessages.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }));

  // Responses models require `instructions` instead of system messages in `input`.
  // Subscription-backed Responses models also require `store: false`.
  const modelId = typeof config.model === 'string' ? config.model : config.model.modelId;
  const modelProviderId = typeof config.model === 'string' ? undefined : config.model.provider;
  const effectiveProviderId = modelProviderId ?? config.provider;
  const normalizedProviderId = typeof effectiveProviderId === 'string' ? effectiveProviderId.toLowerCase() : '';
  const configuredProviderTransport = config.providerTransport;
  const usesResponsesTransport = isOpenAIResponsesTransport(configuredProviderTransport ?? modelProviderId, modelId);
  const usesCodexOAuthTransport =
    configuredProviderTransport?.toLowerCase() === CODEX_OAUTH_RESPONSES_TRANSPORT;
  const usesAnthropicProvider = normalizedProviderId === 'anthropic';

  // Compute thinking/reasoning provider options from session config
  const thinkingOptions = config.thinkingLevel
    ? buildThinkingProviderOptions(modelId, config.thinkingLevel)
    : undefined;

  // Check if model supports prompt caching
  const supportsPromptCaching = (config.model as any)?.supportsPromptCaching === true;

  // Build prompt caching metadata based on provider
  const promptCachingMetadata = supportsPromptCaching
    ? normalizedProviderId === 'anthropic'
      ? { anthropic: { cacheControl: { type: 'ephemeral' as const } } }
      : normalizedProviderId === 'openai'
        ? { openai: { cacheControl: { type: 'ephemeral' as const } } }
        : undefined
    : undefined;

  if (promptCachingMetadata) {
    debugLog(`[SessionRunner] Prompt Caching: ENABLED (${effectiveProviderId} ephemeral cache)`);
  } else {
    debugLog('[SessionRunner] Prompt Caching: DISABLED (model does not support caching)');
  }

  // Execute streamText - prepareStep is only added when memory context exists
  //
  // IMPORTANT: Output.object() must NOT be combined with tools in the same streamText()
  // call. This is a known AI SDK limitation (GitHub #8354, #8984, #12016):
  // - Anthropic: tools are silently ignored when output schema is present
  // - Bedrock: tools are ignored with a runtime warning
  // - OpenAI: NoOutputGeneratedError if tool calls are the last step
  //
  // When both tools and outputSchema are requested, we run the tool loop first
  // (without output schema), then extract structured output from the response text
  // after the stream completes. The orchestrators' file-based validation
  // (validateAndNormalizeJsonFile + repairJsonWithLLM) handle the rest.
  const hasTools = tools != null && Object.keys(tools).length > 0;
  const useOutputSchema = config.outputSchema != null && !hasTools;
  // The ChatGPT/Codex subscription endpoint rejects max_output_tokens. This is
  // a transport constraint, not an OpenSpec workflow constraint.
  const omitMaxOutputTokens = usesCodexOAuthTransport;
  const maxOutputTokens = omitMaxOutputTokens
    ? undefined
    : resolveMaxOutputTokens(config);
  const providerResponsePersistenceOptions = usesCodexOAuthTransport
    ? undefined
    : resolveProviderResponsePersistenceOptions(config, {
        modelId,
        provider: modelProviderId ?? config.provider,
        sessionId,
      });
  const responsePersistence = !usesCodexOAuthTransport && (
    config.responsePersistence === true ||
    Boolean(config.previousResponseId) ||
    Boolean(config.providerResponsePersistence)
  );
  const providerOptions = mergeProviderOptions(
    thinkingOptions,
    usesResponsesTransport ? {
      openai: {
        ...(config.systemPrompt ? { instructions: config.systemPrompt } : {}),
        store: responsePersistence,
        ...(!usesCodexOAuthTransport && config.previousResponseId
          ? { previousResponseId: config.previousResponseId }
          : {}),
      },
    } : undefined,
    useOutputSchema && usesAnthropicProvider ? {
      anthropic: { structuredOutputMode: 'outputFormat' },
    } : undefined,
    config.providerOptions,
    providerResponsePersistenceOptions,
    usesCodexOAuthTransport ? {
      openai: {
        store: false,
        previousResponseId: undefined,
      },
    } : undefined,
  );

  const result = startSessionAttempt(() => streamText({
    model: config.model,
    system: usesResponsesTransport ? undefined : config.systemPrompt,
    messages: aiMessages,
    tools: tools ?? {},
    ...(useOutputSchema ? { output: Output.object({ schema: config.outputSchema! }) } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    stopWhen: stopCondition,
    abortSignal: mergedAbortSignal,
    ...(providerOptions ? { providerOptions } : {}),
    ...(promptCachingMetadata ? {
      experimental_providerMetadata: promptCachingMetadata,
    } : {}),
    // Providing an error callback suppresses AI SDK's default console.error
    // dump. The full stream still carries the error to the classified retry
    // and Codex CLI fallback path below.
    onError: () => undefined,
    experimental_repairToolCall: repairMalformedToolCall,
    prepareStep: async ({ stepNumber }) => {
      flushMemoryReasoningBuffer();
      currentStepNumber = stepNumber;
      // Hard abort: if we're at 95%+ of context window, stop the session
      // so the continuation wrapper can checkpoint and resume.
      if (
        contextWindowLimit > 0 &&
        lastPromptTokens > 0 &&
        lastPromptTokens > contextWindowLimit * CONTEXT_WINDOW_ABORT_THRESHOLD
      ) {
        contextWindowAbortController.abort(CONTEXT_WINDOW_ABORT_REASON);
        return {};
      }

      // Collect system messages to inject between steps
      const systemParts: string[] = [];

      if (writeToolInputCorrectionPrompt) {
        systemParts.push(writeToolInputCorrectionPrompt);
        writeToolInputCorrectionPrompt = undefined;
      }

      // Context window guard: inject compaction warning when approaching limit
      if (
        contextWindowLimit > 0 &&
        lastPromptTokens > 0 &&
        !contextWindowWarningInjected &&
        lastPromptTokens > contextWindowLimit * CONTEXT_WINDOW_THRESHOLD
      ) {
        contextWindowWarningInjected = true;
        const usagePct = Math.round((lastPromptTokens / contextWindowLimit) * 100);
        systemParts.push(
          `Context window is near limit (${usagePct}% used, ${lastPromptTokens.toLocaleString()} of ${contextWindowLimit.toLocaleString()} tokens). ` +
          `Finish the current task and commit progress; do not start new subtasks.`,
        );
      }

      // Convergence nudge: when 75%+ of step budget is used, remind agents
      // that produce file-based output (like QA reviewers) to write their verdict.
      // This doesn't cap the agent - it redirects spinning agents back on task.
      if (
        !convergenceNudgeInjected &&
        maxSteps > 0 &&
        stepNumber >= maxSteps * 0.75 &&
        CONVERGENCE_NUDGE_AGENT_TYPES.has(config.agentType)
      ) {
        convergenceNudgeInjected = true;
        const remaining = maxSteps - stepNumber;
        systemParts.push(
          `Step budget is almost used (${stepNumber}/${maxSteps}, ${remaining} remaining). ` +
          `Write the required verdict/result now and wrap up with current evidence.`,
        );
      }

      const systemMessage = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

      // Memory injection (only when memory context is active)
      if (memoryContext && stepMemoryState) {
        if (stepNumber < MEMORY_INJECTION_WARMUP_STEPS) {
          memoryContext.proxy.onStepComplete(stepNumber);
          return systemMessage ? { system: systemMessage } : {};
        }

        // Skip memory injection if context window is tight.
        const contextUsage = contextWindowLimit > 0 && lastPromptTokens > 0
          ? lastPromptTokens / contextWindowLimit
          : 0;

        if (contextUsage > MEMORY_INJECTION_CONTEXT_THRESHOLD) {
          // Context window tight - skip memory injection to preserve space
          memoryContext.proxy.onStepComplete(stepNumber);
          return systemMessage ? { system: systemMessage } : {};
        }

        if (stepNumber - lastMemoryInjectionStep < MEMORY_INJECTION_INTERVAL_STEPS) {
          memoryContext.proxy.onStepComplete(stepNumber);
          return systemMessage ? { system: systemMessage } : {};
        }

        if (memoryInjectionCount >= MEMORY_INJECTION_MAX_PER_SESSION) {
          memoryContext.proxy.onStepComplete(stepNumber);
          return systemMessage ? { system: systemMessage } : {};
        }

        const recentContext = stepMemoryState.getRecentContext(5);
        const injection = await memoryContext.proxy.requestStepInjection(
          stepNumber,
          recentContext,
        );

        memoryContext.proxy.onStepComplete(stepNumber);

        const injectionContent = injection?.content.trim();
        if (!injection || !injectionContent) {
          return systemMessage ? { system: systemMessage } : {};
        }

        stepMemoryState.markInjected(injection.memoryIds);
        lastMemoryInjectionStep = stepNumber;
        memoryInjectionCount++;

        const combinedSystem = systemMessage
          ? `${systemMessage}\n\n${injectionContent}`
          : injectionContent;

        return { system: combinedSystem };
      }

      // No memory context - just return system message if applicable
      return systemMessage ? { system: systemMessage } : {};
    },
    onStepFinish: (_stepResult) => {
      // onStepFinish is called after each agentic step.
      // Step results (tool calls, usage) are handled via the fullStream handler.
    },
  }));

  // Consume the full stream with inactivity timeout protection.
  // The timer fires if no stream parts arrive within STREAM_INACTIVITY_TIMEOUT_MS,
  // aborting the stream and preventing indefinite worker hangs.
  let streamInactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStreamInactivityTimer = () => {
    if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
    streamInactivityTimer = setTimeout(() => {
      streamInactivityController.abort(STREAM_INACTIVITY_REASON);
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  };

  resetStreamInactivityTimer(); // Arm for initial response
  try {
    for await (const part of result.fullStream) {
      resetStreamInactivityTimer(); // Reset on each part
      if ((part as { type?: string }).type === 'error') {
        const summary = streamHandler.getSummary();
        const retrySafe = summary.stepsExecuted === 0 &&
          summary.toolCallCount === 0 &&
          streamedCompletionChars === 0;
        const streamError = (part as { error?: unknown }).error;
        throw new SessionAttemptError(
          streamError ?? new Error('Stream error'),
          retrySafe,
        );
      }

      streamHandler.processPart(part as FullStreamPart);
      const policyPart = part as unknown as AutocodeStreamPartLike;
      const estimatedPartSize = estimateStreamPartSize(policyPart);
      if (isCompletionStreamPart(policyPart)) {
        streamedCompletionChars += estimatedPartSize;
      } else {
        streamedContextChars += estimatedPartSize;
      }

      const writeToolInputFailure = getWriteToolInputFailure(policyPart);
      const completedSubtaskId = extractCompletedSubtaskIdFromToolResult(policyPart);
      if (completedSubtaskId) {
        completedSubtaskIds.add(completedSubtaskId);
      }

      if (writeToolInputFailure) {
        const alreadyCounted = writeToolInputFailure.toolCallId
          ? writeToolInputFailureCallIds.has(writeToolInputFailure.toolCallId)
          : false;
        if (!alreadyCounted) {
          writeToolInputFailureCount += 1;
          if (writeToolInputFailure.toolCallId) {
            writeToolInputFailureCallIds.add(writeToolInputFailure.toolCallId);
          }
        }
        if (writeToolInputFailureCount >= MAX_WRITE_TOOL_INPUT_FAILURES_PER_SESSION) {
          throw new SessionAttemptError(
            new Error(
              `Tool 'Write' input JSON failed after ${writeToolInputFailureCount} attempts: ` +
              writeToolInputFailure.message,
            ),
            false,
            'local',
          );
        }
        writeToolInputCorrectionPrompt = buildWriteToolInputCorrectionPrompt(writeToolInputFailure);
      } else if (
        part.type === 'tool-result' &&
        typeof (part as { toolName?: unknown }).toolName === 'string' &&
        (part as { toolName: string }).toolName === 'Write'
      ) {
        writeToolInputFailureCount = 0;
        writeToolInputFailureCallIds.clear();
        writeToolInputCorrectionPrompt = undefined;
      }
    }
  } catch (error: unknown) {
    // Stream-level errors (network, abort, etc.)
    const summary = streamHandler.getSummary();

    // Check if this was a stream inactivity timeout
    if (
      streamInactivityController.signal.aborted &&
      streamInactivityController.signal.reason === STREAM_INACTIVITY_REASON
    ) {
      const message =
        `Stream inactivity timeout - no data received from provider for ` +
        `${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s`;
      const retrySafe = summary.stepsExecuted === 0 &&
        summary.toolCallCount === 0 &&
        streamedCompletionChars === 0;
      if (
        providerFailureFallbackEnabled &&
        (retrySafe || allowProviderFailureFallbackAfterProgress)
      ) {
        throw new SessionAttemptError(
          Object.assign(new Error(message), { code: 'stream_timeout' }),
          retrySafe,
        );
      }
      return {
        outcome: 'error',
        stepsExecuted: summary.stepsExecuted,
        usage: summary.usage,
        error: {
          code: 'stream_timeout',
          message,
          retryable: true,
        },
        messages,
        toolCallCount: summary.toolCallCount,
        ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
      };
    }

    // Check if this was a context-window abort (eligible for continuation)
    if (
      contextWindowAbortController.signal.aborted &&
      contextWindowAbortController.signal.reason === CONTEXT_WINDOW_ABORT_REASON
    ) {
      return {
        outcome: 'context_window',
        stepsExecuted: summary.stepsExecuted,
        usage: summary.usage,
        messages,
        toolCallCount: summary.toolCallCount,
        ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
      };
    }

    // Check if it's a user-initiated abort
    if (config.abortSignal?.aborted) {
      return {
        outcome: 'cancelled',
        stepsExecuted: summary.stepsExecuted,
        usage: summary.usage,
        error: {
          code: 'aborted',
          message: 'Session was cancelled',
          retryable: false,
        },
        messages,
        toolCallCount: summary.toolCallCount,
        ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
      };
    }
    // Re-throw for classification in the outer try/catch
    if (error instanceof SessionAttemptError) {
      throw error;
    }
    throw new SessionAttemptError(
      error,
      summary.stepsExecuted === 0 &&
        summary.toolCallCount === 0 &&
        streamedCompletionChars === 0,
    );
  } finally {
    flushMemoryReasoningBuffer();
    if (streamInactivityTimer) clearTimeout(streamInactivityTimer);
  }

  // Gather final summary from stream handler
  const summary = streamHandler.getSummary();

  // Determine outcome
  let outcome: SessionOutcome = 'completed';
  if (summary.stepsExecuted >= maxSteps) {
    outcome = 'max_steps';
  }

  // Collect response text from the stream result.
  // These AI SDK result promises can hang if the provider's stream closed
  // without properly signaling completion (observed with OpenAI Codex).
  // Use a timeout to prevent the worker from hanging indefinitely.
  let responseText = '';
  try {
    responseText = await withTimeout(result.text, POST_STREAM_TIMEOUT_MS, 'result.text');
  } catch {
    // Fall through - use empty text. The stream handler already captured
    // all text deltas, so this is just the final concatenated text.
  }

  // Extract structured output if schema was provided.
  // When Output.object() was used (no tools), extract from the AI SDK result.
  // When tools were present (Output.object() skipped), try to parse response text
  // as JSON and validate against the schema as a best-effort fallback.
  let structuredOutput: Record<string, unknown> | undefined;
  if (config.outputSchema) {
    if (useOutputSchema) {
      // Output.object() was active - extract from AI SDK result
      try {
        const output = await withTimeout(result.output, POST_STREAM_TIMEOUT_MS, 'result.output');
        if (output) {
          structuredOutput = output as Record<string, unknown>;
        }
      } catch {
        // Structured output extraction failed - non-fatal.
      }
    } else if (responseText) {
      // Tools were present so Output.object() was skipped.
      // Try to parse the response text as JSON and validate against the schema.
      // This catches models that output the structured data as their final text.
      try {
        // Extract JSON from response text (may be wrapped in markdown code fences)
        const jsonMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, responseText];
        const jsonStr = jsonMatch[1]?.trim();
        if (jsonStr) {
          const parsed = JSON.parse(jsonStr);
          const validated = config.outputSchema.safeParse(parsed);
          if (validated.success) {
            structuredOutput = validated.data as Record<string, unknown>;
          }
        }
      } catch {
        // JSON parsing failed - non-fatal. Caller uses file-based validation.
      }
    }
  }

  // Keep fallback usage estimates scoped to the actual prompt. The assistant
  // response is counted separately from streamed completion chars below.
  const messagesForUsageEstimate = [...messages];

  // Add assistant response to messages
  if (responseText) {
    messages.push({ role: 'assistant', content: responseText });
  }

  // Get total usage from AI SDK result. Providers differ in field naming, so
  // normalize below instead of assuming only inputTokens/outputTokens.
  let totalUsage: unknown;
  let providerResponseId: string | undefined;

  try {
    totalUsage = await withTimeout(result.totalUsage, POST_STREAM_TIMEOUT_MS, 'result.totalUsage');
  } catch (err) {
    // Fall through - use summary usage collected during stream iteration.
  }

  const providerMetadataPromise = (result as { providerMetadata?: PromiseLike<unknown> }).providerMetadata;
  if (providerMetadataPromise) {
    try {
      providerResponseId = extractProviderResponseId(
        await withTimeout(providerMetadataPromise, POST_STREAM_TIMEOUT_MS, 'result.providerMetadata'),
        config.providerResponseIdFields ?? config.providerResponsePersistence?.providerResponseIdFields,
      );
    } catch {
      providerResponseId = undefined;
    }
  }

  const normalizedTotalUsage = normalizeTokenUsage(totalUsage);
  const estimatedUsage = estimateTokenUsageFromSession({
    systemPrompt: config.systemPrompt,
    messages: messagesForUsageEstimate,
    streamedCompletionChars,
    streamedContextChars,
  });

  // For models that don't return usage in finish-step, totalUsage may have the
  // data while summary.usage is all zeros. Prefer normalized totalUsage when it
  // contains any token information.
  const usage: TokenUsage = {
    promptTokens: normalizedTotalUsage
      ? normalizedTotalUsage.promptTokens
      : summary.usage.totalTokens > 0
        ? summary.usage.promptTokens
        : estimatedUsage.promptTokens,
    completionTokens: normalizedTotalUsage
      ? normalizedTotalUsage.completionTokens
      : summary.usage.totalTokens > 0
        ? summary.usage.completionTokens
        : estimatedUsage.completionTokens,
    totalTokens:
      normalizedTotalUsage
        ? normalizedTotalUsage.totalTokens
        : summary.usage.totalTokens > 0
          ? summary.usage.totalTokens
          : estimatedUsage.totalTokens,
    ...(normalizedTotalUsage || summary.usage.totalTokens > 0 ? {} : { estimated: true }),
    sessionId,
  };

  // Log token usage with cache information
  const cacheReadTokens = (totalUsage as any)?.cacheReadTokens ?? 0;
  const cacheCreationTokens = (totalUsage as any)?.cacheCreationTokens ?? 0;
  const hasCacheData = cacheReadTokens > 0 || cacheCreationTokens > 0;

  debugLog('[SessionRunner] Token Usage:', {
    prompt: usage.promptTokens.toLocaleString(),
    completion: usage.completionTokens.toLocaleString(),
    total: usage.totalTokens.toLocaleString(),
    ...(hasCacheData ? {
      cacheRead: cacheReadTokens.toLocaleString(),
      cacheCreation: cacheCreationTokens.toLocaleString(),
      cacheSavings: cacheReadTokens > 0 ? `${((cacheReadTokens / (usage.promptTokens + cacheReadTokens)) * 100).toFixed(1)}%` : '0%',
    } : {}),
  });

  // Log only when usage is missing or zero (potential issue)
  if (usage.totalTokens === 0) {
    debugLog('[SessionRunner] Warning: Zero token usage detected', {
      totalUsage,
      summaryUsage: summary.usage,
    });
  }

  return {
    outcome,
    stepsExecuted: summary.stepsExecuted,
    usage,
    messages,
    toolCallCount: summary.toolCallCount,
    ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
  };
}

export type DesktopAgentSessionRunner = AutocodeAgentSessionRunner<SessionConfig, RunnerOptions>;

export const desktopAgentSessionRunner: DesktopAgentSessionRunner =
  createAutocodeAgentSessionRunner(runAgentSession);

/**
 * Build an error SessionResult.
 */
function buildErrorResult(
  outcome: SessionOutcome,
  error: SessionError,
  startTime: number,
  sessionId: string,
): SessionResult {
  return {
    outcome,
    stepsExecuted: 0,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      sessionId,
    },
    error,
    messages: [],
    toolCallCount: 0,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Race a promise against a timeout. Rejects with a descriptive error if the
 * promise doesn't settle within `ms` milliseconds.
 *
 * Used for AI SDK result promises (result.text, result.totalUsage) which can
 * hang indefinitely if the provider stream closes without signaling completion.
 */
function withTimeout<T>(thenable: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${label} (${ms}ms)`));
    }, ms);
    thenable.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error as Error); },
    );
  });
}

const DEFAULT_PROVIDER_RESPONSE_ID_FIELDS = [
  'openai.responseId',
  'openai.response_id',
  'responseId',
  'response_id',
];

type ProviderOptionsTemplateContext = Record<string, string | undefined>;

function resolveProviderResponsePersistenceOptions(
  config: SessionConfig,
  context: Pick<ProviderOptionsTemplateContext, 'modelId' | 'provider' | 'sessionId'>,
): StreamTextProviderOptions | undefined {
  const persistence = config.providerResponsePersistence;
  if (!persistence) {
    return undefined;
  }
  const providerResponseId = persistence.providerResponseId;
  const template = providerResponseId && persistence.continuationProviderOptions
    ? persistence.continuationProviderOptions
    : persistence.providerOptions;
  return renderProviderOptionsTemplate(template, {
    providerResponseId,
    provider_response_id: providerResponseId,
    systemPrompt: config.systemPrompt,
    system_prompt: config.systemPrompt,
    modelId: context.modelId,
    model_id: context.modelId,
    provider: context.provider,
    sessionId: context.sessionId,
    session_id: context.sessionId,
  });
}

function renderProviderOptionsTemplate(
  template: Record<string, Record<string, unknown>> | undefined,
  context: ProviderOptionsTemplateContext,
): StreamTextProviderOptions | undefined {
  if (!template) {
    return undefined;
  }
  const rendered = renderProviderOptionValue(template, context);
  return isRecord(rendered) ? rendered as StreamTextProviderOptions : undefined;
}

function renderProviderOptionValue(value: unknown, context: ProviderOptionsTemplateContext): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, shellKey, braceKey) => {
      const key = shellKey ?? braceKey;
      return  Object.hasOwn(context, key) ? context[key] ?? '' : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderProviderOptionValue(item, context));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderProviderOptionValue(item, context)]),
    );
  }
  return value;
}
function mergeProviderOptions(
  ...items: Array<StreamTextProviderOptions | Record<string, Record<string, unknown>> | undefined>
): StreamTextProviderOptions | undefined {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    if (!item) {
      continue;
    }
    for (const [provider, options] of Object.entries(item)) {
      merged[provider] = {
        ...(merged[provider] ?? {}),
        ...options,
      };
    }
  }
  return Object.keys(merged).length > 0 ? merged as StreamTextProviderOptions : undefined;
}

function extractProviderResponseId(metadata: unknown, fields?: string[]): string | undefined {
  const paths = fields?.length ? fields : DEFAULT_PROVIDER_RESPONSE_ID_FIELDS;
  for (const path of paths) {
    const value = getValueByPath(metadata, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getValueByPath(value: unknown, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
