import { addAutocodeContinuationUsage, rawTruncateAutocodeSessionMessages } from '@autocode/core/runtime/agent-continuation';
import { appendAutocodeLanguageRequirement } from '@autocode/core/runtime/agent-language';
import type { AutocodeDirectCodingQualityMetrics } from '@autocode/core/runtime/direct-task-summary';
import { classifyError } from '../session/error-classifier';
import type { SessionConfig, SessionError, SessionMessage, SessionResult, TokenUsage } from '../session/types';
import type { SerializableSessionConfig } from './types';

export const AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS = 3;

const DIRECT_RETRY_TEXT_MAX_CHARS = 1_200;
const DIRECT_CONTEXT_WINDOW_RETRY_CONTEXT_MAX_CHARS = 800;
const DIRECT_RETRY_FILE_PREVIEW_LIMIT = 12;

export interface DirectValidationAttemptFeedback {
  attempt: number;
  result: SessionResult;
  quality: AutocodeDirectCodingQualityMetrics;
  streamedText: string;
  modifiedFiles: string[];
  failureReason: string;
}

export function shouldRetryDirectAttempt(
  result: SessionResult | undefined,
  attempt: number,
  maxAttempts = AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
): boolean {
  if (!result || attempt >= maxAttempts) {
    return false;
  }

  if (result.outcome === 'max_steps' || result.outcome === 'context_window') {
    return true;
  }

  if (result.outcome !== 'error' || result.error?.retryable !== true) {
    return false;
  }

  if (result.error.code === 'direct_quality_gate_failed') {
    return true;
  }

  return isRetryableDirectIncompleteError(result.error.code);
}

function isRetryableDirectIncompleteError(code: string | undefined): boolean {
  return code === 'stream_timeout' ||
    code === 'generic_error' ||
    code === 'temporarily_unavailable' ||
    code === 'network_error' ||
    code === 'concurrency_error';
}

export function buildDirectSessionErrorResult(error: unknown): SessionResult {
  const classified = classifyError(error);
  const message = stringifyDirectSessionError(error);
  const useClassifiedError = classified.sessionError.code !== 'generic_error';
  const sessionError = useClassifiedError
    ? stripDirectSessionErrorCause(classified.sessionError)
    : {
        code: 'direct_session_error',
        message,
        retryable: false,
      };

  return {
    outcome: useClassifiedError ? classified.outcome : 'error',
    stepsExecuted: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    messages: [],
    toolCallCount: 0,
    durationMs: 0,
    error: sessionError,
  };
}

function stripDirectSessionErrorCause(error: SessionError): SessionError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function stringifyDirectSessionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function resolveDirectProviderResponseIdForPersistence(
  result: SessionResult | undefined,
  existingProviderResponseId: string | undefined,
): string | undefined {
  if (result?.outcome === 'context_window') {
    return undefined;
  }
  return result?.providerResponseId ?? existingProviderResponseId;
}

export function resolveDirectPersistedDurationMs(
  result: Pick<SessionResult, 'durationMs'> | undefined,
  quality?: Pick<AutocodeDirectCodingQualityMetrics, 'durationMs'>,
): number | undefined {
  const value = [quality?.durationMs, result?.durationMs]
    .find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}
export function buildDirectRetrySessionConfig(
  baseConfig: SessionConfig,
  session: Pick<SerializableSessionConfig, 'language'>,
  attempts: DirectValidationAttemptFeedback[],
  nextAttempt: number,
  maxAttempts = AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
): SessionConfig {
  const prompt = appendAutocodeLanguageRequirement(
    buildDirectRetryPrompt(attempts, nextAttempt, maxAttempts),
    session.language,
  );

  const latestAttempt = attempts[attempts.length - 1];
  const contextWindowRetry = latestAttempt?.result.outcome === 'context_window';
  const baseProviderPersistence = baseConfig.providerResponsePersistence;
  const baseProviderResponseId = baseProviderPersistence?.providerResponseId ?? baseConfig.previousResponseId;
  const useProviderContinuation = !contextWindowRetry &&
    Boolean(baseProviderPersistence || baseConfig.responsePersistence === true || baseConfig.previousResponseId);
  const providerResponseId = useProviderContinuation
    ? latestAttempt?.result.providerResponseId ?? baseProviderResponseId
    : undefined;
  const transcriptMessages = buildRetryTranscript(baseConfig.initialMessages, latestAttempt);

  return {
    ...baseConfig,
    initialMessages: providerResponseId
      ? [{ role: 'user', content: prompt }]
      : [...transcriptMessages, { role: 'user', content: prompt }],
    previousResponseId: baseConfig.previousResponseId || baseConfig.responsePersistence === true
      ? providerResponseId
      : undefined,
    providerResponsePersistence: contextWindowRetry
      ? undefined
      : buildNextProviderResponsePersistence(baseProviderPersistence, providerResponseId),
  };
}


function buildNextProviderResponsePersistence(
  persistence: SessionConfig['providerResponsePersistence'] | undefined,
  providerResponseId: string | undefined,
): SessionConfig['providerResponsePersistence'] | undefined {
  if (!persistence) {
    return undefined;
  }
  const next = { ...persistence };
  delete next.providerResponseId;
  return providerResponseId ? { ...next, providerResponseId } : next;
}

function buildRetryTranscript(
  initialMessages: SessionMessage[],
  latestAttempt: DirectValidationAttemptFeedback | undefined,
): SessionMessage[] {
  if (latestAttempt?.result.outcome === 'context_window') {
    const contextSummary = buildContextWindowRetryAssistantContext(latestAttempt);
    return contextSummary
      ? [...initialMessages, { role: 'assistant', content: contextSummary }]
      : initialMessages;
  }
  const attemptMessages = latestAttempt?.result.messages ?? [];
  if (attemptMessages.length > 0) {
    return mergeSessionTranscript(initialMessages, attemptMessages);
  }
  if (!latestAttempt?.streamedText.trim()) {
    return initialMessages;
  }
  return [
    ...initialMessages,
    { role: 'assistant', content: latestAttempt.streamedText.trim() },
  ];
}

function buildContextWindowRetryAssistantContext(
  latestAttempt: DirectValidationAttemptFeedback,
): string {
  const excerpt = getDirectAttemptHeadExcerpt(latestAttempt, DIRECT_CONTEXT_WINDOW_RETRY_CONTEXT_MAX_CHARS);
  if (!excerpt) {
    return '';
  }
  return [
    'Previous Direct attempt hit the context window before completion.',
    'Compact record of what the previous attempt reported before retry:',
    excerpt,
  ].join('\n\n');
}

function mergeSessionTranscript(
  initialMessages: SessionMessage[],
  attemptMessages: SessionMessage[],
): SessionMessage[] {
  const sharedPrefixLength = countSharedMessagePrefix(initialMessages, attemptMessages);
  if (sharedPrefixLength > 0) {
    return [
      ...initialMessages,
      ...attemptMessages.slice(sharedPrefixLength),
    ];
  }
  if (attemptMessages[0]?.role === 'user') {
    return attemptMessages;
  }
  return [
    ...initialMessages,
    ...attemptMessages,
  ];
}

function countSharedMessagePrefix(
  first: SessionMessage[],
  second: SessionMessage[],
): number {
  const max = Math.min(first.length, second.length);
  let index = 0;
  while (index < max && isSameSessionMessage(first[index], second[index])) {
    index += 1;
  }
  return index;
}

function isSameSessionMessage(
  first: SessionMessage | undefined,
  second: SessionMessage | undefined,
): boolean {
  return first?.role === second?.role && first?.content === second?.content;
}

export function mergeDirectValidationAttemptResults(
  result: SessionResult,
  attempts: DirectValidationAttemptFeedback[],
): SessionResult {
  if (attempts.length <= 1) {
    return result;
  }

  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const completedSubtaskIds = new Set<string>();
  let stepsExecuted = 0;
  let toolCallCount = 0;
  let durationMs = 0;
  let estimatedUsage = false;

  for (const attempt of attempts) {
    stepsExecuted += attempt.result.stepsExecuted;
    toolCallCount += attempt.result.toolCallCount;
    durationMs += attempt.result.durationMs;
    addAutocodeContinuationUsage(usage, attempt.result.usage);
    estimatedUsage = estimatedUsage || attempt.result.usage.estimated === true;
    for (const subtaskId of attempt.result.completedSubtaskIds ?? []) {
      completedSubtaskIds.add(subtaskId);
    }
  }

  return {
    ...result,
    stepsExecuted,
    toolCallCount,
    durationMs,
    usage: {
      ...usage,
      ...(estimatedUsage ? { estimated: true } : {}),
    },
    ...(completedSubtaskIds.size > 0 ? { completedSubtaskIds: Array.from(completedSubtaskIds) } : {}),
  };
}

function buildDirectRetryPrompt(
  attempts: DirectValidationAttemptFeedback[],
  nextAttempt: number,
  maxAttempts: number,
): string {
  const repeatedFailure = hasRepeatedDirectFailureSignature(attempts);
  const parts = [
    `## Direct Validation Retry (${nextAttempt}/${maxAttempts})`,
    'The previous Direct attempt did not pass validation/quality gates or ended before completion.',
    'Do not repeat the same implementation idea blindly. First inspect the current diff and relevant files, then decide whether the previous hypothesis was wrong or only incomplete.',
  ];

  if (repeatedFailure) {
    parts.push(
      'Repeated failure guard: the latest failure matches an earlier failure. Treat the previous approach as suspect, choose a different strategy, or reduce the fix to a smaller verifiable change before editing again.',
    );
  }

  parts.push(
    '## Previous Attempt Feedback',
    attempts.map((attempt) => formatDirectAttemptFeedback(attempt, maxAttempts)).join('\n\n'),
    '## Required Next Action',
    [
      '1. Re-read the current files and diff before making changes.',
      '2. Diagnose why the previous attempt failed; do not only restate the error.',
      '3. Apply a targeted fix. Rework or replace prior edits when they caused the failure.',
      '4. If the previous attempt hit max_steps or context_window, continue the remaining work from current file state and avoid broad rediscovery.',
      '5. Run the most focused validation command available and report the exact command and result.',
      `6. If validation still cannot pass by attempt ${maxAttempts}, report the blocker with evidence instead of claiming success.`,
    ].join('\n'),
  );

  return parts.join('\n\n');
}

function formatDirectAttemptFeedback(
  attempt: DirectValidationAttemptFeedback,
  maxAttempts: number,
): string {
  const quality = attempt.quality;
  const selfCritique = quality.selfCritique
    ? `${quality.selfCritique.status}${typeof quality.selfCritique.score === 'number' ? ` (${Math.round(quality.selfCritique.score * 100)}%)` : ''}; improvements: ${formatListPreview(quality.selfCritique.improvements, 4)}`
    : 'not run';
  const files = attempt.modifiedFiles.length > 0
    ? formatListPreview(attempt.modifiedFiles, DIRECT_RETRY_FILE_PREVIEW_LIMIT)
    : 'none detected';
  const excerpt = getDirectAttemptFinalExcerpt(attempt);

  return [
    `### Attempt ${attempt.attempt}/${maxAttempts}`,
    `Outcome: ${attempt.result.outcome}${attempt.result.error?.code ? ` (${attempt.result.error.code})` : ''}`,
    `Failure: ${limitDirectRetryText(attempt.failureReason, DIRECT_RETRY_TEXT_MAX_CHARS)}`,
    `Validation: ${quality.validation.status} - ${limitDirectRetryText(quality.validation.reason, DIRECT_RETRY_TEXT_MAX_CHARS)}`,
    `Self-critique: ${limitDirectRetryText(selfCritique, DIRECT_RETRY_TEXT_MAX_CHARS)}`,
    `Changed files: ${files}`,
    excerpt ? `Final response excerpt:\n${excerpt}` : '',
  ].filter(Boolean).join('\n');
}

function getDirectAttemptHeadExcerpt(attempt: DirectValidationAttemptFeedback, maxChars: number): string {
  const messages = getDirectAttemptExcerptMessages(attempt);
  if (messages.length === 0) {
    return '';
  }
  return limitDirectRetryHeadText(rawTruncateAutocodeSessionMessages(messages), maxChars);
}

function getDirectAttemptFinalExcerpt(attempt: DirectValidationAttemptFeedback, maxChars = 2_000): string {
  const messages = getDirectAttemptExcerptMessages(attempt);
  if (messages.length === 0) {
    return '';
  }
  return limitDirectRetryText(rawTruncateAutocodeSessionMessages(messages), maxChars);
}

function getDirectAttemptExcerptMessages(attempt: DirectValidationAttemptFeedback): SessionMessage[] {
  return attempt.result.messages.length > 0
    ? attempt.result.messages
    : attempt.streamedText.trim()
      ? [{ role: 'assistant', content: attempt.streamedText }]
      : [];
}

function hasRepeatedDirectFailureSignature(attempts: DirectValidationAttemptFeedback[]): boolean {
  if (attempts.length < 2) {
    return false;
  }
  const latest = getDirectFailureSignature(attempts[attempts.length - 1]);
  return attempts
    .slice(0, -1)
    .some((attempt) => getDirectFailureSignature(attempt) === latest);
}

function getDirectFailureSignature(attempt: DirectValidationAttemptFeedback): string {
  return normalizeDirectFailureSignatureText([
    attempt.failureReason,
    attempt.quality.validation.status,
    attempt.quality.validation.reason,
    attempt.quality.selfCritique?.status ?? 'no-critique',
    attempt.quality.selfCritique?.improvements.slice(0, 3).join('|') ?? '',
  ].join(' '));
}

function normalizeDirectFailureSignatureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\battempt\s+\d+(?:\s*\/\s*\d+)?\b/g, 'attempt #')
    .replace(/\bretry\s+\d+(?:\s*\/\s*\d+)?\b/g, 'retry #')
    .replace(/\bpid\s*[:=]?\s*\d+\b/g, 'pid #')
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|sec|seconds?|mins?|minutes?)\b/g, '<duration>')
    .replace(/[a-z]:[\\/][^\s]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDirectRetryText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function formatListPreview(items: string[], limit: number): string {
  const normalized = items
    .map((item) => item.trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return 'none';
  }
  const preview = normalized.slice(0, limit).join(', ');
  return normalized.length > limit ? `${preview}, ...and ${normalized.length - limit} more` : preview;
}

function limitDirectRetryHeadText(value: string, maxChars: number): string {
  const normalized = normalizeDirectRetryText(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const marker = `\n[... context-window retry context truncated, ${normalized.length} chars total ...]`;
  const budget = Math.max(0, maxChars - marker.length);
  return [
    normalized.slice(0, budget).trimEnd(),
    marker,
  ].filter(Boolean).join('\n');
}

function limitDirectRetryText(value: string, maxChars: number): string {
  const normalized = normalizeDirectRetryText(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const marker = `\n[... retry feedback truncated, ${normalized.length} chars total ...]\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.max(0, budget - head);
  return [
    normalized.slice(0, head).trimEnd(),
    marker.trimEnd(),
    normalized.slice(Math.max(0, normalized.length - tail)).trimStart(),
  ].filter(Boolean).join('\n');
}
