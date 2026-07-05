import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';
import { describe, expect, it } from 'vitest';
import {
  evaluateDirectCompletionFallback,
  readDirectRunResultFromSpecDirs,
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

function writeRunResult(specDir: string, result: Record<string, unknown>): void {
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    path.join(specDir, AUTOCODE_TASK_ARTIFACTS.runResult),
    JSON.stringify(result, null, 2),
    'utf-8'
  );
}

function setRunResultMtime(specDir: string, date: Date): void {
  utimesSync(path.join(specDir, AUTOCODE_TASK_ARTIFACTS.runResult), date, date);
}

describe('readDirectRunResultFromSpecDirs', () => {
  it('returns the newest run result across worktree and main spec dirs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'direct-run-result-'));
    try {
      const oldSpecDir = path.join(root, 'worktree');
      const newSpecDir = path.join(root, 'main');
      writeRunResult(oldSpecDir, {
        phase: 'direct',
        status: 'error',
        exitCode: 1,
        message: 'Older failure',
        updatedAt: '2026-07-01T01:00:00.000Z',
      });
      writeRunResult(newSpecDir, {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        message: 'Newer success',
        updatedAt: '2026-07-01T01:02:00.000Z',
      });

      expect(readDirectRunResultFromSpecDirs([oldSpecDir, newSpecDir])).toMatchObject({
        status: 'success',
        message: 'Newer success',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers timestamped run results over untimestamped parse errors when both exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'direct-run-result-'));
    try {
      const corruptSpecDir = path.join(root, 'worktree');
      const validSpecDir = path.join(root, 'main');
      mkdirSync(corruptSpecDir, { recursive: true });
      writeFileSync(path.join(corruptSpecDir, AUTOCODE_TASK_ARTIFACTS.runResult), '{bad json', 'utf-8');
      setRunResultMtime(corruptSpecDir, new Date('2026-07-01T00:59:00.000Z'));
      writeRunResult(validSpecDir, {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        updatedAt: '2026-07-01T01:02:00.000Z',
      });

      expect(readDirectRunResultFromSpecDirs([corruptSpecDir, validSpecDir])).toMatchObject({
        status: 'success',
        updatedAt: '2026-07-01T01:02:00.000Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses file mtime when selecting untimestamped run results', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'direct-run-result-'));
    try {
      const validSpecDir = path.join(root, 'main');
      const corruptSpecDir = path.join(root, 'worktree');
      writeRunResult(validSpecDir, {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        message: 'Older success',
        updatedAt: '2026-07-01T01:02:00.000Z',
      });
      mkdirSync(corruptSpecDir, { recursive: true });
      writeFileSync(path.join(corruptSpecDir, AUTOCODE_TASK_ARTIFACTS.runResult), '{bad json', 'utf-8');
      setRunResultMtime(corruptSpecDir, new Date('2026-07-01T01:03:00.000Z'));

      expect(readDirectRunResultFromSpecDirs([validSpecDir, corruptSpecDir])).toMatchObject({
        status: 'error',
        updatedAt: '2026-07-01T01:03:00.000Z',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses file mtime as freshness evidence for untimestamped successful run results', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'direct-run-result-'));
    try {
      const specDir = path.join(root, 'worktree');
      writeRunResult(specDir, {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
      });
      setRunResultMtime(specDir, new Date('2026-07-01T01:01:02.000Z'));

      const decision = evaluateDirectCompletionFallback({
        exitCode: 0,
        fallback: 'clean-exit',
        plan: currentIterationPlan(),
        runResult: readDirectRunResultFromSpecDirs([specDir]),
      });

      expect(decision).toMatchObject({
        action: 'complete',
        reason: 'fresh-successful-run-result',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('fails when a fresh successful Direct run result contains failed quality evidence', () => {
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
          mode: 'direct',
          outcome: 'completed',
          changedFiles: ['src/direct.ts'],
          filesChanged: 1,
          validation: {
            status: 'reported_failed',
            reason: 'npm test failed with 1 assertion error',
          },
        },
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'quality-gate-failed-run-result',
      error: 'Direct validation reported_failed: npm test failed with 1 assertion error',
      quality: {
        fallback: 'clean-exit',
        fallbackReason: 'quality-gate-failed-run-result',
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

  it('ignores stale failed run result when the current Direct plan completed after this iteration started', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan({
        outcome: 'completed',
        completed_at: '2026-07-01T01:01:05.000Z',
      }),
      runResult: {
        phase: 'direct',
        status: 'error',
        exitCode: 1,
        message: 'Older Direct run failed.',
        updatedAt: '2026-07-01T01:00:00.000Z',
      },
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'completed-plan-outcome',
    });
  });

  it('fails on stale failed run result when there is no current Direct success evidence', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'error',
        exitCode: 1,
        message: 'Older Direct run failed.',
        updatedAt: '2026-07-01T01:00:00.000Z',
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'stale-direct-run-result',
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

  it('fails when a completed Direct plan contains failed self-critique evidence', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'stuck-clean-exit',
      plan: currentIterationPlan({
        outcome: 'completed',
        completed_at: '2026-07-01T01:01:05.000Z',
        ai_coding_quality: {
          mode: 'direct',
          outcome: 'completed',
          changedFiles: ['src/direct.ts'],
          filesChanged: 1,
          validation: {
            status: 'reported_passed',
            reason: 'npm test passed',
          },
          selfCritique: {
            status: 'failed',
            score: 0.5,
            filesReviewed: 1,
            improvements: ['Handle null input'],
          },
        },
      }),
      runResult: null,
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'quality-gate-failed-plan-outcome',
      error: 'Direct self-critique failed: Handle null input',
      quality: {
        fallback: 'stuck-clean-exit',
        fallbackReason: 'quality-gate-failed-plan-outcome',
      },
    });
  });
  it('fails implementation Direct success evidence when validation was not reported', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        message: 'Direct CLI run completed.',
        updatedAt: '2026-07-01T01:01:02.000Z',
        quality: {
          mode: 'direct',
          outcome: 'completed',
          validation: {
            status: 'not_run',
            reason: 'No validation command was reported.',
          },
        },
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'quality-gate-failed-run-result',
      error: 'Direct validation not_run: No validation command was reported.',
    });
  });

  it('fails implementation Direct success evidence when validation is ambiguous', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        message: 'Direct CLI run completed.',
        updatedAt: '2026-07-01T01:01:02.000Z',
        quality: {
          mode: 'direct',
          outcome: 'completed',
          validation: {
            status: 'reported',
            reason: 'Validation: npm test was mentioned without pass/fail output.',
          },
        },
      },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'quality-gate-failed-run-result',
      error: 'Direct validation reported: Validation: npm test was mentioned without pass/fail output.',
    });
  });
  it('allows documentation Direct success evidence without validation', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'success',
        exitCode: 0,
        message: 'Documentation summary completed.',
        updatedAt: '2026-07-01T01:01:02.000Z',
        quality: {
          mode: 'direct',
          outcome: 'completed',
          validation: {
            status: 'not_run',
            reason: 'Documentation-only task did not run code validation.',
          },
        },
      },
      taskMetadata: { category: 'documentation' },
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'fresh-successful-run-result',
    });
  });
  it('completes documentation tasks on clean exit without durable success evidence', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: null,
      taskMetadata: { category: 'documentation' },
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'clean-exit-non-implementation-task',
    });
  });

  it('completes investigation workflows on clean exit without durable success evidence', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: {
        ...currentIterationPlan(),
        workflow_type: 'investigation',
      },
      runResult: null,
    });

    expect(decision).toMatchObject({
      action: 'complete',
      reason: 'clean-exit-non-implementation-task',
    });
  });

  it('does not hide explicit Direct failures for documentation tasks', () => {
    const decision = evaluateDirectCompletionFallback({
      exitCode: 0,
      fallback: 'clean-exit',
      plan: currentIterationPlan(),
      runResult: {
        phase: 'direct',
        status: 'error',
        exitCode: 1,
        message: 'Documentation validation failed.',
        updatedAt: '2026-07-01T01:01:02.000Z',
      },
      taskMetadata: { category: 'documentation' },
    });

    expect(decision).toMatchObject({
      action: 'fail',
      reason: 'direct-run-result-not-successful',
      error: 'Documentation validation failed.',
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