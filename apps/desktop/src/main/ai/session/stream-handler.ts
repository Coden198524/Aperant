/**
 * Stream Handler
 * ==============
 *
 * Processes AI SDK v6 fullStream events and emits structured StreamEvent objects.
 * Bridges the raw AI SDK stream into the session event system.
 *
 * AI SDK v6 fullStream parts handled:
 * - text-delta: Incremental text output (field: `text`)
 * - reasoning-delta: Extended thinking / reasoning output (field: `delta`)
 * - tool-call: Model has assembled a complete tool call (fields: `toolCallId`, `toolName`, `input`)
 * - tool-result: Tool execution completed (fields: `toolCallId`, `toolName`, `output`)
 * - tool-error: Tool execution failed (fields: `toolCallId`, `toolName`, `error`)
 * - finish-step: An agentic step completed (field: `usage` with `promptTokens`/`completionTokens`)
 * - error: Stream-level error (field: `error`)
 */

import type {
  SessionEventCallback,
  StreamEvent,
  TokenUsage,
} from './types';
import { classifyError, classifyToolError } from './error-classifier';

// =============================================================================
// Types
// =============================================================================

/**
 * AI SDK v6 fullStream part types we handle.
 * These match the actual shape emitted by `streamText().fullStream` in AI SDK v6.
 *
 * Verified against AI SDK v6 docs:
 * - text-delta uses `text` field
 * - reasoning-delta uses `delta` field
 * - tool-call has `toolCallId`, `toolName`, `input`
 * - tool-result has `toolCallId`, `toolName`, `input`, `output`
 * - tool-error has `toolCallId`, `toolName`, `error`
 * - finish-step usage uses `promptTokens`/`completionTokens`
 * - error uses `error` field (not `errorText`)
 */
export interface TextDeltaPart {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaPart {
  type: 'reasoning-delta';
  delta: string;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

export interface ToolErrorPart {
  type: 'tool-error';
  toolCallId: string;
  toolName: string;
  error: unknown;
}

export interface FinishStepPart {
  type: 'finish-step';
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  response?: {
    id?: string;
    timestamp?: Date;
    modelId?: string;
    headers?: Record<string, string>;
    // OpenAI compatible APIs may include usage in response
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  providerMetadata?: Record<string, unknown>;
}

export interface ErrorPart {
  type: 'error';
  error: unknown;
}

export type FullStreamPart =
  | TextDeltaPart
  | ReasoningDeltaPart
  | ToolCallPart
  | ToolResultPart
  | ToolErrorPart
  | FinishStepPart
  | ErrorPart
  | { type: string; [key: string]: unknown };

// =============================================================================
// Stream Handler State
// =============================================================================

interface StreamHandlerState {
  stepNumber: number;
  toolCallCount: number;
  cumulativeUsage: TokenUsage;
  /** Track tool call start times for duration calculation */
  toolCallTimestamps: Map<string, number>;
  /** Track tool names by toolCallId (needed to emit tool-result with name from tool-output-available) */
  toolCallNames: Map<string, string>;
}

function createInitialState(): StreamHandlerState {
  return {
    stepNumber: 0,
    toolCallCount: 0,
    cumulativeUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    toolCallTimestamps: new Map(),
    toolCallNames: new Map(),
  };
}

// =============================================================================
// Tool Call Parameter Validation
// =============================================================================

/**
 * Validates tool call parameters before execution to catch common issues
 * that would cause failures during tool execution.
 *
 * Returns an error message if validation fails, or null if valid.
 */
function validateToolCallParams(toolName: string, input: unknown): string | null {
  // Only validate if input is an object
  if (typeof input !== 'object' || input === null) {
    return `Tool '${toolName}' received invalid input type: ${typeof input}. Expected object.`;
  }

  const params = input as Record<string, unknown>;

  // Validate Write tool parameters
  if (toolName === 'Write') {
    // Check for required file_path parameter
    if (!params.file_path || typeof params.file_path !== 'string') {
      return `Tool 'Write' missing required parameter 'file_path' or it's not a string.`;
    }

    // Check for required content parameter
    if (!('content' in params)) {
      return `Tool 'Write' missing required parameter 'content'.`;
    }

    const content = params.content;
    if (typeof content !== 'string') {
      return `Tool 'Write' parameter 'content' must be a string, got ${typeof content}.`;
    }

    // Check content size - warn if extremely large (>50KB)
    const contentLength = content.length;
    if (contentLength > 50000) {
      console.warn(`[StreamHandler] Write tool content is very large (${contentLength} chars). This may cause performance issues.`);
    }

    // Validate JSON files have valid JSON content
    const filePath = params.file_path as string;
    if (filePath.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return `Tool 'Write' failed: Cannot write invalid JSON to ${filePath}. JSON parsing error: ${errorMsg}. The AI model generated malformed JSON - this usually happens when the content is too large and gets truncated. Please regenerate with smaller, more concise content.`;
      }
    }
  }

  // Validate Edit tool parameters
  if (toolName === 'Edit') {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return `Tool 'Edit' missing required parameter 'file_path' or it's not a string.`;
    }
    if (!params.old_string || typeof params.old_string !== 'string') {
      return `Tool 'Edit' missing required parameter 'old_string' or it's not a string.`;
    }
    if (!params.new_string || typeof params.new_string !== 'string') {
      return `Tool 'Edit' missing required parameter 'new_string' or it's not a string.`;
    }
  }

  // Validate Read tool parameters
  if (toolName === 'Read') {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return `Tool 'Read' missing required parameter 'file_path' or it's not a string.`;
    }
  }

  // Add more tool-specific validations as needed

  return null; // Validation passed
}

// =============================================================================
// Stream Handler
// =============================================================================

/**
 * Creates a stream handler that processes AI SDK v6 fullStream parts
 * and emits structured StreamEvents via the callback.
 *
 * Usage:
 * ```ts
 * const handler = createStreamHandler(onEvent);
 * for await (const part of result.fullStream) {
 *   handler.processPart(part);
 * }
 * const summary = handler.getSummary();
 * ```
 */
export function createStreamHandler(onEvent: SessionEventCallback, sessionId?: string) {
  const state = createInitialState();

  function emit(event: StreamEvent): void {
    onEvent(event);
  }

  function processPart(part: FullStreamPart): void {
    // Only log important part types
    if (part.type === 'finish-step' || part.type === 'finish' || part.type === 'error') {
      console.log(`[StreamHandler] ${part.type}:`, part);
    }

    switch (part.type) {
      case 'text-delta':
        handleTextDelta(part as TextDeltaPart);
        break;
      case 'reasoning-delta':
        handleReasoningDelta(part as ReasoningDeltaPart);
        break;
      case 'tool-call':
        handleToolCall(part as ToolCallPart);
        break;
      case 'tool-result':
        handleToolResult(part as ToolResultPart);
        break;
      case 'tool-error':
        handleToolError(part as ToolErrorPart);
        break;
      case 'finish-step':
        handleFinishStep(part as FinishStepPart);
        break;
      case 'finish':
        // Handle final 'finish' event which might contain usage
        console.log('[StreamHandler] Got finish event:', part);
        if ((part as any).usage) {
          console.log('[StreamHandler] Found usage in finish event!', (part as any).usage);
          // Accumulate usage from finish event
          const usage = (part as any).usage;
          const promptTokens = usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0;
          const completionTokens = usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens ?? 0;
          if (promptTokens > 0 || completionTokens > 0) {
            state.cumulativeUsage.promptTokens += promptTokens;
            state.cumulativeUsage.completionTokens += completionTokens;
            state.cumulativeUsage.totalTokens += (promptTokens + completionTokens);
            console.log('[StreamHandler] Updated cumulative usage from finish event:', state.cumulativeUsage);
          }
        }
        break;
      case 'error':
        handleError(part as ErrorPart);
        break;
      // Ignore other part types (text-start, text-end, tool-input-start,
      // tool-input-delta, start-step, start, finish, reasoning-start,
      // reasoning-end, source, file, raw, etc.)
    }
  }

  function handleTextDelta(part: TextDeltaPart): void {
    emit({ type: 'text-delta', text: part.text ?? '' });
  }

  function handleReasoningDelta(part: ReasoningDeltaPart): void {
    emit({ type: 'thinking-delta', text: part.delta });
  }

  function handleToolCall(part: ToolCallPart): void {
    state.toolCallCount++;
    state.toolCallTimestamps.set(part.toolCallId, Date.now());
    // Store the tool name so we can include it in tool-result/tool-error events
    state.toolCallNames.set(part.toolCallId, part.toolName);

    // Pre-validate tool call parameters to catch issues before execution
    const validationError = validateToolCallParams(part.toolName, part.input);
    if (validationError) {
      console.error('[StreamHandler] Tool call validation failed:', {
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        error: validationError,
      });

      // Emit as tool-error immediately instead of executing
      emit({
        type: 'tool-result',
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        result: validationError,
        durationMs: 0,
        isError: true,
      });

      const toolError = classifyToolError(part.toolName, part.toolCallId, validationError);
      emit({ type: 'error', error: toolError });
      return;
    }

    // Debug: Log tool call input for Write tool to diagnose JSON truncation
    if (part.toolName === 'Write' && part.input) {
      const input = part.input;
      console.log('[StreamHandler] Write tool call:', {
        toolCallId: part.toolCallId,
        inputType: typeof input,
        isObject: typeof input === 'object' && input !== null,
        file_path: typeof input === 'object' && input !== null ? (input as Record<string, unknown>).file_path : undefined,
        hasContent: typeof input === 'object' && input !== null ? 'content' in input : false,
        contentLength: typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>).content === 'string' ? ((input as Record<string, unknown>).content as string).length : 0,
      });
    }

    emit({
      type: 'tool-call',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      args: (part.input as Record<string, unknown>) ?? {},
    });
  }

  function handleToolResult(part: ToolResultPart): void {
    const startTime = state.toolCallTimestamps.get(part.toolCallId);
    const durationMs = startTime ? Date.now() - startTime : 0;
    state.toolCallTimestamps.delete(part.toolCallId);
    state.toolCallNames.delete(part.toolCallId);

    emit({
      type: 'tool-result',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      result: part.output,
      durationMs,
      isError: false,
    });
  }

  function handleToolError(part: ToolErrorPart): void {
    const startTime = state.toolCallTimestamps.get(part.toolCallId);
    const durationMs = startTime ? Date.now() - startTime : 0;
    state.toolCallTimestamps.delete(part.toolCallId);
    state.toolCallNames.delete(part.toolCallId);

    const errorMessage = part.error instanceof Error ? part.error.message : String(part.error ?? 'Tool execution failed');

    // Detect JSON truncation in Write tool calls
    if (part.toolName === 'Write' && errorMessage.includes('json parsing failed')) {
      console.error('[StreamHandler] Write tool JSON truncation detected:', {
        toolCallId: part.toolCallId,
        error: errorMessage,
        suggestion: 'File content too large for single Write call. Consider using multiple smaller writes or appends.',
      });
    }

    emit({
      type: 'tool-result',
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      result: errorMessage,
      durationMs,
      isError: true,
    });

    const toolError = classifyToolError(part.toolName, part.toolCallId, errorMessage);
    emit({ type: 'error', error: toolError });
  }

  function handleFinishStep(part: FinishStepPart): void {
    state.stepNumber++;

    // AI SDK usage field names differ by provider/transport:
    // - promptTokens/completionTokens (legacy)
    // - inputTokens/outputTokens (OpenAI Responses)
    // - response.usage.prompt_tokens/completion_tokens (OpenAI compatible APIs)
    let promptTokens = part.usage?.promptTokens ?? part.usage?.inputTokens ?? 0;
    let completionTokens = part.usage?.completionTokens ?? part.usage?.outputTokens ?? 0;

    // Fallback: Try to get usage from response object (for OpenAI compatible APIs)
    if (promptTokens === 0 && completionTokens === 0 && part.response?.usage) {
      promptTokens = part.response.usage.prompt_tokens ?? 0;
      completionTokens = part.response.usage.completion_tokens ?? 0;
    }

    // Check if response has any usage-related fields we might have missed
    if (promptTokens === 0 && completionTokens === 0 && part.response) {
      const resp = part.response as any;
      console.log('[StreamHandler] No usage found, checking response object:', {
        hasUsage: !!resp.usage,
        responseKeys: Object.keys(resp),
        headers: resp.headers ? Object.keys(resp.headers) : 'none'
      });
    }

    const totalTokens = promptTokens + completionTokens;

    // Only log if we got non-zero usage or if usage data is completely missing
    if (totalTokens > 0 || (!part.usage && !part.response?.usage)) {
      console.log(`[StreamHandler] finish-step usage:`, {
        step: state.stepNumber,
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
        source: part.usage ? 'part.usage' : part.response?.usage ? 'response.usage' : 'none',
      });
    }

    // Accumulate usage
    state.cumulativeUsage.promptTokens += promptTokens;
    state.cumulativeUsage.completionTokens += completionTokens;
    state.cumulativeUsage.totalTokens += totalTokens;

    const stepUsage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
    };

    emit({
      type: 'step-finish',
      stepNumber: state.stepNumber,
      usage: stepUsage,
    });

    emit({
      type: 'usage-update',
      usage: {
        ...state.cumulativeUsage,
        stepsExecuted: state.stepNumber,
        sessionId,
      },
    });
  }

  function handleError(part: ErrorPart): void {
    const { sessionError } = classifyError(part.error ?? 'Stream error');
    emit({ type: 'error', error: sessionError });
  }

  /**
   * Returns a summary of the stream processing state.
   * Call after the stream is fully consumed.
   */
  function getSummary() {
    return {
      stepsExecuted: state.stepNumber,
      toolCallCount: state.toolCallCount,
      usage: { ...state.cumulativeUsage, sessionId },
    };
  }

  return {
    processPart,
    getSummary,
  };
}

export type StreamHandler = ReturnType<typeof createStreamHandler>;
