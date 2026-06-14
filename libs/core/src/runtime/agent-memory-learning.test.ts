import { describe, expect, it } from 'vitest';

import {
  analyzeAutocodeWhyItWorked,
  createAutocodeExtractedKnowledge,
  formatAutocodeFailurePatternMemory,
  formatAutocodeSuccessPatternMemory,
  isAutocodeSessionMetricInsight,
  summarizeAutocodeSessionForMemory,
} from './agent-memory-learning.js';
import type { AutocodeSessionResult } from './agent-session-types.js';

function makeSessionResult(overrides: Partial<AutocodeSessionResult> = {}): AutocodeSessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 4,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 1,
    toolCallCount: 0,
    ...overrides,
  };
}

describe('agent memory learning compaction', () => {
  it('bounds success pattern memory content extracted from long assistant decisions', () => {
    const knowledge = createAutocodeExtractedKnowledge({
      subtask: {
        id: '1.1',
        description: `Centralize settings persistence ${'detail '.repeat(120)}DESCRIPTION_TAIL_OK`,
      },
      sessionResult: makeSessionResult({
        messages: [{
          role: 'assistant',
          content: [
            `We decided to reuse the shared settings writer ${'because '.repeat(120)}DECISION_TAIL_OK.`,
            `Approach: keep writes centralized ${'and consistent '.repeat(120)}APPROACH_TAIL_OK`,
          ].join('\n'),
        }],
      }),
      sessionId: 'session-1',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const pattern = knowledge.successPatterns?.[0];
    expect(pattern).toBeDefined();
    expect(pattern?.description).toContain('truncated');
    expect(pattern?.keyDecisions.join('\n')).toContain('truncated');
    expect(pattern?.description).toContain('DESCRIPTION_TAIL_OK');
    expect(pattern?.keyDecisions.join('\n')).toContain('DECISION_TAIL_OK');
    expect(pattern?.keyDecisions.join('\n')).toContain('APPROACH_TAIL_OK');

    const memoryText = formatAutocodeSuccessPatternMemory(pattern!);
    expect(memoryText).toContain('Success pattern:');
    expect(memoryText).toContain('truncated');
    expect(memoryText).not.toContain('Efficient implementation with minimal token usage');
    expect(memoryText).not.toContain('Completed in few steps without excessive retries');
    expect(memoryText).toContain('DESCRIPTION_TAIL_OK');
    expect(memoryText).toContain('DECISION_TAIL_OK');
    expect(memoryText).toContain('APPROACH_TAIL_OK');
    expect(memoryText.trim().startsWith('{')).toBe(false);
    expect(memoryText.length).toBeLessThanOrEqual(900);
  });

  it('keeps generic token and step metrics out of long-term success reasons and summaries', () => {
    const whyItWorked = analyzeAutocodeWhyItWorked({
      subtask: { id: '1.2', description: 'Update auth UI' },
      sessionResult: makeSessionResult({
        stepsExecuted: 2,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    });

    expect(whyItWorked).toContain('Implementation passed all verification checks');
    expect(whyItWorked).not.toContain('minimal token');
    expect(whyItWorked).not.toContain('few steps');

    expect(isAutocodeSessionMetricInsight('Efficient token usage - concise and focused implementation')).toBe(true);
    expect(isAutocodeSessionMetricInsight('Completed quickly with few steps - good planning')).toBe(true);
    expect(isAutocodeSessionMetricInsight('AuthStore must refresh token before route transition')).toBe(false);

    const summary = summarizeAutocodeSessionForMemory({
      subtaskId: '1.2',
      outcome: 'completed',
      insights: [
        'Efficient token usage - concise and focused implementation',
        'AuthStore must refresh token before route transition',
      ],
    });

    expect(summary).toContain('AuthStore must refresh token');
    expect(summary).not.toContain('Efficient token usage');
  });

  it('bounds failure pattern memory content and summary text', () => {
    const knowledge = createAutocodeExtractedKnowledge({
      subtask: {
        id: '2.1',
        description: 'Fix failing import path',
      },
      sessionResult: makeSessionResult({
        outcome: 'error',
        error: {
          code: 'unknown_failure',
          message: `Opaque failure ${'diagnostic '.repeat(120)}ERROR_TAIL_OK`,
          retryable: true,
        },
        messages: [{
          role: 'assistant',
          content: '{"toolName":"Read"} {"toolName":"Read"} {"toolName":"Read"}',
        }],
      }),
      sessionId: 'session-2',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const pattern = knowledge.failurePatterns?.[0];
    expect(pattern).toBeDefined();
    expect(pattern?.rootCause).toContain('truncated');
    expect(pattern?.rootCause).toContain('ERROR_TAIL_OK');

    const memoryText = formatAutocodeFailurePatternMemory(pattern!);
    const summary = summarizeAutocodeSessionForMemory(knowledge);
    expect(memoryText).toContain('Failure pattern:');
    expect(memoryText).toContain('ERROR_TAIL_OK');
    expect(memoryText.trim().startsWith('{')).toBe(false);
    expect(memoryText.length).toBeLessThanOrEqual(900);
    expect(summary).toContain('ERROR_TAIL_OK');
    expect(summary.length).toBeLessThanOrEqual(900);
  });
});
