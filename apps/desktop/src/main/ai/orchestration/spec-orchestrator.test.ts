import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  AUTOCODE_TASK_ARTIFACTS,
  loadAutocodeImplementationPlan,
  loadAutocodeTaskRequirementsSync,
  saveAutocodeImplementationPlan,
  saveAutocodeTaskRequirementsSync,
  stringifyAutocodeContextMarkdown,
  stringifyAutocodeTaskDefinitionsMarkdown,
} from '@autocode/core';

import {
  buildWriteToolJsonRetryPrompt,
  isWriteToolJsonFailure,
  SpecOrchestrator,
  type SpecPromptContext,
  type SpecPhase,
  type SpecPhaseResult,
  type SpecSessionRunConfig,
} from './spec-orchestrator';
import { MMO_AGENT_PROFILE } from '../config/project-agent-profile';
import {
  buildStandardDesignV5Fixture,
} from '../../../../../../libs/core/src/tasks/standard-design-v5.test-fixture.js';

const TEST_CONTEXT_EVIDENCE = {
  path: 'src/App.tsx',
  symbol: 'App',
  lines: '1-20',
  proves: 'Existing app entry point identifies the affected local workflow.',
  confidence: 'high',
};

const TEST_TASK_EVIDENCE = 'E1; context.md src/App.tsx lines 1-20; spec.md SCN-1';
const TEST_REQUIREMENT_EVIDENCE = 'User task description and context.md evidence inventory.';
const TEST_DESIGN_REFS = [
  'ADR-001',
  'RM-001',
  'FUN-001',
  'SSD-001',
  'DOM-001',
  'SYS-001',
  'DES-001',
  'STATE-001',
  'FLOW-001',
  'LANG-001',
  'IMP-001',
];

const TEST_STANDARD_DESIGN_V5_FIXTURE = buildStandardDesignV5Fixture();
const TEST_STANDARD_DESIGN_PACKAGE = {
  design: TEST_STANDARD_DESIGN_V5_FIXTURE.designMarkdown,
  requirementModel: TEST_STANDARD_DESIGN_V5_FIXTURE.requirementModelMarkdown,
  domainModel: TEST_STANDARD_DESIGN_V5_FIXTURE.domainModelMarkdown,
  designModel: TEST_STANDARD_DESIGN_V5_FIXTURE.designModelMarkdown,
  implementationModel: TEST_STANDARD_DESIGN_V5_FIXTURE.implementationModelMarkdown,
};
const TEST_STANDARD_DESIGN_REVIEW = [
  'Status: PASSED',
  '',
  'The design is evidence-backed and stays within its local budget.',
  '',
].join('\n');

async function saveTasksSource(specDir: string, plan: Record<string, unknown>): Promise<void> {
  const planWithEvidence = addTaskEvidence(plan);
  await writeFile(
    join(specDir, 'tasks.md'),
    stringifyAutocodeTaskDefinitionsMarkdown(planWithEvidence),
    'utf-8',
  );
}

function evidenceSources(): Array<typeof TEST_CONTEXT_EVIDENCE> {
  return [{ ...TEST_CONTEXT_EVIDENCE }];
}

async function writeValidContextArtifact(
  specDir: string,
  taskDescription = 'Refactor local task execution flow',
): Promise<void> {
  await writeFile(
    join(specDir, AUTOCODE_TASK_ARTIFACTS.context),
    stringifyAutocodeContextMarkdown({
      task_description: taskDescription,
      scoped_services: [],
      architecture_summary: 'Local codebase change.',
      files_to_modify: [],
      files_to_reference: [],
      design_patterns: [],
      implementation_notes: ['Reuse existing patterns.'],
      risks: [],
      verification_suggestions: ['Run tests.'],
      evidence_sources: evidenceSources(),
      created_at: '2026-05-13T00:00:00.000Z',
    }),
    'utf-8',
  );
}

function addTaskEvidence(plan: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const phases = Array.isArray(copy.phases) ? copy.phases : [];
  for (const phase of phases) {
    if (!phase || typeof phase !== 'object') continue;
    const record = phase as Record<string, unknown>;
    const subtasks = Array.isArray(record.subtasks)
      ? record.subtasks
      : Array.isArray(record.chunks)
        ? record.chunks
        : [];
    for (const subtask of subtasks) {
      if (!subtask || typeof subtask !== 'object') continue;
      const subtaskRecord = subtask as Record<string, unknown>;
      const subtaskId = typeof subtaskRecord.id === 'string' && subtaskRecord.id.trim()
        ? subtaskRecord.id.trim()
        : '1.1';
      const subtaskTitle = typeof subtaskRecord.title === 'string' && subtaskRecord.title.trim()
        ? subtaskRecord.title.trim()
        : subtaskId;
      if (!Array.isArray(subtaskRecord.requirements) || subtaskRecord.requirements.length === 0) {
        subtaskRecord.requirements = ['R1', 'AC1', 'SCN-1'];
      }
      subtaskRecord.design_refs ??= [...TEST_DESIGN_REFS];
      subtaskRecord.evidence ??= TEST_TASK_EVIDENCE;
      subtaskRecord.description = [
        `Implement ${subtaskTitle} as mapped by R1, AC1, and SCN-1.`,
        `Done when: ${subtaskTitle} is complete and focused verification passes.`,
      ].join('\n');
    }
  }
  return copy;
}

async function writeValidDesignArtifacts(specDir: string): Promise<void> {
  await Promise.all([
    writeFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.design), TEST_STANDARD_DESIGN_PACKAGE.design, 'utf-8'),
    writeFile(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.requirementModel),
      TEST_STANDARD_DESIGN_PACKAGE.requirementModel,
      'utf-8',
    ),
    writeFile(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.domainModel),
      TEST_STANDARD_DESIGN_PACKAGE.domainModel,
      'utf-8',
    ),
    writeFile(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.designModel),
      TEST_STANDARD_DESIGN_PACKAGE.designModel,
      'utf-8',
    ),
    writeFile(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationModel),
      TEST_STANDARD_DESIGN_PACKAGE.implementationModel,
      'utf-8',
    ),
    writeFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.designReview), TEST_STANDARD_DESIGN_REVIEW, 'utf-8'),
  ]);
}

async function writeDesignArtifactForPhase(specDir: string, phase: SpecPhase): Promise<void> {
  const modelArtifactByPhase = {
    requirement_model: [
      AUTOCODE_TASK_ARTIFACTS.requirementModel,
      TEST_STANDARD_DESIGN_PACKAGE.requirementModel,
    ],
    domain_model: [
      AUTOCODE_TASK_ARTIFACTS.domainModel,
      TEST_STANDARD_DESIGN_PACKAGE.domainModel,
    ],
    design: [
      AUTOCODE_TASK_ARTIFACTS.design,
      TEST_STANDARD_DESIGN_PACKAGE.design,
    ],
    design_model: [
      AUTOCODE_TASK_ARTIFACTS.designModel,
      TEST_STANDARD_DESIGN_PACKAGE.designModel,
    ],
    implementation_model: [
      AUTOCODE_TASK_ARTIFACTS.implementationModel,
      TEST_STANDARD_DESIGN_PACKAGE.implementationModel,
    ],
  } satisfies Partial<Record<SpecPhase, readonly [string, string]>>;
  const artifact = modelArtifactByPhase[phase as keyof typeof modelArtifactByPhase];
  if (artifact) {
    await writeFile(join(specDir, artifact[0]), artifact[1], 'utf-8');
  } else if (phase === 'design_review') {
    await writeFile(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.designReview),
      TEST_STANDARD_DESIGN_REVIEW,
      'utf-8',
    );
  }
}

function makeCompletedSpecSessionResult() {
  return {
    outcome: 'completed' as const,
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    toolCallCount: 1,
    durationMs: 1,
  };
}

async function writeValidStandardArtifacts(
  specDir: string,
  taskDescription = 'Refactor local task execution flow',
): Promise<void> {
  await writeValidContextArtifact(specDir, taskDescription);
  await writeValidDesignArtifacts(specDir);
  await writeValidRequirementsArtifact(specDir, taskDescription);
  await writeValidSpecArtifact(specDir);
}

async function writeValidRequirementsArtifact(
  specDir: string,
  taskDescription = 'Refactor local task execution flow',
  workflowType = 'refactor',
): Promise<void> {
  saveAutocodeTaskRequirementsSync(specDir, {
    task_description: taskDescription,
    workflow_type: workflowType,
    services_involved: [],
    user_requirements: [taskDescription],
    acceptance_criteria: ['Existing behavior remains intact'],
    constraints: ['Use existing patterns'],
    evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
    standards_references: ['Project conventions from AGENTS.md'],
    assumptions: [],
    created_at: '2026-05-13T00:00:00.000Z',
  });
}

async function writeValidSpecArtifact(specDir: string): Promise<void> {
  await writeFile(
    join(specDir, 'spec.md'),
    [
      '# Behavioral Specification',
      '',
      'Specification-Contract: 1',
      '',
      '## SCN-1 Preserve the requested workflow behavior',
      'Covers: R1, AC1',
      'Evidence: E1',
      '',
      '- Given: the existing workflow is available.',
      '- When: the requested change is exercised.',
      '- Then: AC1 remains satisfied.',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeComplexArchitectureReferences(specDir: string): Promise<void> {
  await writeValidDesignArtifacts(specDir);
}

function createStandardPipelineSession(
  specDir: string,
  phases?: SpecPhase[],
) {
  return vi.fn(async (config: { specPhase: SpecPhase }) => {
    phases?.push(config.specPhase);
    if (config.specPhase === 'requirements') {
      await writeValidRequirementsArtifact(specDir);
    } else if (config.specPhase === 'spec_writing') {
      await writeValidSpecArtifact(specDir);
    } else if (config.specPhase === 'planning') {
      await saveTasksSource(specDir, {
        feature: 'Standard resume fixture',
        workflow_type: 'refactor',
        phases: [{
          id: '1',
          name: 'Implementation',
          subtasks: [{
            id: '1.1',
            title: 'Implement the resumed task',
            description: 'Implement the requested workflow change.',
            status: 'pending',
            files_to_modify: ['src/App.tsx'],
            verification: {
              type: 'manual',
              scenario: 'Open the Electron app, exercise the primary resumed task flow, and verify there are no console, resource-loading, blank-screen, startup, or exit errors.',
            },
          }],
        }],
      });
    }
    await writeDesignArtifactForPhase(specDir, config.specPhase);
    return makeCompletedSpecSessionResult();
  });
}

describe('SpecOrchestrator Write tool retry helpers', () => {
  it('detects malformed Write tool JSON errors', () => {
    expect(isWriteToolJsonFailure(
      'Tool \'Write\' failed: invalid input for tool write: json parsing failed: text: {"file_path": "e:/work/project/.autocode/specs/001/spec.md"',
    )).toBe(true);

    expect(isWriteToolJsonFailure(
      'Tool \'Write\' failed: tool \'write\' received invalid input type: string. expected object.',
    )).toBe(true);

    expect(isWriteToolJsonFailure('Authentication failed: unauthorized http 401')).toBe(false);
  });

  it('builds specification retry guidance with normalized paths', () => {
    const prompt = buildWriteToolJsonRetryPrompt('spec_writing', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY WRITE WITH VALID INPUT');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/spec.md');
    expect(prompt).not.toContain('Use the Write tool to create E:/Work/Project/.autocode/specs/001-task/tasks.md');
    expect(prompt).toContain('Use the Write tool to create');
    expect(prompt).toContain('without imposing a line or character limit');
    expect(prompt).not.toContain('20-60 line');
    expect(prompt).not.toContain('\\');
  });

  it('tells planner retries to write one Markdown task list', () => {
    const prompt = buildWriteToolJsonRetryPrompt('planning', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY TASKS WRITE');
    expect(prompt).toContain('tasks.md');
    expect(prompt).toContain('Write checklist Markdown, not JSON');
    expect(prompt).toContain('Write input shape');
  });

  it('tells context retries to write Markdown instead of returning JSON', () => {
    const prompt = buildWriteToolJsonRetryPrompt('discovery', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY WRITE WITH VALID INPUT');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/context.md');
    expect(prompt).toContain('write concise Markdown');
    expect(prompt).toContain('Write input shape');
    expect(prompt).not.toContain('AS FINAL JSON');
    expect(prompt).not.toContain('\\');
  });

  it('tells requirements retries to return final JSON instead of using Write', () => {
    const prompt = buildWriteToolJsonRetryPrompt('requirements', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETURN requirements.md data AS FINAL JSON');
    expect(prompt).toContain('Return final JSON instead of calling Write for this Markdown file');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/requirements.md');
    expect(prompt).toContain('task_description');
    expect(prompt).not.toContain('Write input shape');
    expect(prompt).not.toContain('\\');
  });

  it('stores compact prior phase summaries instead of carrying full long artifacts', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const contextMarkdown = [
      '# Project Context',
      '',
      '## Architecture Summary',
      '',
      '- Renderer owns UI hydration.',
      '- Main process owns orchestration and IPC.',
      ...Array.from(
        { length: 180 },
        (_, index) => `- Tail detail ${index}: ${'implementation evidence and repeated analysis '.repeat(5)}`,
      ),
    ].join('\n');

    try {
      await writeFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.context), contextMarkdown, 'utf-8');
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Improve planning context carryover.',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: vi.fn(async () => ({
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
        })),
      });

      const capturePhaseOutput = (orchestrator as unknown as {
        capturePhaseOutput: (phase: SpecPhase) => Promise<void>;
      }).capturePhaseOutput.bind(orchestrator);
      await capturePhaseOutput('discovery');

      const summaries = (orchestrator as unknown as {
        phaseSummaries: Record<string, string>;
      }).phaseSummaries;
      const summary = summaries[AUTOCODE_TASK_ARTIFACTS.context];

      expect(summary).toContain('Compact phase output summary');
      expect(summary).toContain('Architecture Summary');
      expect(summary).toContain('Renderer owns UI hydration');
      expect(summary).toContain('phase output middle omitted');
      expect(summary).toContain('Tail detail 179');
      expect(summary.length).toBeLessThanOrEqual(2_600);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('passes project documentation reference without legacy projectIndex prompt fields', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const projectDocsReference = '## Project Documentation Reference\n\n- Source: .autocode/project-docs/index.md';
    const generatePrompt = vi.fn(async (
      _agentType: string,
      _phase: SpecPhase,
      _context: SpecPromptContext,
    ) => 'Return requirements JSON.');
    const runSession = vi.fn(async (_config: SpecSessionRunConfig) => ({
      outcome: 'completed' as const,
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      toolCallCount: 0,
      durationMs: 1,
      structuredOutput: {
        task_description: 'Improve the planner.',
        workflow_type: 'refactor',
        services_involved: [],
        user_requirements: ['Improve the planner.'],
        acceptance_criteria: ['Planner remains traceable.'],
        constraints: ['Keep project documentation as Markdown.'],
        evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
        standards_references: ['Project documentation reference'],
        assumptions: [],
        created_at: '2026-05-13T00:00:00.000Z',
      },
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Improve the planner.',
        useAiAssessment: false,
        projectDocsReference,
        generatePrompt,
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('requirements', 1, 1);
      const promptContext = generatePrompt.mock.calls[0][2] as unknown as Record<string, unknown>;
      const sessionConfig = runSession.mock.calls[0][0] as unknown as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(promptContext.projectDocsReference).toBe(projectDocsReference);
      expect(sessionConfig.projectDocsReference).toBe(projectDocsReference);
      expect(Object.hasOwn(promptContext, 'projectIndex')).toBe(false);
      expect(Object.hasOwn(sessionConfig, 'projectIndex')).toBe(false);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('writes fallback requirements after retries when completed sessions create no file', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async (_config: { outputSchema?: unknown }) => ({
      outcome: 'completed' as const,
      stepsExecuted: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      messages: [],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: '\u4fee\u590d\u4efb\u52a1\u6682\u505c\u540e\u8bf7\u6c42\u7edf\u8ba1\u6b21\u6570\u7a81\u7136\u589e\u591a\u7684\u95ee\u9898',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return requirements JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('requirements', 1, 1);
      const requirements = loadAutocodeTaskRequirementsSync(specDir);
      expect(requirements).not.toBeNull();
      if (!requirements) throw new Error('requirements.md was not written');

      expect(result).toEqual({ phase: 'requirements', success: true, errors: [], retries: 1 });
      expect(requirements).toMatchObject({
        task_description: '\u4fee\u590d\u4efb\u52a1\u6682\u505c\u540e\u8bf7\u6c42\u7edf\u8ba1\u6b21\u6570\u7a81\u7136\u589e\u591a\u7684\u95ee\u9898',
        workflow_type: 'bugfix',
        services_involved: [],
      });
      expect(requirements.user_requirements).toEqual(['R1: \u4fee\u590d\u4efb\u52a1\u6682\u505c\u540e\u8bf7\u6c42\u7edf\u8ba1\u6b21\u6570\u7a81\u7136\u589e\u591a\u7684\u95ee\u9898']);
      expect(requirements).not.toHaveProperty('generated_by_fallback');
      expect(runSession).toHaveBeenCalledTimes(2);
      expect(runSession.mock.calls[0][0].outputSchema).toBeDefined();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('writes fallback discovery context after retries when completed sessions create no file', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      messages: [],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a Windows-style calculator page',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Write context Markdown.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('discovery', 1, 1);
      const context = await readFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.context), 'utf-8');

      expect(result).toEqual({ phase: 'discovery', success: true, errors: [], retries: 1 });
      expect(context).toContain('# Project Context');
      expect(context).toContain('Create a Windows-style calculator page');
      expect(context).toContain('Discovery fallback');
      expect(context).toContain('## Evidence Sources');
      expect(runSession).toHaveBeenCalledTimes(2);
      const firstRunCall = runSession.mock.calls[0] as unknown[] | undefined;
      const firstRunConfig = firstRunCall?.[0] as { outputSchema?: unknown } | undefined;
      expect(firstRunConfig?.outputSchema).toBeUndefined();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('compacts oversized task descriptions in fallback spec artifacts', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const longTaskDescription = [
      'Opening artifact rule: keep app-owned structured data as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large fallback task context ${index}: ${'repeated pasted diagnostic text '.repeat(6)}`,
      ),
      'Closing artifact rule: convert only model-readable prose references to Markdown.',
    ].join('\n');
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      messages: [],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: longTaskDescription,
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });
      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      await runPhase('requirements', 1, 2);
      await runPhase('discovery', 2, 2);

      const requirements = loadAutocodeTaskRequirementsSync(specDir);
      const context = await readFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.context), 'utf-8');
      expect(requirements).not.toBeNull();
      if (!requirements) throw new Error('requirements.md was not written');

      expect(requirements.task_description).toContain('Opening artifact rule');
      expect(requirements.task_description).toContain('task description middle omitted for artifact budget');
      expect(requirements.task_description).toContain('Closing artifact rule');
      expect(requirements.task_description).not.toContain('Large fallback task context 160');
      expect(requirements.user_requirements?.[0]).toContain('task description middle omitted for artifact budget');
      expect(context).toContain('Opening artifact rule');
      expect(context).toContain('task description middle omitted for artifact budget');
      expect(context).toContain('Closing artifact rule');
      expect(context).not.toContain('Large fallback task context 160');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('normalizes loose requirements JSON before writing requirements output', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const looseRequirements = {
      task: 'Create a web project dashboard',
      type: 'feature',
      requirements: ['Create the dashboard page', 'Support add, filter, and status updates'],
      success_criteria: ['Open index.html successfully', 'node --check main.js passes'],
      risks: ['Manual browser smoke testing is required'],
      evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
    };
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant' as const, content: JSON.stringify(looseRequirements) }],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a web project dashboard',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return requirements JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('requirements', 1, 1);
      const written = loadAutocodeTaskRequirementsSync(specDir);
      expect(written).not.toBeNull();
      if (!written) throw new Error('requirements.md was not written');

      expect(result).toEqual({ phase: 'requirements', success: true, errors: [], retries: 0 });
      expect(written).toMatchObject({
        task_description: 'Create a web project dashboard',
        workflow_type: 'feature',
        user_requirements: ['R1: Create the dashboard page', 'R2: Support add, filter, and status updates'],
        acceptance_criteria: ['AC1: Open index.html successfully', 'AC2: node --check main.js passes'],
        constraints: ['C1: Manual browser smoke testing is required'],
      });
      expect(written.created_at).toEqual(expect.any(String));
      expect(runSession).toHaveBeenCalledTimes(1);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('accepts Markdown research output written by the research agent', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async () => {
      await writeFile(
        join(specDir, AUTOCODE_TASK_ARTIFACTS.research),
        [
          '# Research',
          '',
          '## Integrations Researched',
          '- None required.',
          '',
          '## Recommendations',
          '- No external dependency is required; follow the existing project structure.',
          '- Run the smallest available project check.',
          '',
          '## Unverified Claims',
          '- Manual review may be needed if no automated check exists (risk: low): Not independently verified during this phase.',
          '',
        ].join('\n'),
        'utf-8',
      );
      return {
        outcome: 'completed' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 1,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small local utility',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Write research Markdown.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('research', 1, 1);
      const written = await readFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.research), 'utf-8');

      expect(result).toEqual({ phase: 'research', success: true, errors: [], retries: 0 });
      expect(written).toContain('# Research');
      expect(written).toContain('No external dependency is required');
      expect(written).toContain('## Unverified Claims');
      expect(runSession).toHaveBeenCalledTimes(1);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('skips research for complex balanced tasks without external dependency signals', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);

      if (config.specPhase === 'discovery' || config.specPhase === 'context') {
        await writeValidContextArtifact(specDir);
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
        };
      }

      if (config.specPhase === 'requirements') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [{
            role: 'assistant' as const,
            content: JSON.stringify({
              task_description: 'Refactor local task execution flow',
              workflow_type: 'refactor',
              services_involved: [],
              user_requirements: ['Refactor local task execution flow'],
              acceptance_criteria: ['Existing behavior remains intact'],
              constraints: ['Use existing patterns'],
              evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
              standards_references: ['Project conventions from AGENTS.md'],
              assumptions: [],
              created_at: '2026-05-13T00:00:00.000Z',
            }),
          }],
          toolCallCount: 0,
          durationMs: 1,
        };
      }

      if (config.specPhase === 'spec_writing' || config.specPhase === 'self_critique') {
        await writeValidStandardArtifacts(specDir);
      }

      await writeDesignArtifactForPhase(specDir, config.specPhase);

      if (config.specPhase === 'planning') {
        await saveTasksSource(specDir, {
          feature: 'Refactor local task execution flow',
          workflow_type: 'refactor',
          phases: [{
            id: '1',
            name: 'Implementation',
            subtasks: [{
              id: '1.1',
              title: 'Refactor flow',
              description: 'Refactor local task execution flow.',
              status: 'pending',
              verification: { type: 'manual', run: 'Run tests' },
            }],
          }],
        });
      }

      return {
        outcome: 'completed' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 1,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'complex',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.phasesExecuted).toEqual([
        'discovery',
        'requirements',
        'context',
        'spec_writing',
        'self_critique',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
        'validation',
      ]);
      expect(phases).not.toContain('research');
      expect(phases).not.toContain('validation');
      expect(phases).toEqual([
        'discovery',
        'requirements',
        'context',
        'spec_writing',
        'self_critique',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
      ]);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('keeps complex conservative implementation plans in one Markdown file', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      if (config.specPhase === 'planning') {
        await saveTasksSource(specDir, {
          feature: 'Refactor platform workflow',
          workflow_type: 'refactor',
          phases: Array.from({ length: 8 }, (_, phaseIndex) => ({
            id: String(phaseIndex + 1),
            name: `Phase ${phaseIndex + 1}`,
            subtasks: [
              {
                id: `${phaseIndex + 1}.1`,
                title: `Task ${phaseIndex + 1}`,
                description: `Implement phase ${phaseIndex + 1}.`,
                status: 'pending',
                architecture: 'platform workflow boundary; service/orchestrator separation strategy; source spec.md Design Notes and context.md Architecture Summary',
                verification: { type: 'manual', scenario: 'Run applicable checks.' },
              },
            ],
          })),
        });
      }

      return {
        outcome: 'completed' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 1,
        durationMs: 1,
      };
    });

    try {
      await writeValidStandardArtifacts(specDir, 'Refactor platform workflow');
      await writeComplexArchitectureReferences(specDir);
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor platform workflow',
        complexityOverride: 'complex',
        workflowConfig: { optimizationLevel: 'conservative', specCreationMode: 'phased' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('planning', 1, 1);
      expect(result.success, JSON.stringify(result)).toBe(true);
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        phases: Array<{ subtasks?: Array<{
          id?: string;
          work_package?: boolean;
          upstream_task_ids?: string[];
          depends_on?: string[];
        }> }>;
      };
      const planContent = await readFile(join(specDir, 'implementation_plan.md'), 'utf-8');
      const tasksContent = await readFile(join(specDir, 'tasks.md'), 'utf-8');

      expect(result.success).toBe(true);
      expect(Object.keys(plan as Record<string, unknown>)).toEqual(expect.not.arrayContaining([
        'split' + '_plan',
        'plan' + '_files',
      ]));
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].subtasks ?? []).toHaveLength(8);
      expect(plan.phases[0].subtasks?.every((subtask) => subtask.work_package)).toBe(true);
      expect(plan.phases[0].subtasks?.[0]?.upstream_task_ids).toEqual(['1.1']);
      expect(plan.phases[0].subtasks?.[0]?.depends_on).toEqual([]);
      expect(plan.phases[0].subtasks?.[7]?.upstream_task_ids).toEqual(['8.1']);
      expect(plan.phases[0].subtasks?.[1]?.depends_on).toEqual(['wp-1']);
      expect(planContent).toContain('_Depends on: none_');
      expect(planContent).toContain('- [ ] wp. Runtime work packages');
      expect(tasksContent).toContain('- [ ] 8. Phase 8');
      const legacyShardPath = join(specDir, ['implementation_plan', 'phase-1', 'json'].join('.'));
      await expect(readFile(legacyShardPath, 'utf-8')).rejects.toThrow();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('does not mark failed non-fallback phases as completed in saved state', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => ({
      outcome: config.specPhase === 'discovery' || config.specPhase === 'requirements'
        ? 'completed' as const
        : 'cancelled' as const,
      stepsExecuted: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      messages: [],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'complex',
        workflowConfig: { optimizationLevel: 'balanced', maxSpecPhaseRetries: 0 },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const state = JSON.parse(await readFile(join(specDir, 'spec_state.json'), 'utf-8'));

      expect(result.success).toBe(false);
      expect(result.phasesExecuted).toEqual(['discovery', 'requirements', 'context']);
      expect(state.completedPhases).toEqual(['discovery', 'requirements']);
      expect(runSession).toHaveBeenCalledTimes(3);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('compacts aggressive simple plans into one coder subtask', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async () => {
      await saveTasksSource(specDir, {
        feature: 'Local Notes Tool',
        workflow_type: 'simple',
        phases: [
          {
            id: '1',
            phase: 1,
            name: 'Implementation',
            subtasks: [
              {
                id: '1.1',
                title: 'Add note model',
                description: 'Create note data structures and persistence helpers.',
                status: 'pending',
                files_to_create: ['src/notes.ts'],
              },
              {
                id: '1-2',
                title: 'Add list state',
                description: 'Create list state and filtering.',
                status: 'pending',
                files_to_create: ['src/notes.ts'],
              },
              {
                id: '1-3',
                title: 'Add controls',
                description: 'Handle add and delete actions.',
                status: 'pending',
                files_to_modify: ['src/notes.ts'],
              },
            ],
          },
        ],
      });

      return {
        outcome: 'completed' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 2,
        durationMs: 1,
      };
    });

    try {
      await writeValidStandardArtifacts(specDir, 'Local Notes Tool');
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small local notes tool',
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'Create the implementation task catalog.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('planning', 1, 1);
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        phases: Array<{ subtasks: Array<{
          title: string;
          description: string;
          files_to_create?: string[];
          files_to_modify?: string[];
          work_package?: boolean;
          upstream_task_ids?: string[];
          definition_fingerprint?: string;
          source_task_fingerprints?: Record<string, string>;
        }> }>;
      };

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].subtasks).toHaveLength(1);
      expect(plan.phases[0].subtasks[0].work_package).toBe(true);
      expect(plan.phases[0].subtasks[0].upstream_task_ids).toEqual(['1.1', '1-2', '1-3']);
      expect(plan.phases[0].subtasks[0].title).toContain('Add note model');
      expect(plan.phases[0].subtasks[0].description).toContain('Add note model');
      expect(plan.phases[0].subtasks[0].description).toContain('Add list state');
      expect(plan.phases[0].subtasks[0].title).toContain('(+2)');
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['src/notes.ts']);
      expect(plan.phases[0].subtasks[0].files_to_modify).toEqual(['src/notes.ts']);
      expect(plan.phases[0].subtasks[0].definition_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(plan.phases[0].subtasks[0].source_task_fingerprints ?? {})).toEqual([
        '1.1',
        '1-2',
        '1-3',
      ]);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('uses specification writing plus deterministic validation for balanced standard tasks', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);

      if (config.specPhase === 'requirements') {
        await writeValidRequirementsArtifact(
          specDir,
          'Refactor runtime metadata schema and update compatibility handling',
        );
      }
      if (config.specPhase === 'spec_writing') {
        await writeValidSpecArtifact(specDir);
      }
      await writeDesignArtifactForPhase(specDir, config.specPhase);
      if (config.specPhase === 'planning') {
        await saveTasksSource(specDir, {
          feature: 'Runtime metadata compatibility',
          workflow_type: 'refactor',
          phases: [{
            id: '1',
            name: 'Implementation',
            subtasks: [{
              id: '1.1',
              title: 'Refactor runtime metadata compatibility handling',
              description: 'Update runtime metadata schema and compatibility handling.',
              status: 'pending',
              files_to_modify: ['src/runtime-metadata.ts'],
              architecture: 'runtime metadata boundary; adapter compatibility strategy; source spec.md Architecture And Design Pattern References',
              verification: { type: 'manual', run: 'Run focused runtime metadata compatibility checks.' },
            }],
          }],
        });
      }

      return {
        outcome: 'completed' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 2,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor runtime metadata schema and update compatibility handling',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run compact Standard planning.'),
        runSession,
      });

      const result = await orchestrator.run();

      expect(phases, JSON.stringify(result)).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
      ]);
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ success: true });
      const validationReport = await readFile(join(specDir, 'spec_validation_report.md'), 'utf-8');

      expect(result.success).toBe(true);
      expect(result.phasesExecuted).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
        'validation',
      ]);
      expect(phases).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
      ]);
      expect(phases).not.toContain('validation');
      expect(runSession).toHaveBeenCalledTimes(9);
      expect(validationReport).toContain('Status: PASSED');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('runs analysis and documentation planning without Design-Contract phases or stale design binding', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const designExemptions: Array<boolean | undefined> = [];
    const taskDescription = 'Analyze task logs and generate a Markdown findings report without modifying source code.';
    const runSession = vi.fn(async (config: SpecSessionRunConfig) => {
      phases.push(config.specPhase);
      designExemptions.push(config.designContractExempt);

      if (config.specPhase === 'requirements') {
        await writeValidRequirementsArtifact(specDir, taskDescription, 'analysis');
      } else if (config.specPhase === 'spec_writing') {
        await writeValidSpecArtifact(specDir);
      } else if (config.specPhase === 'planning') {
        await writeFile(
          join(specDir, AUTOCODE_TASK_ARTIFACTS.tasks),
          stringifyAutocodeTaskDefinitionsMarkdown({
            feature: 'Task log findings report',
            workflow_type: 'analysis',
            phases: [{
              id: '1',
              name: 'Analysis and documentation',
              subtasks: [{
                id: '1.1',
                title: 'Analyze the task logs and write the findings report',
                description: [
                  'Analyze the supplied task-log evidence and document the root cause.',
                  'Done when: findings.md contains the evidence-backed conclusion and verification notes.',
                ].join('\n'),
                status: 'pending',
                requirements: ['R1', 'AC1', 'SCN-1'],
                evidence: 'E1; requirements.md R1; spec.md SCN-1',
                files_to_create: ['findings.md'],
                verification: {
                  type: 'manual',
                  scenario: 'Open findings.md and verify that each conclusion cites task-log evidence.',
                },
              }],
            }],
          }),
          'utf-8',
        );
      }

      return makeCompletedSpecSessionResult();
    });

    try {
      // Simulate a reused directory containing an unrelated package from an older implementation plan.
      await writeValidDesignArtifacts(specDir);

      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription,
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run non-implementation Standard planning.'),
        runSession,
      });

      const classificationContext = await (orchestrator as unknown as {
        readDesignContractClassificationContext: () => Promise<{
          description: string;
          plan: Record<string, unknown> | null;
          metadata: Record<string, unknown> | null;
        }>;
      }).readDesignContractClassificationContext();
      expect(classificationContext).toEqual({
        description: taskDescription,
        plan: null,
        metadata: null,
      });

      const result = await orchestrator.run();
      expect(result.success, JSON.stringify(result)).toBe(true);
      const plan = await loadAutocodeImplementationPlan(specDir);
      const planText = await readFile(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan), 'utf-8');

      expect(result.phasesExecuted).toEqual([
        'requirements',
        'spec_writing',
        'planning',
        'validation',
      ]);
      expect(phases).toEqual(['requirements', 'spec_writing', 'planning']);
      expect(designExemptions).toEqual([true, true, true]);
      expect(phases).not.toContain('design');
      expect((plan as unknown as Record<string, unknown>).design_contract).toBeUndefined();
      expect(planText).not.toContain('design_contract');
      expect(planText).not.toContain('Design-Contract: 5');

      const staleRuntimePlan = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      staleRuntimePlan.source_task = {
        ...((staleRuntimePlan.source_task as Record<string, unknown> | undefined) ?? {}),
        design_contract: { version: 5, fingerprint: 'stale-package' },
      };
      await saveAutocodeImplementationPlan(specDir, staleRuntimePlan as never);
      const checkpointErrors = await (orchestrator as unknown as {
        validateSavedPhaseCheckpoint: (phase: SpecPhase) => Promise<string[]>;
      }).validateSavedPhaseCheckpoint('planning');
      expect(checkpointErrors).toContain(
        'implementation_plan.md still binds a Design-Contract package for a non-implementation task.',
      );
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('maps a legacy quick_spec checkpoint to spec_writing without rerunning the completed pipeline', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));

    try {
      const initialOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir),
      });
      expect((await initialOrchestrator.run()).success).toBe(true);

      await writeFile(join(specDir, 'spec_state.json'), JSON.stringify({
        complexity: 'standard',
        completedPhases: [
          'requirements',
          'quick_spec',
          'requirement_model',
          'domain_model',
          'design',
          'design_model',
          'implementation_model',
          'design_review',
          'planning',
          'validation',
        ],
        lastUpdated: '2026-05-13T00:00:00.000Z',
      }), 'utf-8');

      const resumedSession = createStandardPipelineSession(specDir);
      const resumedOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: resumedSession,
      });

      const result = await resumedOrchestrator.run();
      const state = JSON.parse(await readFile(join(specDir, 'spec_state.json'), 'utf-8')) as {
        completedPhases: string[];
      };

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(resumedSession).not.toHaveBeenCalled();
      expect(state.completedPhases).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
        'validation',
      ]);
      expect(state.completedPhases).not.toContain('quick_spec');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('invalidates planning and validation checkpoints when implementation_plan.md is missing', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));

    try {
      const initialOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir),
      });
      expect((await initialOrchestrator.run()).success).toBe(true);
      await rm(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan), { force: true });

      const phases: SpecPhase[] = [];
      const resumedSession = createStandardPipelineSession(specDir, phases);
      const resumedOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: resumedSession,
      });

      const result = await resumedOrchestrator.run();

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(phases).toEqual(['planning']);
      await expect(readFile(
        join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan),
        'utf-8',
      )).resolves.toContain('# Runtime Execution Ledger');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('safely discards malformed and unknown saved phases', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];

    try {
      await writeFile(join(specDir, 'spec_state.json'), JSON.stringify({
        complexity: 'max',
        completedPhases: ['unknown_phase', null, 'planning', 'planning'],
        lastUpdated: 42,
      }), 'utf-8');

      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir, phases),
      });

      const result = await orchestrator.run();
      const state = JSON.parse(await readFile(join(specDir, 'spec_state.json'), 'utf-8')) as {
        complexity?: string;
        completedPhases: string[];
      };

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(phases).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
      ]);
      expect(state.complexity).toBe('standard');
      expect(state.completedPhases).not.toContain('unknown_phase');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('invalidates every downstream checkpoint when an earlier artifact is missing', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));

    try {
      const initialOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir),
      });
      expect((await initialOrchestrator.run()).success).toBe(true);
      await rm(join(specDir, AUTOCODE_TASK_ARTIFACTS.requirements), { force: true });

      const phases: SpecPhase[] = [];
      const resumedOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir, phases),
      });

      const result = await resumedOrchestrator.run();

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(phases).toEqual([
        'requirements',
        'spec_writing',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'planning',
      ]);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('invalidates a non-empty failed design review checkpoint and every later phase', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));

    try {
      const initialOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir),
      });
      expect((await initialOrchestrator.run()).success).toBe(true);
      await writeFile(
        join(specDir, AUTOCODE_TASK_ARTIFACTS.designReview),
        'Status: FAILED\n\nThe saved review no longer approves this design.\n',
        'utf-8',
      );

      const phases: SpecPhase[] = [];
      const logs: string[] = [];
      const resumedOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir, phases),
      });
      resumedOrchestrator.on('log', (message) => logs.push(String(message)));

      const result = await resumedOrchestrator.run();

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(phases).toEqual(['design_review', 'planning']);
      expect(logs.some((log) => log.includes('Invalidated saved design_review checkpoint'))).toBe(true);
      await expect(readFile(
        join(specDir, AUTOCODE_TASK_ARTIFACTS.designReview),
        'utf-8',
      )).resolves.toContain('Status: PASSED');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('reruns deterministic validation when its saved report has a failed verdict', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));

    try {
      const initialOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: createStandardPipelineSession(specDir),
      });
      expect((await initialOrchestrator.run()).success).toBe(true);
      await writeFile(
        join(specDir, 'spec_validation_report.md'),
        '# Spec Validation Report\n\nStatus: FAILED\n',
        'utf-8',
      );

      const resumedSession = createStandardPipelineSession(specDir);
      const resumedOrchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor local task execution flow',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession: resumedSession,
      });

      const result = await resumedOrchestrator.run();

      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(resumedSession).not.toHaveBeenCalled();
      await expect(readFile(
        join(specDir, 'spec_validation_report.md'),
        'utf-8',
      )).resolves.toContain('Status: PASSED');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('does not use the empty-project simple fast path for integration-heavy tasks', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const emptyProjectIndex = JSON.stringify({
      project_root: specDir,
      project_type: 'single',
      services: {},
      infrastructure: {},
      conventions: {},
    });
    const runSession = vi.fn(async (config: { specPhase: SpecPhase; outputSchema?: unknown }) => {
      phases.push(config.specPhase);
      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small app that integrates OAuth and an external API',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex: emptyProjectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.complexity).toBe('standard');
      expect(result.phasesExecuted[0]).toBe('complexity_assessment');
      expect(phases[0]).toBe('requirements');
      expect(phases).not.toContain('complexity_assessment');
      expect(phases).not.toContain('discovery');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('falls back to complex routing for broad migrations when AI assessment fails', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const projectIndex = JSON.stringify({
      project_type: 'monorepo',
      services: {
        app: { language: 'TypeScript' },
        api: { language: 'Go' },
        worker: { language: 'Python' },
      },
      infrastructure: {
        ci: 'GitHub Actions',
        ci_workflows: ['build.yml', 'release.yml'],
      },
      source_summary: {
        source_file_count: 1200,
        total_file_count: 3200,
        languages: ['TypeScript', 'Go', 'Python'],
        build_files: ['Makefile'],
        project_files: ['app.workspace'],
      },
    });
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);
      if (config.specPhase === 'complexity_assessment') {
        return {
          outcome: 'error' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          error: { code: 'network_error', message: 'network error', retryable: true },
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Migrate and remove the old runtime, replace editor UI, build tooling, CI release pipeline, asset templates, plugin API compatibility, rollback, and platform packaging paths.',
        workflowConfig: { optimizationLevel: 'conservative', specCreationMode: 'phased', qualityChecks: { enableSelfCritique: true } },
        projectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const state = JSON.parse(await readFile(join(specDir, 'spec_state.json'), 'utf-8')) as { complexity?: string };
      const assessment = JSON.parse(await readFile(join(specDir, 'complexity_assessment.json'), 'utf-8')) as { complexity?: string };

      expect(result.success).toBe(false);
      expect(result.complexity).toBe('complex');
      expect(state.complexity).toBe('complex');
      expect(assessment.complexity).toBe('complex');
      expect(phases).toEqual(['complexity_assessment', 'discovery']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('escalates broad conservative platform changes in large multi-subsystem projects', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const projectIndex = JSON.stringify({
      project: { size: 'large', sourceFileCount: 900 },
      services: {
        runtime: { languages: ['C++'] },
        shaders: { languages: ['HLSL'] },
        editor: { languages: ['C#'] },
      },
      source_summary: {
        languages: ['C++', 'HLSL', 'C#'],
        build_files: ['CMakeLists.txt'],
        project_files: ['Engine.sln'],
      },
      infrastructure: {
        ci_workflows: ['build'],
        packaging: ['installer'],
      },
    });
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);
      if (config.specPhase === 'complexity_assessment') {
        return {
          outcome: 'error' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          error: { code: 'network_error', message: 'network error', retryable: true },
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Port the renderer global illumination system from the existing solution to a new runtime architecture with shader and platform integration.',
        workflowConfig: { optimizationLevel: 'conservative', specCreationMode: 'phased', qualityChecks: { enableSelfCritique: true } },
        projectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const assessment = JSON.parse(await readFile(join(specDir, 'complexity_assessment.json'), 'utf-8')) as { complexity?: string };

      expect(result.success).toBe(false);
      expect(result.complexity).toBe('complex');
      expect(assessment.complexity).toBe('complex');
      expect(phases).toEqual(['complexity_assessment', 'discovery']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('recovers complexity assessment from final JSON text without a file write', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);
      if (config.specPhase === 'complexity_assessment') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [{
            role: 'assistant' as const,
            content: JSON.stringify({
              tier: 'high',
              confidence: 80,
              explanation: 'Large multi-area platform change.',
              needs_self_critique: true,
            }),
          }],
          toolCallCount: 0,
          durationMs: 1,
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Refactor the platform workflow.',
        workflowConfig: { optimizationLevel: 'conservative' },
        projectIndex: '{}',
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const assessment = JSON.parse(await readFile(join(specDir, 'complexity_assessment.json'), 'utf-8')) as {
        complexity?: string;
        confidence?: number;
      };

      expect(result.success).toBe(false);
      expect(result.complexity).toBe('complex');
      expect(assessment.complexity).toBe('complex');
      expect(assessment.confidence).toBe(0.8);
      expect(phases).toEqual(['complexity_assessment', 'discovery']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('restores complexity from complexity_assessment.json when old state omitted it', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);
      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      await writeFile(join(specDir, 'spec_state.json'), JSON.stringify({
        completedPhases: ['complexity_assessment'],
        lastUpdated: '2026-05-13T00:00:00.000Z',
      }), 'utf-8');
      await writeFile(join(specDir, 'complexity_assessment.json'), JSON.stringify({
        complexity: 'complex',
        confidence: 0.8,
        reasoning: 'Previously assessed as complex.',
        needs_self_critique: true,
      }), 'utf-8');

      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Continue the migration plan.',
        workflowConfig: { optimizationLevel: 'conservative' },
        projectIndex: '{}',
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(result.complexity).toBe('complex');
      expect(phases).toEqual(['discovery']);
      expect(phases).not.toContain('complexity_assessment');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('routes MMO complexity assessment through the MMO system designer', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const agentCalls: string[] = [];
    const generatePrompt = vi.fn(async (agentType: string) => {
      agentCalls.push(agentType);
      return 'Assess MMO task complexity.';
    });
    const runSession = vi.fn(async (config: { agentType: string; specPhase: SpecPhase }) => {
      agentCalls.push(config.agentType);
      if (config.specPhase === 'complexity_assessment') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          structuredOutput: {
            complexity: 'standard',
            confidence: 0.85,
            reasoning: 'Analyze MMO systems.',
            needs_research: false,
            needs_self_critique: false,
          },
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze the MMO gameplay systems.',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex: JSON.stringify({ services: { client: { languages: ['C++'] } } }),
        agentProfile: MMO_AGENT_PROFILE,
        generatePrompt,
        runSession,
      });

      await orchestrator.run();

      expect(generatePrompt.mock.calls[0][0]).toBe('mmo_system_designer');
      expect(runSession.mock.calls[0][0].agentType).toBe('mmo_system_designer');
      expect(agentCalls.slice(0, 2)).toEqual(['mmo_system_designer', 'mmo_system_designer']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('adds MMO research and self-critique hints for broad game source analysis', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const calls: Array<{ phase: SpecPhase; agentType: string }> = [];
    const projectIndex = JSON.stringify({
      project: { size: 'large', sourceFileCount: 1800 },
      services: {
        client: { languages: ['C++', 'Lua'], frameworks: ['Ogre3D', 'Direct3D'] },
        server: { languages: ['C++'], frameworks: ['socket protocol'] },
        database: { languages: ['SQL'], frameworks: ['MySQL'] },
      },
      source_summary: {
        languages: ['C++', 'Lua', 'HLSL'],
        project_files: ['XYWL_Client.sln', 'GameServer.sln'],
        build_files: ['CMakeLists.txt'],
      },
    });
    const runSession = vi.fn(async (config: { agentType: string; specPhase: SpecPhase }) => {
      calls.push({ phase: config.specPhase, agentType: config.agentType });
      if (config.specPhase === 'complexity_assessment') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          structuredOutput: {
            complexity: 'standard',
            confidence: 0.8,
            reasoning: 'Standard analysis.',
            needs_research: false,
            needs_self_critique: false,
          },
        };
      }

      if (config.specPhase === 'discovery') {
        await writeValidContextArtifact(specDir, 'Analyze MMO source systems and gameplay.');
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
        };
      }

      if (config.specPhase === 'requirements') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          structuredOutput: {
            task_description: 'Analyze MMO source systems and gameplay.',
            workflow_type: 'feature',
            services_involved: ['client', 'server', 'database'],
            user_requirements: ['Identify game systems and gameplay mechanics.'],
            acceptance_criteria: ['The analysis covers engine, server, network, and gameplay systems.'],
            constraints: ['Do not modify source code.'],
            evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
            standards_references: ['Project conventions from AGENTS.md'],
            assumptions: [],
            created_at: '2026-05-20T00:00:00.000Z',
          },
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze what kind of game this is and what systems and gameplay it has.',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex,
        agentProfile: MMO_AGENT_PROFILE,
        generatePrompt: vi.fn(async () => 'Run MMO phase.'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const assessment = JSON.parse(await readFile(join(specDir, 'complexity_assessment.json'), 'utf-8')) as {
        needs_research?: boolean;
        needs_self_critique?: boolean;
        reasoning?: string;
      };

      expect(result.success).toBe(false);
      expect(assessment.needs_research).toBe(true);
      expect(assessment.needs_self_critique).toBe(true);
      expect(assessment.reasoning).toContain('MMO routing hints');
      expect(calls.map((call) => call.phase)).toEqual(['requirements', 'research']);
      expect(calls[0].agentType).toBe('mmo_system_designer');
      expect(calls[1].agentType).toBe('mmo_engine_architect');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('normalizes investigation requirements workflow for source analysis tasks', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      if (config.specPhase === 'requirements') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          structuredOutput: {
            task_description: 'Analyze game source systems and gameplay.',
            workflow_type: 'feature',
            services_involved: ['client'],
            user_requirements: ['Analyze systems.'],
            acceptance_criteria: ['Documentation identifies systems.'],
            constraints: ['Do not modify source.'],
            evidence_sources: [TEST_REQUIREMENT_EVIDENCE],
            standards_references: ['Project conventions from AGENTS.md'],
            assumptions: [],
            created_at: '2026-05-20T00:00:00.000Z',
          },
        };
      }

      return {
        outcome: 'cancelled' as const,
        stepsExecuted: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        messages: [],
        toolCallCount: 0,
        durationMs: 1,
      };
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze game source systems and gameplay without modifying source code.',
        complexityOverride: 'standard',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'Run requirements phase.'),
        runSession,
      });
      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('requirements', 1, 1);
      const requirements = loadAutocodeTaskRequirementsSync(specDir);
      expect(requirements).not.toBeNull();
      if (!requirements) throw new Error('requirements.md was not written');

      expect(result.success).toBe(true);
      expect(requirements.workflow_type).toBe('investigation');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

});

