import { addAutocodeContinuationUsage, rawTruncateAutocodeSessionMessages } from '@autocode/core/runtime/agent-continuation';
import { appendAutocodeLanguageRequirement } from '@autocode/core/runtime/agent-language';
import type { AutocodeDirectCodingQualityMetrics } from '@autocode/core/runtime/direct-task-summary';
import type { SessionConfig, SessionMessage, SessionResult, TokenUsage } from '../session/types';
import type { SerializableSessionConfig } from './types';

export const AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS = 3;

const DIRECT_RETRY_TEXT_MAX_CHARS = 1_200;
const DIRECT_RETRY_FILE_PREVIEW_LIMIT = 12;

export interface DirectValidationAttemptFeedback {
  attempt: number;
  result: SessionResult;
  quality: AutocodeDirectCodingQualityMetrics;
  streamedText: string;
  modifiedFiles: string[];
  failureReason: string;
}

export function shouldRetryDirectValidationAttempt(
  result: SessionResult | undefined,
  attempt: number,
  maxAttempts = AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
): boolean {
  return attempt < maxAttempts &&
    result?.outcome === 'error' &&
    result.error?.code === 'direct_quality_gate_failed' &&
    result.error.retryable === true;
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
  const providerResponseId = latestAttempt?.result.providerResponseId;
  const transcriptMessages = buildRetryTranscript(baseConfig.initialMessages, latestAttempt);

  return {
    ...baseConfig,
    initialMessages: providerResponseId
      ? [{ role: 'user', content: prompt }]
      : [...transcriptMessages, { role: 'user', content: prompt }],
    previousResponseId: providerResponseId,
  };
}

function buildRetryTranscript(
  initialMessages: SessionMessage[],
  latestAttempt: DirectValidationAttemptFeedback | undefined,
): SessionMessage[] {
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
    'The previous Direct attempt did not pass the validation/quality gate.',
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
      '4. Run the most focused validation command available and report the exact command and result.',
      `5. If validation still cannot pass by attempt ${maxAttempts}, report the blocker with evidence instead of claiming success.`,
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

function getDirectAttemptFinalExcerpt(attempt: DirectValidationAttemptFeedback): string {
  const messages: SessionMessage[] = attempt.result.messages.length > 0
    ? attempt.result.messages
    : attempt.streamedText.trim()
      ? [{ role: 'assistant', content: attempt.streamedText }]
      : [];
  if (messages.length === 0) {
    return '';
  }
  return limitDirectRetryText(rawTruncateAutocodeSessionMessages(messages), 2_000);
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
  return [
    attempt.failureReason,
    attempt.quality.validation.status,
    attempt.quality.validation.reason,
    attempt.quality.selfCritique?.status ?? 'no-critique',
    attempt.quality.selfCritique?.improvements.slice(0, 3).join('|') ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
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

function limitDirectRetryText(value: string, maxChars: number): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
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
