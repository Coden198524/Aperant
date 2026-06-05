import type {
  AutocodeSessionMessage,
  AutocodeSessionResult,
  AutocodeTokenUsage,
} from './agent-session-types.js';

export const AUTOCODE_DEFAULT_MAX_CONTINUATIONS = 5;
export const AUTOCODE_MAX_SUMMARY_INPUT_CHARS = 20_000;
export const AUTOCODE_RAW_TRUNCATION_CHARS = 2000;
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
  return (
    `## Session Continuation (${continuationNumber})\n\n` +
    `Continue the previous session from this summary:\n\n` +
    `${summary}\n\n` +
    `Continue with remaining work and avoid repeating completed work.`
  );
}

export function buildAutocodeSummaryPrompt(serializedMessages: string): string {
  return (
    `Summarize this AI agent conversation in approximately ${AUTOCODE_SUMMARY_TARGET_WORDS} words.\n\n` +
    `Focus on:\n` +
    `- What tasks/subtasks have been completed\n` +
    `- What files were created, modified, or read\n` +
    `- Key decisions made and their rationale\n` +
    `- What work remains to be done\n` +
    `- Any errors encountered and how they were resolved\n\n` +
    `## Conversation:\n${serializedMessages}\n\n## Summary:`
  );
}

export function serializeAutocodeSessionMessages(messages: AutocodeSessionMessage[]): string {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join('\n\n---\n\n');
}

export function limitAutocodeSummaryInput(messages: AutocodeSessionMessage[]): string {
  const serialized = serializeAutocodeSessionMessages(messages);
  if (serialized.length <= AUTOCODE_MAX_SUMMARY_INPUT_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, AUTOCODE_MAX_SUMMARY_INPUT_CHARS)}\n\n[... conversation truncated ...]`;
}

export function rawTruncateAutocodeSessionMessages(messages: AutocodeSessionMessage[]): string {
  const text = serializeAutocodeSessionMessages(messages.slice(-5));
  if (text.length <= AUTOCODE_RAW_TRUNCATION_CHARS) {
    return text;
  }
  return `${text.slice(-AUTOCODE_RAW_TRUNCATION_CHARS)}\n\n[... truncated ...]`;
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
