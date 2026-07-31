import { describe, expect, it } from 'vitest';

import type { OpenSpecActionRunSummary } from '../types';
import {
  formatOpenSpecStageDuration,
  summarizeOpenSpecStageTimings,
} from './openspec-stage-timing';

function run(
  overrides: Partial<OpenSpecActionRunSummary> = {},
): OpenSpecActionRunSummary {
  return {
    runId: 'run-a',
    action: 'continue',
    state: 'succeeded',
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:00:01.000Z',
    ...overrides,
  };
}

describe('OpenSpec stage timing', () => {
  it('maps every Action into a stable task-wide timing stage', () => {
    const summaries = summarizeOpenSpecStageTimings([
      run({ runId: 'new', action: 'new', durationMs: 1_000 }),
      run({ runId: 'continue', action: 'continue', durationMs: 2_000 }),
      run({ runId: 'apply', action: 'apply', durationMs: 3_000 }),
      run({ runId: 'verify', action: 'verify', durationMs: 4_000 }),
      run({ runId: 'archive', action: 'archive', durationMs: 5_000 }),
    ]);

    expect(summaries).toEqual([
      {
        stage: 'planning',
        durationMs: 3_000,
        runCount: 2,
        active: false,
      },
      {
        stage: 'implementation',
        durationMs: 3_000,
        runCount: 1,
        active: false,
      },
      {
        stage: 'verification',
        durationMs: 4_000,
        runCount: 1,
        active: false,
      },
      {
        stage: 'archive',
        durationMs: 5_000,
        runCount: 1,
        active: false,
      },
    ]);
  });

  it('uses elapsed wall time for an active run and keeps failed attempts', () => {
    const summaries = summarizeOpenSpecStageTimings([
      run({
        runId: 'failed-apply',
        action: 'apply',
        state: 'failed',
        durationMs: 2_000,
      }),
      run({
        runId: 'active-apply',
        action: 'apply',
        state: 'running',
        startedAt: '2026-07-31T00:00:05.000Z',
        completedAt: undefined,
        durationMs: undefined,
      }),
    ], Date.parse('2026-07-31T00:00:08.500Z'));

    expect(summaries[1]).toEqual({
      stage: 'implementation',
      durationMs: 5_500,
      runCount: 2,
      active: true,
    });
  });

  it('deduplicates live and hydrated summaries by run ID', () => {
    const summaries = summarizeOpenSpecStageTimings([
      run({ durationMs: 1_000 }),
      run({ durationMs: 2_000 }),
    ]);

    expect(summaries[0].durationMs).toBe(2_000);
    expect(summaries[0].runCount).toBe(1);
  });

  it('formats compact durations without locale-specific unit text', () => {
    expect(formatOpenSpecStageDuration(0)).toBe('00:00');
    expect(formatOpenSpecStageDuration(65_999)).toBe('01:05');
    expect(formatOpenSpecStageDuration(7_384_000)).toBe('2:03:04');
  });
});
