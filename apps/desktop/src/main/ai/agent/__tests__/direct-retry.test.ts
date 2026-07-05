import { describe, expect, it } from 'vitest';

import type { AutocodeDirectCodingQualityMetrics } from '@autocode/core/runtime/direct-task-summary';
import type { SessionConfig, SessionResult } from '../../session/types';
import {
  AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS,
  buildDirectRetrySessionConfig,
  mergeDirectValidationAttemptResults,
  resolveDirectProviderResponseIdForPersistence,
  shouldRetryDirectAttempt,
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
  it('retries retryable Direct quality failures and incomplete step-budget attempts before the third attempt', () => {
    const retryable = createResult({
      outcome: 'error',
      error: {
        code: 'direct_quality_gate_failed',
        message: 'validation failed',
        retryable: true,
      },
    });

    const maxSteps = createResult({
      outcome: 'max_steps',
      stepsExecuted: 5,
      messages: [{ role: 'assistant', content: 'I edited src/direct.ts but still need to run validation.' }],
    });

    expect(shouldRetryDirectAttempt(retryable, 1)).toBe(true);
    expect(shouldRetryDirectAttempt(retryable, 2)).toBe(true);
    expect(shouldRetryDirectAttempt(retryable, AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS)).toBe(false);
    expect(shouldRetryDirectAttempt(maxSteps, 1)).toBe(true);
    expect(shouldRetryDirectAttempt(maxSteps, 2)).toBe(true);
    expect(shouldRetryDirectAttempt(maxSteps, AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS)).toBe(false);
    expect(shouldRetryDirectAttempt(createResult({ outcome: 'context_window' }), 1)).toBe(true);
    expect(shouldRetryDirectAttempt(createResult({ outcome: 'context_window' }), 2)).toBe(true);
    expect(shouldRetryDirectAttempt(createResult({ outcome: 'context_window' }), AUTOCODE_DIRECT_MAX_VALIDATION_ATTEMPTS)).toBe(false);
    expect(shouldRetryDirectAttempt(createResult({ outcome: 'auth_failure' }), 1)).toBe(false);
    expect(shouldRetryDirectAttempt(createResult({
      outcome: 'error',
      error: { code: 'direct_session_error', message: 'transport failed', retryable: false },
    }), 1)).toBe(false);
  });

  it('drops provider response persistence after context window exhaustion', () => {
    expect(resolveDirectProviderResponseIdForPersistence(
      createResult({ outcome: 'context_window', providerResponseId: 'resp_too_large' }),
      'resp_existing',
    )).toBeUndefined();

    expect(resolveDirectProviderResponseIdForPersistence(
      createResult({ outcome: 'max_steps' }),
      'resp_existing',
    )).toBe('resp_existing');

    expect(resolveDirectProviderResponseIdForPersistence(
      createResult({ outcome: 'completed', providerResponseId: 'resp_new' }),
      'resp_existing',
    )).toBe('resp_new');
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
      createSessionConfig({ responsePersistence: true }),
      { language: 'zh-CN' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBe('resp_attempt_1');
    expect(retryConfig.initialMessages).toHaveLength(1);
    expect(retryConfig.initialMessages[0]?.content).toContain('Direct Validation Retry (2/3)');
    expect(retryConfig.initialMessages[0]?.content).toContain('Do not repeat the same implementation idea blindly');
    expect(retryConfig.initialMessages[0]?.content).toContain('ended before completion');
  });

  it('does not infer provider continuation from response metadata when persistence is disabled', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        providerResponseId: 'resp_attempt_1',
        messages: [
          { role: 'user', content: 'Fix the original bug.' },
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
      createSessionConfig({ responsePersistence: false }),
      { language: 'en' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBeUndefined();
    expect(retryConfig.initialMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(retryConfig.initialMessages[0]?.content).toBe('Fix the original bug.');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Direct Validation Retry (2/3)');
  });

  it('uses compact transcript retry after context window exhaustion', () => {
    const bloatedText = Array.from({ length: 200 }, (_, index) => `CONTEXT_WINDOW_BLOAT_${index}`).join('\n');
    const attempt = createAttempt({
      result: createResult({
        outcome: 'context_window',
        providerResponseId: 'resp_context_window',
        messages: [
          { role: 'user', content: 'Fix the original bug.' },
          { role: 'assistant', content: bloatedText },
        ],
      }),
      streamedText: bloatedText,
      failureReason: 'Direct task ended with outcome context_window',
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig({ responsePersistence: true, previousResponseId: 'resp_original' }),
      { language: 'en' },
      [attempt],
      2,
    );

    const promptText = retryConfig.initialMessages.map((message) => message.content).join('\n');
    expect(retryConfig.previousResponseId).toBeUndefined();
    expect(retryConfig.initialMessages.map((message) => message.role)).toEqual(['user', 'user']);
    expect(retryConfig.initialMessages[0]?.content).toBe('Fix the bug.');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Outcome: context_window');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('max_steps or context_window');
    expect(promptText.length).toBeLessThan(bloatedText.length);
  });

  it('continues from the base provider session when the latest attempt has no new response id', () => {
    const attempt = createAttempt({
      result: createResult({
        outcome: 'error',
        messages: [{ role: 'assistant', content: 'Validation: npm test failed after metadata was unavailable.' }],
        error: {
          code: 'direct_quality_gate_failed',
          message: 'validation failed',
          retryable: true,
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig({ previousResponseId: 'resp_original' }),
      { language: 'en' },
      [attempt],
      2,
    );

    expect(retryConfig.previousResponseId).toBe('resp_original');
    expect(retryConfig.initialMessages).toHaveLength(1);
    expect(retryConfig.initialMessages[0]?.role).toBe('user');
    expect(retryConfig.initialMessages[0]?.content).toContain('Direct Validation Retry (2/3)');
    expect(retryConfig.initialMessages[0]?.content).toContain('metadata was unavailable');
  });

  it('adds a repeated failure guard when attempt numbering is the only signature difference', () => {
    const firstAttempt = createAttempt({
      attempt: 1,
      failureReason: 'Direct validation reported_failed: Attempt 1 summary. Validation: npm test failed with SAME_ASSERTION.',
      quality: createQuality({
        validation: {
          status: 'reported_failed',
          reason: 'Attempt 1 summary. Validation: npm test failed with SAME_ASSERTION.',
        },
      }),
    });
    const secondAttempt = createAttempt({
      attempt: 2,
      failureReason: 'Direct validation reported_failed: Attempt 2 summary. Validation: npm test failed with SAME_ASSERTION.',
      quality: createQuality({
        validation: {
          status: 'reported_failed',
          reason: 'Attempt 2 summary. Validation: npm test failed with SAME_ASSERTION.',
        },
      }),
    });

    const retryConfig = buildDirectRetrySessionConfig(
      createSessionConfig(),
      { language: 'en' },
      [firstAttempt, secondAttempt],
      3,
    );

    expect(retryConfig.initialMessages.at(-1)?.content).toContain('Repeated failure guard');
    expect(retryConfig.initialMessages.at(-1)?.content).toContain('choose a different strategy');
  });
  it('keeps the previous provider response id across later retries when metadata is missing', () => {
    const firstAttempt = createAttempt({
      result: createResult({
        outcome: 'error',
        providerResponseId: 'resp_attempt_1',
        error: {
          code: 'direct_quality_gate_failed',
          message: 'first validation failed',
          retryable: true,
        },
      }),
    });

    const secondConfig = buildDirectRetrySessionConfig(
      createSessionConfig({ responsePersistence: true }),
      { language: 'en' },
      [firstAttempt],
      2,
    );

    const secondAttempt = createAttempt({
      attempt: 2,
      result: createResult({
        outcome: 'error',
        messages: [{ role: 'assistant', content: 'Validation: npm test still failed, but response metadata was unavailable.' }],
        error: {
          code: 'direct_quality_gate_failed',
          message: 'second validation failed',
          retryable: true,
        },
      }),
    });

    const thirdConfig = buildDirectRetrySessionConfig(
      secondConfig,
      { language: 'en' },
      [firstAttempt, secondAttempt],
      3,
    );

    expect(thirdConfig.previousResponseId).toBe('resp_attempt_1');
    expect(thirdConfig.initialMessages).toHaveLength(1);
    expect(thirdConfig.initialMessages[0]?.content).toContain('Direct Validation Retry (3/3)');
    expect(thirdConfig.initialMessages[0]?.content).toContain('response metadata was unavailable');
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