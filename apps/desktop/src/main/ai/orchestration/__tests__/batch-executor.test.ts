import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBatches } from '../batch-executor';
import type { BatchExecutorConfig } from '../batch-executor';
import type { SessionResult } from '../../session/types';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockRename = vi.fn();
const mockUnlink = vi.fn();
const mockUpdatePlanFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('../../../ipc-handlers/task/plan-file-utils', () => ({
  updatePlanFile: (...args: unknown[]) => mockUpdatePlanFile(...args),
}));

vi.mock('../../utils/json-repair', () => ({
  safeParseJson: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
}));

function makeSessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [],
    durationMs: 1000,
    toolCallCount: 5,
  };
}

function createPlan(statuses: string[]) {
  return {
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: statuses.map((status, index) => ({
          id: `subtask-${index + 1}`,
          title: `Subtask ${index + 1}`,
          description: `Test subtask ${index + 1}`,
          status,
          files_to_create: [`test-${index + 1}.ts`],
          files_to_modify: [],
          pattern_files: [],
          verification: 'Run tests',
        })),
      },
    ],
  };
}

function setupPlanState(initialStatuses: string[]) {
  let planState = createPlan(initialStatuses);

  mockReadFile.mockImplementation((path: string) => {
    if (path.endsWith('implementation_plan.json')) {
      return Promise.resolve(JSON.stringify(planState));
    }
    return Promise.reject(new Error('ENOENT'));
  });

  mockWriteFile.mockImplementation((path: string, content: string) => {
    if (path.includes('implementation_plan.json')) {
      planState = JSON.parse(content) as typeof planState;
    }
    return Promise.resolve(undefined);
  });

  mockUpdatePlanFile.mockImplementation((path: string, updater: (plan: typeof planState) => typeof planState) => {
    if (path.endsWith('implementation_plan.json')) {
      const nextPlan = updater(structuredClone(planState));
      planState = nextPlan;
      return Promise.resolve(nextPlan);
    }
    return Promise.resolve(null);
  });

  return {
    getPlanState: () => planState,
    updateStatuses: (subtaskIds: string[], status: string) => {
      const targetIds = new Set(subtaskIds);
      planState = {
        ...planState,
        phases: planState.phases.map((phase) => ({
          ...phase,
          subtasks: phase.subtasks.map((subtask) => (
            targetIds.has(subtask.id)
              ? { ...subtask, status }
              : subtask
          )),
        })),
      };
    },
  };
}

function createConfig(
  overrides: Partial<BatchExecutorConfig> = {},
): BatchExecutorConfig {
  return {
    specDir: '/spec',
    projectDir: '/project',
    maxRetries: 2,
    batchSize: 3,
    executionMode: 'batch',
    maxConcurrentSubtasks: 3,
    runSubtaskSession: vi.fn().mockResolvedValue(makeSessionResult('completed')),
    ...overrides,
  };
}

describe('executeBatches', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockRename.mockReset();
    mockUnlink.mockReset();
    mockUpdatePlanFile.mockReset();
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  it('executes an entire batch in a single session and completes the round', async () => {
    const { getPlanState, updateStatuses } = setupPlanState(['pending', 'pending']);
    const runSubtaskSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>) => {
      updateStatuses(batch.map((subtask) => subtask.id), 'completed');
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({ runSubtaskSession, runBatchSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(2);
    expect(result.totalFailed).toBe(0);
    expect(runBatchSession).toHaveBeenCalledTimes(1);
    expect(runBatchSession.mock.calls[0]?.[0]?.map((subtask: { id: string }) => subtask.id)).toEqual([
      'subtask-1',
      'subtask-2',
    ]);
    expect(runSubtaskSession).not.toHaveBeenCalled();
    expect(
      getPlanState().phases[0].subtasks.every((subtask) => subtask.status === 'completed'),
    ).toBe(true);
  });

  it('retries only unfinished subtasks after a partial batch session', async () => {
    const { updateStatuses } = setupPlanState(['pending', 'pending']);
    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>, attempt: number) => {
      if (attempt === 0) {
        updateStatuses(['subtask-1'], 'completed');
        return makeSessionResult('max_steps');
      }

      updateStatuses(batch.map((subtask) => subtask.id), 'completed');
      return makeSessionResult('completed');
    });
    const runSubtaskSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));

    const result = await executeBatches(createConfig({
      runSubtaskSession,
      runBatchSession,
    }));

    expect(result.success).toBe(true);
    expect(runBatchSession).toHaveBeenCalledTimes(2);
    expect(runBatchSession.mock.calls[0]?.[0]?.map((subtask: { id: string }) => subtask.id)).toEqual([
      'subtask-1',
      'subtask-2',
    ]);
    expect(runBatchSession.mock.calls[1]?.[0]?.map((subtask: { id: string }) => subtask.id)).toEqual([
      'subtask-2',
    ]);
    expect(result.totalCompleted).toBe(2);
  });

  it('keeps legacy shared batch sessions grouped by batch size', async () => {
    const { updateStatuses } = setupPlanState(['pending', 'pending', 'pending']);
    const runSubtaskSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>) => {
      updateStatuses(batch.map((subtask) => subtask.id), 'completed');
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 3,
      maxConcurrentSubtasks: 2,
      runSubtaskSession,
      runBatchSession,
    }));

    expect(result.success).toBe(true);
    expect(runBatchSession).toHaveBeenCalledTimes(1);
    expect(runBatchSession.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('runs independent subtasks concurrently when no batch session handler is provided', async () => {
    const { updateStatuses } = setupPlanState(['pending', 'pending']);
    let inFlight = 0;
    let maxInFlight = 0;

    const runSubtaskSession = vi.fn().mockImplementation(async (subtask: { id: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      updateStatuses([subtask.id], 'completed');
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 2,
      maxConcurrentSubtasks: 2,
      runBatchSession: undefined,
      runSubtaskSession,
    }));

    expect(result.success).toBe(true);
    expect(runSubtaskSession).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(2);
  });

  it('serializes conflicting subtasks when using parallel subtask sessions', async () => {
    let planState = {
      phases: [
        {
          id: 'phase-1',
          name: 'Phase 1',
          subtasks: [
            {
              id: 'subtask-1',
              title: 'Subtask 1',
              description: 'Test subtask 1',
              status: 'pending',
              files_to_create: [],
              files_to_modify: ['shared.ts'],
              pattern_files: [],
              verification: 'Run tests',
            },
            {
              id: 'subtask-2',
              title: 'Subtask 2',
              description: 'Test subtask 2',
              status: 'pending',
              files_to_create: [],
              files_to_modify: ['shared.ts'],
              pattern_files: [],
              verification: 'Run tests',
            },
          ],
        },
      ],
    };

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(JSON.stringify(planState));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation((path: string, content: string) => {
      if (path.includes('implementation_plan.json')) {
        planState = JSON.parse(content) as typeof planState;
      }
      return Promise.resolve(undefined);
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const runSubtaskSession = vi.fn().mockImplementation(async (subtask: { id: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      for (const phase of planState.phases) {
        for (const planSubtask of phase.subtasks) {
          if (planSubtask.id === subtask.id) {
            planSubtask.status = 'completed';
          }
        }
      }
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 2,
      maxConcurrentSubtasks: 2,
      runBatchSession: undefined,
      runSubtaskSession,
    }));

    expect(result.success).toBe(true);
    expect(runSubtaskSession).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it('caps auto batch sizing at four subtasks per batch', async () => {
    const { updateStatuses } = setupPlanState(new Array(11).fill('pending'));
    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>) => {
      updateStatuses(batch.map((subtask) => subtask.id), 'completed');
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 'auto',
      maxConcurrentSubtasks: 99,
      runBatchSession,
    }));

    expect(result.success).toBe(true);
    expect(runBatchSession).toHaveBeenCalledTimes(3);
    expect(runBatchSession.mock.calls[0]?.[0]).toHaveLength(4);
    expect(runBatchSession.mock.calls[1]?.[0]).toHaveLength(4);
    expect(runBatchSession.mock.calls[2]?.[0]).toHaveLength(3);
  });

  it('resets stale in_progress subtasks before applying the capped batch size', async () => {
    const { getPlanState, updateStatuses } = setupPlanState(new Array(11).fill('in_progress'));
    const observedInProgressCounts: number[] = [];

    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>) => {
      const inProgressCount = getPlanState().phases[0].subtasks.filter((subtask) => subtask.status === 'in_progress').length;
      observedInProgressCounts.push(inProgressCount);
      updateStatuses(batch.map((subtask) => subtask.id), 'completed');
      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 'auto',
      maxConcurrentSubtasks: 99,
      runBatchSession,
    }));

    expect(result.success).toBe(true);
    expect(observedInProgressCounts).toEqual([4, 4, 3]);
  });

  it('clears stray in_progress subtasks from the previous batch before starting the next batch', async () => {
    const { getPlanState, updateStatuses } = setupPlanState(new Array(11).fill('pending'));
    const observedInProgressCounts: number[] = [];
    let batchInvocation = 0;

    const runBatchSession = vi.fn().mockImplementation(async (batch: Array<{ id: string }>) => {
      const inProgressCount = getPlanState().phases[0].subtasks.filter((subtask) => subtask.status === 'in_progress').length;
      observedInProgressCounts.push(inProgressCount);
      batchInvocation++;

      updateStatuses(batch.map((subtask) => subtask.id), 'completed');

      // Simulate the previous batch accidentally leaving one future subtask marked active.
      if (batchInvocation < 3) {
        updateStatuses(['subtask-11'], 'in_progress');
      }

      return makeSessionResult('completed');
    });

    const result = await executeBatches(createConfig({
      batchSize: 'auto',
      maxConcurrentSubtasks: 99,
      runBatchSession,
    }));

    expect(result.success).toBe(true);
    expect(observedInProgressCounts).toEqual([4, 4, 3]);
  });

  it('returns early when no pending subtasks remain', async () => {
    setupPlanState(['completed']);
    const runSubtaskSession = vi.fn();

    const result = await executeBatches(createConfig({ runSubtaskSession }));

    expect(result.success).toBe(true);
    expect(result.totalCompleted).toBe(0);
    expect(runSubtaskSession).not.toHaveBeenCalled();
  });

  it('handles cancellation before starting work', async () => {
    setupPlanState(['pending']);

    const abortController = new AbortController();
    abortController.abort();
    const runSubtaskSession = vi.fn();

    const result = await executeBatches(createConfig({
      abortSignal: abortController.signal,
      runSubtaskSession,
    }));

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(runSubtaskSession).not.toHaveBeenCalled();
  });
});
