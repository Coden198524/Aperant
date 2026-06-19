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

import { BuildOrchestrator, formatPreQAReturnToCodingReason } from '../build-orchestrator';
import { MMO_AGENT_PROFILE } from '../../config/project-agent-profile';
import type { SessionResult } from '../../session/types';
import type { ExecutionPhase } from '../../../../shared/constants/phase-protocol';

const STANDARD_SPEC_MD = [
  '# Test task',
  '',
  '## Evidence',
  '',
  '- spec.md test fixture proves task scope.',
  '',
  '## Requirements',
  '',
  '- Subtask 1 is complete and satisfies the fixture requirement.',
  '',
].join('\n');
const STANDARD_REQUIREMENTS_MD = [
  '# Requirements',
  '',
  '## Evidence Sources',
  '',
  '- spec.md test fixture proves requirements.',
  '',
].join('\n');
const STANDARD_CONTEXT_MD = [
  '# Project Context',
  '',
  '## Files To Modify',
  '',
  '- src/file-1.ts',
  '',
  '## Evidence Sources',
  '',
  '- spec.md - test fixture proves context.',
  '',
].join('\n');

function readStandardArtifactOrReject(filePath: string): Promise<string> {
  if (filePath.endsWith('spec.md')) {
    return Promise.resolve(STANDARD_SPEC_MD);
  }
  if (filePath.endsWith('requirements.md')) {
    return Promise.resolve(STANDARD_REQUIREMENTS_MD);
  }
  if (filePath.endsWith('context.md')) {
    return Promise.resolve(STANDARD_CONTEXT_MD);
  }
  return Promise.reject(new Error('ENOENT'));
}

function makePlan(statuses: string[], withSchedulingMetadata = true): string {
  return JSON.stringify({
    phases: [
      {
        id: 'phase-1',
        name: 'phase-1',
        subtasks: statuses.map((status, index) => ({
          id: `subtask-${index + 1}`,
          description: `Subtask ${index + 1}`,
          status,
          ...(withSchedulingMetadata
            ? {
                depends_on: [],
                evidence: `spec.md Subtask ${index + 1}`,
                verification: { type: 'manual', run: 'Run focused check' },
              }
            : {}),
        })),
      },
    ],
  });
}

function makePlanWithoutSchedulingMetadata(statuses: string[]): string {
  return makePlan(statuses, false);
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

function makePassedQAReport(): string {
  return [
    '# QA Report',
    '',
    'Status: PASSED',
    '',
    '## Scope Reviewed',
    '- Reviewed `spec.md`, `requirements.md`, `implementation_plan.md`, `tasks.md`, and changed source path `src/file-1.ts` for the completed test fixture.',
    '',
    '## Changed Files And Contracts',
    '| File | Contract / Boundary | Result |',
    '| --- | --- | --- |',
    '| `src/file-1.ts` | Public API, data flow, side effects, and error behavior remain compatible with the planned implementation contract. | passed |',
    '',
    '## Acceptance Matrix',
    '| Requirement | Evidence | Verification | Result |',
    '| --- | --- | --- | --- |',
    '| Subtask 1 is complete and satisfies the fixture requirement. | `tasks.md` Evidence metadata, `implementation_plan.md` completion, `src/file-1.ts` changed source. | Manual static check: Run focused check. | passed |',
    '',
    '## Verification',
    '- Manual/static check: inspected `src/file-1.ts` against the completed plan and fixture requirement.',
    '- Automated tests not run in this unit fixture; the mocked check path is documented as the verification limitation.',
    '',
    '## Findings',
    '- No blocking issues remain.',
    '',
    '## Residual Risks',
    '- No residual risks beyond this mocked unit fixture not exercising a real project command.',
  ].join('\n');
}

function makeFailedQAReport(): string {
  return [
    '# QA Report',
    '',
    'Status: FAILED',
    '',
    '## Scope Reviewed',
    '- Reviewed `spec.md`, `requirements.md`, `implementation_plan.md`, `tasks.md`, and changed source path `src/file-1.ts`.',
    '',
    '## Changed Files And Contracts',
    '| File | Contract / Boundary | Result |',
    '| --- | --- | --- |',
    '| `src/file-1.ts` | Planned behavior contract is incomplete. | failed |',
    '',
    '## Acceptance Matrix',
    '| Requirement | Evidence | Verification | Result |',
    '| --- | --- | --- | --- |',
    '| Subtask 1 remains incomplete. | `tasks.md` Evidence metadata and `src/file-1.ts`. | Manual static check. | failed |',
    '',
    '## Verification',
    '- Manual/static check: inspected the fixture state and found incomplete behavior.',
    '',
    '## Findings',
    '### Missing implementation',
    '- **Severity**: high',
    '- **Location**: `src/file-1.ts`',
    '- **Evidence**: the planned behavior is not complete.',
    '- **Impacted requirement/contract**: Subtask 1 requirement and source contract.',
    '- **Required fix**: Complete the implementation in `src/file-1.ts`.',
    '- **Re-verification**: rerun the focused static check.',
    '',
    '## Residual Risks',
    '- Risk remains until the missing implementation is fixed and re-verified.',
  ].join('\n');
}

function makeMmoPassedQAReport(): string {
  return [
    '# QA Report',
    '',
    'Status: PASSED',
    '',
    '## Scope Reviewed',
    '- Reviewed `server/combat/CombatService.cpp`, `client/combat/CombatView.cpp`, `config/items/skills.xml`, and `tools/gm/CombatInspector.cs` for the MMO fixture.',
    '',
    '## MMO Domain Matrix',
    '| Domain | Source/config paths | Authority / contract | Result |',
    '| --- | --- | --- | --- |',
    '| Server authority | `server/combat/CombatService.cpp` | Server authoritative validation and trust boundary preserved. | passed |',
    '| Network sync/protocol | `client/combat/CombatView.cpp` | Replication, prediction, and reconciliation assumptions unchanged. | passed |',
    '| Persistence/data/config | `config/items/skills.xml` | Save/config data contract remains compatible. | passed |',
    '| Tools/content/liveops/release | `tools/gm/CombatInspector.cs` | Tooling, telemetry, rollout, and release inspection remain compatible. | passed |',
    '',
    '## Changed Files And Contracts',
    '- Gameplay/client, server authority, protocol, persistence, data/config, tooling, performance, security/anti-cheat, and liveops contracts were reviewed.',
    '',
    '## Acceptance Matrix',
    '| Requirement | Evidence | Verification | Result |',
    '| --- | --- | --- | --- |',
    '| MMO fixture implementation is complete. | `tasks.md`, `server/combat/CombatService.cpp`, `client/combat/CombatView.cpp`, and `config/items/skills.xml`. | Targeted MMO static review. | passed |',
    '',
    '## Verification',
    '- Manual/static check: reviewed authority, sync/protocol, persistence, performance budget, security/anti-cheat, tooling, telemetry, liveops, and release risk paths.',
    '',
    '## Findings',
    '- No blocking issues remain.',
    '',
    '## Residual Risks',
    '- No residual risks beyond this mocked unit fixture not exercising production bandwidth or rollout infrastructure.',
  ].join('\n');
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
      lines.push(`    - _Requirements: 1.${index + 1}_`);
      lines.push(`    - _Evidence: spec.md Subtask ${index + 1}_`);
      lines.push(`    - _Done when: Subtask ${index + 1} is implemented and the focused check passes_`);
      lines.push('    - _Verification: Run focused check_');
    }
    lines.push('');
  });
  return lines.join('\n');
}

function makeBroadTasks(): string {
  return [
    '# Tasks',
    '',
    'Feature: Test task',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Broad implementation',
    '',
    '  - [ ] 1.1 Build complete browser game loop',
    '    - Create src/game.js to implement board state, piece spawning, random generation, automatic falling, left/right movement, rotation, soft drop, hard drop, collision detection, locking, line clearing, scoring, levels, pause, restart, and game-over transitions.',
    '    - _Files to modify: src/game.js_',
    '    - _Depends on: none_',
    '    - _Requirements: R1, R2, R3, R4, AC1, AC2_',
    '    - _Evidence: spec.md browser game requirements_',
    '    - _Done when: the browser game loop supports movement, scoring, pause, restart, and game over._',
    '    - _Verification: Run focused gameplay check_',
    '',
  ].join('\n');
}

function makeVagueEvidenceTasks(): string {
  return [
    '# Tasks',
    '',
    'Feature: Test task',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Static page',
    '',
    '  - [ ] 1.1 Create browser entry files',
    '    - Create index.html, styles.css, and script.js entry files for the browser game shell.',
    '    - _Files to modify: index.html, styles.css, script.js_',
    '    - _Depends on: none_',
    '    - _Requirements: R1, AC1_',
    '    - _Evidence: user request_',
    '    - _Done when: the browser opens the page shell without missing-resource errors._',
    '    - _Verification: Open index.html manually_',
    '',
  ].join('\n');
}

function makePhaseHeadingDependencyTasks(): string {
  return [
    '# Tasks',
    '',
    'Feature: Test task',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Static app shell',
    '',
    '  - [ ] 1.1 Create semantic HTML shell',
    '    - Add the primary page structure.',
    '    - _Files to modify: index.html_',
    '    - _Depends on: 1_',
    '    - _Requirements: R1, AC1_',
    '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
    '    - _Done when: index.html contains the expected page shell._',
    '    - _Verification: inspect index.html_',
    '',
    '  - [ ] 1.2 Add responsive layout',
    '    - Add CSS after the shell exists.',
    '    - _Files to modify: styles.css_',
    '    - _Depends on: 1_',
    '    - _Requirements: R2, AC2_',
    '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
    '    - _Done when: styles.css renders the shell readably._',
    '    - _Verification: inspect styles.css_',
    '',
    '- [ ] 2. Game rules',
    '',
    '  - [ ] 2.1 Implement board state',
    '    - Add board state after shell work finishes.',
    '    - _Files to modify: src/game.js_',
    '    - _Depends on: 1_',
    '    - _Requirements: R3, AC3_',
    '    - _Evidence: spec.md R3; requirements.md Evidence Sources_',
    '    - _Done when: src/game.js can represent a board._',
    '    - _Verification: inspect board state_',
    '',
    '  - [ ] 2.2 Wire keyboard input',
    '    - Add keyboard input after board state exists.',
    '    - _Files to modify: src/game.js_',
    '    - _Depends on: 2.1_',
    '    - _Requirements: R4, AC4_',
    '    - _Evidence: spec.md R4; requirements.md Evidence Sources_',
    '    - _Done when: keyboard input changes game state._',
    '    - _Verification: test keyboard controls_',
    '',
    '- [ ] 3. End-to-end verification',
    '  - Validate the browser flow.',
    '  - _Files to modify: none_',
    '  - _Depends on: 2_',
    '  - _Requirements: AC1, AC2, AC3, AC4_',
    '  - _Evidence: spec.md Acceptance Criteria; requirements.md Evidence Sources_',
    '  - _Done when: the complete browser flow is verified._',
    '  - _Verification: run the browser smoke test_',
    '',
  ].join('\n');
}

function makePlanWithSchedulingMetadata(statuses: string[]): string {
  return makePlan(statuses, true);
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

  it('compacts long pre-QA failure details before returning to coding', () => {
    const issues = Array.from({ length: 12 }, (_, index) => (
      `quality-check-${index + 1}: ${'very long command output with repeated diagnostics '.repeat(20)}`
    ));

    const reason = formatPreQAReturnToCodingReason(issues, 1, 2);

    expect(reason).toContain('Pre-QA quality checks failed (attempt 1/2)');
    expect(reason).toContain('quality-check-1');
    expect(reason).toContain('6 more error(s) omitted');
    expect(reason).toContain('[truncated');
    expect(reason).not.toContain('quality-check-12');
    expect(reason.length).toBeLessThanOrEqual(1_800);
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
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
          ? Promise.resolve(makePassedQAReport())
          : Promise.reject(new Error('ENOENT'));
      }
      return readStandardArtifactOrReject(path);
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

  it('retries QA reviewer without running fixer when the QA verdict is unknown', async () => {
    let reviewerRuns = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        if (reviewerRuns === 0) {
          return Promise.reject(new Error('ENOENT'));
        }
        return Promise.resolve(reviewerRuns >= 2 ? makePassedQAReport() : '# QA Report\n\nReviewer forgot status.');
      }
      return readStandardArtifactOrReject(path);
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
      }
      return makeSessionResult('completed');
    });

    const orchestrator = makeOrchestrator(runSession);
    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'qa_reviewer')).toHaveLength(2);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'qa_fixer')).toHaveLength(0);
    expect(mockUnlink.mock.calls.map(([filePath]) => String(filePath).replace(/\\/g, '/')))
      .toContain('/spec/qa_report.md');
  });

  it('does not rerun QA when an existing complete plan already has a passed QA report', async () => {
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(runSession).not.toHaveBeenCalled();
    expect(outcome.finalPhase).toBe('complete');
  });

  it('reruns QA when an existing passed QA report lacks review evidence', async () => {
    let reviewerRuns = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlan(['completed']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve(reviewerRuns > 0 ? makePassedQAReport() : 'Status: PASSED');
      }
      return readStandardArtifactOrReject(path);
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'qa_reviewer')).toHaveLength(1);
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
        return Promise.resolve(reviewerRuns >= 2 ? makePassedQAReport() : makeFailedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
      return readStandardArtifactOrReject(path);
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
      return readStandardArtifactOrReject(path);
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
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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

  it('does not block planning when context artifact is absent after evidence-backed planning', async () => {
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
      if (path.endsWith('context.md')) {
        return Promise.reject(new Error('ENOENT'));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).not.toContain('context.md is missing');
    expect(logs.join('\n')).not.toContain('Requirements section must cite Evidence');
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
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
          return Promise.resolve(makePlanWithoutSchedulingMetadata(['pending']));
        }
        return Promise.resolve(codingRuns > 0
          ? makePlanWithSchedulingMetadata(['completed'])
          : makePlanWithSchedulingMetadata(['pending']));
      }
      if (path.endsWith('qa_report.md')) {
        return Promise.resolve(makePassedQAReport());
      }
      return readStandardArtifactOrReject(path);
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });
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

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(2);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('continues from repaired Standard artifacts when planner retry times out with only granularity warnings', async () => {
    let plannerRuns = 0;
    const files = new Map<string, string>([
      [
        '/spec/spec.md',
        [
          '# Test task',
          '',
          '## Requirements',
          '',
          '- R1: Build a browser game with movement, scoring, pause, restart, and game-over behavior.',
          '',
        ].join('\n'),
      ],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/tasks.md', makeBroadTasks()],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
    ]);

    const normalizePath = (path: string) => path.replace(/\\/g, '/');
    mockReadFile.mockImplementation((path: string) => {
      const normalizedPath = normalizePath(path);
      if (files.has(normalizedPath)) {
        return Promise.resolve(files.get(normalizedPath));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (path: string, content: unknown) => {
      files.set(normalizePath(path), String(content));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
        if (plannerRuns > 1) {
          return {
            ...makeSessionResult('error'),
            error: new Error('Stream inactivity timeout - no data received from provider for 120s'),
          };
        }
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.error).toBeUndefined();
    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(plannerRuns).toBe(2);
    expect(files.get('/spec/spec.md')).toContain('## Evidence');
    expect(files.get('/spec/implementation_plan.md')).toContain('Build complete browser game loop');
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('continues a new task into coding when planner retry times out after generating usable Standard artifacts', async () => {
    let plannerRuns = 0;
    let reviewerRuns = 0;
    const files = new Map<string, string>([
      [
        '/spec/spec.md',
        [
          '# Test task',
          '',
          '## Requirements',
          '',
          '- R1: Build a browser game with movement, scoring, pause, restart, and game-over behavior.',
          '',
        ].join('\n'),
      ],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/tasks.md', makeBroadTasks()],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
    ]);
    const normalizePath = (path: string) => path.replace(/\\/g, '/');

    mockReadFile.mockImplementation((path: string) => {
      const normalizedPath = normalizePath(path);
      if (files.has(normalizedPath)) {
        return Promise.resolve(files.get(normalizedPath));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (path: string, content: unknown) => {
      files.set(normalizePath(path), String(content));
    });
    mockIterateSubtasks.mockImplementation(async () => {
      const plan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{"phases":[]}') as {
        phases?: Array<{ subtasks?: Array<{ status?: string }> }>;
      };
      for (const phase of plan.phases ?? []) {
        for (const subtask of phase.subtasks ?? []) {
          subtask.status = 'completed';
        }
      }
      files.set('/spec/implementation_plan.md', JSON.stringify(plan));
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
        if (plannerRuns > 1) {
          return {
            ...makeSessionResult('error'),
            error: new Error('Stream inactivity timeout - no data received from provider for 120s'),
          };
        }
      }
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
        files.set('/spec/qa_report.md', makePassedQAReport());
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.error).toBeUndefined();
    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('complete');
    expect(plannerRuns).toBe(2);
    expect(reviewerRuns).toBe(1);
    expect(files.get('/spec/spec.md')).toContain('## Evidence');
    expect(files.get('/spec/implementation_plan.md')).toContain('"status":"completed"');
    expect(mockIterateSubtasks).toHaveBeenCalled();
  });

  it('repairs vague tasks.md evidence before deriving runtime work packages for a new task', async () => {
    let reviewerRuns = 0;
    const files = new Map<string, string>([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/tasks.md', makeVagueEvidenceTasks()],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
    ]);
    const normalizePath = (path: string) => path.replace(/\\/g, '/');

    mockReadFile.mockImplementation((path: string) => {
      const normalizedPath = normalizePath(path);
      if (files.has(normalizedPath)) {
        return Promise.resolve(files.get(normalizedPath));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (path: string, content: unknown) => {
      files.set(normalizePath(path), String(content));
    });
    mockIterateSubtasks.mockImplementation(async () => {
      const plan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{"phases":[]}') as {
        phases?: Array<{ subtasks?: Array<{ status?: string }> }>;
      };
      for (const phase of plan.phases ?? []) {
        for (const subtask of phase.subtasks ?? []) {
          subtask.status = 'completed';
        }
      }
      files.set('/spec/implementation_plan.md', JSON.stringify(plan));
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
        files.set('/spec/qa_report.md', makePassedQAReport());
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.error).toBeUndefined();
    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('complete');
    expect(reviewerRuns).toBe(1);
    expect(files.get('/spec/tasks.md')).toContain('spec.md Requirements');
    expect(files.get('/spec/tasks.md')).toContain('requirements.md Evidence Sources');
    expect(files.get('/spec/implementation_plan.md')).toContain('"status":"completed"');
    expect(mockIterateSubtasks).toHaveBeenCalled();
  });

  it('derives runtime work packages when tasks.md dependencies reference phase headings', async () => {
    let reviewerRuns = 0;
    const files = new Map<string, string>([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/tasks.md', makePhaseHeadingDependencyTasks()],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
    ]);
    const normalizePath = (path: string) => path.replace(/\\/g, '/');

    mockReadFile.mockImplementation((path: string) => {
      const normalizedPath = normalizePath(path);
      if (files.has(normalizedPath)) {
        return Promise.resolve(files.get(normalizedPath));
      }
      return Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (path: string, content: unknown) => {
      files.set(normalizePath(path), String(content));
    });
    mockIterateSubtasks.mockImplementation(async () => {
      const plan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{"phases":[]}') as {
        phases?: Array<{ subtasks?: Array<{ status?: string }> }>;
      };
      for (const phase of plan.phases ?? []) {
        for (const subtask of phase.subtasks ?? []) {
          subtask.status = 'completed';
        }
      }
      files.set('/spec/implementation_plan.md', JSON.stringify(plan));
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
        files.set('/spec/qa_report.md', makePassedQAReport());
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const implementationPlan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{"phases":[]}') as {
      phases?: Array<{ subtasks?: Array<{ upstream_task_ids?: string[] }> }>;
    };
    const upstreamTaskIds = implementationPlan.phases
      ?.flatMap((phase) => phase.subtasks ?? [])
      .flatMap((subtask) => subtask.upstream_task_ids ?? []) ?? [];

    expect(outcome.error).toBeUndefined();
    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('complete');
    expect(reviewerRuns).toBe(1);
    expect(upstreamTaskIds).toEqual(expect.arrayContaining(['1.1', '1.2', '2.1', '2.2', '3']));
    expect(files.get('/spec/implementation_plan.md')).toContain('"status":"completed"');
    expect(mockIterateSubtasks).toHaveBeenCalled();
  });

  it('does not replace the runtime plan when Standard quality fails during replanning', async () => {
    let plannerRuns = 0;

    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('tasks.md')) {
        return Promise.resolve(makeTasks(['pending'], false));
      }
      if (path.endsWith('implementation_plan.md')) {
        return Promise.resolve(makePlanWithSchedulingMetadata(['completed']));
      }
      return readStandardArtifactOrReject(path);
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        plannerRuns++;
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();

    expect(outcome.success).toBe(false);
    expect(plannerRuns).toBeGreaterThan(0);
    expect(mockWriteFile.mock.calls.some(([path]) =>
      String(path).endsWith('/implementation_plan.md')
    )).toBe(false);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
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
        return Promise.resolve(makeMmoPassedQAReport());
      }
      return readStandardArtifactOrReject(path);
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
