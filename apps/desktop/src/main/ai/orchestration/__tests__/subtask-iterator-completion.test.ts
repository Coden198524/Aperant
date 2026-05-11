import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

describe('iterateSubtasks completion gating', () => {
  let specDir: string;
  let planPath: string;

  beforeEach(async () => {
    specDir = await mkdtemp(join(tmpdir(), 'subtask-iter-test-'));
    planPath = join(specDir, 'implementation_plan.json');
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
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => makeResult('max_steps'),
    });

    const updatedPlan = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    };

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
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => makeResult('completed'),
    });

    const updatedPlan = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    };

    expect(result.totalSubtasks).toBe(1);
    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
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
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

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

    const updatedPlan = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ completion_summary?: string; notes?: string }> }>;
    };

    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toBe(
      'Implemented the detail view summary and verified with targeted tests.'
    );
    expect(updatedPlan.phases[0].subtasks[0].notes).toBe(
      'Implemented the detail view summary and verified with targeted tests.'
    );
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
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

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

    const updatedPlan = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ completion_summary?: string }> }>;
    };

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
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    let snapshotDuringRun: Record<string, unknown> | null = null;

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        snapshotDuringRun = JSON.parse(await readFile(planPath, 'utf-8')) as Record<string, unknown>;
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
