import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        taskDescription: '修复任务暂停后请求统计次数突然增多的问题',
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
        task_description: '修复任务暂停后请求统计次数突然增多的问题',
        workflow_type: 'bugfix',
        services_involved: [],
      });
      expect(requirements.user_requirements).toEqual(['修复任务暂停后请求统计次数突然增多的问题']);
      expect(requirements).not.toHaveProperty('generated_by_fallback');
      expect(runSession).toHaveBeenCalledTimes(3);
      expect(runSession.mock.calls[0][0].outputSchema).toBeDefined();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });
});
