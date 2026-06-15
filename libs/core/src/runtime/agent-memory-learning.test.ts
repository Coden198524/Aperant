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
    if (!pattern) {
      throw new Error('Expected success pattern');
    }
    expect(pattern?.description).toContain('truncated');
    expect(pattern?.keyDecisions.join('\n')).toContain('truncated');
    expect(pattern?.description).toContain('DESCRIPTION_TAIL_OK');
    expect(pattern?.keyDecisions.join('\n')).toContain('DECISION_TAIL_OK');
    expect(pattern?.keyDecisions.join('\n')).toContain('APPROACH_TAIL_OK');

    const memoryText = formatAutocodeSuccessPatternMemory(pattern);
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

  it('skips generic success pattern memories when no reusable signal exists', () => {
    const genericKnowledge = createAutocodeExtractedKnowledge({
      subtask: { id: '1.3', description: 'Update copy' },
      sessionResult: makeSessionResult(),
      sessionId: 'session-generic',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(genericKnowledge.successPatterns).toEqual([]);
    expect(summarizeAutocodeSessionForMemory(genericKnowledge)).toBe('');

    const patternBackedKnowledge = createAutocodeExtractedKnowledge({
      subtask: {
        id: '1.4',
        description: 'Follow existing auth retry flow',
        patternFiles: ['src/auth/retry-policy.ts'],
      },
      sessionResult: makeSessionResult(),
      sessionId: 'session-pattern-backed',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    expect(patternBackedKnowledge.successPatterns).toHaveLength(1);
    expect(summarizeAutocodeSessionForMemory(patternBackedKnowledge)).toContain('Follow existing auth retry flow');
  });

  it('compacts code patterns before they reach long-term memory', () => {
    const apiPattern = {
      category: 'api_design' as const,
      name: 'API Response Format',
      code: 'return { success: true, data: session, error: null }',
      useCase: 'Session response shape',
      language: 'typescript',
      sourceFile: 'src/auth/api.ts',
    };
    const knowledge = createAutocodeExtractedKnowledge({
      subtask: { id: '1.5', description: 'Extract code patterns' },
      sessionResult: makeSessionResult(),
      codePatterns: [
        {
          category: 'state_management',
          name: 'React useState Hook',
          code: 'const [count, setCount] = useState(0)',
          useCase: 'Managing component state in React',
          language: 'typescript',
          sourceFile: 'src/ui/Counter.tsx',
        },
        {
          category: 'api_design',
          name: 'API Response Format',
          code: 'return { success: true, data: result, error: null }',
          useCase: 'Generic response shape',
          language: 'typescript',
          sourceFile: 'src/api/generic.ts',
        },
        {
          category: 'error_handling',
          name: 'Try-Catch Block',
          code: 'try { await runGenericOperation(); } catch (error) { console.error(error); throw error; }',
          useCase: 'Generic rethrow',
          language: 'typescript',
          sourceFile: 'src/api/generic.ts',
        },
        apiPattern,
        { ...apiPattern, sourceFile: 'src/auth/api-copy.ts' },
        ...Array.from({ length: 5 }, (_, index) => ({
          category: 'error_handling' as const,
          name: `Domain error handler ${index}`,
          code: `try { await refreshToken(${index}); } catch (error) { reportAuthFailure(error); }`,
          useCase: `Auth refresh error path ${index}`,
          language: 'typescript',
          sourceFile: `src/auth/retry-${index}.ts`,
        })),
      ],
      sessionId: 'session-code-patterns',
      timestamp: '2026-06-14T00:00:00.000Z',
    });

    const patterns = knowledge.codePatterns ?? [];

    expect(patterns).toHaveLength(4);
    expect(patterns.some((pattern) => pattern.name === 'React useState Hook')).toBe(false);
    expect(patterns.filter((pattern) => pattern.name === 'API Response Format')).toHaveLength(1);
    expect(patterns.some((pattern) => pattern.useCase === 'Generic response shape')).toBe(false);
    expect(patterns.some((pattern) => pattern.useCase === 'Generic rethrow')).toBe(false);
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
    if (!pattern) {
      throw new Error('Expected failure pattern');
    }
    expect(pattern?.rootCause).toContain('truncated');
    expect(pattern?.rootCause).toContain('ERROR_TAIL_OK');

    const memoryText = formatAutocodeFailurePatternMemory(pattern);
    const summary = summarizeAutocodeSessionForMemory(knowledge);
    expect(memoryText).toContain('Failure pattern:');
    expect(memoryText).toContain('ERROR_TAIL_OK');
    expect(memoryText.trim().startsWith('{')).toBe(false);
    expect(memoryText.length).toBeLessThanOrEqual(900);
    expect(summary).toContain('ERROR_TAIL_OK');
    expect(summary.length).toBeLessThanOrEqual(900);
  });
});
