import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAutocodeDesignPackageFingerprint } from '@autocode/core/tasks/design-quality';
import {
  buildStandardDesignV5Fixture,
} from '../../../../../../../libs/core/src/tasks/standard-design-v5.test-fixture.js';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockUnlink = vi.fn();
const mockValidateAndNormalizeJsonFile = vi.fn();
const mockValidateImplementationPlanLanguage = vi.fn();
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
  rename: (...args: unknown[]) => mockRename(...args),
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
  validateImplementationPlanLanguage: (...args: unknown[]) => mockValidateImplementationPlanLanguage(...args),
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
  '## User Requirements',
  '',
  '- R1: Subtask 1 is complete and satisfies the fixture requirement.',
  '',
  '## Acceptance Criteria',
  '',
  '- AC1: The runtime work package is represented by a validated tasks.md item.',
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
const NON_IMPLEMENTATION_REQUIREMENTS_MD = [
  '# Requirements',
  '',
  'Requirements-Contract: 1',
  '',
  '## User Requirements',
  '',
  '- R1: Analyze the recorded task failure and produce an evidence-backed report.',
  '',
  '## Acceptance Criteria',
  '',
  '- AC1: The report explains the failure without modifying product code.',
  '',
  '## Evidence Sources',
  '',
  '- E1: task_logs.jsonl records the failure analyzed by this task.',
  '',
].join('\n');
const STRICT_STANDARD_SPEC_MD = [
  '# Specification: Incremental owner stages',
  '',
  'Specification-Contract: 1',
  '',
  '## Scope',
  '- In scope: update the requested observable behavior.',
  '- Non-goal: unrelated behavior.',
  '',
  '## SCN-001 Apply the requested behavior',
  'Covers: R1, AC1',
  'Evidence: E1',
  '',
  '- Given: the existing task is under review.',
  '- When: the approved change is planned.',
  '- Then: the updated behavior is represented by executable work.',
  '- Errors/edges: preserve unrelated completed work.',
  '',
  '## Verification Notes',
  '- Run the focused owner-stage regression test.',
  '',
].join('\n');

const STRICT_STANDARD_TASKS_MD = [
  '# Tasks',
  '',
  'Tasks-Contract: 1',
  'Feature: Incremental owner stages',
  'Workflow: feature',
  'Status: pending',
  '',
  '- [ ] 1. Incremental implementation',
  '',
  '  - [ ] 1.1 Apply the requested behavior',
  '    - Implement SCN-001 inside the existing workflow boundary.',
  '    - _Files to modify: src/file-1.ts_',
  '    - _Depends on: none_',
  '    - _Requirements: R1, AC1, SCN-001_',
  '    - _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_',
  '    - _Evidence: E1; src/file-1.ts existing workflow_',
  '    - _Done when: SCN-001 is represented by one focused work package_',
  '    - _Verification: npm test -- file-1.test.ts_',
  '',
].join('\n');

const NON_IMPLEMENTATION_TASKS_MD = [
  '# Tasks',
  '',
  'Tasks-Contract: 1',
  'Feature: Analyze task logs',
  'Workflow: analysis',
  'Status: pending',
  '',
  '- [ ] 1. Analysis report',
  '',
  '  - [ ] 1.1 Write the task-log analysis report',
  '    - Summarize the observed failure and cite the evidence without changing product code.',
  '    - _Files to create: docs/task-log-analysis.md_',
  '    - _Depends on: none_',
  '    - _Requirements: R1, AC1, SCN-001_',
  '    - _Evidence: E1; requirements.md R1; spec.md SCN-001_',
  '    - _Done when: docs/task-log-analysis.md explains the failure and evidence_',
  '    - _Verification: Review docs/task-log-analysis.md against requirements.md and spec.md_',
  '',
].join('\n');

function makeStandardPlanningChangeRequest(
  flowDocuments: string[],
  id = 'cr-owner-stages',
): string {
  return JSON.stringify({
    id,
    createdAt: '2026-07-14T00:00:00.000Z',
    scope: 'planning',
    impacts: [],
    iteration: {
      mode: 'standard-planning',
      flowDocuments,
    },
  }) + '\n';
}

const STANDARD_DESIGN_PACKAGE = buildStandardDesignV5Fixture();
const STANDARD_DESIGN_MD = STANDARD_DESIGN_PACKAGE.designMarkdown;
const STANDARD_REQUIREMENT_MODEL_MD = STANDARD_DESIGN_PACKAGE.requirementModelMarkdown;
const STANDARD_DOMAIN_MODEL_MD = STANDARD_DESIGN_PACKAGE.domainModelMarkdown;
const STANDARD_DESIGN_MODEL_MD = STANDARD_DESIGN_PACKAGE.designModelMarkdown;
const STANDARD_IMPLEMENTATION_MODEL_MD = STANDARD_DESIGN_PACKAGE.implementationModelMarkdown;
const STANDARD_DESIGN_FINGERPRINT = getAutocodeDesignPackageFingerprint(STANDARD_DESIGN_PACKAGE);
const STANDARD_DESIGN_REVIEW_MD = [
  'Status: PASSED',
  '',
  'The design is evidence-backed and stays within its local budget.',
  '',
].join('\n');

function withStandardDesignMetadata(tasksMarkdown: string): string {
  if (/^\s*-\s+_Design:/im.test(tasksMarkdown)) {
    return tasksMarkdown;
  }
  return tasksMarkdown.replace(
    /^(\s*)-\s+_Requirements:[^\r\n]*_\s*$/gm,
    (line, indent: string) =>
      `${line}\n${indent}- _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_`,
  );
}

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
  if (filePath.endsWith('design.md')) {
    return Promise.resolve(STANDARD_DESIGN_MD);
  }
  if (filePath.endsWith('requirement_model.md')) {
    return Promise.resolve(STANDARD_REQUIREMENT_MODEL_MD);
  }
  if (filePath.endsWith('domain_model.md')) {
    return Promise.resolve(STANDARD_DOMAIN_MODEL_MD);
  }
  if (filePath.endsWith('design_model.md')) {
    return Promise.resolve(STANDARD_DESIGN_MODEL_MD);
  }
  if (filePath.endsWith('implementation_model.md')) {
    return Promise.resolve(STANDARD_IMPLEMENTATION_MODEL_MD);
  }
  if (filePath.endsWith('design_review.md')) {
    return Promise.resolve(STANDARD_DESIGN_REVIEW_MD);
  }
  return Promise.reject(new Error('ENOENT'));
}

function makePlan(statuses: string[], withSchedulingMetadata = true): string {
  return JSON.stringify({
    source_task: {
      kind: 'autocode-tasks',
      design_contract: {
        version: 5,
        path: 'design.md',
        paths: [
          'design.md',
          'requirement_model.md',
          'domain_model.md',
          'design_model.md',
          'implementation_model.md',
        ],
        fingerprint: STANDARD_DESIGN_FINGERPRINT,
      },
    },
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
      lines.push(
        '    - _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_',
      );
      lines.push(`    - _Evidence: spec.md Subtask ${index + 1}_`);
      lines.push(`    - _Done when: Subtask ${index + 1} is implemented and the focused check passes_`);
      lines.push('    - _Verification: Run focused check_');
    }
    lines.push('');
  });
  return lines.join('\n');
}

function makeBroadTasks(): string {
  return withStandardDesignMetadata([
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
    '    - _Verification: Start the browser game, exercise the primary path, and check console errors, resource loading, blank screen, startup, and exit status._',
    '',
  ].join('\n'));
}

function standardDesignPackageEntries(): Array<[string, string]> {
  return [
    ['/spec/design.md', STANDARD_DESIGN_MD],
    ['/spec/requirement_model.md', STANDARD_REQUIREMENT_MODEL_MD],
    ['/spec/domain_model.md', STANDARD_DOMAIN_MODEL_MD],
    ['/spec/design_model.md', STANDARD_DESIGN_MODEL_MD],
    ['/spec/implementation_model.md', STANDARD_IMPLEMENTATION_MODEL_MD],
  ];
}

function makeStandardArtifactMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map([...standardDesignPackageEntries(), ...entries]);
}

function makeVagueEvidenceTasks(): string {
  return withStandardDesignMetadata([
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
  ].join('\n'));
}

function makePhaseHeadingDependencyTasks(): string {
  return withStandardDesignMetadata([
    '# Tasks',
    '',
    'Feature: Test task',
    'Workflow: feature',
    'Status: pending',
    '',
    '## Architecture And Design Pattern References',
    '',
    '- Tasks 1.1-1.2 UI layer: follow the general guidance of separating semantic HTML structure from responsive CSS so shell and layout remain independently reviewable.',
    '- Tasks 2.1-2.2 domain/runtime layer: follow the general guidance of keeping board state changes separate from keyboard input adapters for focused browser game behavior.',
    '- Task 2.2 input boundary: follow the general guidance of event adapter isolation so keyboard events translate into explicit game state commands.',
    '- Task 3 verification boundary: follow the general guidance of a late smoke verification after shell, layout, state, and input dependencies have completed.',
    '',
    '- [ ] 1. Static app shell',
    '',
    '  - [ ] 1.1 Create semantic HTML shell',
    '    - Add the primary page structure.',
    '    - _Files to modify: index.html_',
    '    - _Depends on: 1_',
    '    - _Requirements: R1, AC1_',
    '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
    '    - _Architecture: UI layer; semantic shell separation strategy; General guidance for task 1.1_',
    '    - _Done when: index.html contains the expected page shell._',
    '    - _Verification: inspect index.html_',
    '',
    '  - [ ] 1.2 Add responsive layout',
    '    - Add CSS after the shell exists.',
    '    - _Files to modify: styles.css_',
    '    - _Depends on: 1_',
    '    - _Requirements: R2, AC2_',
    '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
    '    - _Architecture: UI styling layer; responsive layout separation strategy; General guidance for task 1.2_',
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
    '    - _Architecture: domain state layer; pure state model strategy; General guidance for task 2.1_',
    '    - _Done when: src/game.js can represent a board._',
    '    - _Verification: inspect board state_',
    '',
    '  - [ ] 2.2 Wire keyboard input',
    '    - Add keyboard input after board state exists.',
    '    - _Files to modify: src/game.js_',
    '    - _Depends on: 2.1_',
    '    - _Requirements: R4, AC4_',
    '    - _Evidence: spec.md R4; requirements.md Evidence Sources_',
    '    - _Architecture: input adapter boundary; keyboard event adapter strategy; General guidance for task 2.2_',
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
    '  - _Verification: Start the browser flow, exercise the primary path, and check console errors, resource loading, blank screen, startup, and exit status._',
    '',
  ].join('\n'));
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

function installPlanningArtifactMap(files: Map<string, string>): void {
  const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
  mockReadFile.mockImplementation((filePath: string) => {
    const content = files.get(normalizePath(filePath));
    return content === undefined
      ? Promise.reject(new Error('ENOENT'))
      : Promise.resolve(content);
  });
  mockWriteFile.mockImplementation(async (filePath: string, content: unknown) => {
    files.set(normalizePath(filePath), String(content));
  });
  mockRename.mockImplementation(async (sourcePath: string, targetPath: string) => {
    const source = normalizePath(sourcePath);
    const target = normalizePath(targetPath);
    const content = files.get(source);
    if (content === undefined) {
      throw new Error('ENOENT');
    }
    files.set(target, content);
    files.delete(source);
  });
  mockUnlink.mockImplementation(async (filePath: string) => {
    files.delete(normalizePath(filePath));
  });
}

describe('BuildOrchestrator QA recovery', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockRename.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockValidateAndNormalizeJsonFile.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
    });
    mockValidateImplementationPlanLanguage.mockReset().mockReturnValue([]);
    mockRewriteImplementationPlanFiles.mockReset().mockResolvedValue(null);
    mockIterateSubtasks.mockReset();
  });

  it('blocks coding when design.md is stale for the active runtime plan', async () => {
    mockReadFile.mockImplementation((path: string) => readStandardArtifactOrReject(path));
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    const error = await orchestrator.validateRuntimeDesignContract({
      source_task: {
        design_contract: {
          version: 5,
          path: 'design.md',
          paths: [
            'design.md',
            'requirement_model.md',
            'domain_model.md',
            'design_model.md',
            'implementation_model.md',
          ],
          fingerprint: 'stale-design-fingerprint',
        },
      },
    });

    expect(error).toContain('approved design package changed after the runtime plan was derived');
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('rejects runtime plans that do not bind the exact v5 package paths', async () => {
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      source_task: {
        design_contract: {
          version: 5,
          path: 'design.md',
          paths: ['design.md'],
          fingerprint: 'manual-fingerprint',
        },
      },
    })).resolves.toContain('does not bind the exact five-file Design-Contract: 5 package');
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('task_metadata.json'),
      'utf-8',
    );
  });

  it.each([3, 4])('rejects a v%s model even when its runtime fingerprint matches', async (version) => {
    const malformedDesignModel = STANDARD_DESIGN_MODEL_MD.replace(
      'Design-Contract: 5',
      `Design-Contract: ${version}`,
    );
    mockReadFile.mockImplementation((path: string) =>
      String(path).endsWith('design_model.md')
        ? Promise.resolve(malformedDesignModel)
        : readStandardArtifactOrReject(path)
    );
    const malformedPackage = {
      designMarkdown: STANDARD_DESIGN_MD,
      requirementModelMarkdown: STANDARD_REQUIREMENT_MODEL_MD,
      domainModelMarkdown: STANDARD_DOMAIN_MODEL_MD,
      designModelMarkdown: malformedDesignModel,
      implementationModelMarkdown: STANDARD_IMPLEMENTATION_MODEL_MD,
    };
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      source_task: {
        design_contract: {
          version: 5,
          path: 'design.md',
          paths: [
            'design.md',
            'requirement_model.md',
            'domain_model.md',
            'design_model.md',
            'implementation_model.md',
          ],
          fingerprint: getAutocodeDesignPackageFingerprint(malformedPackage),
        },
      },
    })).resolves.toContain('design_model.md must declare Design-Contract: 5');
  });

  it('rejects legacy runtime plans without a v5 design contract', async () => {
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      source_task: { kind: 'legacy-standard-plan' },
    })).resolves.toContain('no Design-Contract: 5 package fingerprint');
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('task_metadata.json'),
      'utf-8',
    );
  });

  it.each(['documentation', 'investigation', 'analysis', 'research'])(
    'allows %s runtime plans without a design contract',
    async (workflowType) => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const orchestrator = makeOrchestrator() as unknown as {
        validateRuntimeDesignContract: (
          plan: Record<string, unknown>,
        ) => Promise<string | undefined>;
      };

      await expect(orchestrator.validateRuntimeDesignContract({
        workflow_type: workflowType,
        source_task: { kind: 'non-implementation-task' },
      })).resolves.toBeUndefined();
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('task_metadata.json'),
        'utf-8',
      );
    },
  );

  it('allows metadata-classified analysis tasks without a design contract', async () => {
    mockReadFile.mockImplementation((filePath: string) =>
      String(filePath).endsWith('task_metadata.json')
        ? Promise.resolve(JSON.stringify({ taskType: 'analysis' }))
        : Promise.reject(new Error('ENOENT')),
    );
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      workflow_type: 'feature',
      source_task: { kind: 'manual-analysis' },
    })).resolves.toBeUndefined();
  });

  it('still requires a design contract when an analysis-labelled task requests implementation', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      workflow_type: 'analysis',
      description: 'Analyze the failure and fix the implementation in worker.ts.',
      source_task: { kind: 'implementation-task' },
    })).resolves.toContain('no Design-Contract: 5 package fingerprint');
  });

  it('uses the persisted task description to reject mislabeled implementation work', async () => {
    mockReadFile.mockImplementation((filePath: string) => {
      if (String(filePath).endsWith('task_metadata.json')) {
        return Promise.resolve(JSON.stringify({ taskType: 'analysis' }));
      }
      if (String(filePath).endsWith('requirements.md')) {
        return Promise.resolve('Analyze the current behavior, then build a report dashboard.');
      }
      return Promise.reject(new Error('ENOENT'));
    });
    const orchestrator = makeOrchestrator() as unknown as {
      validateRuntimeDesignContract: (
        plan: Record<string, unknown>,
      ) => Promise<string | undefined>;
    };

    await expect(orchestrator.validateRuntimeDesignContract({
      workflow_type: 'analysis',
      source_task: { kind: 'implementation-task' },
    })).resolves.toContain('no Design-Contract: 5 package fingerprint');
  });

  it('does not reuse a stale passed review when the independent review session errors', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ...standardDesignPackageEntries(),
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
    ]);
    const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
    mockReadFile.mockImplementation((filePath: string) => {
      const content = files.get(normalizePath(filePath));
      return content === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(content);
    });
    mockWriteFile.mockImplementation(async (filePath: string, content: unknown) => {
      files.set(normalizePath(filePath), String(content));
    });
    mockRename.mockImplementation(async (sourcePath: string, targetPath: string) => {
      const source = normalizePath(sourcePath);
      const target = normalizePath(targetPath);
      const content = files.get(source);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      files.set(target, content);
      files.delete(source);
    });
    mockUnlink.mockImplementation(async (filePath: string) => {
      files.delete(normalizePath(filePath));
    });

    let criticRuns = 0;
    const runSession = vi.fn(async (config: { agentType: string }): Promise<SessionResult> => {
      if (config.agentType !== 'design_critic') {
        return makeSessionResult('completed');
      }
      criticRuns++;
      if (criticRuns === 1) {
        return {
          ...makeSessionResult('error'),
          error: { code: 'temporary-review-error', message: 'review process interrupted', retryable: true },
        };
      }
      files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession) as unknown as {
      ensureStandardDesignForPlanning: (
        transaction: Record<string, unknown>,
      ) => Promise<{ success: boolean; error?: string }>;
    };

    const result = await orchestrator.ensureStandardDesignForPlanning({
      version: 1,
      id: 'stale-review-transaction',
      phase: 'planning',
      status: 'active',
      stage: 'started',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      baselineArtifactHashes: {},
      artifactHashes: {},
    });

    expect(result.success, result.error).toBe(true);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'software_designer')).toHaveLength(5);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'design_critic')).toHaveLength(2);
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('design_review.md'));
  });

  it('routes a downstream traceability failure back to the design owner', async () => {
    const malformedDesign = STANDARD_DESIGN_MD.replace(
      ' -> LANG-001 -> IMP-001',
      '',
    );
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', malformedDesign],
    ]);
    installPlanningArtifactMap(files);

    let designRuns = 0;
    const runSession = vi.fn(async (config: {
      agentType: string;
      specPhase?: string;
    }): Promise<SessionResult> => {
      if (config.specPhase === 'design') {
        designRuns++;
        if (designRuns === 2) {
          files.set('/spec/design.md', STANDARD_DESIGN_MD);
        }
      }
      if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession) as unknown as {
      ensureStandardDesignForPlanning: (
        transaction: Record<string, unknown>,
      ) => Promise<{ success: boolean; error?: string }>;
    };
    const logMessages: string[] = [];
    (orchestrator as unknown as BuildOrchestrator).on('log', (message: string) => {
      logMessages.push(message);
    });

    const result = await orchestrator.ensureStandardDesignForPlanning({
      version: 1,
      id: 'upstream-owner-repair',
      phase: 'planning',
      status: 'active',
      stage: 'started',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      baselineArtifactHashes: {},
      artifactHashes: {},
    });

    expect(result.success, result.error).toBe(true);
    expect(runSession.mock.calls
      .filter(([config]) => config.agentType === 'software_designer')
      .map(([config]) => config.specPhase), logMessages.join('\n'))
      .toEqual([
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design',
        'design_model',
        'implementation_model',
      ]);
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

    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession,
      maxIterations: 2,
    });
    const logs: string[] = [];
    orchestrator.on('log', (message) => logs.push(String(message)));
    const outcome = await orchestrator.run();

    expect(outcome.success, [outcome.error, ...logs].filter(Boolean).join('\n')).toBe(true);
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

  it('re-enters planning when a non-empty implementation plan fails schema validation', async () => {
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
          return Promise.resolve(JSON.stringify({
            phases: [{
              name: 'Malformed phase without an id',
              subtasks: [{ id: '1.1', description: 'Non-empty malformed task', status: 'pending' }],
            }],
          }));
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
    const logs: string[] = [];
    orchestrator.on('phase-change', (phase) => phases.push(phase));
    orchestrator.on('log', (message) => logs.push(String(message)));

    const outcome = await orchestrator.run();

    expect(outcome.success, [outcome.error, ...logs].filter(Boolean).join('\n')).toBe(true);
    expect(runSession.mock.calls.some(([config]) => config.agentType === 'planner')).toBe(true);
    expect(mockIterateSubtasks).toHaveBeenCalledTimes(1);
    expect(logs.some((log) => log.includes('Existing implementation plan is invalid; regenerating plan'))).toBe(true);
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

  it('runs only the tasks owner for a new analysis plan and omits stale design metadata', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STRICT_STANDARD_SPEC_MD],
      ['/spec/requirements.md', NON_IMPLEMENTATION_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/task_metadata.json', JSON.stringify({
        taskType: 'analysis',
        taskTitle: 'Analyze task logs and write an evidence report',
      })],
      ['/spec/design.md', 'stale design that must not be validated or rebound'],
      ['/spec/design_review.md', 'Status: PASSED\n\nStale review.'],
    ]);
    installPlanningArtifactMap(files);
    const generatePrompt = vi.fn().mockResolvedValue('prompt');
    const runSession = vi.fn(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt,
      runSession,
    }) as unknown as {
      runPlanningPhase: () => Promise<{ success: boolean; error?: string }>;
    };

    const result = await orchestrator.runPlanningPhase();
    const runtimePlan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{}');

    expect(result.success, result.error).toBe(true);
    expect(runSession.mock.calls.map(([config]) => config.agentType)).toEqual(['planner']);
    expect(runtimePlan.source_task?.design_contract).toBeUndefined();
    expect(files.get('/spec/design.md')).toBe('stale design that must not be validated or rebound');
  });

  it('filters all design owners from force planning for an analysis task', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STRICT_STANDARD_SPEC_MD],
      ['/spec/requirements.md', NON_IMPLEMENTATION_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/task_metadata.json', JSON.stringify({
        taskType: 'analysis',
        taskTitle: 'Summarize the task log failure in a report',
      })],
      ['/spec/design.md', 'invalid stale design'],
      ['/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD],
      ['/spec/implementation_plan.md', makePlanWithSchedulingMetadata(['pending'])],
      ['/spec/change_requests.jsonl', makeStandardPlanningChangeRequest([
        'design.md',
        'requirement_model.md',
        'domain_model.md',
        'design_model.md',
        'implementation_model.md',
        'design_review.md',
        'tasks.md',
      ], 'cr-analysis-docs')],
    ]);
    installPlanningArtifactMap(files);
    const runSession = vi.fn(async (config: { agentType: string }) => {
      if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession) as unknown as {
      runPlanningPhase: () => Promise<{ success: boolean; error?: string }>;
    };

    const result = await orchestrator.runPlanningPhase();
    const transaction = JSON.parse(files.get('/spec/planning-transaction.json') ?? '{}');

    expect(result.success, result.error).toBe(true);
    expect(runSession.mock.calls.map(([config]) => config.agentType)).toEqual(['planner']);
    expect(transaction.ownerStages).toEqual(['tasks']);
  });

  it('uses a no-design retry prompt when analysis task planning must retry', async () => {
    const files = new Map<string, string>([
      ['/spec/spec.md', STRICT_STANDARD_SPEC_MD],
      ['/spec/requirements.md', NON_IMPLEMENTATION_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/task_metadata.json', JSON.stringify({
        taskType: 'analysis',
        taskTitle: 'Analyze task logs and write a report',
      })],
    ]);
    installPlanningArtifactMap(files);
    const generatePrompt = vi.fn().mockResolvedValue('prompt');
    let plannerRuns = 0;
    const runSession = vi.fn(async () => {
      plannerRuns++;
      if (plannerRuns === 1) {
        return {
          ...makeSessionResult('error'),
          error: {
            code: 'temporary-planner-error',
            message: 'temporary planner failure',
            retryable: true,
          },
        } satisfies SessionResult;
      }
      files.set('/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD);
      return makeSessionResult('completed');
    });
    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt,
      runSession,
    }) as unknown as {
      runPlanningPhase: () => Promise<{ success: boolean; error?: string }>;
    };

    const result = await orchestrator.runPlanningPhase();
    const retryContext = generatePrompt.mock.calls[1]?.[2]?.planningRetryContext as string;

    expect(result.success, result.error).toBe(true);
    expect(retryContext).toContain('REWRITE TASKS SOURCE');
    expect(retryContext).not.toMatch(/Design-Contract|five-file|_Design_/i);
  });

  it('derives an exempt runtime plan without reading stale design artifacts', async () => {
    const files = new Map<string, string>([
      ['/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD],
      ['/spec/design.md', 'stale design'],
      ['/spec/requirement_model.md', 'stale requirement model'],
      ['/spec/domain_model.md', 'stale domain model'],
      ['/spec/design_model.md', 'stale design model'],
      ['/spec/implementation_model.md', 'stale implementation model'],
    ]);
    installPlanningArtifactMap(files);
    const orchestrator = makeOrchestrator() as unknown as {
      deriveRuntimePlanFromStandardTasks: (
        snapshot: undefined,
        requireDesignContract: boolean,
      ) => Promise<{ success: boolean; error?: string }>;
    };
    mockReadFile.mockClear();

    const result = await orchestrator.deriveRuntimePlanFromStandardTasks(undefined, false);
    const readPaths = mockReadFile.mock.calls.map(([path]) => String(path).replace(/\\/g, '/'));
    const runtimePlan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{}');

    expect(result.success, result.error).toBe(true);
    expect(readPaths).toEqual(['/spec/tasks.md']);
    expect(runtimePlan.source_task?.design_contract).toBeUndefined();
  });

  it('keeps Design-Contract planning for an analysis-labelled implementation request', async () => {
    const files = new Map<string, string>([
      ['/spec/requirements.md', 'Analyze the failure and fix the worker implementation.'],
      ['/spec/task_metadata.json', JSON.stringify({
        taskType: 'analysis',
        taskTitle: 'Analyze the failure and implement the fix',
      })],
    ]);
    installPlanningArtifactMap(files);
    const orchestrator = makeOrchestrator() as unknown as {
      requiresStandardPlanningDesignContract: () => Promise<boolean>;
      resolveStandardPlanningOwnerPlan: (
        requireDesignContract: boolean,
      ) => Promise<{ stages: string[] }>;
    };

    const requireDesignContract = await orchestrator.requiresStandardPlanningDesignContract();
    const ownerPlan = await orchestrator.resolveStandardPlanningOwnerPlan(requireDesignContract);

    expect(requireDesignContract).toBe(true);
    expect(ownerPlan.stages).toEqual(['design', 'design_review', 'tasks']);
  });

  it('ignores generic passive implementation boilerplate for an analysis task', async () => {
    const files = new Map<string, string>([
      ['/spec/requirements.md', [
        NON_IMPLEMENTATION_REQUIREMENTS_MD,
        'The requested change is implemented according to the task description.',
      ].join('\n')],
      ['/spec/task_metadata.json', JSON.stringify({ taskType: 'analysis' })],
    ]);
    installPlanningArtifactMap(files);
    const orchestrator = makeOrchestrator() as unknown as {
      requiresStandardPlanningDesignContract: () => Promise<boolean>;
    };

    await expect(orchestrator.requiresStandardPlanningDesignContract()).resolves.toBe(false);
  });

  it('keeps the cached no-design decision on coding and every QA reviewer/fixer session', async () => {
    const buildPlan = (status: 'pending' | 'completed') => JSON.stringify({
      workflow_type: 'analysis',
      source_task: { kind: 'analysis-task' },
      phases: [{
        id: 'phase-1',
        name: 'Analysis delivery',
        subtasks: [{
          id: '1.1',
          description: 'Write the task-log findings report',
          status,
          depends_on: [],
          evidence: 'E1; task_logs.jsonl',
          verification: { type: 'manual', run: 'Review the findings report' },
        }],
      }],
    });
    const files = new Map<string, string>([
      ['/spec/implementation_plan.md', buildPlan('pending')],
      ['/spec/tasks.md', NON_IMPLEMENTATION_TASKS_MD],
      ['/spec/spec.md', STRICT_STANDARD_SPEC_MD],
      ['/spec/requirements.md', NON_IMPLEMENTATION_REQUIREMENTS_MD],
      ['/spec/task_metadata.json', JSON.stringify({ taskType: 'analysis' })],
    ]);
    installPlanningArtifactMap(files);
    const promptDecisions: Array<{ agentType: string; phase: string; requireDesignContract?: boolean }> = [];
    const sessionDecisions: Array<{ agentType: string; requireDesignContract?: boolean }> = [];
    const generatePrompt = vi.fn(async (
      agentType: string,
      phase: string,
      context: { requireDesignContract?: boolean },
    ) => {
      promptDecisions.push({ agentType, phase, requireDesignContract: context.requireDesignContract });
      return 'prompt';
    });
    let reviewerRuns = 0;
    const runSession = vi.fn(async (config: { agentType: string; requireDesignContract?: boolean }) => {
      sessionDecisions.push({
        agentType: config.agentType,
        requireDesignContract: config.requireDesignContract,
      });
      if (config.agentType === 'qa_reviewer') {
        reviewerRuns++;
        files.set('/spec/qa_report.md', reviewerRuns === 1
          ? makeFailedQAReport()
          : makePassedQAReport());
      }
      return makeSessionResult('completed');
    });
    mockIterateSubtasks.mockImplementationOnce(async (config: {
      runSubtaskSession: (
        subtask: { id: string; description: string; filesToCreate: string[] },
        attempt: number,
      ) => Promise<SessionResult>;
    }) => {
      await config.runSubtaskSession({
        id: '1.1',
        description: 'Write the task-log findings report',
        filesToCreate: ['docs/task-log-analysis.md'],
      }, 1);
      files.set('/spec/implementation_plan.md', buildPlan('completed'));
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    const outcome = await new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt,
      runSession,
      maxIterations: 2,
    }).run();

    expect(outcome.success, outcome.error).toBe(true);
    expect(sessionDecisions.map(({ agentType }) => agentType)).toEqual([
      'planner',
      'coder',
      'qa_reviewer',
      'qa_fixer',
      'qa_reviewer',
    ]);
    expect(promptDecisions.every(({ requireDesignContract }) => requireDesignContract === false)).toBe(true);
    expect(sessionDecisions.every(({ requireDesignContract }) => requireDesignContract === false)).toBe(true);
  });

  it('keeps the cached Design-Contract decision on implementation coding and QA sessions', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/implementation_plan.md', makePlan(['pending'])],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/task_metadata.json', JSON.stringify({ taskType: 'feature' })],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
    ]);
    installPlanningArtifactMap(files);
    const promptDecisions: Array<boolean | undefined> = [];
    const sessionDecisions: Array<boolean | undefined> = [];
    const generatePrompt = vi.fn(async (
      _agentType: string,
      _phase: string,
      context: { requireDesignContract?: boolean },
    ) => {
      promptDecisions.push(context.requireDesignContract);
      return 'prompt';
    });
    const runSession = vi.fn(async (config: { agentType: string; requireDesignContract?: boolean }) => {
      sessionDecisions.push(config.requireDesignContract);
      if (config.agentType === 'qa_reviewer') {
        files.set('/spec/qa_report.md', makePassedQAReport());
      }
      return makeSessionResult('completed');
    });
    mockIterateSubtasks.mockImplementationOnce(async (config: {
      runSubtaskSession: (
        subtask: { id: string; description: string; filesToModify: string[] },
        attempt: number,
      ) => Promise<SessionResult>;
    }) => {
      await config.runSubtaskSession({
        id: 'subtask-1',
        description: 'Implement subtask 1',
        filesToModify: ['src/file-1.ts'],
      }, 1);
      files.set('/spec/implementation_plan.md', makePlan(['completed']));
      return {
        totalSubtasks: 1,
        completedSubtasks: 1,
        stuckSubtasks: [],
        cancelled: false,
      };
    });

    const outcome = await new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt,
      runSession,
    }).run();

    expect(outcome.success, outcome.error).toBe(true);
    expect(promptDecisions.every((value) => value === true)).toBe(true);
    expect(sessionDecisions.every((value) => value === true)).toBe(true);
  });

  it('runs only the tasks owner for a tasks-only Request Changes plan', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/implementation_plan.md', makePlanWithSchedulingMetadata(['pending'])],
      ['/spec/change_requests.jsonl', makeStandardPlanningChangeRequest([
        'HUMAN_INPUT.md',
        'change_requests.jsonl',
        'tasks.md',
        'implementation_plan.md',
      ])],
    ]);
    installPlanningArtifactMap(files);
    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const ownerAgents = runSession.mock.calls.map(([config]) => config.agentType);

    expect(outcome.success, outcome.error).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(ownerAgents).toEqual(['planner']);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('runs design review and tasks owners without rerunning requirements or spec', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/implementation_plan.md', makePlanWithSchedulingMetadata(['pending'])],
      ['/spec/change_requests.jsonl', makeStandardPlanningChangeRequest([
        'HUMAN_INPUT.md',
        'change_requests.jsonl',
        'design.md',
        'design_review.md',
        'tasks.md',
        'implementation_plan.md',
      ], 'cr-design-only')],
    ]);
    installPlanningArtifactMap(files);
    const runSession = vi.fn(async (config: { agentType: string; specPhase?: string }) => {
      if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const ownerAgents = runSession.mock.calls.map(([config]) => config.agentType);

    expect(outcome.success, outcome.error).toBe(true);
    expect(ownerAgents).toEqual([
      'software_designer',
      'software_designer',
      'software_designer',
      'design_critic',
      'planner',
    ]);
    expect(runSession.mock.calls
      .filter(([config]) => config.agentType === 'software_designer')
      .map(([config]) => config.specPhase))
      .toEqual(['design', 'design_model', 'implementation_model']);
    expect(ownerAgents).not.toContain('spec_gatherer');
    expect(ownerAgents).not.toContain('spec_writer');
  });

  it('runs the full owner chain and retries only the failed requirements stage', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/implementation_plan.md', makePlanWithSchedulingMetadata(['pending'])],
      ['/spec/change_requests.jsonl', makeStandardPlanningChangeRequest([
        'HUMAN_INPUT.md',
        'change_requests.jsonl',
        'requirements.md',
        'spec.md',
        'design.md',
        'design_review.md',
        'tasks.md',
        'implementation_plan.md',
      ], 'cr-requirements')],
    ]);
    installPlanningArtifactMap(files);
    let gathererRuns = 0;
    const runSession = vi.fn(async (
      config: { agentType: string; specPhase?: string },
    ): Promise<SessionResult> => {
      if (config.agentType === 'spec_gatherer') {
        gathererRuns++;
        if (gathererRuns === 1) {
          return {
            ...makeSessionResult('error'),
            error: {
              code: 'temporary-owner-failure',
              message: 'temporary requirements failure',
              retryable: true,
            },
          };
        }
        return {
          ...makeSessionResult('completed'),
          structuredOutput: {
            contract_version: 1,
            task_description: 'Apply the requested incremental behavior.',
            workflow_type: 'feature',
            services_involved: [],
            user_requirements: ['R1: Apply the requested behavior.'],
            acceptance_criteria: ['AC1: The requested behavior is represented by executable work.'],
            constraints: ['C1: Keep the existing workflow contract compatible.'],
            evidence_sources: ['E1: HUMAN_INPUT.md - approved Request Changes feedback.'],
            standards_references: [],
            assumptions: [],
            open_questions: [],
            created_at: '2026-07-14T00:00:00.000Z',
          },
        };
      }
      if (config.agentType === 'spec_writer') {
        files.set('/spec/spec.md', STRICT_STANDARD_SPEC_MD);
      }
      if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      }
      if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', STRICT_STANDARD_TASKS_MD);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const ownerAgents = runSession.mock.calls.map(([config]) => config.agentType);
    const transaction = JSON.parse(files.get('/spec/planning-transaction.json') ?? '{}');

    expect(outcome.success, outcome.error).toBe(true);
    expect(ownerAgents).toEqual([
      'spec_gatherer',
      'spec_gatherer',
      'spec_writer',
      'software_designer',
      'software_designer',
      'software_designer',
      'software_designer',
      'software_designer',
      'design_critic',
      'planner',
    ]);
    expect(runSession.mock.calls
      .filter(([config]) => config.agentType === 'software_designer')
      .map(([config]) => config.specPhase))
      .toEqual([
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
      ]);
    expect(transaction).toMatchObject({
      changeRequestId: 'cr-requirements',
      status: 'completed',
      checkpoint: 'committed',
    });
    expect(files.get('/spec/requirements.md')).toContain('Requirements-Contract: 1');
    expect(files.get('/spec/spec.md')).toBe(STRICT_STANDARD_SPEC_MD);
  });

  it('completes force planning when every preserved work package is already completed', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/tasks.md', makeTasks(['completed'])],
      ['/spec/implementation_plan.md', makePlanWithSchedulingMetadata(['completed'])],
    ]);
    const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
    mockReadFile.mockImplementation((filePath: string) => {
      const normalizedPath = normalizePath(filePath);
      return files.has(normalizedPath)
        ? Promise.resolve(files.get(normalizedPath))
        : Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (filePath: string, content: unknown) => {
      files.set(normalizePath(filePath), String(content));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);
    const outcome = await orchestrator.run();
    const implementationPlan = JSON.parse(
      files.get('/spec/implementation_plan.md') ?? '{"phases":[]}',
    ) as { phases?: Array<{ subtasks?: Array<{ status?: string }> }> };
    const statuses = implementationPlan.phases
      ?.flatMap((phase) => phase.subtasks ?? [])
      .map((subtask) => subtask.status) ?? [];

    expect(outcome.success, outcome.error).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(statuses).toEqual(['completed']);
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });
  it('resumes validated planning transaction artifacts without another planner session', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
      ['/spec/planning-transaction.json', JSON.stringify({
        version: 1,
        id: 'resume-build-transaction',
        phase: 'planning',
        status: 'active',
        stage: 'tasks_validated',
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        artifactHashes: {},
      })],
    ]);
    const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
    mockReadFile.mockImplementation((filePath: string) => {
      const normalizedPath = normalizePath(filePath);
      return files.has(normalizedPath)
        ? Promise.resolve(files.get(normalizedPath))
        : Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (filePath: string, content: unknown) => {
      files.set(normalizePath(filePath), String(content));
    });
    mockRename.mockImplementation(async (sourcePath: string, targetPath: string) => {
      const source = normalizePath(sourcePath);
      const target = normalizePath(targetPath);
      const content = files.get(source);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      files.set(target, content);
      files.delete(source);
    });
    mockUnlink.mockImplementation(async (filePath: string) => {
      files.delete(normalizePath(filePath));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);
    const outcome = await orchestrator.run();

    const transaction = JSON.parse(files.get('/spec/planning-transaction.json') ?? '{}') as {
      status?: string;
      stage?: string;
      checkpoint?: string;
    };
    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(runSession).not.toHaveBeenCalled();
    expect(files.get('/spec/implementation_plan.md')).toContain('Subtask 1');
    expect(transaction).toMatchObject({
      status: 'completed',
      stage: 'committed',
      checkpoint: 'committed',
    });
  });

  it('resumes a legacy sources checkpoint before design, review, and task planning', async () => {
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/planning-transaction.json', JSON.stringify({
        version: 1,
        id: 'legacy-sources-transaction',
        phase: 'planning',
        status: 'repair_required',
        stage: 'sources_validated',
        checkpoint: 'sources_validated',
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
        artifactHashes: {},
      })],
    ]);
    installPlanningArtifactMap(files);

    const runSession = vi.fn(async (config: { agentType: string }) => {
      if (config.agentType === 'software_designer') {
        files.set('/spec/design.md', STANDARD_DESIGN_MD);
      } else if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      } else if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', makeTasks(['pending']));
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const ownerAgents = runSession.mock.calls.map(([config]) => config.agentType);

    expect(outcome.success, outcome.error).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(ownerAgents).toEqual([
      'software_designer',
      'design_critic',
      'planner',
    ]);
    expect(files.get('/spec/implementation_plan.md')).toContain('Subtask 1');
  });

  it('preserves completed runtime work packages during force planning iteration', async () => {
    const tasksMarkdown = withStandardDesignMetadata([
      '# Tasks',
      '',
      'Feature: Preserve completed iteration work',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Completed baseline',
      '',
      '  - [x] 1.1 Preserve completed baseline work',
      '    - Preserve the existing completed implementation result without scheduling it for another coding pass.',
      '    - _Files to modify: src/baseline.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: completed baseline work remains represented as completed_',
      '    - _Verification: npm test -- baseline.test.ts_',
      '',
      '- [ ] 2. Change request follow-up',
      '',
      '  - [ ] 2.1 Apply focused change request',
      '    - Apply only the new focused change requested by the reviewer.',
      '    - _Files to modify: src/follow-up.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; spec.md Requirements R2; requirements.md Evidence Sources_',
      '    - _Done when: the focused change request is ready for coding_',
      '    - _Verification: npm test -- follow-up.test.ts_',
      '',
    ].join('\n'));
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/tasks.md', tasksMarkdown],
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

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();

    const implementationPlan = JSON.parse(files.get('/spec/implementation_plan.md') ?? '{"phases":[]}') as {
      phases?: Array<{ subtasks?: Array<{ status?: string; upstream_task_ids?: string[] }> }>;
    };
    const subtasks = implementationPlan.phases?.flatMap((phase) => phase.subtasks ?? []) ?? [];

    expect(outcome.success).toBe(true);
    expect(outcome.finalPhase).toBe('planning');
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
    expect(subtasks.some((subtask) =>
      subtask.status === 'completed' && subtask.upstream_task_ids?.includes('1.1')
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('2.1')
    )).toBe(true);
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

    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession,
      maxIterations: 2,
    });
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

    const orchestrator = new BuildOrchestrator({
      specDir: '/spec',
      projectDir: '/project',
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession,
      maxIterations: 2,
    });
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

    expect(outcome.success, outcome.error).toBe(true);
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
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
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
    expect(files.get('/spec/spec.md')).toBe(STANDARD_SPEC_MD);
    expect(files.get('/spec/implementation_plan.md')).toContain('Build complete browser game loop');
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('continues a new task into coding when planner retry times out after generating usable Standard artifacts', async () => {
    let plannerRuns = 0;
    let reviewerRuns = 0;
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
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
    expect(files.get('/spec/spec.md')).toBe(STANDARD_SPEC_MD);
    expect(files.get('/spec/implementation_plan.md')).toContain('"status":"completed"');
    expect(mockIterateSubtasks).toHaveBeenCalled();
  });

  it('rejects vague tasks.md evidence without mutating another artifact owner', async () => {
    let reviewerRuns = 0;
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
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

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('tasks.md task 1.1 has vague _Evidence_');
    expect(reviewerRuns).toBe(0);
    expect(files.get('/spec/tasks.md')).toBe(makeVagueEvidenceTasks());
    expect(JSON.parse(files.get('/spec/implementation_plan.md') ?? '{}')).toEqual({ phases: [] });
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('rejects a manual Standard seed spec without synthesizing cross-owner content', async () => {
    const seedSpec = [
      '# Recalculate Standard board progress',
      '',
      '## Type',
      'Standard mode task',
      '',
      '## Request',
      'Keep the board progress synchronized with real work package progress after Request Changes planning.',
      '',
      '## Execution',
      'Use compact Standard Autocode planning. Keep spec.md, tasks.md, and derived implementation_plan.md inside this task directory.',
      'Create or repair tasks.md as the executable checklist. Do not write implementation_plan.md; the runtime derives it from tasks.md.',
    ].join('\n');
    const requirementsMarkdown = [
      '# Requirements',
      '',
      '## User Requirements',
      '',
      '- R1: Recalculate Standard board progress from the current executable work package statuses after Request Changes planning.',
      '',
      '## Acceptance Criteria',
      '',
      '- AC1: The board progress is below 100 percent whenever any derived work package remains pending.',
      '',
      '## Evidence Sources',
      '',
      '- HUMAN_INPUT.md latest reviewer feedback for Request Changes progress behavior.',
      '- tasks.md work package metadata for executable progress status.',
      '',
    ].join('\n');
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', seedSpec],
      ['/spec/requirements.md', requirementsMarkdown],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/tasks.md', makeTasks(['pending'])],
      ['/spec/implementation_plan.md', JSON.stringify({ phases: [] })],
      ['/spec/HUMAN_INPUT.md', 'Request Changes: board progress should sync with detail progress.'],
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

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const repairedSpec = files.get('/spec/spec.md') ?? '';

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('spec.md is still the manual Standard planning seed');
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner')).toHaveLength(2);
    expect(repairedSpec).toBe(seedSpec);
    expect(JSON.parse(files.get('/spec/implementation_plan.md') ?? '{}')).toEqual({ phases: [] });
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
  });

  it('derives runtime work packages when tasks.md dependencies reference phase headings', async () => {
    let reviewerRuns = 0;
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
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

  it('preserves validated Standard sources while rolling back only a failed runtime plan', async () => {
    const originalTasksMarkdown = makeTasks(['completed']);
    const revisedTasksMarkdown = makeTasks(['pending']);
    const originalPlanMarkdown = makePlanWithSchedulingMetadata(['completed']);
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/tasks.md', originalTasksMarkdown],
      ['/spec/implementation_plan.md', originalPlanMarkdown],
    ]);
    const normalizePath = (filePath: string) => filePath.replace(/\\/g, '/');
    mockReadFile.mockImplementation((filePath: string) => {
      const normalizedPath = normalizePath(filePath);
      return files.has(normalizedPath)
        ? Promise.resolve(files.get(normalizedPath))
        : Promise.reject(new Error('ENOENT'));
    });
    mockWriteFile.mockImplementation(async (filePath: string, content: unknown) => {
      files.set(normalizePath(filePath), String(content));
    });
    mockRename.mockImplementation(async (sourcePath: string, targetPath: string) => {
      const source = normalizePath(sourcePath);
      const target = normalizePath(targetPath);
      const content = files.get(source);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      files.set(target, content);
      files.delete(source);
    });
    mockUnlink.mockImplementation(async (filePath: string) => {
      files.delete(normalizePath(filePath));
    });
    mockValidateImplementationPlanLanguage.mockReturnValue([
      'simulated post-derivation runtime plan validation failure',
    ]);

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      }
      if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', revisedTasksMarkdown);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);
    const outcome = await orchestrator.run();

    const transaction = JSON.parse(files.get('/spec/planning-transaction.json') ?? '{}') as {
      status?: string;
      stage?: string;
      checkpoint?: string;
    };
    const failedTaskArtifactKeys = [...files.keys()]
      .filter((key) => key.startsWith('/spec/tasks.md.failed-'));
    const failedPlanArtifactKeys = [...files.keys()]
      .filter((key) => key.startsWith('/spec/implementation_plan.md.failed-'));
    expect(outcome.success).toBe(false);
    expect(runSession.mock.calls.filter(([config]) => config.agentType === 'planner'))
      .toHaveLength(2);
    expect(files.get('/spec/tasks.md')).toBe(revisedTasksMarkdown);
    expect(files.get('/spec/implementation_plan.md')).toBe(originalPlanMarkdown);
    expect(failedTaskArtifactKeys).toHaveLength(0);
    expect(failedPlanArtifactKeys).toHaveLength(1);
    expect(transaction).toMatchObject({
      status: 'repair_required',
      stage: 'repair_required',
      checkpoint: 'plan_derived',
    });
  });
  it('restores previous Standard task artifacts when Request Changes planning fails quality validation', async () => {
    const originalTasksMarkdown = makeTasks(['completed']);
    const failedTasksMarkdown = makeTasks(['pending'], false);
    const originalPlanMarkdown = makePlanWithSchedulingMetadata(['completed']);
    const files = makeStandardArtifactMap([
      ['/spec/spec.md', STANDARD_SPEC_MD],
      ['/spec/requirements.md', STANDARD_REQUIREMENTS_MD],
      ['/spec/design.md', STANDARD_DESIGN_MD],
      ['/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD],
      ['/spec/context.md', STANDARD_CONTEXT_MD],
      ['/spec/tasks.md', originalTasksMarkdown],
      ['/spec/implementation_plan.md', originalPlanMarkdown],
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
    mockUnlink.mockImplementation(async (path: string) => {
      files.delete(normalizePath(path));
    });

    const runSession = vi.fn().mockImplementation(async (config: { agentType: string }) => {
      if (config.agentType === 'design_critic') {
        files.set('/spec/design_review.md', STANDARD_DESIGN_REVIEW_MD);
      }
      if (config.agentType === 'planner') {
        files.set('/spec/tasks.md', failedTasksMarkdown);
      }
      return makeSessionResult('completed');
    });
    const orchestrator = makeForcePlanningOrchestrator(runSession);

    const outcome = await orchestrator.run();
    const failedTaskArtifactKeys = [...files.keys()].filter((key) => key.startsWith('/spec/tasks.md.failed-'));

    expect(outcome.success).toBe(false);
    expect(files.get('/spec/tasks.md')).toBe(originalTasksMarkdown);
    expect(files.get('/spec/implementation_plan.md')).toBe(originalPlanMarkdown);
    expect(failedTaskArtifactKeys).toHaveLength(1);
    expect(files.get(failedTaskArtifactKeys[0])).not.toBe(originalTasksMarkdown);
    expect(files.get(failedTaskArtifactKeys[0])).toContain('1.1 Subtask 1');
    expect(mockIterateSubtasks).not.toHaveBeenCalled();
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
