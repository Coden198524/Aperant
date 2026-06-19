import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAutocodeImplementationPlan,
  saveAutocodeImplementationPlan,
  type MutableAutocodePlan,
} from '@autocode/core';

import { iterateSubtasks } from '../subtask-iterator';
import { RESUME_FILE } from '../pause-handler';
import type { SessionResult } from '../../session/types';

function makeResult(outcome: SessionResult['outcome'], durationMs = 1): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    durationMs,
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

  it('does not auto-complete runnable work without startup verification evidence', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            {
              id: 'ui-start',
              title: 'Browser game startup',
              description: 'Implement browser game page with canvas controls.',
              status: 'pending',
              files_to_modify: ['src/index.html', 'src/game.js'],
            },
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
      runSubtaskSession: async () => ({
        ...makeResult('completed'),
        messages: [
          {
            role: 'assistant',
            content: [
              '| Item | Details |',
              '| --- | --- |',
              '| What changed | Updated `src/index.html` and `src/game.js`. |',
              '| Verification | Ran `node --check src/game.js` and static tests. |',
              '| Review notes | No residual syntax risks. |',
            ].join('\n'),
          },
        ],
      }),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; notes?: string }> }>;
    }>(specDir);

    expect(result.completedSubtasks).toBe(0);
    expect(updatedPlan.phases[0].subtasks[0].status).not.toBe('completed');
    expect(updatedPlan.phases[0].subtasks[0].notes).toContain('runtime-readiness gate');
  });

  it('records active session duration across a rate-limit pause without counting wait time', async () => {
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
    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 2,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        runs++;
        if (runs === 1) {
          await writeFile(join(specDir, RESUME_FILE), '', 'utf-8');
          return makeResult('rate_limited', 1000);
        }
        return makeResult('completed', 2000);
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; duration_ms?: number }> }>;
    }>(specDir);

    expect(runs).toBe(2);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('completed');
    expect(updatedPlan.phases[0].subtasks[0].duration_ms).toBe(3000);
  });

  it('writes session memory when active memory learning is enabled', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 't', description: 'implement local memory', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);
    const storedMemories: Array<{ type?: string; content?: string }> = [];
    const memoryService = {
      store: async (entry: { type?: string; content?: string }) => {
        storedMemories.push(entry);
        return `memory-${storedMemories.length}`;
      },
    };

    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      qualityConfig: {
        enableActiveMemoryLearning: true,
        enableIncrementalValidation: false,
        enableContextAwareRecovery: false,
        projectId: 'project-1',
        memoryService: memoryService as never,
      },
      runSubtaskSession: async () => makeResult('completed'),
    });

    const memoryDir = join(specDir, 'memory', 'session_insights');
    const files = await readdir(memoryDir);
    expect(files).toHaveLength(1);

    const raw = await readFile(join(memoryDir, files[0]), 'utf-8');
    const memory = JSON.parse(raw) as { subtaskId?: string; outcome?: string };
    expect(memory.subtaskId).toBe('s1');
    expect(memory.outcome).toBe('completed');
    expect(storedMemories.some((entry) => entry.type === 'work_unit_outcome')).toBe(true);
    expect(storedMemories.some((entry) => entry.type === 'module_insight')).toBe(false);
    expect(storedMemories.find((entry) => entry.type === 'work_unit_outcome')?.content)
      .not.toContain('Efficient token usage');
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

  it('does not retry a subtask after a non-retryable session error', async () => {
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
    const stuckReasons: string[] = [];
    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 3,
      autoContinueDelayMs: 0,
      onSubtaskStuck: (_subtask, reason) => stuckReasons.push(reason),
      runSubtaskSession: async () => {
        runs++;
        return {
          ...makeResult('error'),
          error: {
            code: 'billing_error',
            message: 'billing quota exceeded',
            retryable: false,
          },
        };
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; notes?: string }> }>;
    }>(specDir);

    expect(runs).toBe(1);
    expect(result.totalSubtasks).toBe(1);
    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(stuckReasons[0]).toContain('Non-retryable error');
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('failed');
    expect(updatedPlan.phases[0].subtasks[0].notes).toContain('billing quota exceeded');
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

  it('preserves localized assistant completion tables without wrapping them again', async () => {
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
      '| 项目 | 详情 |',
      '|---|---|',
      '| 变更内容 | 已修复中文摘要识别。 |',
      '| 验证 | 单测通过。 |',
      '| 评审备注 | 可继续人工检查。 |',
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
  });

  it('keeps fallback completion summaries compact for downstream QA context', async () => {
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
      'Verbose implementation detail '.repeat(80),
      'FINAL PLAN SUMMARY TAIL OK',
    ].join(' ');

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
    expect(updatedPlan.phases[0].subtasks[0].completion_summary?.length).toBeLessThanOrEqual(1200);
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('manual audit');
    expect(updatedPlan.phases[0].subtasks[0].completion_summary).toContain('FINAL PLAN SUMMARY TAIL OK');
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

  it('does not accept model-completed later subtasks before their turn', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 'first', description: 'first work', status: 'pending' },
            { id: 's2', title: 'second', description: 'second work', status: 'pending' },
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
      runSubtaskSession: async () => {
        const currentPlan = await loadPlan<{
          phases: Array<{ subtasks: Array<{ status: string; completion_summary?: string }> }>;
        }>(specDir);
        for (const phase of currentPlan.phases) {
          for (const subtask of phase.subtasks) {
            subtask.status = 'completed';
            subtask.completion_summary = 'Model tried to complete this early.';
          }
        }
        await savePlan(specDir, currentPlan);
        return makeResult('completed');
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
    }>(specDir);

    expect(started).toEqual(['s1', 's2']);
    expect(result.completedSubtasks).toBe(2);
    expect(updatedPlan.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('runs dependent subtasks only after their dependencies are completed', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 'first', description: 'first work', status: 'pending' },
            { id: 's2', title: 'second', description: 'second work', status: 'pending', depends_on: ['s1'] },
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

    expect(started).toEqual(['s1', 's2']);
    expect(result.completedSubtasks).toBe(2);
    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
    }>(specDir);
    expect(updatedPlan.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('marks subtasks blocked when dependencies cannot be resolved', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 'blocked', description: 'blocked work', status: 'pending', depends_on: ['missing'] },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);
    const stuckReasons: string[] = [];

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      onSubtaskStuck: (_subtask, reason) => stuckReasons.push(reason),
      runSubtaskSession: async () => makeResult('completed'),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; notes?: string }> }>;
    }>(specDir);
    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(updatedPlan.phases[0].subtasks[0].status).toBe('blocked');
    expect(updatedPlan.phases[0].subtasks[0].notes).toContain('missing work item missing');
    expect(stuckReasons[0]).toContain('missing work item missing');
  });

  it('marks dependency cycles blocked with a clear reason', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 'first', description: 'first work', status: 'pending', depends_on: ['s2'] },
            { id: 's2', title: 'second', description: 'second work', status: 'pending', depends_on: ['s1'] },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);
    const stuckReasons: string[] = [];

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      onSubtaskStuck: (_subtask, reason) => stuckReasons.push(reason),
      runSubtaskSession: async () => makeResult('completed'),
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; notes?: string }> }>;
    }>(specDir);
    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['s1', 's2']);
    expect(updatedPlan.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'blocked',
      'blocked',
    ]);
    expect(stuckReasons.join('\n')).toContain('dependency cycle');
  });

  it('marks duplicate subtask ids blocked before running the agent', async () => {
    const plan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            { id: 's1', title: 'first', description: 'first work', status: 'pending' },
            { id: 's1', title: 'second', description: 'second work', status: 'pending' },
          ],
        },
      ],
    };
    await savePlan(specDir, plan);
    const stuckReasons: string[] = [];
    let runs = 0;

    const result = await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      onSubtaskStuck: (_subtask, reason) => stuckReasons.push(reason),
      runSubtaskSession: async () => {
        runs++;
        return makeResult('completed');
      },
    });

    const updatedPlan = await loadPlan<{
      phases: Array<{ subtasks: Array<{ status: string; notes?: string }> }>;
    }>(specDir);
    expect(runs).toBe(0);
    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['s1']);
    expect(updatedPlan.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'blocked',
      'blocked',
    ]);
    expect(stuckReasons.join('\n')).toContain('Duplicate work item id s1');
  });
});
