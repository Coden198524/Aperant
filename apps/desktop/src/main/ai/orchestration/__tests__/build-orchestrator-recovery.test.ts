import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockValidateAndNormalizeJsonFile = vi.fn();
const mockIterateSubtasks = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
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

vi.mock('../../schema', () => ({
  ImplementationPlanSchema: {},
  ImplementationPlanOutputSchema: {},
  validateAndNormalizeJsonFile: (...args: unknown[]) => mockValidateAndNormalizeJsonFile(...args),
  repairJsonWithLLM: vi.fn(),
  buildValidationRetryPrompt: vi.fn(() => ''),
  IMPLEMENTATION_PLAN_SCHEMA_HINT: 'schema hint',
}));

vi.mock('../subtask-iterator', () => ({
  iterateSubtasks: (...args: unknown[]) => mockIterateSubtasks(...args),
}));

import { BuildOrchestrator } from '../build-orchestrator';
import type { SessionResult } from '../../session/types';
import type { ExecutionPhase } from '../../../../shared/constants/phase-protocol';

function makePlan(statuses: string[]): string {
  return JSON.stringify({
    phases: [
      {
        name: 'phase-1',
        subtasks: statuses.map((status, index) => ({
          id: `subtask-${index + 1}`,
          description: `Subtask ${index + 1}`,
          status,
        })),
      },
    ],
  });
}

function makeSessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    durationMs: 1,
    toolCallCount: 0,
  };
}

function makeOrchestrator(runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'))): BuildOrchestrator {
  return new BuildOrchestrator({
    specDir: '/spec',
    projectDir: '/project',
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
  });
}

describe('BuildOrchestrator QA recovery', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockValidateAndNormalizeJsonFile.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
    });
    mockIterateSubtasks.mockReset();
  });

  it('continues coding instead of failing when subtasks remain after a coding pass', async () => {
    let codingRuns = 0;

    mockIterateSubtasks.mockImplementation(async () => {
      codingRuns++;
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(codingRuns >= 2 ? makePlan(['completed']) : makePlan(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeOrchestrator(runSession);
    const phases: ExecutionPhase[] = [];
    orchestrator.on('phase-change', (phase) => phases.push(phase));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(2);
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(runSession.mock.calls[0]?.[0]?.agentType).toBe('qa_reviewer');
    expect(phases.filter((phase) => phase === 'coding')).toHaveLength(2);
    expect(phases).toContain('qa_review');
    expect(outcome.finalPhase).toBe('complete');
  });

  it('returns from QA to coding when QA detects incomplete subtasks', async () => {
    let codingRuns = 0;
    let reviewerRuns = 0;

    mockIterateSubtasks.mockImplementation(async () => {
      codingRuns++;
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        if (codingRuns === 0) {
          return Promise.resolve(makePlan(['pending']));
        }
        if (codingRuns === 1 && reviewerRuns === 0) {
          return Promise.resolve(makePlan(['completed']));
        }
        if (codingRuns === 1 && reviewerRuns >= 1) {
          return Promise.resolve(makePlan(['pending']));
        }
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve(reviewerRuns >= 2 ? 'Status: PASSED' : 'Status: FAILED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = makeOrchestrator(runSession);
    const phases: ExecutionPhase[] = [];
    orchestrator.on('phase-change', (phase) => phases.push(phase));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(2);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'qa_reviewer')).toHaveLength(2);
    expect(mockUnlink).toHaveBeenCalled();

    const firstQa = phases.indexOf('qa_review');
    const recoveryCoding = phases.indexOf('coding', firstQa + 1);
    const secondQa = phases.indexOf('qa_review', recoveryCoding + 1);

    expect(firstQa).toBeGreaterThanOrEqual(0);
    expect(recoveryCoding).toBeGreaterThan(firstQa);
    expect(secondQa).toBeGreaterThan(recoveryCoding);
    expect(outcome.finalPhase).toBe('complete');
  });
});
