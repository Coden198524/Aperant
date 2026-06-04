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

import { buildThinkingProviderOptions } from '@autocode/core';
import { createStreamHandler } from './stream-handler';
import type { FullStreamPart } from './stream-handler';
import { classifyError, isAuthenticationError, isRateLimitError, isModelNotFoundError } from './error-classifier';
import { ProgressTracker } from './progress-tracker';
import type {
  SessionConfig,
  SessionResult,
  SessionOutcome,
  SessionError,
  SessionEventCallback,
  StreamEvent,
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

const WRITE_TOOL_INPUT_ERROR_PATTERNS = [
  'json parsing failed',
  'received invalid input type',
  'expected object',
  'invalid input for tool write',
  'missing required parameter',
  'parameter \'content\' must be a string',
] as const;

const MAX_WRITE_TOOL_INPUT_FAILURES_PER_SESSION = 2;

const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

function isOpenAIResponsesTransport(
  modelProviderId: string | undefined,
  modelId: string | undefined,
): boolean {
  if (modelProviderId) {
    const normalizedProviderId = modelProviderId.toLowerCase();
    const isResponsesProvider = normalizedProviderId === 'openai-responses' ||
      normalizedProviderId.endsWith('.responses') ||
      normalizedProviderId.endsWith('-responses');
    if (isResponsesProvider) return true;

    const isChatProvider = normalizedProviderId === 'openai-chat' ||
      normalizedProviderId.endsWith('.chat') ||
      normalizedProviderId.endsWith('-chat') ||
      normalizedProviderId.includes('chatmodel');
    if (isChatProvider) return false;

    // Some OpenAI-compatible gateways expose responses models with a generic
    // provider id (e.g. "openai"), so fall back to model-id based detection
    // when the provider is not explicitly marked as chat transport.
    return isResponsesApiModel(modelId);
  }

  // Fallback for tests or provider implementations that only expose model IDs.
  return isResponsesApiModel(modelId);
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function isWriteToolInputErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return WRITE_TOOL_INPUT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

interface WriteToolInputFailure {
  message: string;
  toolCallId?: string;
  filePath?: string;
}

function extractMalformedWritePath(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const match = input.match(/"file_path"\s*:\s*"([^"]+)"/);
  return match?.[1]?.replace(/\\/g, '/');
}

function getWriteToolInputFailure(part: FullStreamPart): WriteToolInputFailure | null {
  const toolName = typeof (part as { toolName?: unknown }).toolName === 'string'
    ? (part as { toolName: string }).toolName
    : undefined;

  if (part.type === 'tool-call' && toolName === 'Write') {
    const input = (part as { input?: unknown }).input;
    const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
      ? (part as { toolCallId: string }).toolCallId
      : undefined;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return {
        message: `received invalid input type ${typeof input}; expected object with file_path and content`,
        toolCallId,
        filePath: extractMalformedWritePath(input),
      };
    }

    const params = input as Record<string, unknown>;
    if (typeof params.file_path !== 'string' || typeof params.content !== 'string') {
      return {
        message: 'expected object with string file_path and string content',
        toolCallId,
        filePath: typeof params.file_path === 'string' ? params.file_path.replace(/\\/g, '/') : undefined,
      };
    }
  }

  if (part.type !== 'tool-error' || toolName !== 'Write') {
    return null;
  }

  const message = getErrorText((part as { error?: unknown }).error);
  if (!isWriteToolInputErrorMessage(message)) {
    return null;
  }

  return {
    message,
    toolCallId: typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
      ? (part as { toolCallId: string }).toolCallId
      : undefined,
    filePath: extractMalformedWritePath((part as { input?: unknown }).input),
  };
}

function buildWriteToolInputCorrectionPrompt(failure: WriteToolInputFailure): string {
  const target = failure.filePath ?? 'the required output file';
  return [
    'WRITE TOOL INPUT CORRECTION',
    '',
    `The previous Write call failed before execution: ${failure.message}`,
    '',
    'Next action: call Write with one JSON object, not a quoted string or markdown text.',
    '',
    'Required shape:',
    `{"file_path":"${target}","content":"# ...\\n..."}`,
    '',
    'Rules:',
    '- Include both file_path and content.',
    '- Use forward slashes in file_path.',
    '- Keep content compact enough for valid tool JSON.',
    '- Use Edit for small changes to existing files.',
    '- For spec.md, use Edit for targeted fixes; use Write only to create a missing short spec.',
  ].join('\n');
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function repairWriteToolInput(rawInput: string): string | null {
  const parsed = tryParseJson(rawInput);
  const candidate = typeof parsed === 'string' ? tryParseJson(parsed) : parsed;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const input = candidate as Record<string, unknown>;
  if (typeof input.file_path !== 'string' || typeof input.content !== 'string') {
    return null;
  }

  return JSON.stringify({
    file_path: input.file_path.replace(/\\/g, '/'),
    content: input.content,
  });
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolName(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.toolName === 'string'
    ? record.toolName
    : typeof record.tool_name === 'string'
      ? record.tool_name
      : null;
}

function isUpdateSubtaskStatusTool(toolName: string | null): boolean {
  return toolName?.endsWith('update_subtask_status') === true;
}

function getToolCallId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.toolCallId === 'string'
    ? record.toolCallId
    : typeof record.id === 'string'
      ? record.id
      : undefined;
}

function getRecordValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (name in record) {
      return record[name];
    }
  }
  return undefined;
}

function extractCompletedStatusText(text: string): string | null {
  const lower = text.toLowerCase();
  if (
    !lower.includes('completed') &&
    !text.includes("to status 'completed'") &&
    !text.includes('"status":"completed"') &&
    !text.includes('"status": "completed"')
  ) {
    return null;
  }
  return text.match(/subtask ['"]([^'"]+)['"]/i)?.[1] ??
    text.match(/subtask_id["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1] ??
    text.match(/"subtask_id"\s*:\s*"([^"]+)"/i)?.[1] ??
    null;
}

function extractCompletedStatusInput(input: unknown): { subtaskId?: string; completed: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { completed: false };
  }
  const record = input as Record<string, unknown>;
  const status = getRecordValue(record, ['status']);
  const subtaskId = getRecordValue(record, ['subtask_id', 'subtaskId', 'id']);
  return {
    completed: status === 'completed',
    subtaskId: typeof subtaskId === 'string' ? subtaskId : undefined,
  };
}

function extractCompletedSubtaskIdFromToolResult(part: FullStreamPart): string | null {
  if (part.type !== 'tool-result' || !isUpdateSubtaskStatusTool(getToolName(part))) {
    return null;
  }

  const record = part as Record<string, unknown>;
  const output = getRecordValue(record, ['output', 'result', 'content', 'text']);
  const text = stringifyToolValue(output);
  const idFromOutput = extractCompletedStatusText(text);
  if (idFromOutput) {
    return idFromOutput;
  }

  const inputCompletion = extractCompletedStatusInput(record.input);
  return inputCompletion.completed ? inputCompletion.subtaskId ?? null : null;
}

function extractCompletedSubtaskIdFromEvent(
  event: StreamEvent,
  pendingCompletions: Map<string, string>,
): string | null {
  if (event.type === 'tool-call' && isUpdateSubtaskStatusTool(event.toolName)) {
    const completion = extractCompletedStatusInput(event.args);
    if (completion.completed && completion.subtaskId) {
      pendingCompletions.set(event.toolCallId, completion.subtaskId);
    }
    return null;
  }

  if (event.type !== 'tool-result' || !isUpdateSubtaskStatusTool(event.toolName)) {
    return null;
  }

  if (event.isError) {
    pendingCompletions.delete(event.toolCallId);
    return null;
  }

  const text = stringifyToolValue(event.result);
  const idFromOutput = extractCompletedStatusText(text);
  const idFromInput = pendingCompletions.get(event.toolCallId);
  pendingCompletions.delete(event.toolCallId);
  return idFromOutput ?? idFromInput ?? null;
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
  const { onEvent, onAuthRefresh, onModelRefresh, tools, memoryContext, onAccountSwitch, currentAccountId } = options;
  const startTime = Date.now();
  const sessionId = crypto.randomUUID();

  let authRetries = 0;
  let activeConfig = config;
  let activeAccountId = currentAccountId;

  // Retry loop for auth refresh and account switching
  while (authRetries <= MAX_AUTH_RETRIES) {
    try {
      const result = await executeStream(activeConfig, tools, onEvent, memoryContext, sessionId);
      return {
        ...result,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const { sessionError, outcome } = classifyError(error);

      // Account-switch on rate limit (429), auth failure (401), or model not found (404)
      // This enables cross-provider fallback via the global priority queue
      if (
        (isRateLimitError(error) || isAuthenticationError(error) || isModelNotFoundError(error)) &&
        onAccountSwitch &&
        activeAccountId &&
        authRetries < MAX_AUTH_RETRIES
      ) {
        authRetries++;

        // Log the reason for switching
        const errorType = isRateLimitError(error) ? 'rate limit' :
                         isAuthenticationError(error) ? 'authentication failure' :
                         'model not found';
        console.warn(`[SessionRunner] ${errorType} detected, attempting to switch accounts...`);

        const newAuth = await onAccountSwitch(activeAccountId, sessionError);
        if (newAuth) {
          debugLog(`[SessionRunner] Switching to account ${newAuth.accountId} with model ${newAuth.resolvedModelId}`);

          // Switch to new account - dynamic import to avoid circular deps
          const { createProvider } = await import('../providers/factory');
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
            }),
          };
          activeAccountId = newAuth.accountId;
          continue;
        }
        // No more accounts available - fall through to legacy retry
      }

      // Legacy auth refresh (single-provider token refresh)
      if (
        isAuthenticationError(error) &&
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
const MEMORY_INJECTION_WARMUP_STEPS = 5;

/** Minimum gap between memory injections. Keeps repeated reminders from bloating context. */
const MEMORY_INJECTION_INTERVAL_STEPS = 4;

/** Stop active memory injection once the context window is moderately full. */
const MEMORY_INJECTION_CONTEXT_THRESHOLD = 0.65;

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
  let currentStepNumber = 0;
  let writeToolInputFailureCount = 0;
  const writeToolInputFailureCallIds = new Set<string>();
  let writeToolInputCorrectionPrompt: string | undefined;
  const completedSubtaskIds = new Set<string>();
  const pendingCompletedSubtaskToolCalls = new Map<string, string>();

  // Convergence nudge: track whether we've already nudged the agent to wrap up
  let convergenceNudgeInjected = false;

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
      memoryContext?.proxy.onReasoning(event.text, currentStepNumber);
    }
    // Track prompt tokens for context window guard
    if (event.type === 'step-finish') {
      lastPromptTokens = event.usage.promptTokens;
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
  const isResponsesModel = isResponsesApiModel(modelId);
  const usesResponsesTransport = isOpenAIResponsesTransport(modelProviderId, modelId);
  const isAnthropicModel = modelId?.startsWith('claude-') ?? false;

  // Compute thinking/reasoning provider options from session config
  const thinkingOptions = config.thinkingLevel
    ? buildThinkingProviderOptions(modelId, config.thinkingLevel)
    : undefined;

  // Check if model supports prompt caching
  const supportsPromptCaching = (config.model as any)?.supportsPromptCaching === true;

  // Build prompt caching metadata based on provider
  const promptCachingMetadata = supportsPromptCaching
    ? config.provider === 'anthropic'
      ? { anthropic: { cacheControl: { type: 'ephemeral' as const } } }
      : config.provider === 'openai'
        ? { openai: { cacheControl: { type: 'ephemeral' as const } } }
        : undefined
    : undefined;

  if (promptCachingMetadata) {
    debugLog(`[SessionRunner] Prompt Caching: ENABLED (${config.provider} ephemeral cache)`);
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
  const maxOutputTokens = resolveMaxOutputTokens(config);
  const responsePersistence = config.responsePersistence === true;

  const result = streamText({
    model: config.model,
    system: usesResponsesTransport ? undefined : config.systemPrompt,
    messages: aiMessages,
    tools: tools ?? {},
    ...(useOutputSchema ? { output: Output.object({ schema: config.outputSchema! }) } : {}),
    maxOutputTokens,
    stopWhen: stopCondition,
    abortSignal: mergedAbortSignal,
    ...((thinkingOptions || isResponsesModel || (useOutputSchema && isAnthropicModel) || promptCachingMetadata) ? {
      providerOptions: {
        ...(thinkingOptions ?? {}),
        ...(usesResponsesTransport ? {
          openai: {
            ...(thinkingOptions?.openai ?? {}),
            ...(config.systemPrompt ? { instructions: config.systemPrompt } : {}),
            store: responsePersistence,
          },
        } : {}),
        ...(useOutputSchema && isAnthropicModel ? {
          anthropic: { structuredOutputMode: 'outputFormat' },
        } : {}),
      },
    } : {}),
    ...(promptCachingMetadata ? {
      experimental_providerMetadata: promptCachingMetadata,
    } : {}),
    experimental_repairToolCall: repairMalformedToolCall,
    prepareStep: async ({ stepNumber }) => {
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

        const recentContext = stepMemoryState.getRecentContext(5);
        const injection = await memoryContext.proxy.requestStepInjection(
          stepNumber,
          recentContext,
        );

        memoryContext.proxy.onStepComplete(stepNumber);

        if (!injection) {
          return systemMessage ? { system: systemMessage } : {};
        }

        stepMemoryState.markInjected(injection.memoryIds);
        lastMemoryInjectionStep = stepNumber;

        const combinedSystem = systemMessage
          ? `${systemMessage}\n\n${injection.content}`
          : injection.content;

        return { system: combinedSystem };
      }

      // No memory context - just return system message if applicable
      return systemMessage ? { system: systemMessage } : {};
    },
    onStepFinish: (_stepResult) => {
      // onStepFinish is called after each agentic step.
      // Step results (tool calls, usage) are handled via the fullStream handler.
    },
  });

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
      streamHandler.processPart(part as FullStreamPart);
      const estimatedPartSize = estimateStreamPartSize(part as FullStreamPart);
      if (isCompletionStreamPart(part as FullStreamPart)) {
        streamedCompletionChars += estimatedPartSize;
      } else {
        streamedContextChars += estimatedPartSize;
      }

      const writeToolInputFailure = getWriteToolInputFailure(part as FullStreamPart);
      const completedSubtaskId = extractCompletedSubtaskIdFromToolResult(part as FullStreamPart);
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
          throw new Error(`Tool 'Write' input JSON failed after ${writeToolInputFailureCount} attempts: ${writeToolInputFailure.message}`);
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

      // Some providers surface request failures as `error` parts instead of
      // throwing from the async iterator. Treat these as fatal for the current
      // session so retry/account-switch logic can run in the outer catch.
      if ((part as { type?: string }).type === 'error') {
        const streamError = (part as { error?: unknown }).error;
        throw streamError ?? new Error('Stream error');
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
      return {
        outcome: 'error',
        stepsExecuted: summary.stepsExecuted,
        usage: summary.usage,
        error: {
          code: 'stream_timeout',
          message: `Stream inactivity timeout - no data received from provider for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s`,
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
    throw error;
  } finally {
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

  // Add assistant response to messages
  if (responseText) {
    messages.push({ role: 'assistant', content: responseText });
  }

  // Get total usage from AI SDK result. Providers differ in field naming, so
  // normalize below instead of assuming only inputTokens/outputTokens.
  let totalUsage: unknown;

  try {
    totalUsage = await withTimeout(result.totalUsage, POST_STREAM_TIMEOUT_MS, 'result.totalUsage');
  } catch (err) {
    // Fall through - use summary usage collected during stream iteration.
  }

  const normalizedTotalUsage = normalizeTokenUsage(totalUsage);
  const estimatedUsage = estimateTokenUsageFromSession({
    systemPrompt: config.systemPrompt,
    messages,
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
  };
}

// =============================================================================
// Helpers
// =============================================================================

function readNumberField(source: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const promptTokens = readNumberField(record, [
    'inputTokens',
    'promptTokens',
    'prompt_tokens',
    'input_tokens',
  ]) ?? 0;
  const completionTokens = readNumberField(record, [
    'outputTokens',
    'completionTokens',
    'completion_tokens',
    'output_tokens',
  ]) ?? 0;
  const explicitTotal = readNumberField(record, [
    'totalTokens',
    'total_tokens',
  ]);
  const totalTokens = explicitTotal ?? promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value ?? '').length;
  }
}

function estimateStreamPartSize(part: FullStreamPart): number {
  const record = part as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';

  if (type === 'text-delta') {
    return typeof record.delta === 'string'
      ? record.delta.length
      : typeof record.text === 'string'
        ? record.text.length
        : 0;
  }
  if (type === 'reasoning-delta' || type === 'reasoning') {
    return typeof record.delta === 'string'
      ? record.delta.length
      : typeof record.text === 'string'
        ? record.text.length
        : 0;
  }
  if (type === 'tool-call') {
    return safeJsonLength(record.input ?? record.args ?? record);
  }
  if (type === 'tool-result') {
    return safeJsonLength(record.output ?? record.result ?? record);
  }

  return 0;
}

function isCompletionStreamPart(part: FullStreamPart): boolean {
  const type = (part as { type?: unknown }).type;
  return type === 'text-delta' || type === 'reasoning-delta' || type === 'reasoning';
}

function estimateTokenUsageFromSession(input: {
  systemPrompt: string;
  messages: SessionMessage[];
  streamedCompletionChars: number;
  streamedContextChars: number;
}): TokenUsage {
  const promptChars = input.systemPrompt.length
    + input.messages.reduce((total, message) => total + message.content.length, 0)
    + input.streamedContextChars;
  const completionChars = input.streamedCompletionChars;
  const promptTokens = estimateTokensFromChars(promptChars);
  const completionTokens = estimateTokensFromChars(completionChars);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

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
