import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('compacts aggressive simple quick specs into one coder subtask', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn(async () => {
      await writeFile(join(specDir, 'spec.md'), '# Quick Spec: Tetris\n', 'utf-8');
      await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
        feature: 'Tetris',
        workflow_type: 'simple',
        phases: [
          {
            id: '1',
            phase: 1,
            name: 'Implementation',
            subtasks: [
              {
                id: '1-1',
                title: 'Add tetromino logic',
                description: 'Create tetromino shapes and rotation rules.',
                status: 'pending',
                files_to_create: ['src/game.ts'],
              },
              {
                id: '1-2',
                title: 'Add board state',
                description: 'Create board state and line clearing.',
                status: 'pending',
                files_to_create: ['src/game.ts'],
              },
              {
                id: '1-3',
                title: 'Add controls',
                description: 'Handle keyboard input.',
                status: 'pending',
                files_to_modify: ['src/game.ts'],
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
        taskDescription: 'Create a small Tetris game',
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
      expect(plan.phases[0].subtasks[0].description).toContain('Add tetromino logic');
      expect(plan.phases[0].subtasks[0].description).toContain('Add board state');
      expect(plan.phases[0].subtasks[0].description).toContain('Add controls');
      expect(plan.phases[0].subtasks[0].files_to_create).toEqual(['src/game.ts']);
      expect(plan.phases[0].subtasks[0].files_to_modify).toEqual(['src/game.ts']);
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('writes localized aggressive quick specs from only the user task text', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'autocode-spec-'));
    const runSession = vi.fn();
    const taskDescription = [
      'Task: \u7528 C++ \u5b9e\u73b0\u4e00\u4e2a\u63a7\u5236\u53f0\u4fc4\u7f57\u65af\u65b9\u5757\u6e38\u620f',
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
        phases: Array<{ name: string; subtasks: Array<{
          title: string;
          description: string;
          pattern_files?: string[];
        }> }>;
      };

      expect(result.success).toBe(true);
      expect(runSession).not.toHaveBeenCalled();
      expect(spec).toContain('# \u5feb\u901f\u89c4\u683c\uff1a\u7528 C++ \u5b9e\u73b0\u4e00\u4e2a\u63a7\u5236\u53f0\u4fc4\u7f57\u65af\u65b9\u5757\u6e38\u620f');
      expect(spec).not.toContain('Project directory');
      expect(plan.feature).toBe('\u7528 C++ \u5b9e\u73b0\u4e00\u4e2a\u63a7\u5236\u53f0\u4fc4\u7f57\u65af\u65b9\u5757\u6e38\u620f');
      expect(plan.phases[0].name).toBe('\u5b9e\u73b0');
      expect(plan.phases[0].subtasks[0].title).toBe('\u5b9e\u73b0\u5b8c\u6574\u4efb\u52a1');
      expect(plan.phases[0].subtasks[0].description).not.toContain('Spec directory');
      expect(plan.phases[0].subtasks[0].pattern_files).toContain('main.cpp');
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });
});

