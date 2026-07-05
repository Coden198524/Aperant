import type {
  AutocodeSessionMessage,
  AutocodeSessionResult,
  AutocodeTokenUsage,
} from './agent-session-types.js';
import { foldRepeatedAutocodePromptLines } from './prompt-context.js';

export const AUTOCODE_DEFAULT_MAX_CONTINUATIONS = 5;
export const AUTOCODE_MAX_SUMMARY_INPUT_CHARS = 20_000;
export const AUTOCODE_RAW_TRUNCATION_CHARS = 2000;
export const AUTOCODE_SUMMARY_MESSAGE_HEAD_CHARS = 8_000;
export const AUTOCODE_SUMMARY_MESSAGE_TAIL_CHARS = 8_000;
export const AUTOCODE_SUMMARY_TRUNCATION_SLACK_CHARS = 256;
export const AUTOCODE_CONTINUATION_SUMMARY_MAX_CHARS = 6_000;
export const AUTOCODE_SUMMARY_TARGET_WORDS = 500;
export const AUTOCODE_SUMMARY_RECENT_MESSAGE_LIMIT = 8;
export const AUTOCODE_SUMMARIZER_SYSTEM_PROMPT =
  'Summarize an agent/tool conversation for continuation. Include completed work, modified files, remaining tasks, and key decisions or findings. Use concise bullets.';

export interface AutocodeContinuableSessionConfig {
  initialMessages: AutocodeSessionMessage[];
  abortSignal?: { readonly aborted: boolean };
}

export interface AutocodeContinuationConfig {
  maxContinuations?: number;
  contextWindowExhaustedOutcome?: AutocodeSessionResult['outcome'];
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
  const contextWindowExhaustedOutcome = continuationConfig.contextWindowExhaustedOutcome ?? 'completed';
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
      return mergeAutocodeContinuationResult({ ...result, outcome: contextWindowExhaustedOutcome }, {
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
  const serializedAll = serializeAutocodeSessionMessages(messages);
  const compactSerializedAll = foldRepeatedAutocodePromptLines(serializedAll);
  if (serializedAll.length <= AUTOCODE_MAX_SUMMARY_INPUT_CHARS) {
    return compactSerializedAll;
  }
  if (compactSerializedAll.length <= AUTOCODE_MAX_SUMMARY_INPUT_CHARS) {
    return compactSerializedAll;
  }

  const { selectedMessages, omittedCount } = selectAutocodeSummaryMessages(messages);
  const parts: string[] = [];
  const suffix = '\n\n[... conversation truncated ...]';
  let remaining = AUTOCODE_MAX_SUMMARY_INPUT_CHARS - suffix.length;
  let omissionMarkerPending = omittedCount > 0;

  for (let index = 0; index < selectedMessages.length; index += 1) {
    const message = selectedMessages[index];

    const separator = parts.length > 0 ? '\n\n---\n\n' : '';
    const header = `${separator}[${message.role.toUpperCase()}]\n`;
    if (remaining <= header.length) {
      break;
    }

    const contentBudget = remaining - header.length;
    const effectiveContentBudget = message.content.length > contentBudget
      ? Math.max(0, contentBudget - suffix.length - AUTOCODE_SUMMARY_TRUNCATION_SLACK_CHARS)
      : contentBudget;
    const content = limitAutocodeSummaryMessageContent(message.content, effectiveContentBudget);

    parts.push(`${header}${content}`);
    remaining -= header.length + content.length;

    if (omissionMarkerPending) {
      omissionMarkerPending = false;
      const marker = `[... ${omittedCount} older, duplicate, or blank message(s) omitted from continuation summary input ...]`;
      const markerSeparator = parts.length > 0 ? '\n\n---\n\n' : '';
      if (remaining <= marker.length + markerSeparator.length) {
        break;
      }
      parts.push(`${markerSeparator}${marker}`);
      remaining -= marker.length + markerSeparator.length;
    }
  }

  if (omissionMarkerPending) {
    const marker = `[... ${omittedCount} older, duplicate, or blank message(s) omitted from continuation summary input ...]`;
    const markerSeparator = parts.length > 0 ? '\n\n---\n\n' : '';
    if (remaining > marker.length + markerSeparator.length) {
      parts.push(`${markerSeparator}${marker}`);
    }
  }

  const serialized = parts.join('');
  if (serialized.length + suffix.length <= AUTOCODE_MAX_SUMMARY_INPUT_CHARS) {
    return `${serialized}${suffix}`;
  }

  return `${serialized.slice(0, Math.max(0, AUTOCODE_MAX_SUMMARY_INPUT_CHARS - suffix.length)).trimEnd()}${suffix}`;
}

function selectAutocodeSummaryMessages(messages: AutocodeSessionMessage[]): {
  selectedMessages: AutocodeSessionMessage[];
  omittedCount: number;
} {
  const firstUsefulIndex = messages.findIndex((message) => message.content.trim().length > 0);
  if (firstUsefulIndex < 0) {
    return { selectedMessages: [], omittedCount: messages.length };
  }

  const selected = new Map<number, AutocodeSessionMessage>();
  const seen = new Set<string>();
  const firstMessage = messages[firstUsefulIndex];
  selected.set(firstUsefulIndex, firstMessage);
  seen.add(getAutocodeSummaryMessageKey(firstMessage));

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.size >= AUTOCODE_SUMMARY_RECENT_MESSAGE_LIMIT + 1) {
      break;
    }

    const message = messages[index];
    if (!message.content.trim()) {
      continue;
    }

    const key = getAutocodeSummaryMessageKey(message);
    if (seen.has(key)) {
      continue;
    }

    selected.set(index, message);
    seen.add(key);
  }

  const selectedMessages = [...selected.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, message]) => message);

  return {
    selectedMessages,
    omittedCount: Math.max(0, messages.length - selectedMessages.length),
  };
}

function getAutocodeSummaryMessageKey(message: AutocodeSessionMessage): string {
  const normalized = message.content.replace(/\s+/g, ' ').trim().toLowerCase();
  const keyContent = normalized.length <= 800
    ? normalized
    : `${normalized.slice(0, 400)}...${normalized.slice(-400)}`;
  return `${message.role}:${keyContent}`;
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
  const compactContent = foldRepeatedAutocodePromptLines(content);
  if (compactContent.length <= maxChars) {
    return compactContent;
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
    compactContent.slice(0, adjustedHeadBudget).trimEnd(),
    suffix.trimEnd(),
    compactContent.slice(Math.max(0, compactContent.length - tailBudget)).trimStart(),
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
  const compact = foldRepeatedAutocodePromptLines(normalized);
  if (compact.length <= maxChars) {
    return compact;
  }

  const marker = markerFactory(normalized.length);
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }

  const bodyBudget = maxChars - marker.length;
  const headBudget = Math.ceil(bodyBudget * 0.6);
  const tailBudget = Math.max(0, bodyBudget - headBudget);
  return [
    compact.slice(0, headBudget).trimEnd(),
    marker.trimEnd(),
    compact.slice(Math.max(0, compact.length - tailBudget)).trimStart(),
  ].join('\n');
}

function limitAutocodeSummaryMessageTail(content: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  const compactContent = foldRepeatedAutocodePromptLines(content);
  if (compactContent.length <= maxChars) {
    return compactContent;
  }

  const prefix = `[... message truncated, ${content.length} chars total ...]\n`;
  if (maxChars <= prefix.length) {
    return prefix.slice(0, maxChars);
  }
  return `${prefix}${compactContent.slice(Math.max(0, compactContent.length - maxChars + prefix.length)).trimStart()}`;
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
