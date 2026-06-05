import { isResponsesApiModel } from '../providers/routing.js';
import type {
  AutocodeSessionMessage,
  AutocodeStreamEvent,
  AutocodeTokenUsage,
} from './agent-session-types.js';

export const AUTOCODE_WRITE_TOOL_INPUT_ERROR_PATTERNS = [
  'json parsing failed',
  'received invalid input type',
  'expected object',
  'invalid input for tool write',
  'missing required parameter',
  'parameter \'content\' must be a string',
] as const;

export const MAX_AUTOCODE_WRITE_TOOL_INPUT_FAILURES_PER_SESSION = 2;
export const AUTOCODE_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

export interface AutocodeStreamPartLike {
  type?: string;
  [key: string]: unknown;
}

export interface AutocodeWriteToolInputFailure {
  message: string;
  toolCallId?: string;
  filePath?: string;
}

export function isAutocodeOpenAIResponsesTransport(
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

    return isResponsesApiModel(modelId);
  }

  return isResponsesApiModel(modelId);
}

export function isAutocodeWriteToolInputErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTOCODE_WRITE_TOOL_INPUT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function extractAutocodeMalformedWritePath(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const match = input.match(/"file_path"\s*:\s*"([^"]+)"/);
  return match?.[1]?.replace(/\\/g, '/');
}

export function getAutocodeWriteToolInputFailure(part: AutocodeStreamPartLike): AutocodeWriteToolInputFailure | null {
  const toolName = typeof part.toolName === 'string'
    ? part.toolName
    : undefined;

  if (part.type === 'tool-call' && toolName === 'Write') {
    const input = part.input;
    const toolCallId = typeof part.toolCallId === 'string'
      ? part.toolCallId
      : undefined;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return {
        message: `received invalid input type ${typeof input}; expected object with file_path and content`,
        toolCallId,
        filePath: extractAutocodeMalformedWritePath(input),
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

  const message = getErrorText(part.error);
  if (!isAutocodeWriteToolInputErrorMessage(message)) {
    return null;
  }

  return {
    message,
    toolCallId: typeof part.toolCallId === 'string'
      ? part.toolCallId
      : undefined,
    filePath: extractAutocodeMalformedWritePath(part.input),
  };
}

export function buildAutocodeWriteToolInputCorrectionPrompt(
  failure: AutocodeWriteToolInputFailure,
): string {
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

export function repairAutocodeWriteToolInput(rawInput: string): string | null {
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

export function extractAutocodeCompletedSubtaskIdFromToolResult(part: AutocodeStreamPartLike): string | null {
  if (part.type !== 'tool-result' || !isUpdateSubtaskStatusTool(getToolName(part))) {
    return null;
  }

  const output = getRecordValue(part, ['output', 'result', 'content', 'text']);
  const text = stringifyToolValue(output);
  const idFromOutput = extractCompletedStatusText(text);
  if (idFromOutput) {
    return idFromOutput;
  }

  const inputCompletion = extractCompletedStatusInput(part.input);
  return inputCompletion.completed ? inputCompletion.subtaskId ?? null : null;
}

export function extractAutocodeCompletedSubtaskIdFromEvent(
  event: AutocodeStreamEvent,
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

export function normalizeAutocodeTokenUsage(value: unknown): AutocodeTokenUsage | null {
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

export function estimateAutocodeStreamPartSize(part: AutocodeStreamPartLike): number {
  const type = typeof part.type === 'string' ? part.type : '';

  if (type === 'text-delta') {
    return typeof part.delta === 'string'
      ? part.delta.length
      : typeof part.text === 'string'
        ? part.text.length
        : 0;
  }
  if (type === 'reasoning-delta' || type === 'reasoning') {
    return typeof part.delta === 'string'
      ? part.delta.length
      : typeof part.text === 'string'
        ? part.text.length
        : 0;
  }
  if (type === 'tool-call') {
    return safeJsonLength(part.input ?? part.args ?? part);
  }
  if (type === 'tool-result') {
    return safeJsonLength(part.output ?? part.result ?? part);
  }

  return 0;
}

export function isAutocodeCompletionStreamPart(part: AutocodeStreamPartLike): boolean {
  const type = part.type;
  return type === 'text-delta' || type === 'reasoning-delta' || type === 'reasoning';
}

export function estimateAutocodeTokenUsageFromSession(input: {
  systemPrompt: string;
  messages: AutocodeSessionMessage[];
  streamedCompletionChars: number;
  streamedContextChars: number;
}): AutocodeTokenUsage {
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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

function readNumberField(source: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / AUTOCODE_TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value ?? '').length;
  }
}

