import { describe, expect, it } from 'vitest';

import {
  SPEC_TASK_DESCRIPTION_FROM_INITIAL_MAX_CHARS,
  extractSpecTaskDescriptionFromInitialMessages,
} from '../task-description';

describe('extractSpecTaskDescriptionFromInitialMessages', () => {
  it('removes runtime metadata from spec creation initial messages', () => {
    const task = extractSpecTaskDescriptionFromInitialMessages([{
      content: [
        'Task: Improve planning context carryover.',
        '',
        'Project directory: E:/repo',
        'Spec directory: E:/repo/.autocode/specs/001-task',
        'Base branch: master',
        'Auto-approve: true',
      ].join('\n'),
    }]);

    expect(task).toBe('Improve planning context carryover.');
  });

  it('removes legacy project documentation blocks from initial messages', () => {
    const task = extractSpecTaskDescriptionFromInitialMessages([{
      content: [
        'Task: Add project docs reminder.',
        '',
        '# Project Documentation Reference',
        '',
        '- .autocode/project-docs/index.md',
        '- Deep project docs content that should not become the task.',
      ].join('\n'),
    }]);

    expect(task).toBe('Add project docs reminder.');
    expect(task).not.toContain('Project Documentation Reference');
    expect(task).not.toContain('Deep project docs content');
  });

  it('compacts oversized task messages while preserving head and tail requirements', () => {
    const longTask = [
      'Task: Opening worker rule: keep parsed configuration data as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large worker task context ${index}: ${'diagnostic text '.repeat(8)}`,
      ),
      'Closing worker rule: convert only model-readable prose references to Markdown.',
      'Project directory: E:/repo',
    ].join('\n');

    const task = extractSpecTaskDescriptionFromInitialMessages([{ content: longTask }]);

    expect(task).toContain('Opening worker rule: keep parsed configuration data as JSON.');
    expect(task).toContain('task description middle omitted for worker budget');
    expect(task).toContain('Closing worker rule: convert only model-readable prose references to Markdown.');
    expect(task).not.toContain('Large worker task context 160');
    expect(task).not.toContain('Project directory');
    expect(task.length).toBeLessThanOrEqual(SPEC_TASK_DESCRIPTION_FROM_INITIAL_MAX_CHARS);
  });
});
