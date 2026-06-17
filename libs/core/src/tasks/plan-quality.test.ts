import { describe, expect, it } from 'vitest';

import { validateAutocodeStandardPlanArtifacts } from './plan-quality.js';

describe('standard plan quality', () => {
  it('accepts spec Requirements backed by a global Evidence section', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      specMarkdown: [
        '# Spec',
        '',
        '## Requirements',
        '',
        '- The planner keeps runtime work packages traceable.',
        '',
        '## Evidence',
        '',
        '- libs/core/src/tasks/plan-quality.ts validates plan artifact quality.',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

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
        '    - _Done when: the concrete behavior is implemented and the focused check passes_',
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
        '    - _Done when: task evidence validation rejects ungrounded planner output without blocking source-backed tasks_',
        '    - _Verification: npx vitest libs/core/src/tasks/plan-quality.test.ts_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects tasks that are not mapped to requirements or completion criteria', () => {
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
        '    - Update `validateAutocodeStandardPlanArtifacts` around `validateTasksEvidence`.',
        '    - _Files to modify: libs/core/src/tasks/plan-quality.ts_',
        '    - _Depends on: none_',
        '    - _Evidence: libs/core/src/tasks/plan-quality.ts validateTasksEvidence pattern_',
        '    - _Verification: npx vitest libs/core/src/tasks/plan-quality.test.ts_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 missing _Requirements');
    expect(result.errors.join('\n')).toContain('task 1.1 missing a done signal');
  });

  it('rejects an empty tasks.md checklist', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Improve planning',
        'Workflow: feature',
        'Status: pending',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('tasks.md contains no executable subtasks');
  });
});
