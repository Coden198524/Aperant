import { describe, expect, it } from 'vitest';

import { validateAutocodeStandardPlanArtifacts } from './plan-quality.js';

describe('standard plan quality', () => {
  it('rejects generic tasks that have no project-specific anchor', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Improve planning',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Implement feature',
        '    - Update the code.',
        '    - _Files to modify: none_',
        '    - _Depends on: none_',
        '    - _Requirements: 1.1_',
        '    - _Evidence: spec.md requirement 1.1_',
        '    - _Verification: npm test_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 is too generic');
    expect(result.errors.join('\n')).toContain('has no project-specific task anchors');
  });

  it('accepts concise tasks grounded in source files and existing runtime boundaries', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Improve planning',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Tighten planner quality gate',
        '    - Update `validateAutocodeStandardPlanArtifacts` so tasks stay grounded in source-backed planning evidence.',
        '    - _Files to modify: libs/core/src/tasks/plan-quality.ts_',
        '    - _Depends on: none_',
        '    - _Requirements: 1.1_',
        '    - _Evidence: libs/core/src/tasks/plan-quality.ts validateTasksEvidence pattern_',
        '    - _Verification: npx vitest libs/core/src/tasks/plan-quality.test.ts_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
