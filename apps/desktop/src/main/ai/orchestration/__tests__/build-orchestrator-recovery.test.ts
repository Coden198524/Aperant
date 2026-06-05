import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockValidateAndNormalizeJsonFile = vi.fn();
const mockRewriteImplementationPlanFiles = vi.fn();
const mockIterateSubtasks = vi.fn();

async function readMockPlan(specDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await mockReadFile(`${specDir}/implementation_plan.md`);
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
  ImplementationPlanSchema: {
    safeParse: (plan: { phases?: Array<{ id?: string; phase?: number; subtasks?: unknown[] }> }) => {
      const valid = Array.isArray(plan?.phases) &&
        plan.phases.length > 0 &&
        plan.phases.every((phase) => (phase.id || phase.phase) && Array.isArray(phase.subtasks) && phase.subtasks.length > 0);
      return valid
        ? { success: true, data: plan }
        : { success: false, error: { issues: [{ message: 'Invalid implementation plan' }] } };
    },
  },
  ImplementationPlanOutputSchema: {},
  validateAndNormalizeJsonFile: (...args: unknown[]) => mockValidateAndNormalizeJsonFile(...args),
  validateImplementationPlanLanguage: vi.fn(() => []),
  repairJsonWithLLM: vi.fn(),
  buildValidationRetryPrompt: vi.fn(() => ''),
  IMPLEMENTATION_PLAN_SCHEMA_HINT: 'schema hint',
  writeImplementationPlanFiles: vi.fn(async (specDir: string, plan: unknown) => {
    await mockWriteFile(`${specDir}/implementation_plan.md`, JSON.stringify(plan));
    return { plan, split: false, totalSubtasks: 1, filesWritten: [`${specDir}/implementation_plan.md`] };
  }),
  rewriteImplementationPlanFiles: (...args: unknown[]) => mockRewriteImplementationPlanFiles(...args),
  loadImplementationPlanFromFiles: (specDir: string) => readMockPlan(specDir),
  saveImplementationPlanToFiles: vi.fn(async (specDir: string, plan: unknown) => {
    await mockWriteFile(`${specDir}/implementation_plan.md`, JSON.stringify(plan));
  }),
}));

vi.mock('../subtask-iterator', () => ({
  iterateSubtasks: (...args: unknown[]) => mockIterateSubtasks(...args),
}));

import { BuildOrchestrator } from '../build-orchestrator';
import { MMO_AGENT_PROFILE } from '../../config/project-agent-profile';
import type { SessionResult } from '../../session/types';
import type { ExecutionPhase } from '../../../../shared/constants/phase-protocol';

function makePlan(statuses: string[]): string {
  return JSON.stringify({
    phases: [
      {
        id: 'phase-1',
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

function makeTasks(statuses: string[], withSchedulingMetadata = true): string {
  const lines = [
    '# Tasks',
    '',
    'Feature: Test task',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
  ];
  statuses.forEach((status, index) => {
    const id = `1.${index + 1}`;
    lines.push(`  - [${status === 'completed' ? 'x' : ' '}] ${id} Subtask ${index + 1}`);
    lines.push(`    - Subtask ${index + 1}`);
    if (withSchedulingMetadata) {
      lines.push(`    - _Files to modify: src/file-${index + 1}.ts_`);
      lines.push(`    - _Depends on: ${index === 0 ? 'none' : `1.${index}`}_`);
      lines.push('    - _Verification: Run focused check_');
    }
    lines.push('');
  });
  return lines.join('\n');
}

function makePlanWithSchedulingMetadata(statuses: string[]): string {
  return JSON.stringify({
    phases: [
      {
        id: 'phase-1',
        name: 'phase-1',
        subtasks: statuses.map((status, index) => ({
          id: `subtask-${index + 1}`,
          description: `Subtask ${index + 1}`,
          status,
          files_to_modify: [`src/file-${index + 1}.ts`],
          depends_on: [],
          verification: { type: 'manual', run: 'Run focused check' },
        })),
      },
    ],
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

function makeForcePlanningOrchestrator(runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'))): BuildOrchestrator {
  return new BuildOrchestrator({
    specDir: '/spec',
    projectDir: '/project',
    generatePrompt: vi.fn().mockResolvedValue('prompt'),
    runSession,
    forcePlanning: true,
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
      if (path.endsWith('implementation_plan.md')) {
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

  it('injects compact coding recovery hints into retry prompts', async () => {
    let codingDone = false;
    const subtask = {
      id: 'subtask-1',
      description: 'Fix retry-aware coder behavior',
      status: 'pending' as const,
      filesToModify: ['src/retry.ts'],
    };

    mockIterateSubtasks.mockImplementation(async (iteratorConfig: {
      runSubtaskSession: (subtaskInfo: typeof subtask, attempt: number) => Promise<SessionResult>;
    }) => {
      await iteratorConfig.runSubtaskSession(subtask, 1);
      await iteratorConfig.runSubtaskSession(subtask, 2);
      codingDone = true;
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(codingDone ? makePlan(['completed']) : makePlan(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const generatePrompt = vi.fn().mockResolvedValue('base coder prompt');
    const runSession = vi.fn().mockImplementation(async (config: { phase: string; subtaskId?: string }) => {
      if (config.phase === 'coding' && config.subtaskId === 'subtask-1' && runSession.mock.calls.length === 1) {
        return {
          ...makeSessionResult('error'),
          stepsExecuted: 4,
          toolCallCount: 2,
          error: {
            code: 'tool_execution_error',
            message: 'Tool edit failed because target line no longer matched',
            retryable: true,
          },
        };
      }
      return makeSessionResult('completed');
    });

    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt,
      runSession,
    });

    const outcome = await orchestrator.run();
    const codingCalls = runSession.mock.calls
      .map(([config]) => config)
      .filter((config) => config.phase === 'coding');
    const retryPrompt = codingCalls[1]?.systemPrompt as string;
    const retryContext = generatePrompt.mock.calls[1]?.[2] as { recoveryHints?: string };

    expect(outcome.success).toBe(true);
    expect(retryContext.recoveryHints).toContain('Attempt 1 failed');
    expect(retryPrompt).toContain('## Previous Attempt Recovery');
    expect(retryPrompt).toContain('Tool edit failed because target line no longer matched');
    expect(retryPrompt).toContain('avoid the failing tool pattern');
  });

  it('runs QA when an existing plan is complete but no passed QA report exists', async () => {
    let reviewerRuns = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        return reviewerRuns > 0
          ? Promise.resolve('Status: PASSED')
          : Promise.reject(new Error('ENOENT'));
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
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'qa_reviewer')).toHaveLength(1);
    expect(phases).toContain('qa_review');
    expect(outcome.finalPhase).toBe('complete');
  });

  it('does not rerun QA when an existing complete plan already has a passed QA report', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve('Status: PASSED');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(runSession).not.toHaveBeenCalled();
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
      if (path.endsWith('implementation_plan.md')) {
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

  it('re-enters planning when an existing implementation_plan.md has no subtasks', async () => {
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
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(makeTasks(['pending']));
      }
      if (path.endsWith('implementation_plan.md')) {
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
      if (path.endsWith('implementation_plan.md')) {
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

  it('force-runs planning against an existing executable plan and stops before coding', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(makeTasks(['pending']));
      }
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['pending']));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);
    const phases: ExecutionPhase[] = [];
    const logs: string[] = [];
    orchestrator.on('phase-change', (phase) => phases.push(phase));
    orchestrator.on('log', (message) => logs.push(message));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(1);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(phases).toEqual(['planning']);
    expect(logs.some((log) => log.includes('Force planning requested'))).toBe(true);
  });

  it('continues planning when the main implementation plan becomes executable', async () => {
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
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(makeTasks(['pending']));
      }
      if (path.endsWith('implementation_plan.md')) {
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
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(logs.some(log => log.includes('Plan validation failed'))).toBe(false);
  });

  it('retries planning when no executable subtasks are available', async () => {
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
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(plannerRuns <= 1 ? '# Tasks\n\n- [ ] 1. Empty\n' : makeTasks(['pending']));
      }
      if (path.endsWith('implementation_plan.md')) {
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
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
  });

  it('retries planning when a concurrent standard plan lacks scheduling metadata', async () => {
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
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(plannerRuns <= 1
          ? makeTasks(['pending'], false)
          : makeTasks(['pending'], true));
      }
      if (path.endsWith('implementation_plan.md')) {
        if (plannerRuns <= 1) {
          return Promise.resolve(makePlan(['pending']));
        }
        return Promise.resolve(codingRuns > 0
          ? makePlanWithSchedulingMetadata(['completed'])
          : makePlanWithSchedulingMetadata(['pending']));
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
    const logs: string[] = [];
    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      forcePlanning: true,
      runtimeConcurrency: {
        mode: 'concurrent',
        workers: 2,
        unit: 'work_item',
        conflictPolicy: 'lock-and-queue',
      },
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession,
    });
    orchestrator.on('log', (message) => logs.push(message));

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(2);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(logs.some((log) => log.includes('missing _Depends on'))).toBe(true);
  });

  it('uses MMO profile agents for planning and QA phases', async () => {
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
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(makeTasks(['pending']));
      }
      if (path.endsWith('implementation_plan.md')) {
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
      if (config.agentType === 'mmo_system_designer') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      agentProfile: MMO_AGENT_PROFILE,
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession,
    });

    const outcome = await orchestrator.run();
    const agentTypes = runSession.mock.calls.map(([config]) => config.agentType);

    expect(outcome.success).toBe(true);
    expect(agentTypes).toContain('mmo_system_designer');
    expect(agentTypes).toContain('mmo_qa_reviewer');
    expect(agentTypes).not.toContain('planner');
    expect(agentTypes).not.toContain('qa_reviewer');
  });
});
