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

    expect(prompt).toContain('CRITICAL - RETRY WITH SPLIT OUTPUTS');
    expect(prompt).toContain('E:/Work/Project/.autocode/specs/001-task/spec.md');
    expect(prompt).toContain('Do NOT call Write for implementation_plan.json');
    expect(prompt).toContain('final response JSON object');
    expect(prompt).toContain('20-60 line');
    expect(prompt).not.toContain('\\');
  });

  it('tells planner retries to return final JSON instead of using Write', () => {
    const prompt = buildWriteToolJsonRetryPrompt('planning', 'E:\\Work\\Project\\.autocode\\specs\\001-task');

    expect(prompt).toContain('DO NOT USE WRITE FOR implementation_plan.json');
    expect(prompt).toContain('final response JSON object');
    expect(prompt).not.toContain('Required Write tool input shape');
  });
});
