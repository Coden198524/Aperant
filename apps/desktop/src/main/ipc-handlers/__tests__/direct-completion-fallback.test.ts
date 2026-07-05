import { describe, expect, it } from 'vitest';
import {
  evaluateDirectCompletionFallback,
  type DirectFallbackPlan,
} from '../direct-completion-fallback';

function currentIterationPlan(overrides: Partial<DirectFallbackPlan['direct_execution']> = {}): DirectFallbackPlan {
  return {
    workflow_type: 'direct',
    direct_execution: {
      enabled: true,
      outcome: 'running',
      current_subtask_id: 'direct-cr-20260701010101000',
      change_request_id: 'cr-20260701010101000',
      ...overrides,
    },
    phases: [
      {
        type: 'direct',
        subtasks: [
          {
            id: 'direct-cr-20260701010101000',
            started_at: '2026-07-01T01:01:01.000Z',
          },
        ],
      },
    ],
  };
}

describe('evaluateDirectCompletionFallback', () => {
  it('completes when the current Direct run result is successful and fresh', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        updatedAt: '2026-07-01T01:01:02.000Z',
        quality: {
          filesChanged: 2,
          changedFiles: ['src/a.ts', 'src/b.ts'],
        },
      },
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'fresh-successful-run-result',
      filesChanged: 2,
      quality: {
        fallback: 'clean-exit',
        fallbackReason: 'fresh-successful-run-result',
      },
    });
  });

  it('fails when a Direct run result is explicit failure even if plan still says completed', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan({
        outcome: 'completed',
        completed_at: '2026-07-01T01:01:03.000Z',
      }),
      runResult: {
        phase: 'direct',
        status: 'error',
        exitCode: 1,
        message: 'Validation failed.',
        updatedAt: '2026-07-01T01:01:04.000Z',
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'direct-run-result-not-successful',
      error: 'Validation failed.',
    });
  });

  it('fails instead of reusing a stale successful run result from an older iteration', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        updatedAt: '2026-07-01T01:00:00.000Z',
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'stale-successful-run-result',
    });
  });

  it('keeps legacy Direct worker fallback when plan outcome is completed', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'stuck-clean-exit',
      plan: currentIterationPlan({
        outcome: 'completed',
        completed_at: '2026-07-01T01:01:05.000Z',
        ai_coding_quality: {
          filesChanged: 1,
          changedFiles: ['src/direct.ts'],
        },
      }),
      runResult: null,
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'completed-plan-outcome',
      filesChanged: 1,
      quality: {
        fallback: 'stuck-clean-exit',
        fallbackReason: 'completed-plan-outcome',
      },
    });
  });

  it('fails clean exit when Direct has no durable success evidence', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: null,
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'unfinished-plan-outcome',
      error: 'Direct process exited cleanly while plan outcome is running.',
    });
  });

  it('ignores non-zero process exits because the normal exit path handles them', () => {
    expect(evaluateDirectCompletionFallback({
      exitCode: 1,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: null,
    })).toEqual({
      action: 'ignore',
      reason: 'process-exit-nonzero',
    });
  });
});