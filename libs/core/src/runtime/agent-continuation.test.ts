import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_CONTINUATION_SUMMARY_MAX_CHARS,
  AUTOCODE_MAX_SUMMARY_INPUT_CHARS,
  AUTOCODE_RAW_TRUNCATION_CHARS,
  buildAutocodeContinuationPrompt,
  buildAutocodeSummaryPrompt,
  limitAutocodeContinuationSummary,
  limitAutocodeSummaryInput,
  rawTruncateAutocodeSessionMessages,
  runAutocodeContinuableSession,
  serializeAutocodeSessionMessages,
} from './agent-continuation.js';
import type { AutocodeSessionMessage, AutocodeSessionResult } from './agent-session-types.js';

describe('Autocode agent continuation compaction', () => {
  it('keeps small summary input identical to normal serialization', () => {
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'Implement the focused change.' },
      { role: 'assistant', content: 'Changed src/a.ts and verified with npm test.' },
    ];

    expect(limitAutocodeSummaryInput(messages)).toBe(serializeAutocodeSessionMessages(messages));
  });

  it('limits summary input without losing the tail of a large assistant response', () => {
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'Continue the build task.' },
      {
        role: 'assistant',
        content: [
          'assistant-head',
          'middle '.repeat(30_000),
          'assistant-tail critical verification result',
        ].join('\n'),
      },
    ];

    const compact = limitAutocodeSummaryInput(messages);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_MAX_SUMMARY_INPUT_CHARS);
    expect(compact).toContain('assistant-head');
    expect(compact).toContain('assistant-tail critical verification result');
    expect(compact).toContain('message truncated');
    expect(compact).toContain('conversation truncated');
  });

  it('preserves the initial task and recent progress when many old messages exceed budget', () => {
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'INITIAL_GOAL: continue product hardening.' },
      ...Array.from({ length: 24 }, (_, index) => ({
        role: 'assistant' as const,
        content: `OLD_VERBOSE_${index} ${'old tool output '.repeat(120)}`,
      })),
      {
        role: 'assistant',
        content: 'RECENT_DECISION: memory injection should prefer current failing file.',
      },
      {
        role: 'assistant',
        content: 'RECENT_REMAINING_WORK: run focused tests and push.',
      },
    ];

    const compact = limitAutocodeSummaryInput(messages);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_MAX_SUMMARY_INPUT_CHARS);
    expect(compact).toContain('INITIAL_GOAL');
    expect(compact).toContain('RECENT_DECISION');
    expect(compact).toContain('RECENT_REMAINING_WORK');
    expect(compact).toContain('older, duplicate, or blank message');
    expect(compact).toContain('conversation truncated');
    expect(compact).not.toContain('OLD_VERBOSE_0');
  });

  it('omits duplicate and blank messages from oversized continuation summary input', () => {
    const repeated = `DUPLICATE_TOOL_NOISE ${'same output '.repeat(1_200)}`;
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'Start the continuation summary.' },
      { role: 'assistant', content: repeated },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: repeated },
      { role: 'assistant', content: repeated },
      { role: 'assistant', content: 'UNIQUE_RECENT_CONTEXT' },
    ];

    const compact = limitAutocodeSummaryInput(messages);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_MAX_SUMMARY_INPUT_CHARS);
    expect((compact.match(/DUPLICATE_TOOL_NOISE/g) ?? [])).toHaveLength(1);
    expect(compact).toContain('UNIQUE_RECENT_CONTEXT');
    expect(compact).toContain('older, duplicate, or blank message');
  });

  it('keeps the omission marker when only one useful oversized input message remains', () => {
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'ONLY_USEFUL_CONTEXT' },
      ...Array.from({ length: 220 }, () => ({
        role: 'assistant' as const,
        content: ' '.repeat(600),
      })),
    ];

    const compact = limitAutocodeSummaryInput(messages);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_MAX_SUMMARY_INPUT_CHARS);
    expect(compact).toContain('ONLY_USEFUL_CONTEXT');
    expect(compact).toContain('older, duplicate, or blank message');
    expect(compact).toContain('conversation truncated');
  });

  it('raw fallback keeps recent message tails within its compact budget', () => {
    const messages: AutocodeSessionMessage[] = [
      { role: 'user', content: 'old context that can be omitted' },
      {
        role: 'assistant',
        content: [
          'assistant-large-head',
          'body '.repeat(20_000),
          'assistant-large-tail unresolved issue',
        ].join('\n'),
      },
    ];

    const compact = rawTruncateAutocodeSessionMessages(messages);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_RAW_TRUNCATION_CHARS);
    expect(compact).toContain('assistant-large-tail unresolved issue');
    expect(compact).toContain('truncated');
    expect(compact).not.toContain('assistant-large-head');
  });

  it('summary prompt builder bounds raw serialized conversation defensively', () => {
    const serialized = [
      '[USER]\nHEAD: continue the commercial hardening task.',
      'middle history '.repeat(40_000),
      '[ASSISTANT]\nTAIL: remaining work is to run targeted verification.',
    ].join('\n');

    const prompt = buildAutocodeSummaryPrompt(serialized);

    expect(prompt.length).toBeLessThan(serialized.length);
    expect(prompt).toContain('HEAD: continue the commercial hardening task.');
    expect(prompt).toContain('TAIL: remaining work is to run targeted verification.');
    expect(prompt).toContain('serialized conversation middle omitted');
    expect(prompt).toContain('## Summary:');
  });

  it('continuation prompt bounds oversized generated summaries while preserving remaining work', () => {
    const summary = [
      'SUMMARY HEAD: completed settings persistence and memory compaction.',
      'verbose summary '.repeat(20_000),
      'SUMMARY TAIL: remaining work is packaging verification and UI smoke testing.',
    ].join('\n');

    const compact = limitAutocodeContinuationSummary(summary);
    const prompt = buildAutocodeContinuationPrompt(summary, 2);

    expect(compact.length).toBeLessThanOrEqual(AUTOCODE_CONTINUATION_SUMMARY_MAX_CHARS);
    expect(prompt).toContain('SUMMARY HEAD: completed settings persistence and memory compaction.');
    expect(prompt).toContain('SUMMARY TAIL: remaining work is packaging verification and UI smoke testing.');
    expect(prompt).toContain('continuation summary middle omitted');
    expect(prompt).toContain('Continue with remaining work');
    expect(prompt.length).toBeLessThan(summary.length);
  });

  it('aggregates token usage across continuation sessions', async () => {
    const results: AutocodeSessionResult[] = [
      {
        outcome: 'context_window',
        stepsExecuted: 8,
        usage: {
          promptTokens: 1_000,
          completionTokens: 200,
          totalTokens: 1_200,
          thinkingTokens: 40,
          cacheReadTokens: 300,
          cacheCreationTokens: 20,
          sessionId: 'session-a',
        },
        messages: [{ role: 'assistant', content: 'Partial result before context window.' }],
        durationMs: 100,
        toolCallCount: 4,
        completedSubtaskIds: ['1.1'],
      },
      {
        outcome: 'completed',
        stepsExecuted: 3,
        usage: {
          promptTokens: 250,
          completionTokens: 75,
          totalTokens: 325,
          thinkingTokens: 10,
          cacheReadTokens: 50,
          sessionId: 'session-b',
        },
        messages: [{ role: 'assistant', content: 'Final result.' }],
        durationMs: 50,
        toolCallCount: 2,
        completedSubtaskIds: ['1.2'],
      },
    ];
    const observedPrompts: string[] = [];

    const result = await runAutocodeContinuableSession(
      { initialMessages: [{ role: 'user', content: 'Start implementation.' }] },
      undefined,
      { maxContinuations: 2 },
      {
        runSession: async (config) => {
          observedPrompts.push(config.initialMessages[0]?.content ?? '');
          const nextResult = results.shift();
          if (!nextResult) {
            throw new Error('Expected queued continuation result');
          }
          return nextResult;
        },
        summarizeMessages: async () => 'Continue after finishing subtask 1.1.',
      },
    );

    expect(result.outcome).toBe('completed');
    expect(result.continuationCount).toBe(1);
    expect(result.stepsExecuted).toBe(11);
    expect(result.toolCallCount).toBe(6);
    expect(result.durationMs).toBe(150);
    expect(result.completedSubtaskIds).toEqual(['1.1', '1.2']);
    expect(result.usage).toEqual({
      promptTokens: 1_250,
      completionTokens: 275,
      totalTokens: 1_525,
      thinkingTokens: 50,
      cacheReadTokens: 350,
      cacheCreationTokens: 20,
      sessionId: 'session-b',
    });
    expect(result.cumulativeUsage).toBe(result.usage);
    expect(observedPrompts[1]).toContain('## Session Continuation (1)');
    expect(observedPrompts[1]).toContain('Continue after finishing subtask 1.1.');
  });
});
