import { describe, expect, it } from 'vitest';

import type { AutocodeDirectCodingQualityMetrics } from '@autocode/core/runtime/direct-task-summary';
import type { SessionConfig, SessionResult } from '../../session/types';
import {
  AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
  buildDirectRetrySessionConfig,
  mergeDirectValidationAttemptResults,
  shouldRetryDirectValidationAttempt,
  type DirectValidationAttemptFeedback,
} from '../direct-retry';

function createResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 1,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    messages: [{ role: 'assistant', content: 'Validation: npm test failed.' }],
    durationMs: 100,
    toolCallCount: 1,
    ...overrides,
  };
}

function createQuality(overrides: Partial<AutocodeDirectCodingQualityMetrics> = {}): AutocodeDirectCodingQualityMetrics {
  return {
    mode: 'direct',
    outcome: 'completed',
    changedFiles: ['src/direct.ts'],
    filesChanged: 1,
    stepsExecuted: 1,
    toolCallCount: 1,
    durationMs: 100,
    recordedAt: '2026-07-05T00:00:00.000Z',
    validation: {
      status: 'reported_failed',
      reason: 'npm test failed with 1 assertion error',
    },
    selfCritique: {
      status: 'failed',
      score: 0.4,
      filesReviewed: 1,
      improvements: ['Re-check the null path before editing again.'],
    },
    ...overrides,
  };
}

function createAttempt(overrides: Partial<DirectValidationAttemptFeedback> = {}): DirectValidationAttemptFeedback {
  const result = createResult({
    outcome: 'error',
    error: {
      code: 'direct_quality_gate_failed',
      message: 'Direct validation reported_failed: npm test failed',
      retryable: true,
    },
  });
  return {
    attempt: 1,
    result,
    quality: createQuality(),
    streamedText: 'Validation: npm test failed.',
    modifiedFiles: ['src/direct.ts'],
    failureReason: result.error?.message ?? 'failed',
    ...overrides,
  };
}

function createSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: 'session-1',
    agentType: 'coder' as SessionConfig['agentType'],
    model: {} as SessionConfig['model'],
    systemPrompt: 'You are a coding agent.',
    initialMessages: [{ role: 'user', content: 'Fix the bug.' }],
    toolContext: {} as SessionConfig['toolContext'],
    maxSteps: 5,
    specDir: 'E:/repo/.autocode/specs/001-direct',
    projectDir: 'E:/repo',
    ...overrides,
  };
}

describe('Direct validation retry helpers', () => {
  it('retries only retryable Direct quality gate failures before the third attempt', () => {
    const retryable = createResult({
      outcome: 'error',
      error: {
        code: 'direct_quality_gate_failed',
        message: 'validation failed',
        retryable: true,
      },
    });

    expect(shouldRetryDirectValidationAttempt(retryable, 1)).toBe(true);
    expect(shouldRetryDirectValidationAttempt(retryable, 2)).toBe(true);
    expect(shouldRetryDirectValidationAttempt(retryable, AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS)).toBe(false);
    expect(shouldRetryDirectValidationAttempt(createResult({ outcome: 'auth_failure' }), 1)).toBe(false);
    expect(shouldRetryDirectValidationAttempt(createResult({
      outcome: 'error',
      error: { code: 'direct_session_error', message: 'transport failed', retryable: false },
    }), 1)).toBe(false);
  });

  it('keeps retry attempts inside the provider session when a response id is available', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        providerResponseId: 'resp_attempt_1',
        error: {
          code: 'direct_quality_gate_failed',
          message: 'validation failed',
          retryable: true,
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig(),
      { language: 'zh-CN' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBe('resp_attempt_1');
    expect(retryConfig.initialMessages).toHaveLength(1);
    expect(retryConfig.initialMessages[0]?.content).toContain('Direct Validation Retry (2/3)');
    expect(retryConfig.initialMessages[0]?.content).toContain('Do not repeat the same implementation idea blindly');
  });

  it('does not reuse a stale base response id when the latest attempt cannot continue provider state', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        messages: [{ role: 'assistant', content: 'Validation: npm test failed after a chat fallback.' }],
        error: {
          code: 'direct_quality_gate_failed',
          message: 'validation failed',
          retryable: true,
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig({ previousResponseId: 'resp_stale_original' }),
      { language: 'en' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBeUndefined();
    expect(retryConfig.initialMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(retryConfig.initialMessages[0]?.content).toBe('Fix the bug.');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Direct Validation Retry (2/3)');
  });

  it('does not duplicate the original task when attempt messages already include it', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        messages: [
          { role: 'user', content: 'Fix the bug.' },
          { role: 'assistant', content: 'Validation: npm test failed after editing src/direct.ts.' },
        ],
        error: {
          code: 'direct_quality_gate_failed',
          message: 'validation failed',
          retryable: true,
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig(),
      { language: 'en' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBeUndefined();
    expect(retryConfig.initialMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(retryConfig.initialMessages.filter((message) => message.content === 'Fix the bug.')).toHaveLength(1);
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Direct Validation Retry (2/3)');
  });

  it('falls back to transcript continuation when provider session state is unavailable', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        messages: [
          { role: 'user', content: 'Fix the original bug.' },
          { role: 'assistant', content: 'I changed src/direct.ts. Validation: npm test failed.' },
        ],
        error: {
          code: 'direct_quality_gate_failed',
          message: 'validation failed',
          retryable: true,
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig(),
      { language: 'en' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBeUndefined();
    expect(retryConfig.initialMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(retryConfig.initialMessages[0]?.content).toBe('Fix the original bug.');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Re-read the current files and diff');
  });

  it('aggregates attempt metrics while preserving the final attempt result', () => {
    const first = createAttempt({
      result: createResult({
        outcome: 'error',
        stepsExecuted: 2,
        toolCallCount: 3,
        durationMs: 50,
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        error: { code: 'direct_quality_gate_failed', message: 'validation failed', retryable: true },
      }),
    });
    const secondResult = createResult({
      outcome: 'completed',
      stepsExecuted: 1,
      toolCallCount: 2,
      durationMs: 70,
      usage: { promptTokens: 15, completionTokens: 9, totalTokens: 24 },
      messages: [{ role: 'assistant', content: 'Validation: npm test passed.' }],
    });
    const second = createAttempt({ attempt: 2, result: secondResult });

    const merged = mergeDirectValidationAttemptResults(secondResult, [first, second]);

    expect(merged.outcome).toBe('completed');
    expect(merged.stepsExecuted).toBe(3);
    expect(merged.toolCallCount).toBe(5);
    expect(merged.durationMs).toBe(120);
    expect(merged.usage.totalTokens).toBe(54);
    expect(merged.messages).toEqual(secondResult.messages);
  });
});