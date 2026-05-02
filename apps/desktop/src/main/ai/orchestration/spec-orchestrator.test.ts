import { describe, expect, it } from 'vitest';

import {
  buildWriteToolJsonRetryPrompt,
  isWriteToolJsonFailure,
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
});
