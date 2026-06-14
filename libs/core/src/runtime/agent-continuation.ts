import type {
  AutocodeSessionMessage,
  AutocodeSessionResult,
  AutocodeTokenUsage,
} from './agent-session-types.js';

export const AUTOCODE_DEFAULT_MAX_CONTINUATIONS = 5;
export const AUTOCODE_MAX_SUMMARY_INPUT_CHARS = 20_000;
export const AUTOCODE_RAW_TRUNCATION_CHARS = 2000;
export const AUTOCODE_SUMMARY_MESSAGE_HEAD_CHARS = 8_000;
export const AUTOCODE_SUMMARY_MESSAGE_TAIL_CHARS = 8_000;
export const AUTOCODE_SUMMARY_TRUNCATION_SLACK_CHARS = 256;
export const AUTOCODE_CONTINUATION_SUMMARY_MAX_CHARS = 6_000;
export const AUTOCODE_SUMMARY_TARGET_WORDS = 500;
export const AUTOCODE_SUMMARIZER_SYSTEM_PROMPT =
  'Summarize an agent/tool conversation for continuation. Include completed work, modified files, remaining tasks, and key decisions or findings. Use concise bullets.';

export interface AutocodeContinuableSessionConfig {
  initialMessages: AutocodeSessionMessage[];
  abortSignal?: { readonly aborted: boolean };
}

export interface AutocodeContinuationConfig {
  maxContinuations?: number;
}

export interface AutocodeContinuationContext {
  continuationNumber: number;
}

export interface AutocodeContinuationRunner<
  Config extends AutocodeContinuableSessionConfig,
  Options,
  Result extends AutocodeSessionResult,
> {
  runSession(config: Config, options?: Options): Promise<Result>;
  summarizeMessages(
    messages: AutocodeSessionMessage[],
    context: AutocodeContinuationContext,
  ): Promise<string>;
}

export interface AutocodeContinuationResult extends AutocodeSessionResult {
  continuationCount: number;
  cumulativeUsage: AutocodeTokenUsage;
}

export async function runAutocodeContinuableSession<
  Config extends AutocodeContinuableSessionConfig,
  Options,
  Result extends AutocodeSessionResult,
>(
  config: Config,
  options: Options | undefined,
  continuationConfig: AutocodeContinuationConfig,
  runner: AutocodeContinuationRunner<Config, Options, Result>,
): Promise<Result & AutocodeContinuationResult> {
  const maxContinuations = continuationConfig.maxContinuations ?? AUTOCODE_DEFAULT_MAX_CONTINUATIONS;
  let currentConfig = config;
  let continuationCount = 0;
  let totalStepsExecuted = 0;
  let totalToolCallCount = 0;
  let totalDurationMs = 0;
  const completedSubtaskIds = new Set<string>();
  const cumulativeUsage: AutocodeTokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  for (let i = 0; i <= maxContinuations; i++) {
    const result = await runner.runSession(currentConfig, options);
    totalStepsExecuted += result.stepsExecuted;
    totalToolCallCount += result.toolCallCount;
    totalDurationMs += result.durationMs;
    addAutocodeContinuationUsage(cumulativeUsage, result.usage);
    for (const subtaskId of result.completedSubtaskIds ?? []) {
      completedSubtaskIds.add(subtaskId);
    }

    if (result.outcome !== 'context_window') {
      return mergeAutocodeContinuationResult(result, {
        totalStepsExecuted,
        totalToolCallCount,
        totalDurationMs,
        cumulativeUsage,
        completedSubtaskIds,
        continuationCount,
      });
    }

    if (i >= maxContinuations) {
      return mergeAutocodeContinuationResult({ ...result, outcome: 'completed' }, {
        totalStepsExecuted,
        totalToolCallCount,
        totalDurationMs,
        cumulativeUsage,
        completedSubtaskIds,
        continuationCount,
      });
    }

    if (config.abortSignal?.aborted) {
      return mergeAutocodeContinuationResult({ ...result, outcome: 'cancelled' }, {
        totalStepsExecuted,
        totalToolCallCount,
        totalDurationMs,
        cumulativeUsage,
        completedSubtaskIds,
        continuationCount,
      });
    }

    continuationCount++;
    const summary = await runner.summarizeMessages(result.messages, { continuationNumber: continuationCount });
    currentConfig = {
      ...config,
      initialMessages: [{
        role: 'user',
        content: buildAutocodeContinuationPrompt(summary, continuationCount),
      }],
    };
  }

  return {
    outcome: 'completed',
    stepsExecuted: totalStepsExecuted,
    toolCallCount: totalToolCallCount,
    durationMs: totalDurationMs,
    usage: cumulativeUsage,
    messages: [],
    ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
    continuationCount,
    cumulativeUsage,
  } as unknown as Result & AutocodeContinuationResult;
}

export function buildAutocodeContinuationPrompt(summary: string, continuationNumber: number): string {
  const compactSummary = limitAutocodeContinuationSummary(summary);
  return (
    `## Session Continuation (${continuationNumber})\n\n` +
    `Continue the previous session from this summary:\n\n` +
    `${compactSummary}\n\n` +
    `Continue with remaining work and avoid repeating completed work.`
  );
}

export function buildAutocodeSummaryPrompt(serializedMessages: string): string {
  const compactMessages = limitAutocodeSerializedSummaryInput(serializedMessages);
  return (
    `Summarize this AI agent conversation in approximately ${AUTOCODE_SUMMARY_TARGET_WORDS} words.\n\n` +
    `Focus on:\n` +
    `- What tasks/subtasks have been completed\n` +
    `- What files were created, modified, or read\n` +
    `- Key decisions made and their rationale\n` +
    `- What work remains to be done\n` +
    `- Any errors encountered and how they were resolved\n\n` +
    `## Conversation:\n${compactMessages}\n\n## Summary:`
  );
}

export function limitAutocodeContinuationSummary(summary: string): string {
  return limitAutocodeHeadTailText(
    summary,
    AUTOCODE_CONTINUATION_SUMMARY_MAX_CHARS,
    (length) => `\n\n[... continuation summary middle omitted, ${length} chars total ...]\n\n`,
  );
}

export function limitAutocodeSerializedSummaryInput(serializedMessages: string): string {
  return limitAutocodeHeadTailText(
    serializedMessages,
    AUTOCODE_MAX_SUMMARY_INPUT_CHARS,
    (length) => `\n\n[... serialized conversation middle omitted, ${length} chars total ...]\n\n`,
  );
}

export function serializeAutocodeSessionMessages(messages: AutocodeSessionMessage[]): string {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join('\n\n---\n\n');
}

export function limitAutocodeSummaryInput(messages: AutocodeSessionMessage[]): string {
  const parts: string[] = [];
  let remaining = AUTOCODE_MAX_SUMMARY_INPUT_CHARS;
  let truncated = false;
  const suffix = '\n\n[... conversation truncated ...]';

  for (const message of messages) {
    const separator = parts.length > 0 ? '\n\n---\n\n' : '';
    const header = `${separator}[${message.role.toUpperCase()}]\n`;
    if (remaining <= header.length) {
      truncated = true;
      break;
    }

    const contentBudget = remaining - header.length;
    const effectiveContentBudget = message.content.length > contentBudget
      ? Math.max(0, contentBudget - suffix.length - AUTOCODE_SUMMARY_TRUNCATION_SLACK_CHARS)
      : contentBudget;
    const content = limitAutocodeSummaryMessageContent(message.content, effectiveContentBudget);
    if (content.length < message.content.length) {
      truncated = true;
    }

    parts.push(`${header}${content}`);
    remaining -= header.length + content.length;
  }

  if (messages.length > parts.length) {
    truncated = true;
  }

  const serialized = parts.join('');
  if (!truncated) {
    return serialized;
  }

  if (serialized.length + suffix.length <= AUTOCODE_MAX_SUMMARY_INPUT_CHARS) {
    return `${serialized}${suffix}`;
  }

  return `${serialized.slice(0, Math.max(0, AUTOCODE_MAX_SUMMARY_INPUT_CHARS - suffix.length)).trimEnd()}${suffix}`;
}

export function rawTruncateAutocodeSessionMessages(messages: AutocodeSessionMessage[]): string {
  const parts: string[] = [];
  let remaining = AUTOCODE_RAW_TRUNCATION_CHARS;
  let truncated = messages.length > 5;

  for (const message of messages.slice(-5).reverse()) {
    const separator = parts.length > 0 ? '\n\n---\n\n' : '';
    const header = `[${message.role.toUpperCase()}]\n`;
    const overhead = header.length + separator.length;
    if (remaining <= overhead) {
      truncated = true;
      break;
    }
    const content = limitAutocodeSummaryMessageTail(message.content, remaining - overhead);
    if (content.length < message.content.length) {
      truncated = true;
    }
    parts.unshift(`${header}${content}${separator}`);
    remaining -= overhead + content.length;
  }

  const text = parts.join('').trimEnd();
  if (!truncated) {
    return text;
  }

  const suffix = '\n\n[... truncated ...]';
  if (text.length + suffix.length <= AUTOCODE_RAW_TRUNCATION_CHARS) {
    return `${text}${suffix}`;
  }
  return `${text.slice(Math.max(0, text.length - AUTOCODE_RAW_TRUNCATION_CHARS + suffix.length)).trimStart()}${suffix}`;
}

function limitAutocodeSummaryMessageContent(content: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (content.length <= maxChars) {
    return content;
  }

  const suffix = `\n[... message truncated, ${content.length} chars total ...]\n`;
  if (maxChars <= suffix.length) {
    return suffix.slice(0, maxChars);
  }

  const bodyBudget = maxChars - suffix.length;
  const headBudget = Math.min(
    AUTOCODE_SUMMARY_MESSAGE_HEAD_CHARS,
    Math.ceil(bodyBudget / 2),
  );
  const tailBudget = Math.min(
    AUTOCODE_SUMMARY_MESSAGE_TAIL_CHARS,
    Math.max(0, bodyBudget - headBudget),
  );
  const remainingBudget = bodyBudget - headBudget - tailBudget;
  const adjustedHeadBudget = headBudget + Math.max(0, remainingBudget);

  return [
    content.slice(0, adjustedHeadBudget).trimEnd(),
    suffix.trimEnd(),
    content.slice(Math.max(0, content.length - tailBudget)).trimStart(),
  ].filter(Boolean).join('\n');
}

function limitAutocodeHeadTailText(
  value: string,
  maxChars: number,
  markerFactory: (length: number) => string,
): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const marker = markerFactory(normalized.length);
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }

  const bodyBudget = maxChars - marker.length;
  const headBudget = Math.ceil(bodyBudget * 0.6);
  const tailBudget = Math.max(0, bodyBudget - headBudget);
  return [
    normalized.slice(0, headBudget).trimEnd(),
    marker.trimEnd(),
    normalized.slice(Math.max(0, normalized.length - tailBudget)).trimStart(),
  ].join('\n');
}

function limitAutocodeSummaryMessageTail(content: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (content.length <= maxChars) {
    return content;
  }

  const prefix = `[... message truncated, ${content.length} chars total ...]\n`;
  if (maxChars <= prefix.length) {
    return prefix.slice(0, maxChars);
  }
  return `${prefix}${content.slice(Math.max(0, content.length - maxChars + prefix.length)).trimStart()}`;
}

export function addAutocodeContinuationUsage(
  cumulative: AutocodeTokenUsage,
  addition: AutocodeTokenUsage,
): void {
  cumulative.promptTokens += addition.promptTokens;
  cumulative.completionTokens += addition.completionTokens;
  cumulative.totalTokens += addition.totalTokens;
  if (addition.thinkingTokens) {
    cumulative.thinkingTokens = (cumulative.thinkingTokens ?? 0) + addition.thinkingTokens;
  }
  if (addition.cacheReadTokens) {
    cumulative.cacheReadTokens = (cumulative.cacheReadTokens ?? 0) + addition.cacheReadTokens;
  }
  if (addition.cacheCreationTokens) {
    cumulative.cacheCreationTokens = (cumulative.cacheCreationTokens ?? 0) + addition.cacheCreationTokens;
  }
  if (addition.stepsExecuted) {
    cumulative.stepsExecuted = (cumulative.stepsExecuted ?? 0) + addition.stepsExecuted;
  }
  if (addition.sessionId) {
    cumulative.sessionId = addition.sessionId;
  }
}

function mergeAutocodeContinuationResult<Result extends AutocodeSessionResult>(
  result: Result,
  state: {
    totalStepsExecuted: number;
    totalToolCallCount: number;
    totalDurationMs: number;
    cumulativeUsage: AutocodeTokenUsage;
    completedSubtaskIds: Set<string>;
    continuationCount: number;
  },
): Result & AutocodeContinuationResult {
  return {
    ...result,
    stepsExecuted: state.totalStepsExecuted,
    toolCallCount: state.totalToolCallCount,
    durationMs: state.totalDurationMs,
    usage: state.cumulativeUsage,
    ...(state.completedSubtaskIds.size > 0
      ? { completedSubtaskIds: Array.from(state.completedSubtaskIds) }
      : {}),
    continuationCount: state.continuationCount,
    cumulativeUsage: state.cumulativeUsage,
  };
}
