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
});

