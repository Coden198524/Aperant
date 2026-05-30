import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeConcurrentWorkItems } from '../concurrent-work-executor';
import type { ConcurrentWorkExecutorConfig } from '../concurrent-work-executor';
import type { SessionResult } from '../../session/types';

const mockLoadImplementationPlanFromFiles = vi.fn();
const mockSaveImplementationPlanToFiles = vi.fn();

vi.mock('../../schema/plan-shards', () => ({
  loadImplementationPlanFromFiles: (...args: unknown[]) => mockLoadImplementationPlanFromFiles(...args),
  saveImplementationPlanToFiles: (...args: unknown[]) => mockSaveImplementationPlanToFiles(...args),
}));

function makeSessionResult(outcome: SessionResult['outcome'] = 'completed'): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 1000,
    toolCallCount: 5,
  };
}

function createPlan(files: string[]) {
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
          files_to_create: [],
          files_to_modify: [file],
          pattern_files: [],
          verification: 'Run tests',
        })),
      },
    ],
  };
}

function setupPlanState(files: string[]) {
  let planState = createPlan(files);

  mockLoadImplementationPlanFromFiles.mockImplementation(() => Promise.resolve(structuredClone(planState)));
  mockSaveImplementationPlanToFiles.mockImplementation((_specDir: string, plan: typeof planState) => {
    planState = structuredClone(plan);
    return Promise.resolve(undefined);
  });

  return {
    getPlanState: () => planState,
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
});
