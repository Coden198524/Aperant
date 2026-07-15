import { describe, expect, it } from 'vitest';
import {
  validateAutocodeCompletedTaskDefinitionHistory,
  validateAutocodeStandardArtifactResponsibilities,
} from './standard-artifact-contract.js';

function makeTasks(title = 'Create page shell', extraTasks: string[] = []): string {
  return [
    '# Tasks',
    '',
    'Tasks-Contract: 1',
    'Feature: Static history',
    'Workflow: feature',
    '',
    '- [ ] 1. Implementation',
    '',
    `  - [ ] 1.1 ${title}`,
    '    - Implement the page shell in the existing renderer boundary.',
    '    - _Files to modify: src/page.ts_',
    '    - _Depends on: none_',
    '    - _Requirements: R1, AC1_',
    '    - _Design: SYS-001, DES-001, IMP-001_',
    '    - _Evidence: E1; src/page.ts existing entry_',
    '    - _Done when: the shell renders_',
    '    - _Verification: npm test -- page.test.ts_',
    '',
    ...extraTasks,
  ].join('\n');
}

function makePreviousLedger(status: 'completed' | 'pending' = 'completed'): string {
  const marker = status === 'completed' ? 'x' : ' ';
  return [
    '# Runtime Execution Ledger',
    '',
    'Status: pending',
    '<!-- autocode-plan-meta: {"source_task":{"runtime_ledger_schema":"autocode-runtime-ledger/v1"},"subtaskMetadata":{"wp-1":{"work_package":true,"upstream_task_ids":["1.1"],"depends_on":[],"definition_fingerprint":"package-fingerprint","source_task_fingerprints":{"1.1":"task-fingerprint"}}}} -->',
    '',
    `- [${marker}] wp. Runtime work packages`,
    '',
    `  - [${marker}] wp-1 Work package`,
    '    - _Depends on: none_',
    '',
  ].join('\n');
}

describe('Standard artifact responsibility contract', () => {
  it('allows checkbox normalization without changing a completed static definition', () => {
    const result = validateAutocodeCompletedTaskDefinitionHistory({
      previousTasksMarkdown: makeTasks().replace('  - [ ] 1.1', '  - [x] 1.1'),
      tasksMarkdown: makeTasks(),
      previousImplementationPlanMarkdown: makePreviousLedger(),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects changing a completed task definition under the same ID', () => {
    const result = validateAutocodeCompletedTaskDefinitionHistory({
      previousTasksMarkdown: makeTasks(),
      tasksMarkdown: makeTasks('Revise page shell'),
      previousImplementationPlanMarkdown: makePreviousLedger(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'tasks.md changed completed task 1.1; restore its prior definition and add revised work under a new task ID.',
    ]);
  });

  it('rejects removing completed task history', () => {
    const result = validateAutocodeCompletedTaskDefinitionHistory({
      previousTasksMarkdown: makeTasks(),
      tasksMarkdown: [
        '# Tasks',
        '',
        'Tasks-Contract: 1',
        '- [ ] 1. Implementation',
        '',
      ].join('\n'),
      previousImplementationPlanMarkdown: makePreviousLedger(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('removed completed task 1.1');
  });

  it('does not freeze definitions that were not completed', () => {
    const result = validateAutocodeCompletedTaskDefinitionHistory({
      previousTasksMarkdown: makeTasks(),
      tasksMarkdown: makeTasks('Revise page shell'),
      previousImplementationPlanMarkdown: makePreviousLedger('pending'),
    });

    expect(result.valid).toBe(true);
  });

  it('allows completed legacy packages retained as history-only runtime entries', () => {
    const result = validateAutocodeStandardArtifactResponsibilities({
      implementationPlanMarkdown: [
        '# Runtime Execution Ledger',
        '',
        'Status: human_review',
        '<!-- autocode-plan-meta: {source_task:{runtime_ledger_schema:autocode-runtime-ledger/v1},subtaskMetadata:{legacy-1:{work_package:true,history_only:true,depends_on:[]}}} -->',
        '',
        '- [x] wp. Runtime work packages',
        '',
        '  - [x] legacy-1 Historical completed package',
        '    - _Depends on: none_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects repeated requirement prose and runtime data in static artifacts', () => {
    const requirementBody = 'The page shell remains visible while navigation state changes.';
    const result = validateAutocodeStandardArtifactResponsibilities({
      requirementsMarkdown: [
        '# Requirements',
        '',
        'Requirements-Contract: 1',
        '## User Requirements',
        `- R1: ${requirementBody}`,
        '## Acceptance Criteria',
        '- AC1: The page shell is visible after navigation.',
        '## Evidence Sources',
        '- E1: src/page.ts - existing shell behavior.',
      ].join('\n'),
      specMarkdown: [
        '# Specification: Page shell',
        '',
        'Specification-Contract: 1',
        '## SCN-001 Navigation',
        'Covers: R1, AC1',
        'Evidence: E1',
        `- Then: ${requirementBody}`,
      ].join('\n'),
      tasksMarkdown: [
        makeTasks(),
        '    - _Started: 2026-07-14T00:00:00.000Z_',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('spec.md repeats R1 prose');
    expect(result.errors.join('\n')).toContain('tasks.md must not contain runtime status');
  });

  it('requires every observable requirement and acceptance ID to be covered by a scenario', () => {
    const result = validateAutocodeStandardArtifactResponsibilities({
      requirementsMarkdown: [
        '# Requirements',
        '',
        'Requirements-Contract: 1',
        '## User Requirements',
        '- R1: The page shell remains visible.',
        '- R2: Navigation failures are reported.',
        '## Acceptance Criteria',
        '- AC1: The shell is visible after navigation.',
        '- AC2: A failed navigation displays an error.',
        '## Evidence Sources',
        '- E1: src/page.ts - current navigation behavior.',
      ].join('\n'),
      specMarkdown: [
        '# Specification: Page shell',
        '',
        'Specification-Contract: 1',
        '## SCN-001 Successful navigation',
        'Covers: R1, AC1',
        'Evidence: E1',
        '- Then: the shell remains visible.',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'spec.md scenarios do not cover requirements.md IDs: R2, AC2.',
    );
  });
});
