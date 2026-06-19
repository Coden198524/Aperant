import { describe, expect, it } from 'vitest';

import {
  mergeAutocodeTokenUsage,
  resetAutocodeStuckSubtasksInPlan,
  type MutableAutocodePlan,
} from './plan-file.js';

describe('Autocode plan file state', () => {
  it('replaces estimated token usage with provider-reported usage even when lower', () => {
    const result = mergeAutocodeTokenUsage(
      {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        stepsExecuted: 3,
        estimated: true,
        sessionId: 'estimated-session',
      },
      {
        promptTokens: 320,
        completionTokens: 90,
        totalTokens: 410,
        stepsExecuted: 2,
        sessionId: 'provider-session',
      },
    );

    expect(result).toEqual({
      promptTokens: 320,
      completionTokens: 90,
      totalTokens: 410,
      stepsExecuted: 3,
      sessionId: 'provider-session',
    });
  });

  it('clears stale completion evidence when resetting stuck subtasks', () => {
    const plan: MutableAutocodePlan = {
      phases: [
        {
          subtasks: [
            {
              id: 'wp-1',
              status: 'completed',
              completion_summary: 'Keep real completion.',
              completed_at: '2026-06-18T05:00:00.000Z',
            },
            {
              id: 'wp-2',
              status: 'failed',
              completion_summary: 'Stale summary from failed execution.',
              completed_at: '2026-06-18T05:01:00.000Z',
              started_at: '2026-06-18T05:00:30.000Z',
            },
            {
              id: 'wp-3',
              status: 'blocked',
              completion_summary: 'Blocked by wp-2.',
            },
          ],
        },
      ],
    };

    const result = resetAutocodeStuckSubtasksInPlan(plan);

    expect(result.resetCount).toBe(2);
    expect(plan.phases?.[0].subtasks?.[0]).toMatchObject({
      status: 'completed',
      completion_summary: 'Keep real completion.',
    });
    expect(plan.phases?.[0].subtasks?.[1]).toMatchObject({
      status: 'pending',
      started_at: null,
      completed_at: null,
      completion_summary: null,
    });
    expect(plan.phases?.[0].subtasks?.[2]).toMatchObject({
      status: 'pending',
      completion_summary: null,
    });
  });
});
