import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  loadAutocodeImplementationPlan,
  loadAutocodeTaskRequirementsSync,
  stringifyAutocodeImplementationPlanMarkdown,
} from '@autocode/core';

import {
  buildWriteToolJsonRetryPrompt,
  isWriteToolJsonFailure,
  SpecOrchestrator,
  type SpecPhase,
  type SpecPhaseResult,
} from './spec-orchestrator';
import { MMO_AGENT_PROFILE } from '../config/project-agent-profile';

async function saveTasksSource(specDir: string, plan: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(specDir, 'tasks.md'),
    stringifyAutocodeImplementationPlanMarkdown(plan).replace(/^# Implementation Plan/m, '# Tasks'),
    'utf-8',
  );
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

  it('builds compact retry guidance with normalized paths', () => {
    const prompt = buildWriteToolJsonRetryPrompt('quick_spec', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY QUICK SPEC WRITES');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/spec.md');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/tasks.md');
    expect(prompt).toContain('Use the Write tool to create');
    expect(prompt).toContain('20-60 line');
    expect(prompt).not.toContain('\\');
  });

  it('tells planner retries to write one Markdown task list', () => {
    const prompt = buildWriteToolJsonRetryPrompt('planning', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY TASKS WRITE');
    expect(prompt).toContain('tasks.md');
    expect(prompt).toContain('Write checklist Markdown, not JSON');
    expect(prompt).toContain('Write input shape');
  });

  it('tells context retries to return final JSON instead of using Write', () => {
    const prompt = buildWriteToolJsonRetryPrompt('discovery', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETURN context.json AS FINAL JSON');
    expect(prompt).toContain('Target file: E:/Work/Project/.autocode/specs/001-task/context.json');
    expect(prompt).toContain('files_to_modify');
    expect(prompt).not.toContain('Write input shape');
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

      expect(result).toEqual({ phase: 'requirements', success: true, errors: [], retries: 2 });
      expect(requirements).toMatchObject({
        task_description: '\u4fee\u590d\u4efb\u52a1\u6682\u505c\u540e\u8bf7\u6c42\u7edf\u8ba1\u6b21\u6570\u7a81\u7136\u589e\u591a\u7684\u95ee\u9898',
        workflow_type: 'bugfix',
        services_involved: [],
      });
      expect(requirements.user_requirements).toEqual(['\u4fee\u590d\u4efb\u52a1\u6682\u505c\u540e\u8bf7\u6c42\u7edf\u8ba1\u6b21\u6570\u7a81\u7136\u589e\u591a\u7684\u95ee\u9898']);
      expect(requirements).not.toHaveProperty('generated_by_fallback');
      expect(runSession).toHaveBeenCalledTimes(3);
      expect(runSession.mock.calls[0][0].outputSchema).toBeDefined();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('writes discovery context from final JSON text when no file is created', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const context = {
      task_description: 'Create a small local dashboard',
      scoped_services: [],
      architecture_summary: 'Empty static web project.',
      files_to_modify: [{
        path: 'index.html',
        reason: 'Main page',
        change_needed: 'Create the dashboard UI and script',
      }],
      files_to_reference: [],
      design_patterns: [],
      implementation_notes: ['Use plain HTML, CSS, and JavaScript.'],
      risks: ['Manual browser verification is required.'],
      verification_suggestions: ['Open index.html in a browser.'],
      created_at: '2026-05-13T00:00:00.000Z',
    };
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant' as const, content: JSON.stringify(context) }],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small local dashboard',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return context JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('discovery', 1, 1);
      const written = JSON.parse(await readFile(join(specDir, 'context.json'), 'utf-8'));

      expect(result).toEqual({ phase: 'discovery', success: true, errors: [], retries: 0 });
      expect(written).toEqual(context);
      expect(runSession).toHaveBeenCalledTimes(1);
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
        generatePrompt: vi.fn(async () => 'Return context JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('discovery', 1, 1);
      const context = JSON.parse(await readFile(join(specDir, 'context.json'), 'utf-8'));

      expect(result).toEqual({ phase: 'discovery', success: true, errors: [], retries: 2 });
      expect(context.task_description).toBe('Create a Windows-style calculator page');
      expect(context.scoped_services).toEqual([]);
      expect(context.files_to_modify).toEqual([]);
      expect(context.implementation_notes[0]).toContain('task description');
      expect(context.risks[0]).toContain('Discovery fallback');
      expect(runSession).toHaveBeenCalledTimes(3);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('normalizes loose discovery JSON before writing context output', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const looseContext = {
      project_root: 'E:/Work/Test/aitest',
      task: 'Create a web project dashboard',
      tech_stack: {
        detected: 'none',
        recommended: 'HTML5 Canvas + CSS + JavaScript',
      },
      architecture_summary: 'Empty project; create a static web tool.',
      files_to_modify: [
        'E:/Work/Test/aitest/index.html',
        'E:/Work/Test/aitest/styles.css',
        'E:/Work/Test/aitest/main.js',
      ],
      files_to_reference: [],
      scoped_services: [],
      design_patterns: [
        'HTML5 Canvas rendering',
        'DOM event handling',
      ],
      implementation_notes: ['Use native HTML, CSS, and JavaScript.'],
      risks: ['Manual browser verification is required.'],
      verification_suggestions: ['Open index.html to verify.'],
    };
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant' as const, content: JSON.stringify(looseContext) }],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a web project dashboard',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return context JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('discovery', 1, 1);
      const written = JSON.parse(await readFile(join(specDir, 'context.json'), 'utf-8'));

      expect(result).toEqual({ phase: 'discovery', success: true, errors: [], retries: 0 });
      expect(written.task_description).toBe('Create a web project dashboard');
      expect(written.files_to_modify[0]).toEqual({
        path: 'E:/Work/Test/aitest/index.html',
        reason: 'Relevant file for the requested change',
        change_needed: 'Create or update this file to implement the task',
      });
      expect(written.design_patterns[0]).toEqual({
        name: 'HTML5 Canvas rendering',
        existing_usage: 'Not detected',
        files: [],
        guidance: 'HTML5 Canvas rendering',
      });
      expect(written.created_at).toEqual(expect.any(String));
      expect(runSession).toHaveBeenCalledTimes(1);
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
        user_requirements: ['Create the dashboard page', 'Support add, filter, and status updates'],
        acceptance_criteria: ['Open index.html successfully', 'node --check main.js passes'],
        constraints: ['Manual browser smoke testing is required'],
      });
      expect(written.created_at).toEqual(expect.any(String));
      expect(runSession).toHaveBeenCalledTimes(1);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('normalizes loose research JSON before writing research output', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const looseResearch = {
      recommended_approach: 'No external dependency is required; follow the existing project structure.',
      validation_plan: ['Run the smallest available project check.'],
      risks: ['Manual review may be needed if no automated check exists.'],
    };
    const runSession = vi.fn(async () => ({
      outcome: 'completed' as const,
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant' as const, content: JSON.stringify(looseResearch) }],
      toolCallCount: 0,
      durationMs: 1,
    }));

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small local utility',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return research JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('research', 1, 1);
      const written = JSON.parse(await readFile(join(specDir, 'research.json'), 'utf-8'));

      expect(result).toEqual({ phase: 'research', success: true, errors: [], retries: 0 });
      expect(written.integrations_researched).toEqual([]);
      expect(written.recommendations).toEqual([
        'No external dependency is required; follow the existing project structure.',
        'Run the smallest available project check.',
      ]);
      expect(written.unverified_claims).toEqual([{
        claim: 'Manual review may be needed if no automated check exists.',
        reason: 'Not independently verified during this phase',
        risk_level: 'low',
      }]);
      expect(written.created_at).toEqual(expect.any(String));
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
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [{
            role: 'assistant' as const,
            content: JSON.stringify({
              task_description: 'Refactor local task execution flow',
              scoped_services: [],
              architecture_summary: 'Local codebase change.',
              files_to_modify: [],
              files_to_reference: [],
              design_patterns: [],
              implementation_notes: ['Reuse existing patterns.'],
              risks: [],
              verification_suggestions: ['Run tests.'],
              created_at: '2026-05-13T00:00:00.000Z',
            }),
          }],
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
              created_at: '2026-05-13T00:00:00.000Z',
            }),
          }],
          toolCallCount: 0,
          durationMs: 1,
        };
      }

      if (config.specPhase === 'spec_writing' || config.specPhase === 'self_critique') {
        await writeFile(join(specDir, 'spec.md'), '# Spec\n\nRefactor local task execution flow.\n', 'utf-8');
      }

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

      expect(result.success).toBe(true);
      expect(phases).not.toContain('research');
      expect(phases).toEqual([
        'discovery',
        'requirements',
        'context',
        'spec_writing',
        'self_critique',
        'planning',
        'validation',
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
      expect(plan.phases[0].subtasks?.[7]?.upstream_task_ids).toEqual(['8.1']);
      expect(plan.phases[0].subtasks?.[1]?.depends_on).toEqual(['wp-1']);
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

  it('compacts aggressive simple quick specs into one coder subtask', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async () => {
      await writeFile(join(specDir, 'spec.md'), '# Quick Spec: Local Notes Tool\n', 'utf-8');
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
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Create a small local notes tool',
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'Create quick spec and plan.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('quick_spec', 1, 1);
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        phases: Array<{ subtasks: Array<{
          title: string;
          description: string;
          files_to_create?: string[];
          files_to_modify?: string[];
          work_package?: boolean;
          upstream_task_ids?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].subtasks).toHaveLength(1);
      expect(plan.phases[0].subtasks[0].work_package).toBe(true);
      expect(plan.phases[0].subtasks[0].upstream_task_ids).toEqual(['1.1', '1-2', '1-3']);
      expect(plan.phases[0].subtasks[0].title).toContain('Add note model');
      expect(plan.phases[0].subtasks[0].description).toContain('Add note model');
      expect(plan.phases[0].subtasks[0].description).toContain('Add list state');
      expect(plan.phases[0].subtasks[0].description).toContain('Add controls');
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['src/notes.ts']);
      expect(plan.phases[0].subtasks[0].files_to_modify).toEqual(['src/notes.ts']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('writes localized aggressive quick specs from only the user task text', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();
    const localizedTask = '\u7528 C++ \u5b9e\u73b0\u4e00\u4e2a\u63a7\u5236\u53f0\u5f85\u529e\u4e8b\u9879\u5de5\u5177';
    const taskDescription = [
      `Task: ${localizedTask}`,
      '',
      'Project directory: E:\\Work\\Test\\aitest',
      'Spec directory: E:\\Work\\Test\\aitest\\.autocode\\specs\\002-c',
      'Base branch: master',
      'Auto-approve: true',
    ].join('\n');

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription,
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      await writeFile(join(specDir, 'main.cpp'), 'int main() { return 0; }\n', 'utf-8');

      const result = await orchestrator.run();
      const spec = await readFile(join(specDir, 'spec.md'), 'utf-8');
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        feature: string;
        source_task?: {
          original_request?: string;
          constraint_terms?: string[];
        };
        phases: Array<{ name: string; subtasks: Array<{
          title: string;
          description: string;
          pattern_files?: string[];
          work_package?: boolean;
          upstream_task_ids?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(spec).toContain(`# \u5feb\u901f\u89c4\u683c\uff1a${localizedTask}`);
      expect(spec).not.toContain('Project directory');
      expect(plan.feature).toBe(localizedTask);
      expect(plan.source_task?.constraint_terms).toEqual(expect.arrayContaining(['C++', 'Console']));
      expect(plan.phases[0].name).toBe('\u8fd0\u884c\u5de5\u4f5c\u5305');
      expect(plan.phases[0].subtasks[0].work_package).toBe(true);
      expect(plan.phases[0].subtasks[0].upstream_task_ids).toEqual(['1.1']);
      expect(plan.phases[0].subtasks[0].title).toContain('\u5b9e\u73b0\u5b8c\u6574\u4efb\u52a1');
      expect(plan.phases[0].subtasks[0].description).toContain('C++');
      expect(plan.phases[0].subtasks[0].description).not.toContain('Spec directory');
      expect(plan.phases[0].subtasks[0].pattern_files).toContain('main.cpp');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('adds generic create-file hints for aggressive quick specs in empty projects', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Task: 鐢?C++ 瀹炵幇涓€涓帶鍒跺彴寰呭姙浜嬮」宸ュ叿',
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        phases: Array<{ subtasks: Array<{
          files_to_create?: string[];
          pattern_files?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['CMakeLists.txt', 'src/main.cpp']);
      expect(plan.phases[0].subtasks[0].pattern_files).toBeUndefined();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('keeps balanced simple tasks on quick_spec plus validation instead of aggressive local planning', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const phases: SpecPhase[] = [];
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      phases.push(config.specPhase);
      if (config.specPhase === 'quick_spec') {
        await writeFile(join(specDir, 'spec.md'), '# Quick Spec\n\nImplement the local app.\n', 'utf-8');
        await saveTasksSource(specDir, {
          feature: 'Local app',
          workflow_type: 'simple',
          phases: [{
            id: '1',
            name: 'Implementation',
            subtasks: [{
              id: '1.1',
              title: 'Implement complete task',
              description: 'Implement the local app.',
              status: 'pending',
              verification: { type: 'manual', run: 'Open the app locally.' },
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
    const emptyProjectIndex = JSON.stringify({
      project_root: specDir,
      project_type: 'single',
      services: {},
      infrastructure: {},
      conventions: {},
    });

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Build a small local app and document how to run it.',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex: emptyProjectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        workflow_type: string;
        phases: Array<{ subtasks: unknown[] }>;
      };

      expect(result.success).toBe(true);
      expect(result.complexity).toBe('simple');
      expect(result.phasesExecuted).toEqual(['complexity_assessment', 'quick_spec', 'validation']);
      expect(phases).toEqual(['quick_spec', 'validation']);
      expect(plan.workflow_type).toBe('simple');
      expect(plan.phases[0].subtasks).toHaveLength(1);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('uses a local one-subtask plan for source analysis documentation tasks', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      await writeFile(join(specDir, 'engine.cpp'), 'void tick() {}\n', 'utf-8');
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze source structure and generate one Markdown document.',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const spec = await readFile(join(specDir, 'spec.md'), 'utf-8');
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        workflow_type: string;
        documentation_depth?: string;
        document_outputs?: {
          final_markdown?: string;
          outline?: string;
          evidence_index?: string;
        };
        phases: Array<{ name: string; subtasks: Array<{
          title: string;
          description: string;
          verification?: { run?: string };
          pattern_files?: string[];
          files_to_create?: string[];
          work_package?: boolean;
          upstream_task_ids?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(result.complexity).toBe('simple');
      expect(result.phasesExecuted).toEqual(['complexity_assessment', 'quick_spec']);
      expect(spec).toContain('文档分析任务');
      expect(plan.workflow_type).toBe('documentation');
      expect(plan.documentation_depth).toBeTruthy();
      expect(plan.document_outputs?.outline).toBe('doc_outline.json');
      expect(plan.document_outputs?.evidence_index).toBe('evidence_index.json');
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(expect.arrayContaining([
        'doc_outline.json',
        'evidence_index.json',
      ]));
      expect(plan.phases[0].subtasks[0].description).toContain('doc_outline.json');
      expect(plan.phases[0].subtasks[0].description).toContain('evidence_index.json');
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].name).toBe('运行工作包');
      expect(plan.phases[0].subtasks).toHaveLength(1);
      expect(plan.phases[0].subtasks[0].work_package).toBe(true);
      expect(plan.phases[0].subtasks[0].upstream_task_ids).toEqual(['1.1']);
      expect(plan.phases[0].subtasks[0].title).toContain('分析源码并生成文档');
      expect(plan.phases[0].subtasks[0].description).toContain('不修改产品代码');
      expect(plan.phases[0].subtasks[0].verification?.run).toContain('不要为纯文档任务运行编译或 QA');
      expect(plan.phases[0].subtasks[0].pattern_files).toContain('engine.cpp');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('does not seed documentation plans with recursive source globs', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      await writeFile(join(specDir, 'CMakeLists.txt'), 'add_executable(app src/main.cpp src/Game.cpp)\n', 'utf-8');
      await mkdir(join(specDir, 'src'), { recursive: true });
      await writeFile(join(specDir, 'src', 'main.cpp'), 'int main() { return 0; }\n', 'utf-8');
      await writeFile(join(specDir, 'src', 'Game.h'), 'class Game {};\n', 'utf-8');
      await writeFile(join(specDir, 'src', 'Game.cpp'), '#include "Game.h"\n', 'utf-8');

      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze game source code and generate a Markdown implementation document.',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        workflow_type: string;
        phases: Array<{ subtasks: Array<{ files_to_create?: string[]; pattern_files?: string[] }> }>;
      };
      const subtask = plan.phases[0].subtasks[0];

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(plan.workflow_type).toBe('documentation');
      expect(subtask.files_to_create).toEqual([
        'docs/analysis.md',
        'doc_outline.json',
        'evidence_index.json',
      ]);
      expect(subtask.pattern_files).toContain('CMakeLists.txt');
      expect(subtask.pattern_files).toContain('src/main.cpp');
      expect(subtask.pattern_files).toContain('src/Game.h');
      expect(subtask.pattern_files?.some((file) => file.includes('**'))).toBe(false);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('adds MMO documentation profile requirements for game project documentation', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      await writeFile(join(specDir, 'GameServer.cpp'), 'void sync_combat() {}\n', 'utf-8');
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze MMO source architecture and generate a Markdown document without changing code.',
        complexityOverride: 'simple',
        useAiAssessment: false,
        workflowConfig: { optimizationLevel: 'aggressive' },
        agentProfile: MMO_AGENT_PROFILE,
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
      });

      const result = await orchestrator.run();
      const spec = await readFile(join(specDir, 'spec.md'), 'utf-8');
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        project_type?: string;
        documentation_profile?: string;
        documentation_focus?: string[];
        phases: Array<{ subtasks: Array<{ description: string }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(plan.project_type).toBe('game-mmo');
      expect(plan.documentation_profile).toBe('game-mmo-source');
      expect(plan.documentation_focus?.join('\n')).toContain('server authority');
      expect(spec).toContain('large online game / MMO source analysis');
      expect(plan.phases[0].subtasks[0].description).toContain('server authority');
      expect(plan.phases[0].subtasks[0].description).toContain('network sync');
      expect(plan.phases[0].subtasks[0].description).toContain('live operations');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('treats implementation plan documentation wording as documentation-only', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Analyze game source code, generate a Markdown implementation document, and do not modify any source code.',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        workflow_type: string;
        phases: Array<{ subtasks: unknown[] }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(result.phasesExecuted).toEqual(['complexity_assessment', 'quick_spec']);
      expect(plan.workflow_type).toBe('documentation');
      expect(plan.phases[0].subtasks).toHaveLength(1);
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
            confidence: 0.9,
            reasoning: 'External API integration requires normal planning.',
          },
        };
      }

      if (config.specPhase === 'discovery') {
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [{
            role: 'assistant' as const,
            content: JSON.stringify({
              task_description: 'Create a small app that integrates OAuth and an external API',
              scoped_services: [],
              architecture_summary: 'External integration task.',
              files_to_modify: [],
              files_to_reference: [],
              design_patterns: [],
              implementation_notes: ['Plan integration details.'],
              risks: ['External API behavior.'],
              verification_suggestions: ['Run tests.'],
              created_at: '2026-05-13T00:00:00.000Z',
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
        taskDescription: 'Create a small app that integrates OAuth and an external API',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex: emptyProjectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();

      expect(result.success).toBe(false);
      expect(phases[0]).toBe('complexity_assessment');
      expect(phases).toContain('discovery');
      expect(phases).not.toContain('quick_spec');
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
        workflowConfig: { optimizationLevel: 'balanced' },
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
        return {
          outcome: 'completed' as const,
          stepsExecuted: 1,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          messages: [],
          toolCallCount: 0,
          durationMs: 1,
          structuredOutput: {
            task_description: 'Analyze MMO source systems and gameplay.',
            scoped_services: ['client', 'server', 'database'],
            architecture_summary: 'Large C++/Lua MMO with engine, server, network, and data layers.',
            files_to_modify: [],
            files_to_reference: [],
            design_patterns: [],
            implementation_notes: ['Document systems.'],
            risks: ['Broad analysis scope.'],
            verification_suggestions: ['Review generated docs.'],
            created_at: '2026-05-20T00:00:00.000Z',
          },
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
      expect(calls.map((call) => call.phase)).toEqual(['complexity_assessment', 'discovery', 'requirements', 'research']);
      expect(calls[0].agentType).toBe('mmo_system_designer');
      expect(calls[1].agentType).toBe('mmo_system_designer');
      expect(calls[2].agentType).toBe('mmo_system_designer');
      expect(calls[3].agentType).toBe('mmo_engine_architect');
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

  it('prefers explicit filenames over inferred aggressive create-file hints', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();

    try {
      const orchestrator = new SpecOrchestrator({
        specDir,
        projectDir: specDir,
        taskDescription: 'Task: Create a Python tool in tools/report.py',
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
      });

      const result = await orchestrator.run();
      const plan = await loadAutocodeImplementationPlan(specDir) as unknown as {
        phases: Array<{ subtasks: Array<{ files_to_create?: string[] }> }>;
      };

      expect(result.success).toBe(true);
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['tools/report.py']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });
});

