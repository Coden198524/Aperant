import { relative, resolve } from 'node:path';

import type {
  ToolUsageLimits,
  ToolUsagePolicyContext,
  ToolUsageState,
} from './types.js';

export const DEFAULT_READ_ONLY_TOOL_LIMITS: Record<string, number> = {
  Read: 160,
  Glob: 80,
  Grep: 80,
};

export const DEFAULT_MAX_DUPLICATE_READ_ONLY_CALLS = 3;

/**
 * Pattern matching trailing JSON artifact characters that some models leak
 * into tool call string arguments. Matches sequences like `'}},{`, `"}`,
 * `'},` etc. at the end of a path.
 */
const TRAILING_JSON_ARTIFACT_RE = /['"}\],{]+$/;

/**
 * Sanitize file_path arguments in tool input.
 *
 * Mutates the input object in place for compatibility with AI SDK tool calls.
 */
export function sanitizeFilePathArg(input: Record<string, unknown>): void {
  const filePath = input.file_path;
  if (typeof filePath !== 'string') return;

  let cleaned = filePath;
  cleaned = cleaned.replace(TRAILING_JSON_ARTIFACT_RE, '');
  cleaned = cleaned.replace(/\\/g, '/');

  if (cleaned !== filePath) {
    input.file_path = cleaned;
  }
}

export function createToolUsageState(): ToolUsageState {
  return {
    totalCalls: 0,
    toolCalls: {},
    readOnlySignatureCalls: {},
  };
}

export function getToolUsageState(context: ToolUsagePolicyContext): ToolUsageState {
  if (!context.toolUsageState) {
    context.toolUsageState = createToolUsageState();
  }
  return context.toolUsageState;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeToolSignatureValue(
  value: unknown,
  context: Pick<ToolUsagePolicyContext, 'projectDir'>,
): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.replace(/\\/g, '/');
  const projectDir = context.projectDir.replace(/\\/g, '/');
  if (!normalized.toLowerCase().startsWith(projectDir.toLowerCase())) {
    return normalized;
  }

  const rel = relative(projectDir, normalized).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') ? rel : normalized;
}

export function buildReadOnlyToolSignature(
  toolName: string,
  input: Record<string, unknown>,
  context: Pick<ToolUsagePolicyContext, 'projectDir'>,
): string {
  const normalizedInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalizedInput[key] = normalizeToolSignatureValue(value, context);
  }
  return `${toolName}:${stableStringify(normalizedInput)}`;
}

export function resolveToolUsageLimits(
  context: Pick<ToolUsagePolicyContext, 'toolUsageLimits'>,
): Required<ToolUsageLimits> {
  return {
    readOnlyToolCallLimits: {
      ...DEFAULT_READ_ONLY_TOOL_LIMITS,
      ...(context.toolUsageLimits?.readOnlyToolCallLimits ?? {}),
    },
    maxDuplicateReadOnlyCalls:
      context.toolUsageLimits?.maxDuplicateReadOnlyCalls ?? DEFAULT_MAX_DUPLICATE_READ_ONLY_CALLS,
  };
}

/**
 * Track a read-only tool call and return a guard message when the call should
 * be skipped.
 */
export function guardReadOnlyToolUsage(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolUsagePolicyContext,
): string | null {
  const limits = resolveToolUsageLimits(context);
  const state = getToolUsageState(context);

  state.totalCalls += 1;
  state.toolCalls[toolName] = (state.toolCalls[toolName] ?? 0) + 1;

  const toolLimit = limits.readOnlyToolCallLimits[toolName];
  if (toolLimit !== undefined && state.toolCalls[toolName] > toolLimit) {
    return [
      `Tool budget exceeded for ${toolName}: ${state.toolCalls[toolName]} calls in this session, limit ${toolLimit}.`,
      'Use the evidence already gathered, or run a narrower non-repeated query only after starting a new session.',
    ].join('\n');
  }

  const signature = buildReadOnlyToolSignature(toolName, input, context);
  const repeated = (state.readOnlySignatureCalls[signature] ?? 0) + 1;
  state.readOnlySignatureCalls[signature] = repeated;
  if (repeated > limits.maxDuplicateReadOnlyCalls) {
    return [
      `Repeated ${toolName} call skipped: the same input has already been used ${repeated - 1} times in this session.`,
      'Use the earlier result, change offset/limit for a targeted range, or narrow the query instead of repeating it.',
    ].join('\n');
  }

  return null;
}

/**
 * Return a denial message when a write-like tool tries to write outside the
 * allowed directories. Returns null when no allowedWritePaths policy is set or
 * all provided write paths are allowed.
 */
export function getToolWritePathDenial(
  toolName: string,
  input: Record<string, unknown>,
  allowedWritePaths: string[] | undefined,
  writePathInputKeys: string[] = ['file_path'],
): string | null {
  if (!allowedWritePaths?.length) {
    return null;
  }

  for (const key of writePathInputKeys) {
    const writePath = input[key];
    if (typeof writePath !== 'string' || !writePath) continue;

    const resolved = resolve(writePath);
    const allowed = allowedWritePaths.some((dir) => resolved.startsWith(resolve(dir)));
    if (!allowed) {
      return `Write denied: ${toolName} cannot write to ${writePath}. Allowed directories: ${allowedWritePaths.join(', ')}`;
    }
  }

  return null;
}
