/**
 * Core stream handler for AI SDK fullStream parts.
 *
 * The handler turns provider-specific stream chunks into the shared
 * Autocode session event protocol used by desktop, CLI, and VS Code hosts.
 */

import type {
  AutocodeSessionEventCallback,
  AutocodeStreamEvent,
  AutocodeTokenUsage,
} from './agent-session-types.js';
import {
  classifyAutocodeSessionError,
  classifyAutocodeToolError,
} from './agent-error-classifier.js';

export interface AutocodeTextDeltaPart {
  type: 'text-delta';
  text: string;
}

export interface AutocodeReasoningDeltaPart {
  type: 'reasoning-delta';
  delta: string;
}

export interface AutocodeToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  dynamic?: boolean;
  error?: unknown;
}

export interface AutocodeToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

export interface AutocodeToolErrorPart {
  type: 'tool-error';
  toolCallId: string;
  toolName: string;
  error: unknown;
}

export interface AutocodeFinishStepPart {
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
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  providerMetadata?: Record<string, unknown>;
}

export interface AutocodeErrorPart {
  type: 'error';
  error: unknown;
}

export type AutocodeFullStreamPart =
  | AutocodeTextDeltaPart
  | AutocodeReasoningDeltaPart
  | AutocodeToolCallPart
  | AutocodeToolResultPart
  | AutocodeToolErrorPart
  | AutocodeFinishStepPart
  | AutocodeErrorPart
  | { type: string; [key: string]: unknown };

export interface AutocodeStreamHandlerLogger {
  debug?(message?: unknown, ...optionalParams: unknown[]): void;
  warn?(message?: unknown, ...optionalParams: unknown[]): void;
  error?(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface AutocodeStreamHandlerOptions {
  debug?: boolean;
  logger?: AutocodeStreamHandlerLogger;
  now?: () => number;
}

interface AutocodeStreamHandlerState {
  stepNumber: number;
  toolCallCount: number;
  cumulativeUsage: AutocodeTokenUsage;
  toolCallTimestamps: Map<string, number>;
  toolCallNames: Map<string, string>;
}

function createInitialState(): AutocodeStreamHandlerState {
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

export function createAutocodeStreamHandler(
  onEvent: AutocodeSessionEventCallback,
  sessionId?: string,
  options: AutocodeStreamHandlerOptions = {},
) {
  const state = createInitialState();
  const getNow = options.now ?? (() => Date.now());

  function emit(event: AutocodeStreamEvent): void {
    onEvent(event);
  }

  function processPart(part: AutocodeFullStreamPart): void {
    if (part.type === 'finish-step' || part.type === 'finish' || part.type === 'error') {
      logDebug(options, `[StreamHandler] ${part.type}:`, part);
    }

    switch (part.type) {
      case 'text-delta':
        handleTextDelta(part as AutocodeTextDeltaPart);
        break;
      case 'reasoning-delta':
        handleReasoningDelta(part as AutocodeReasoningDeltaPart);
        break;
      case 'tool-call':
        handleToolCall(part as AutocodeToolCallPart);
        break;
      case 'tool-input-available':
        handleToolInputAvailable(part as { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown });
        break;
      case 'tool-result':
        handleToolResult(part as AutocodeToolResultPart);
        break;
      case 'tool-output-available':
        handleToolOutputAvailable(part as { type: 'tool-output-available'; toolCallId: string; output: unknown });
        break;
      case 'tool-output-error':
        handleToolOutputError(part as { type: 'tool-output-error'; toolCallId: string; errorText?: string });
        break;
      case 'tool-error':
        handleToolError(part as AutocodeToolErrorPart);
        break;
      case 'finish-step':
        handleFinishStep(part as AutocodeFinishStepPart);
        break;
      case 'finish':
        handleFinish(part);
        break;
      case 'error':
        handleError(part as AutocodeErrorPart);
        break;
    }
  }

  function handleTextDelta(part: AutocodeTextDeltaPart): void {
    emit({ type: 'text-delta', text: part.text ?? '' });
  }

  function handleReasoningDelta(part: AutocodeReasoningDeltaPart): void {
    emit({ type: 'thinking-delta', text: part.delta });
  }

  function handleToolCall(part: AutocodeToolCallPart): void {
    const toolCallId = getToolCallId(part as unknown as Record<string, unknown>) ?? part.toolCallId;
    state.toolCallCount++;
    state.toolCallTimestamps.set(toolCallId, getNow());
    state.toolCallNames.set(toolCallId, part.toolName);
    const args = normalizeToolCallArgs(part.toolName, part.input);

    if (part.invalid === true) {
      emit({
        type: 'tool-call',
        toolName: part.toolName,
        toolCallId,
        args,
      });
      return;
    }

    const validationError = validateToolCallParams(part.toolName, part.input, options);
    if (validationError) {
      logError(options, '[StreamHandler] Tool call validation failed:', {
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        error: validationError,
      });

      emit({
        type: 'tool-result',
        toolName: part.toolName,
        toolCallId,
        result: validationError,
        durationMs: 0,
        isError: true,
      });

      const toolError = classifyAutocodeToolError(part.toolName, toolCallId, validationError);
      emit({ type: 'error', error: toolError });
      return;
    }

    if (part.toolName === 'Write' && part.input) {
      const input = part.input;
      const record = typeof input === 'object' && input !== null
        ? input as Record<string, unknown>
        : undefined;
      logDebug(options, '[StreamHandler] Write tool call:', {
        toolCallId,
        inputType: typeof input,
        isObject: Boolean(record),
        file_path: record?.file_path,
        hasContent: record ? 'content' in record : false,
        contentLength: typeof record?.content === 'string' ? record.content.length : 0,
      });
    }

    emit({
      type: 'tool-call',
      toolName: part.toolName,
      toolCallId,
      args,
    });
  }

  function handleToolInputAvailable(part: { toolCallId: string; toolName: string; input: unknown }): void {
    handleToolCall({
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
    });
  }

  function handleToolResult(part: AutocodeToolResultPart): void {
    const toolCallId = getToolCallId(part as unknown as Record<string, unknown>) ?? part.toolCallId;
    const startTime = state.toolCallTimestamps.get(toolCallId);
    const durationMs = startTime ? getNow() - startTime : 0;
    state.toolCallTimestamps.delete(toolCallId);
    state.toolCallNames.delete(toolCallId);

    emit({
      type: 'tool-result',
      toolName: part.toolName,
      toolCallId,
      result: part.output,
      durationMs,
      isError: false,
    });
  }

  function handleToolOutputAvailable(part: { toolCallId: string; output: unknown }): void {
    const toolName = state.toolCallNames.get(part.toolCallId) ?? 'Tool';
    const startTime = state.toolCallTimestamps.get(part.toolCallId);
    const durationMs = startTime ? getNow() - startTime : 0;
    state.toolCallTimestamps.delete(part.toolCallId);
    state.toolCallNames.delete(part.toolCallId);

    emit({
      type: 'tool-result',
      toolName,
      toolCallId: part.toolCallId,
      result: part.output,
      durationMs,
      isError: false,
    });
  }

  function handleToolOutputError(part: { toolCallId: string; errorText?: string }): void {
    const toolName = state.toolCallNames.get(part.toolCallId) ?? 'Tool';
    const startTime = state.toolCallTimestamps.get(part.toolCallId);
    const durationMs = startTime ? getNow() - startTime : 0;
    state.toolCallTimestamps.delete(part.toolCallId);
    state.toolCallNames.delete(part.toolCallId);
    const errorMessage = part.errorText ?? 'Tool execution failed';

    emit({
      type: 'tool-result',
      toolName,
      toolCallId: part.toolCallId,
      result: errorMessage,
      durationMs,
      isError: true,
    });

    const toolError = classifyAutocodeToolError(toolName, part.toolCallId, errorMessage);
    emit({ type: 'error', error: toolError });
  }

  function handleToolError(part: AutocodeToolErrorPart): void {
    const toolCallId = getToolCallId(part as unknown as Record<string, unknown>) ?? part.toolCallId;
    const startTime = state.toolCallTimestamps.get(toolCallId);
    const durationMs = startTime ? getNow() - startTime : 0;
    state.toolCallTimestamps.delete(toolCallId);
    state.toolCallNames.delete(toolCallId);

    const errorMessage = part.error instanceof Error
      ? part.error.message
      : String(part.error ?? 'Tool execution failed');

    if (part.toolName === 'Write' && errorMessage.includes('json parsing failed')) {
      logError(options, '[StreamHandler] Write tool JSON truncation detected:', {
        toolCallId: part.toolCallId,
        error: errorMessage,
        suggestion: 'File content too large for single Write call. Consider using multiple smaller writes or appends.',
      });
    }

    emit({
      type: 'tool-result',
      toolName: part.toolName,
      toolCallId,
      result: errorMessage,
      durationMs,
      isError: true,
    });

    const toolError = classifyAutocodeToolError(part.toolName, toolCallId, errorMessage);
    emit({ type: 'error', error: toolError });
  }

  function handleFinishStep(part: AutocodeFinishStepPart): void {
    state.stepNumber++;

    let promptTokens = readNumberField(part.usage, ['promptTokens', 'inputTokens']) ?? 0;
    let completionTokens = readNumberField(part.usage, ['completionTokens', 'outputTokens']) ?? 0;

    if (promptTokens === 0 && completionTokens === 0 && part.response?.usage) {
      promptTokens = readNumberField(part.response.usage, ['prompt_tokens']) ?? 0;
      completionTokens = readNumberField(part.response.usage, ['completion_tokens']) ?? 0;
    }

    if (promptTokens === 0 && completionTokens === 0 && part.response) {
      logDebug(options, '[StreamHandler] No usage found, checking response object:', {
        hasUsage: Boolean(part.response.usage),
        responseKeys: Object.keys(part.response),
        headers: part.response.headers ? Object.keys(part.response.headers) : 'none',
      });
    }

    const totalTokens = promptTokens + completionTokens;

    if (totalTokens > 0 || (!part.usage && !part.response?.usage)) {
      logDebug(options, '[StreamHandler] finish-step usage:', {
        step: state.stepNumber,
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
        source: part.usage ? 'part.usage' : part.response?.usage ? 'response.usage' : 'none',
      });
    }

    state.cumulativeUsage.promptTokens += promptTokens;
    state.cumulativeUsage.completionTokens += completionTokens;
    state.cumulativeUsage.totalTokens += totalTokens;

    const stepUsage: AutocodeTokenUsage = {
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

  function handleFinish(part: Record<string, unknown>): void {
    logDebug(options, '[StreamHandler] Got finish event:', part);
    const usage = part.usage;
    if (!usage || typeof usage !== 'object') {
      return;
    }

    logDebug(options, '[StreamHandler] Found usage in finish event!', usage);
    const usageRecord = usage as Record<string, unknown>;
    const promptTokens = readNumberField(usageRecord, ['prompt_tokens', 'inputTokens', 'promptTokens']) ?? 0;
    const completionTokens = readNumberField(usageRecord, ['completion_tokens', 'outputTokens', 'completionTokens']) ?? 0;
    if (promptTokens > 0 || completionTokens > 0) {
      state.cumulativeUsage.promptTokens += promptTokens;
      state.cumulativeUsage.completionTokens += completionTokens;
      state.cumulativeUsage.totalTokens += promptTokens + completionTokens;
      logDebug(options, '[StreamHandler] Updated cumulative usage from finish event:', state.cumulativeUsage);
    }
  }

  function handleError(part: AutocodeErrorPart): void {
    const { sessionError } = classifyAutocodeSessionError(part.error ?? 'Stream error');
    emit({ type: 'error', error: sessionError });
  }

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

export type AutocodeStreamHandler = ReturnType<typeof createAutocodeStreamHandler>;

function validateToolCallParams(
  toolName: string,
  input: unknown,
  options: AutocodeStreamHandlerOptions,
): string | null {
  if (typeof input !== 'object' || input === null) {
    return `Tool '${toolName}' received invalid input type: ${typeof input}. Expected object.`;
  }

  const params = input as Record<string, unknown>;

  if (toolName === 'Write') {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return `Tool 'Write' missing required parameter 'file_path' or it's not a string.`;
    }

    if (!('content' in params)) {
      return `Tool 'Write' missing required parameter 'content'.`;
    }

    const content = params.content;
    if (typeof content !== 'string') {
      return `Tool 'Write' parameter 'content' must be a string, got ${typeof content}.`;
    }

    const contentLength = content.length;
    if (contentLength > 50000) {
      logWarn(options, `[StreamHandler] Write tool content is very large (${contentLength} chars). This may cause performance issues.`);
    }

    const filePath = params.file_path;
    if (filePath.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return `Tool 'Write' failed: Cannot write invalid JSON to ${filePath}. JSON parsing error: ${errorMsg}. The AI model generated malformed JSON - this usually happens when the content is too large and gets truncated. Please regenerate with smaller, more concise content.`;
      }
    }
  }

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

  if (toolName === 'Read') {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return `Tool 'Read' missing required parameter 'file_path' or it's not a string.`;
    }
  }

  return null;
}

function extractMalformedWritePath(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const match = input.match(/"file_path"\s*:\s*"([^"]+)"/);
  return match?.[1]?.replace(/\\/g, '/');
}

function normalizeToolCallArgs(toolName: string, input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  if (toolName === 'Write') {
    const filePath = extractMalformedWritePath(input);
    if (filePath) {
      return { file_path: filePath };
    }
  }

  return {};
}

function getToolCallId(part: Record<string, unknown>): string | null {
  if (typeof part.toolCallId === 'string') return part.toolCallId;
  if (typeof part.id === 'string') return part.id;
  return null;
}

function readNumberField(record: unknown, fieldNames: readonly string[]): number | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  const typedRecord = record as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const value = typedRecord[fieldName];
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : undefined;
    if (number !== undefined && Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return undefined;
}

function logDebug(options: AutocodeStreamHandlerOptions, message?: unknown, ...optionalParams: unknown[]): void {
  if (!options.debug) return;
  options.logger?.debug?.(message, ...optionalParams);
}

function logWarn(options: AutocodeStreamHandlerOptions, message?: unknown, ...optionalParams: unknown[]): void {
  options.logger?.warn?.(message, ...optionalParams);
}

function logError(options: AutocodeStreamHandlerOptions, message?: unknown, ...optionalParams: unknown[]): void {
  options.logger?.error?.(message, ...optionalParams);
}
