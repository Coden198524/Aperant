import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAutocodeImplementationPlan,
  saveAutocodeImplementationPlan,
  type MutableAutocodePlan,
} from '@autocode/core';

import { iterateSubtasks } from '../subtask-iterator';
import type { SessionResult } from '../../session/types';

function makeResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    durationMs: 1,
    toolCallCount: 0,
  };
}

async function savePlan(specDir: string, plan: MutableAutocodePlan): Promise<void> {
  await saveAutocodeImplementationPlan(specDir, plan);
}

async function loadPlan<T = MutableAutocodePlan>(specDir: string): Promise<T> {
  const plan = await loadAutocodeImplementationPlan(specDir);
  expect(plan).not.toBeNull();
  return plan as T;
}

describe('iterateSubtasks completion gating', () => {
  let specDir: string;

  beforeEach(async () => {
    specDir = await mkdtemp(join(tmpdir(), 'subtask-iter-test-'));
  });

  afterEach(async () => {
    await rm(specDir, { recursive: true, force: true });
  });

  it('does not auto-complete subtask when session ends with max_steps', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => makeResult('max_steps'),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    }>(specDir);

    expect(result.totalSubtasks).toBe(1);
    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(updatedPlan.phases[0].subtasks[0].status).not.toBe('completed');
  });

  it('auto-completes subtask when session ends with completed', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => makeResult('completed'),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    }>(specDir);

    expect(result.totalSubtasks).toBe(1);
    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
  });

  it('accepts a model-updated completed status even when the session outcome is error', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    let runs = 0;
    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 2,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        runs++;
        const currentPlan = await loadPlan<{
          phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
        }>(specDir);
        currentPlan.phases[0].subtasks[0].status = 'completed';
        await savePlan(specDir, currentPlan);
        return makeResult('error');
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    }>(specDir);

    expect(runs).toBe(1);
    expect(result.totalSubtasks).toBe(1);
    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
  });

  it('trusts update_subtask_status completion evidence even if the plan was overwritten stale', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    let runs = 0;
    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 2,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        runs++;
        const stalePlan = await loadPlan<{
          phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
        }>(specDir);
        stalePlan.phases[0].subtasks[0].status = 'in_progress';
        await savePlan(specDir, stalePlan);
        return {
          ...makeResult('error'),
          completedSubtaskIds: ['s1'],
          messages: [
            { role: 'assistant', content: '| Item | Details |\n|---|---|\n| What changed | Done. |\n| Verification | Checked. |\n| Review notes | Ready. |' },
          ],
        };
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; completion_summary?: string }> }>;
    }>(specDir);

    expect(runs).toBe(1);
    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('What changed');
  });

  it('does not retry a tool-completed subtask when the session hits max_steps', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    let runs = 0;
    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 2,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        runs++;
        const stalePlan = await loadPlan<{
          phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
        }>(specDir);
        stalePlan.phases[0].subtasks[0].status = 'in_progress';
        await savePlan(specDir, stalePlan);
        return {
          ...makeResult('max_steps'),
          completedSubtaskIds: ['s1'],
          messages: [
            { role: 'assistant', content: 'Done and checked.' },
          ],
        };
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; completion_summary?: string }> }>;
    }>(specDir);

    expect(runs).toBe(1);
    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('Done and checked');
  });

  it('skips subtasks that have completion evidence even if status regressed', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            {
              id: 's1',
              title: 'done',
              description: 'already done',
              status: 'in_progress',
              completion_summary: '| Item | Details |\n| --- | --- |\n| What changed | Done. |',
            },
            { id: 's2', title: 'next', description: 'next work', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    const started: string[] = [];
    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      onSubtaskStart: (subtask) => started.push(subtask.id),
      runSubtaskSession: async () => makeResult('completed'),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ id: string; status: string; completed_at?: string }> }>;
    }>(specDir);

    expect(started).toEqual(['s2']);
    expect(result.totalSubtasks).toBe(2);
    expect(result.completedSubtasks).toBe(2);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
    expect(updatedPlan.phases[0].subtasks[0].completed_at).toEqual(expect.any(String));
    expect(updatedPlan.phases[0].subtasks[1].status).toBe('completed');
  });

  it('adds a completion summary from the final assistant message when auto-completing', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => ({
        ...makeResult('completed'),
        messages: [
          { role: 'assistant', content: 'Implemented the detail view summary and verified with targeted tests.' },
        ],
      }),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ completion_summary?: string; notes?: string }> }>;
    }>(specDir);

    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('| What changed |');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain(
      'Implemented the detail view summary and verified with targeted tests.'
    );
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('| Verification |');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('| Review notes |');
    expect(updatedPlan.phases[0].subtasks[0].notes).toBe(
      updatedPlan.phases[0].subtasks[0].completion_summary
    );
  });

  it('preserves assistant completion tables without wrapping them again', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    const table = [
      '| Item | Details |',
      '|---|---|',
      '| What changed | Added match-3 gameplay loop. |',
      '| Verification | Build passed. |',
      '| Review notes | Ready for manual review. |',
    ].join('\n');

    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => ({
        ...makeResult('completed'),
        messages: [
          { role: 'assistant', content: table },
        ],
      }),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ completion_summary?: string }> }>;
    }>(specDir);

    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toBe(table);
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).not.toContain('Session outcome');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).not.toContain('\\| Item \\| Details \\|');
  });

  it('preserves long fallback completion summaries for human review', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    const longSummary = [
      'Implemented the complete task detail summary surface.',
      'Added structured rows for changed files, verification, and reviewer notes.',
      'Preserved enough detail for manual audit without forcing reviewers to inspect raw logs.',
    ].join(' ').repeat(8);

    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => ({
        ...makeResult('completed'),
        messages: [
          { role: 'assistant', content: longSummary },
        ],
      }),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ completion_summary?: string }> }>;
    }>(specDir);

    expect(updatedPlan.phases[0].subtasks[0].completion_summary?.length).toBeGreaterThan(500);
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('manual audit');
  });

  it('marks subtask in_progress and restamps executionPhase before coder session starts', async () => {
    const plan = {
      executionPhase: 'planning',
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'd', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);

    let snapshotDuringRun: Record<string, unknown> | null = null;

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        snapshotDuringRun = await loadPlan<Record<string, unknown> & MutableAutocodePlan>(specDir);
        return makeResult('completed');
      },
    });

    expect(result.totalSubtasks).toBe(1);
    expect(snapshotDuringRun).not.toBeNull();
    const planDuringRun = snapshotDuringRun!;
    const typedPlanDuringRun = planDuringRun as {
      executionPhase?: string;
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    };
    expect(typedPlanDuringRun.executionPhase).toBe('coding');
    expect(typedPlanDuringRun.phases[0].subtasks[0].status).toBe('in_progress');
  });
});
