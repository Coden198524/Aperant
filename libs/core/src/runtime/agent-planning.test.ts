import { describe, expect, it } from 'vitest';

import {
  buildAutocodePlanningStructuredOutputRetryPrompt,
  buildAutocodePlanningStructuredOutputValidationRetryPrompt,
  buildAutocodeStandardTasksValidationRetryPrompt,
} from './agent-planning.js';
import { buildAutocodePlanQualityRetryPrompt } from '../tasks/plan-quality.js';

function longErrors(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `error ${index}: ${'very detailed validation context '.repeat(20)}`,
  );
}

describe('agent planning retry prompt compaction', () => {
  it('compacts Write tool failure details in tasks retry prompts', () => {
    const prompt = buildAutocodePlanningStructuredOutputRetryPrompt(
      `Tool input failed: ${'malformed JSON payload '.repeat(80)}`,
    );

    expect(prompt).toContain('Previous Write call failed before execution');
    expect(prompt).toContain('truncated');
    expect(prompt.length).toBeLessThan(2_000);
  });

  it('limits runtime plan validation errors in tasks retry prompts', () => {
    const prompt = buildAutocodePlanningStructuredOutputValidationRetryPrompt(longErrors(12));

    expect(prompt).toContain('Errors:');
    expect(prompt).toContain('... 4 more error(s) omitted');
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('error 11');
    expect(prompt.length).toBeLessThan(4_000);
  });

  it('limits standard planning validation errors in tasks retry prompts', () => {
    const prompt = buildAutocodeStandardTasksValidationRetryPrompt(longErrors(10));

    expect(prompt).toContain('... 2 more error(s) omitted');
    expect(prompt).not.toContain('error 9');
    expect(prompt.length).toBeLessThan(4_000);
  });

  it('limits standard artifact quality retry errors', () => {
    const prompt = buildAutocodePlanQualityRetryPrompt(longErrors(11));

    expect(prompt).toContain('REWRITE STANDARD PLAN ARTIFACTS');
    expect(prompt).toContain('... 3 more error(s) omitted');
    expect(prompt).not.toContain('error 10');
    expect(prompt.length).toBeLessThan(4_000);
  });
});
