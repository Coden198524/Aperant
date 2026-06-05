import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeConcurrentWorkItems } from '../concurrent-work-executor';
import type { ConcurrentWorkExecutorConfig } from '../concurrent-work-executor';
import type { SessionResult } from '../../session/types';
import { RESUME_FILE } from '../pause-handler';

const mockLoadImplementationPlanFromFiles = vi.fn();
const mockSaveImplementationPlanToFiles = vi.fn();
const mockUpdateImplementationPlanInFiles = vi.fn();
const mockLearnFromSession = vi.fn();

vi.mock('../../schema/plan-shards', () => ({
  loadImplementationPlanFromFiles: (...args: unknown[]) => mockLoadImplementationPlanFromFiles(...args),
  saveImplementationPlanToFiles: (...args: unknown[]) => mockSaveImplementationPlanToFiles(...args),
  updateImplementationPlanInFiles: (...args: unknown[]) => mockUpdateImplementationPlanInFiles(...args),
}));

vi.mock('../quality-integration', () => ({
  learnFromSession: (...args: unknown[]) => mockLearnFromSession(...args),
}));

function makeSessionResult(outcome: SessionResult['outcome'] = 'completed', durationMs = 1000): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs,
    toolCallCount: 5,
  };
}

function createPlan(files: Array<string | undefined>) {
  return {
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: files.map((file, index) => ({
          id: `work-${index + 1}`,
          title: `Work ${index + 1}`,
          description: `Test work item ${index + 1}`,
          status: 'pending',
          files_to_create: [] as string[],
          files_to_modify: file ? [file] : [],
          pattern_files: [] as string[],
          depends_on: [] as string[],
          verification: 'Run tests',
        })),
      },
    ],
  };
}

function createPatternPlan(patterns: string[]) {
  return {
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: patterns.map((pattern, index) => ({
          id: `work-${index + 1}`,
          title: `Work ${index + 1}`,
          description: `Test work item ${index + 1}`,
          status: 'pending',
          files_to_create: [] as string[],
          files_to_modify: [] as string[],
          pattern_files: [pattern],
          depends_on: [] as string[],
          verification: 'Run tests',
        })),
      },
    ],
  };
}

function setupPlanState(files: Array<string | undefined>) {
  let planState = createPlan(files);

  mockLoadImplementationPlanFromFiles.mockImplementation(() => Promise.resolve(structuredClone(planState)));
  mockSaveImplementationPlanToFiles.mockImplementation((_specDir: string, plan: typeof planState) => {
    planState = structuredClone(plan);
    return Promise.resolve(undefined);
  });
  mockUpdateImplementationPlanInFiles.mockImplementation(async (_specDir: string, updater: (plan: typeof planState) => unknown) => {
    const draft = structuredClone(planState);
    const result = await updater(draft);
    if (result !== false && result !== null) {
      planState = structuredClone((result ?? draft) as typeof planState);
    }
    return structuredClone(planState);
  });

  return {
    getPlanState: () => planState,
  };
}

function setupPlanStates(initial: Record<string, ReturnType<typeof createPlan>>) {
  const planStates = new Map(Object.entries(initial).map(([specDir, plan]) => [specDir, structuredClone(plan)]));

  mockLoadImplementationPlanFromFiles.mockImplementation((specDir: string) => {
    const plan = planStates.get(specDir);
    return Promise.resolve(plan ? structuredClone(plan) : null);
  });
  mockSaveImplementationPlanToFiles.mockImplementation((specDir: string, plan: ReturnType<typeof createPlan>) => {
    planStates.set(specDir, structuredClone(plan));
    return Promise.resolve(undefined);
  });
  mockUpdateImplementationPlanInFiles.mockImplementation(async (specDir: string, updater: (plan: ReturnType<typeof createPlan>) => unknown) => {
    const current = planStates.get(specDir);
    if (!current) return null;
    const draft = structuredClone(current);
    const result = await updater(draft);
    if (result !== false && result !== null) {
      planStates.set(specDir, structuredClone((result ?? draft) as ReturnType<typeof createPlan>));
    }
    return structuredClone(planStates.get(specDir));
  });

  return {
    getPlanState: (specDir: string) => planStates.get(specDir),
  };
}

function createConfig(overrides: Partial<ConcurrentWorkExecutorConfig> = {}): ConcurrentWorkExecutorConfig {
  return {
    specDir: '/spec',
    projectDir: '/project',
    maxRetries: 1,
    workers: 2,
    runWorkItemSession: vi.fn().mockResolvedValue(makeSessionResult()),
    ...overrides,
  };
}

describe('executeConcurrentWorkItems', () => {
  beforeEach(() => {
    mockLoadImplementationPlanFromFiles.mockReset();
    mockSaveImplementationPlanToFiles.mockReset();
    mockUpdateImplementationPlanInFiles.mockReset();
    mockLearnFromSession.mockReset();
  });

  it('runs independent work items concurrently and marks them completed', async () => {
    const { getPlanState } = setupPlanState(['a.ts', 'b.ts', 'c.ts']);
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(3);
    expect(maxActive).toBe(2);
    expect(getPlanState().phases[0].subtasks.every((subtask) => subtask.status === 'completed')).toBe(true);
  });

  it('serializes work items that touch the same file', async () => {
    setupPlanState(['shared.ts', 'shared.ts']);
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('serializes parent directory and child file write intents', async () => {
    setupPlanState(['src', 'src/components/App.tsx']);
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('serializes glob write intents with files under the same prefix', async () => {
    setupPlanState(['src/**/*.ts', 'src/app.ts']);
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('runs disjoint pattern file work items concurrently', async () => {
    setupPlanStates({
      '/spec': createPatternPlan(['src/**/*.ts', 'docs/**/*.md']),
    });
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(2);
  });

  it('runs work items with unknown file intent concurrently', async () => {
    setupPlanState([undefined, undefined]);
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(2);
  });

  it('runs work items concurrently when file metadata is missing but dependencies are declared', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    for (const subtask of plan.phases[0].subtasks) {
      delete (subtask as { files_to_modify?: string[] }).files_to_modify;
      delete (subtask as { files_to_create?: string[] }).files_to_create;
      delete (subtask as { pattern_files?: string[] }).pattern_files;
    }
    setupPlanStates({ '/spec': plan });
    const logs: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({
      workers: 2,
      runWorkItemSession,
      onLog: (message) => logs.push(message),
    }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(2);
    expect(logs.some((message) => message.includes('Dependency scheduling metadata missing'))).toBe(false);
  });

  it('records active work item duration across rate-limit pause without counting wait time', async () => {
    const specDir = mkdtempSync(join(tmpdir(), 'concurrent-work-duration-'));
    try {
      const { getPlanState } = setupPlanState(['a.ts']);
      let runs = 0;
      const runWorkItemSession = vi.fn().mockImplementation(async () => {
        runs++;
        if (runs === 1) {
          writeFileSync(join(specDir, RESUME_FILE), '', 'utf8');
          return makeSessionResult('rate_limited', 1000);
        }
        return makeSessionResult('completed', 2000);
      });

      const result = await executeConcurrentWorkItems(createConfig({ specDir, runWorkItemSession }));

      expect(result.success).toBe(true);
      expect(runs).toBe(2);
      expect((getPlanState().phases[0].subtasks[0] as { duration_ms?: number }).duration_ms).toBe(3000);
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('runs work items concurrently when dependency scheduling metadata is missing', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    for (const subtask of plan.phases[0].subtasks) {
      delete (subtask as { files_to_modify?: string[] }).files_to_modify;
      delete (subtask as { files_to_create?: string[] }).files_to_create;
      delete (subtask as { pattern_files?: string[] }).pattern_files;
      delete (subtask as { depends_on?: string[] }).depends_on;
    }
    setupPlanStates({ '/spec': plan });
    const logs: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({
      workers: 2,
      runWorkItemSession,
      onLog: (message) => logs.push(message),
    }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(2);
    expect(logs.some((message) => message.includes('Dependency scheduling metadata missing'))).toBe(false);
  });

  it('serializes high-risk work items when file metadata is missing', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    for (const subtask of plan.phases[0].subtasks) {
      subtask.description = 'Global architecture refactor without scoped file metadata';
      delete (subtask as { files_to_modify?: string[] }).files_to_modify;
      delete (subtask as { files_to_create?: string[] }).files_to_create;
      delete (subtask as { pattern_files?: string[] }).pattern_files;
    }
    setupPlanStates({ '/spec': plan });
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('marks failed work items as failed after retries are exhausted', async () => {
    const { getPlanState } = setupPlanState(['a.ts']);
    const runWorkItemSession = vi.fn().mockResolvedValue({
      ...makeSessionResult('error'),
      error: { message: 'boom' },
    });

    const result = await executeConcurrentWorkItems(createConfig({ maxRetries: 0, runWorkItemSession }));

    expect(result.success).toBe(false);
    expect(result.totalFailed).toBe(1);
    expect(getPlanState().phases[0].subtasks[0].status).toBe('failed');
    expect((getPlanState().phases[0].subtasks[0] as { notes?: string }).notes).toContain('boom');
  });

  it('records failed work item memory even when failure status persistence fails', async () => {
    setupPlanState(['a.ts']);
    let updateCalls = 0;
    mockUpdateImplementationPlanInFiles.mockImplementation(async (_specDir: string, updater: (plan: ReturnType<typeof createPlan>) => unknown) => {
      updateCalls++;
      if (updateCalls >= 3) {
        throw new Error('plan write failed');
      }
      const current = createPlan(['a.ts']);
      const result = await updater(current);
      return result === false || result === null ? current : (result ?? current);
    });
    const runWorkItemSession = vi.fn().mockResolvedValue({
      ...makeSessionResult('error'),
      error: { message: 'boom memory' },
    });
    const logs: string[] = [];

    const result = await executeConcurrentWorkItems(createConfig({
      maxRetries: 0,
      runWorkItemSession,
      onLog: (message) => logs.push(message),
      qualityConfig: {
        enableActiveMemoryLearning: true,
      } as NonNullable<ConcurrentWorkExecutorConfig['qualityConfig']>,
    }));

    expect(result.success).toBe(false);
    expect(result.totalFailed).toBe(1);
    expect(mockLearnFromSession).toHaveBeenCalledTimes(1);
    expect(mockLearnFromSession.mock.calls[0][0]).toMatchObject({
      id: 'work-1',
      status: 'stuck',
    });
    expect(mockLearnFromSession.mock.calls[0][1]).toMatchObject({
      error: { message: 'boom memory' },
    });
    expect(logs.some((message) => message.includes('Failed to persist failure for work-1'))).toBe(true);
  });

  it('isolates thrown session errors to the current work item', async () => {
    const { getPlanState } = setupPlanState(['a.ts', 'b.ts']);
    const runWorkItemSession = vi.fn()
      .mockRejectedValueOnce(new Error('session crashed'))
      .mockResolvedValueOnce(makeSessionResult());

    const result = await executeConcurrentWorkItems(createConfig({
      maxRetries: 0,
      workers: 2,
      runWorkItemSession,
    }));

    expect(result.success).toBe(false);
    expect(result.totalCompleted).toBe(1);
    expect(result.totalFailed).toBe(1);
    expect(getPlanState().phases[0].subtasks[0].status).toBe('failed');
    expect(getPlanState().phases[0].subtasks[1].status).toBe('completed');
    expect((getPlanState().phases[0].subtasks[0] as { notes?: string }).notes).toContain('session crashed');
  });

  it('continues unrelated dependent work after isolating a failed work item', async () => {
    const plan = createPlan(['a.ts', 'b.ts', 'c.ts']);
    plan.phases[0].subtasks[2].depends_on = ['work-2'];
    const { getPlanState } = setupPlanStates({ '/spec': plan });
    const started: string[] = [];
    const runWorkItemSession = vi.fn().mockImplementation(async (item) => {
      started.push(item.id);
      if (item.id === 'work-1') {
        return {
          ...makeSessionResult('error'),
          error: { message: 'isolated failure' },
        };
      }
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({
      maxRetries: 0,
      workers: 2,
      runWorkItemSession,
    }));

    expect(result.success).toBe(false);
    expect(result.totalCompleted).toBe(2);
    expect(result.totalFailed).toBe(1);
    expect(started).toEqual(['work-1', 'work-2', 'work-3']);
    expect(getPlanState('/spec')?.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'failed',
      'completed',
      'completed',
    ]);
  });

  it('isolates plan status write failures without rejecting the whole executor', async () => {
    setupPlanState(['a.ts']);
    let updateCalls = 0;
    mockUpdateImplementationPlanInFiles.mockImplementation(async (_specDir: string, updater: (plan: ReturnType<typeof createPlan>) => unknown) => {
      updateCalls++;
      if (updateCalls >= 3) {
        throw new Error('plan write failed');
      }
      const current = createPlan(['a.ts']);
      const result = await updater(current);
      return result === false || result === null ? current : (result ?? current);
    });

    const result = await executeConcurrentWorkItems(createConfig({
      maxRetries: 0,
      runWorkItemSession: vi.fn().mockResolvedValue(makeSessionResult()),
    }));

    expect(result.success).toBe(false);
    expect(result.totalCompleted).toBe(0);
    expect(result.totalFailed).toBe(1);
  });

  it('syncs concurrent work item status to the source spec directory', async () => {
    const { getPlanState } = setupPlanStates({
      '/spec': createPlan(['a.ts']),
      '/source-spec': createPlan(['a.ts']),
    });

    const result = await executeConcurrentWorkItems(createConfig({
      specDir: '/spec',
      sourceSpecDir: '/source-spec',
      runWorkItemSession: vi.fn().mockResolvedValue(makeSessionResult()),
    }));

    expect(result.success).toBe(true);
    expect(getPlanState('/source-spec')?.phases[0].subtasks[0].status).toBe('completed');
  });

  it('records concurrent work item quality metrics when quality config is enabled', async () => {
    const { getPlanState } = setupPlanState(['src/a.ts']);

    const result = await executeConcurrentWorkItems(createConfig({
      runWorkItemSession: vi.fn().mockResolvedValue(makeSessionResult()),
      qualityConfig: {
        enableActiveMemoryLearning: true,
      } as NonNullable<ConcurrentWorkExecutorConfig['qualityConfig']>,
    }));

    const metrics = (getPlanState().phases[0].subtasks[0] as {
      ai_coding_quality?: {
        outcome: string;
        attempt: number;
        changed_files: string[];
        files_changed: number;
        tool_call_count: number;
      };
    }).ai_coding_quality;
    expect(result.success).toBe(true);
    expect(metrics).toMatchObject({
      outcome: 'completed',
      attempt: 1,
      changed_files: ['src/a.ts'],
      files_changed: 1,
      tool_call_count: 5,
    });
  });

  it('waits for declared dependencies before scheduling dependent work items', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    plan.phases[0].subtasks[1].depends_on = ['work-1'];
    setupPlanStates({ '/spec': plan });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runWorkItemSession = vi.fn().mockImplementation(async (item) => {
      started.push(item.id);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(true);
    expect(started).toEqual(['work-1', 'work-2']);
    expect(maxActive).toBe(1);
  });

  it('fails without starting sessions when dependencies cannot be resolved', async () => {
    const plan = createPlan(['a.ts']);
    plan.phases[0].subtasks[0].depends_on = ['missing-work'];
    const { getPlanState } = setupPlanStates({ '/spec': plan });
    const runWorkItemSession = vi.fn().mockResolvedValue(makeSessionResult());

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(false);
    expect(result.totalFailed).toBe(1);
    expect(result.error).toContain('dependencies are unresolved');
    expect(runWorkItemSession).not.toHaveBeenCalled();
    expect(getPlanState('/spec')?.phases[0].subtasks[0].status).toBe('blocked');
    expect((getPlanState('/spec')?.phases[0].subtasks[0] as { notes?: string }).notes).toContain('missing-work');
  });

  it('reports dependency cycles before starting sessions', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    plan.phases[0].subtasks[0].depends_on = ['work-2'];
    plan.phases[0].subtasks[1].depends_on = ['work-1'];
    const { getPlanState } = setupPlanStates({ '/spec': plan });
    const runWorkItemSession = vi.fn().mockResolvedValue(makeSessionResult());

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('dependency cycle');
    expect(runWorkItemSession).not.toHaveBeenCalled();
    expect(getPlanState('/spec')?.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'blocked',
      'blocked',
    ]);
  });

  it('rejects duplicate work item ids before starting sessions', async () => {
    const plan = createPlan(['a.ts', 'b.ts']);
    plan.phases[0].subtasks[1].id = 'work-1';
    const { getPlanState } = setupPlanStates({ '/spec': plan });
    const runWorkItemSession = vi.fn().mockResolvedValue(makeSessionResult());

    const result = await executeConcurrentWorkItems(createConfig({ workers: 2, runWorkItemSession }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Duplicate work item id work-1');
    expect(runWorkItemSession).not.toHaveBeenCalled();
    expect(getPlanState('/spec')?.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'blocked',
      'blocked',
    ]);
  });

  it('stops scheduling queued work items after abort', async () => {
    const { getPlanState } = setupPlanState(['a.ts', 'b.ts', 'c.ts']);
    const controller = new AbortController();
    const runWorkItemSession = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeSessionResult();
    });

    const result = await executeConcurrentWorkItems(createConfig({
      workers: 1,
      abortSignal: controller.signal,
      runWorkItemSession,
    }));

    expect(result.cancelled).toBe(true);
    expect(result.totalCompleted).toBe(1);
    expect(runWorkItemSession).toHaveBeenCalledTimes(1);
    expect(getPlanState().phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'completed',
      'pending',
      'pending',
    ]);
  });
});
