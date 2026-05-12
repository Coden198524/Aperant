import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockValidateAndNormalizeJsonFile = vi.fn();
const mockRewriteImplementationPlanFiles = vi.fn();
const mockIterateSubtasks = vi.fn();

async function readMockPlan(specDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await mockReadFile(`${specDir}/implementation_plan.json`);
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
  validateImplementationPlanLanguage: vi.fn(() => []),
  repairJsonWithLLM: vi.fn(),
  buildValidationRetryPrompt: vi.fn(() => ''),
  IMPLEMENTATION_PLAN_SCHEMA_HINT: 'schema hint',
  writeImplementationPlanFiles: vi.fn(async (specDir: string, plan: unknown) => {
    await mockWriteFile(`${specDir}/implementation_plan.json`, JSON.stringify(plan));
    return { plan, split: false, totalSubtasks: 1, filesWritten: [`${specDir}/implementation_plan.json`] };
  }),
  rewriteImplementationPlanFiles: (...args: unknown[]) => mockRewriteImplementationPlanFiles(...args),
  loadImplementationPlanFromFiles: (specDir: string) => readMockPlan(specDir),
  saveImplementationPlanToFiles: vi.fn(async (specDir: string, plan: unknown) => {
    await mockWriteFile(`${specDir}/implementation_plan.json`, JSON.stringify(plan));
  }),
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

function makeAggressiveOrchestrator(runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'))): BuildOrchestrator {
  return new BuildOrchestrator({
    specDir: '/spec',
    projectDir: '/project',
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
    workflowConfig: {
      optimizationLevel: 'aggressive',
      skipAIQAReview: true,
      maxPlanningRetries: 1,
      maxSubtaskRetries: 2,
      maxQACycles: 1,
      maxSpecPhaseRetries: 1,
      qualityChecks: {
        enableSmokeTests: false,
        enablePatternInjection: false,
        enableSelfCritique: false,
        enablePreImplementationChecklist: false,
        enableTieredQualityStandards: false,
      },
      specCreationMode: 'unified',
    },
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
    mockRewriteImplementationPlanFiles.mockReset().mockResolvedValue(null);
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

  it('re-enters planning when an existing implementation_plan.json has no subtasks', async () => {
    let plannerRuns = 0;
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
        if (plannerRuns === 0) {
          return Promise.resolve(JSON.stringify({ phases: [] }));
        }
        return Promise.resolve(codingRuns > 0 ? makePlan(['completed']) : makePlan(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = makeOrchestrator(runSession);
    const phases: ExecutionPhase[] = [];
    orchestrator.on('phase-change', (phase) => phases.push(phase));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(runSession.mock.calls.some(([config]) => config.agentType === 'planner')).toBe(true);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(phases[0]).toBe('planning');
    expect(phases).toContain('coding');
    expect(phases).toContain('qa_review');
  });

  it('skips planner in aggressive mode when quick plan already has executable subtasks', async () => {
    let codingRuns = 0;
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.json')) {
        return Promise.resolve(codingRuns > 0 ? makePlan(['completed']) : makePlan(['pending']));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockIterateSubtasks.mockImplementation(async () => {
      codingRuns++;
      return {
      totalSubtasks: 1,
      completedSubtasks: 1,
      stuckSubtasks: [],
      cancelled: false,
      };
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeAggressiveOrchestrator(runSession);
    const logs: string[] = [];
    orchestrator.on('log', (message) => logs.push(message));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(runSession.mock.calls.some(([config]) => config.agentType === 'planner')).toBe(false);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(logs.some(log => log.includes('skipping planner session'))).toBe(true);
  });

  it('continues planning when split rewrite fails but the main implementation plan is executable', async () => {
    let plannerRuns = 0;
    let codingRuns = 0;

    mockRewriteImplementationPlanFiles
      .mockRejectedValueOnce(new Error('EACCES: failed to write implementation_plan.phase-1.json'));

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
        if (plannerRuns === 0) {
          return Promise.resolve(JSON.stringify({ phases: [] }));
        }
        return Promise.resolve(codingRuns > 0 ? makePlan(['completed']) : makePlan(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = makeOrchestrator(runSession);
    const logs: string[] = [];
    orchestrator.on('log', (message) => logs.push(message));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(1);
    expect(mockRewriteImplementationPlanFiles).toHaveBeenCalledTimes(1);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(logs.some(log => log.includes('Planning file rewrite failed'))).toBe(true);
    expect(logs.some(log => log.includes('main implementation_plan.json is executable'))).toBe(true);
  });

  it('retries planning when split rewrite fails and no executable subtasks are available', async () => {
    let plannerRuns = 0;
    let codingRuns = 0;

    mockRewriteImplementationPlanFiles
      .mockRejectedValueOnce(new Error('EACCES: failed to write implementation_plan.phase-1.json'))
      .mockResolvedValue(null);

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
        if (plannerRuns <= 1) {
          return Promise.resolve(JSON.stringify({ phases: [] }));
        }
        return Promise.resolve(codingRuns > 0 ? makePlan(['completed']) : makePlan(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(2);
    expect(mockRewriteImplementationPlanFiles).toHaveBeenCalledTimes(2);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
  });
});
