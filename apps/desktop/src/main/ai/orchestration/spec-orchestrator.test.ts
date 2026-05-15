import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildWriteToolJsonRetryPrompt,
  isWriteToolJsonFailure,
  SpecOrchestrator,
  type SpecPhase,
  type SpecPhaseResult,
} from './spec-orchestrator';

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

    expect(prompt).toContain('CRITICAL - RETRY QUICK SPEC FILE WRITES');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/spec.md');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/implementation_plan.json');
    expect(prompt).toContain('Use the Write tool to create');
    expect(prompt).toContain('20-60 line');
    expect(prompt).not.toContain('\\');
  });

  it('tells planner retries to use split Write files', () => {
    const prompt = buildWriteToolJsonRetryPrompt('planning', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETRY IMPLEMENTATION PLAN WITH WRITE TOOL');
    expect(prompt).toContain('implementation_plan.phase-1.json');
    expect(prompt).toContain('subtasks_file');
    expect(prompt).toContain('Required Write tool input shape');
  });

  it('tells context retries to return final JSON instead of using Write', () => {
    const prompt = buildWriteToolJsonRetryPrompt('discovery', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETURN context.json AS FINAL JSON');
    expect(prompt).toContain('Do NOT call Write for E:/Work/Project/.autocode/specs/001-task/context.json');
    expect(prompt).toContain('files_to_modify');
    expect(prompt).not.toContain('Required Write tool input shape');
    expect(prompt).not.toContain('\\');
  });

  it('tells requirements retries to return final JSON instead of using Write', () => {
    const prompt = buildWriteToolJsonRetryPrompt('requirements', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('RETURN requirements.json AS FINAL JSON');
    expect(prompt).toContain('Do NOT call Write for E:/Work/Project/.autocode/specs/001-task/requirements.json');
    expect(prompt).toContain('task_description');
    expect(prompt).not.toContain('Required Write tool input shape');
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
      const requirements = JSON.parse(await readFile(join(specDir, 'requirements.json'), 'utf-8'));

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
      task: '开发网页版项目看板',
      tech_stack: {
        detected: 'none',
        recommended: 'HTML5 Canvas + CSS + JavaScript',
      },
      architecture_summary: '空项目，创建静态 Web 工具。',
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
      implementation_notes: ['使用原生 HTML/CSS/JavaScript。'],
      risks: ['需要手动浏览器验证。'],
      verification_suggestions: ['打开 index.html 验证。'],
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
        taskDescription: '开发网页版项目看板',
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
      expect(written.task_description).toBe('开发网页版项目看板');
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
      task: '开发网页版项目看板',
      type: 'feature',
      requirements: ['创建项目看板页面', '支持新增、筛选和状态更新'],
      success_criteria: ['打开 index.html 可运行', 'node --check main.js 通过'],
      risks: ['需要人工浏览器冒烟验证'],
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
        taskDescription: '开发网页版项目看板',
        useAiAssessment: false,
        generatePrompt: vi.fn(async () => 'Return requirements JSON.'),
        runSession,
      });

      const runPhase = (orchestrator as unknown as {
        runPhase: (phase: SpecPhase, phaseNumber: number, totalPhases: number) => Promise<SpecPhaseResult>;
      }).runPhase.bind(orchestrator);

      const result = await runPhase('requirements', 1, 1);
      const written = JSON.parse(await readFile(join(specDir, 'requirements.json'), 'utf-8'));

      expect(result).toEqual({ phase: 'requirements', success: true, errors: [], retries: 0 });
      expect(written).toMatchObject({
        task_description: '开发网页版项目看板',
        workflow_type: 'feature',
        user_requirements: ['创建项目看板页面', '支持新增、筛选和状态更新'],
        acceptance_criteria: ['打开 index.html 可运行', 'node --check main.js 通过'],
        constraints: ['需要人工浏览器冒烟验证'],
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
        await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
          feature: 'Refactor local task execution flow',
          workflow_type: 'refactor',
          phases: [{
            id: '1',
            name: 'Implementation',
            subtasks: [{
              id: '1-1',
              title: 'Refactor flow',
              description: 'Refactor local task execution flow.',
              status: 'pending',
              verification: { type: 'manual', run: 'Run tests' },
            }],
          }],
        }, null, 2), 'utf-8');
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
        workflowConfig: { optimizationLevel: 'balanced' },
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

  it('splits complex conservative implementation plans into phase files', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async (config: { specPhase: SpecPhase }) => {
      if (config.specPhase === 'planning') {
        await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
          feature: 'Refactor platform workflow',
          workflow_type: 'refactor',
          phases: Array.from({ length: 8 }, (_, phaseIndex) => ({
            id: String(phaseIndex + 1),
            name: `Phase ${phaseIndex + 1}`,
            subtasks: [
              {
                id: `${phaseIndex + 1}-1`,
                title: `Task ${phaseIndex + 1}`,
                description: `Implement phase ${phaseIndex + 1}.`,
                status: 'pending',
                verification: { type: 'manual', scenario: 'Run applicable checks.' },
              },
            ],
          })),
        }, null, 2), 'utf-8');
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
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        split_plan?: boolean;
        plan_files?: string[];
        phases: Array<{ subtasks_file?: string; subtasks?: unknown[] }>;
      };

      expect(result.success).toBe(true);
      expect(plan.split_plan).toBe(true);
      expect(plan.plan_files).toHaveLength(8);
      expect(plan.phases[0].subtasks ?? []).toHaveLength(0);
      expect(plan.phases[0].subtasks_file).toBe('implementation_plan.phase-1.json');
      await expect(readFile(join(specDir, 'implementation_plan.phase-1.json'), 'utf-8')).resolves.toContain('"subtasks"');
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
      await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
        feature: 'Local Notes Tool',
        workflow_type: 'simple',
        phases: [
          {
            id: '1',
            phase: 1,
            name: 'Implementation',
            subtasks: [
              {
                id: '1-1',
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
      }, null, 2), 'utf-8');

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
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        phases: Array<{ subtasks: Array<{
          title: string;
          description: string;
          files_to_create?: string[];
          files_to_modify?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].subtasks).toHaveLength(1);
      expect(plan.phases[0].subtasks[0].title).toBe('Implement complete task');
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
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        feature: string;
        source_task?: {
          original_request?: string;
          constraint_terms?: string[];
        };
        phases: Array<{ name: string; subtasks: Array<{
          title: string;
          description: string;
          pattern_files?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(spec).toContain(`# \u5feb\u901f\u89c4\u683c\uff1a${localizedTask}`);
      expect(spec).not.toContain('Project directory');
      expect(plan.feature).toBe(localizedTask);
      expect(plan.source_task?.constraint_terms).toEqual(expect.arrayContaining(['C++', 'Console']));
      expect(plan.phases[0].name).toBe('\u5b9e\u73b0');
      expect(plan.phases[0].subtasks[0].title).toBe('\u5b9e\u73b0\u5b8c\u6574\u4efb\u52a1');
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
        taskDescription: 'Task: 用 C++ 实现一个控制台待办事项工具',
        complexityOverride: 'simple',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
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
        await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
          feature: 'Local app',
          workflow_type: 'simple',
          phases: [{
            id: '1',
            name: 'Implementation',
            subtasks: [{
              id: '1-1',
              title: 'Implement complete task',
              description: 'Implement the local app.',
              status: 'pending',
              verification: { type: 'manual', run: 'Open the app locally.' },
            }],
          }],
        }, null, 2), 'utf-8');
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
        taskDescription: '实现一个小型本地可运行应用，用一个文件说明运行方式',
        workflowConfig: { optimizationLevel: 'balanced' },
        projectIndex: emptyProjectIndex,
        generatePrompt: vi.fn(async () => 'Run phase.'),
        runSession,
      });

      const result = await orchestrator.run();
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
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
        taskDescription: '分析源码架构并生成一份中文 Markdown 文档',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const spec = await readFile(join(specDir, 'spec.md'), 'utf-8');
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        workflow_type: string;
        phases: Array<{ name: string; subtasks: Array<{
          title: string;
          description: string;
          verification?: { run?: string };
          pattern_files?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(result.complexity).toBe('simple');
      expect(result.phasesExecuted).toEqual(['complexity_assessment', 'quick_spec']);
      expect(spec).toContain('文档分析任务');
      expect(plan.workflow_type).toBe('documentation');
      expect(plan.phases).toHaveLength(1);
      expect(plan.phases[0].name).toBe('文档分析');
      expect(plan.phases[0].subtasks).toHaveLength(1);
      expect(plan.phases[0].subtasks[0].title).toBe('分析源码并生成文档');
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
        taskDescription: '分析游戏源码，生成游戏实现方案的markdown文档。',
        workflowConfig: { optimizationLevel: 'aggressive' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        workflow_type: string;
        phases: Array<{ subtasks: Array<{ files_to_create?: string[]; pattern_files?: string[] }> }>;
      };
      const subtask = plan.phases[0].subtasks[0];

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(plan.workflow_type).toBe('documentation');
      expect(subtask.files_to_create).toEqual(['docs/analysis.md']);
      expect(subtask.pattern_files).toContain('CMakeLists.txt');
      expect(subtask.pattern_files).toContain('src/main.cpp');
      expect(subtask.pattern_files).toContain('src/Game.h');
      expect(subtask.pattern_files?.some((file) => file.includes('**'))).toBe(false);
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
        taskDescription: '分析游戏源码，生成游戏实现方案的markdown文档，不修改任何源码',
        workflowConfig: { optimizationLevel: 'balanced' },
        generatePrompt: vi.fn(async () => 'should not be used'),
        runSession,
        language: 'zh-CN',
      });

      const result = await orchestrator.run();
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
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
      const plan = JSON.parse(await readFile(join(specDir, 'implementation_plan.json'), 'utf-8')) as {
        phases: Array<{ subtasks: Array<{ files_to_create?: string[] }> }>;
      };

      expect(result.success).toBe(true);
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['tools/report.py']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });
});

