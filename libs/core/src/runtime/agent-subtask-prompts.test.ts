import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_PLANNING_RETRY_CONTEXT_MAX_CHARS,
  AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS,
  AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT,
  AUTOCODE_SUBTASK_CONTEXT_FILE_MAX_CHARS,
  AUTOCODE_SUBTASK_CONTEXT_TOTAL_MAX_CHARS,
  buildAutocodePlannerPrompt,
  buildAutocodeSubtaskPrompt,
  formatAutocodeSubtaskContextForPrompt,
} from './agent-subtask-prompts.js';

describe('agent subtask prompt compaction', () => {
  it('bounds retry recovery hints and omits older hints', () => {
    const prompt = buildAutocodeSubtaskPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      subtask: {
        id: '1.1',
        description: 'Fix settings persistence',
        status: 'pending',
      },
      attemptCount: 4,
      recoveryHints: [
        `old hint ${'detail '.repeat(80)}SHOULD_NOT_APPEAR_OLD_HINT_TAIL`,
        `first kept hint ${'detail '.repeat(80)}FIRST_HINT_TAIL_OK`,
        `second kept hint ${'detail '.repeat(80)}SECOND_HINT_TAIL_OK`,
        `third kept hint ${'detail '.repeat(80)}THIRD_HINT_TAIL_OK`,
      ],
    });

    expect(prompt).toContain('Previous attempt insights');
    expect(prompt).toContain('1 earlier hint(s) omitted');
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('SHOULD_NOT_APPEAR_OLD_HINT_TAIL');
    expect(prompt).toContain('FIRST_HINT_TAIL_OK');
    expect(prompt).toContain('SECOND_HINT_TAIL_OK');
    expect(prompt).toContain('THIRD_HINT_TAIL_OK');
  });

  it('bounds long descriptions and large file lists', () => {
    const prompt = buildAutocodeSubtaskPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      subtask: {
        id: '2.1',
        description: `Update generated UI state ${'detail '.repeat(300)}DESC_TAIL_OK`,
        status: 'pending',
        filesToModify: Array.from(
          { length: 30 },
          (_, index) => `src/${index}/${'nested/'.repeat(40)}PATH_TAIL_${index}.ts`,
        ),
        filesToCreate: Array.from(
          { length: 30 },
          (_, index) => `tests/${index}/${'nested/'.repeat(40)}CREATE_TAIL_${index}.ts`,
        ),
        patternsFrom: Array.from(
          { length: 30 },
          (_, index) => `patterns/${index}/${'nested/'.repeat(40)}PATTERN_TAIL_${index}.ts`,
        ),
      },
    });

    expect(prompt).toContain('Update generated UI state');
    expect(prompt).toContain('truncated');
    expect(prompt).toContain('... 6 more');
    expect(prompt).toContain('DESC_TAIL_OK');
    expect(prompt).toContain('PATH_TAIL_0.ts');
    expect(prompt).toContain('CREATE_TAIL_0.ts');
    expect(prompt).toContain('PATTERN_TAIL_0.ts');
    expect(prompt).not.toContain('PATH_TAIL_29.ts');
    expect(prompt).not.toContain('CREATE_TAIL_29.ts');
    expect(prompt).not.toContain('PATTERN_TAIL_29.ts');
  });

  it('folds repeated subtask description lines before building prompts', () => {
    const repeatedLine = 'SUBTASK DESCRIPTION REPEAT: same implementation detail.';
    const prompt = buildAutocodeSubtaskPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      subtask: {
        id: '2.2',
        description: [
          'SUBTASK DESCRIPTION HEAD',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'SUBTASK DESCRIPTION TAIL',
        ].join('\n'),
        status: 'pending',
      },
    });

    expect(prompt).toContain('SUBTASK DESCRIPTION HEAD');
    expect(prompt).toContain('SUBTASK DESCRIPTION TAIL');
    expect(prompt).toContain('119 repeated line(s) omitted for prompt budget');
    expect((prompt.match(/SUBTASK DESCRIPTION REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('bounds large subtask context files with head and tail excerpts', () => {
    const context = {
      patterns: Object.fromEntries(Array.from({ length: AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT + 2 }, (_, index) => [
        `src/pattern-${index}.ts`,
        [
          `PATTERN_${index}_HEAD`,
          'x'.repeat(AUTOCODE_SUBTASK_CONTEXT_FILE_MAX_CHARS * 2),
          `PATTERN_${index}_TAIL`,
        ].join('\n'),
      ])),
      filesToModify: Object.fromEntries(Array.from({ length: AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT + 2 }, (_, index) => [
        `src/modify-${index}.ts`,
        [
          `MODIFY_${index}_HEAD`,
          'y'.repeat(AUTOCODE_SUBTASK_CONTEXT_FILE_MAX_CHARS * 2),
          `MODIFY_${index}_TAIL`,
        ].join('\n'),
      ])),
      specExcerpt: null,
    };

    const formatted = formatAutocodeSubtaskContextForPrompt(context);

    expect(formatted.length).toBeLessThanOrEqual(AUTOCODE_SUBTASK_CONTEXT_TOTAL_MAX_CHARS);
    expect(formatted).toContain('## Reference Files (Patterns to Follow)');
    expect(formatted).toContain('PATTERN_0_HEAD');
    expect(formatted).toContain('PATTERN_0_TAIL');
    expect(formatted).toContain('file content truncated');
    expect(formatted).toContain('context file(s) omitted');
    expect(formatted).not.toContain(`src/pattern-${AUTOCODE_SUBTASK_CONTEXT_FILE_LIMIT + 1}.ts`);
    expect(formatted).not.toContain('MODIFY_7_HEAD');
  });

  it('folds repeated subtask context file lines before spending context budget', () => {
    const repeatedLine = 'SUBTASK CONTEXT REPEAT: same file content line.';
    const formatted = formatAutocodeSubtaskContextForPrompt({
      patterns: {
        'src/repeated-pattern.ts': [
          'SUBTASK CONTEXT HEAD',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'SUBTASK CONTEXT TAIL',
        ].join('\n'),
      },
      filesToModify: {},
      specExcerpt: null,
    });

    expect(formatted).toContain('SUBTASK CONTEXT HEAD');
    expect(formatted).toContain('SUBTASK CONTEXT TAIL');
    expect(formatted).toContain('119 repeated line(s) omitted for prompt budget');
    expect((formatted.match(/SUBTASK CONTEXT REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('bounds project instructions and planning retry context in planner prompts', () => {
    const prompt = buildAutocodePlannerPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      basePlannerPrompt: 'Create the plan.',
      projectInstructions: [
        'PROJECT_RULE_HEAD',
        'x'.repeat(AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS * 2),
        'PROJECT_RULE_TAIL_PRESERVED',
      ].join('\n'),
      planningRetryContext: [
        'RETRY_CONTEXT_HEAD',
        'y'.repeat(AUTOCODE_PLANNING_RETRY_CONTEXT_MAX_CHARS * 2),
        'RETRY_CONTEXT_TAIL_PRESERVED',
      ].join('\n'),
    });

    expect(prompt).toContain('PROJECT_RULE_HEAD');
    expect(prompt).toContain('project instructions truncated');
    expect(prompt).toContain('PROJECT_RULE_TAIL_PRESERVED');
    expect(prompt).toContain('RETRY_CONTEXT_HEAD');
    expect(prompt).toContain('planning retry context truncated');
    expect(prompt).toContain('RETRY_CONTEXT_TAIL_PRESERVED');
  });

  it('bounds project instructions in subtask prompts', () => {
    const prompt = buildAutocodeSubtaskPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      subtask: {
        id: '3.1',
        description: 'Apply project instruction compaction',
      },
      projectInstructions: [
        'SUBTASK_PROJECT_RULE_HEAD',
        'z'.repeat(AUTOCODE_PROJECT_INSTRUCTIONS_MAX_CHARS * 2),
        'SUBTASK_PROJECT_RULE_TAIL_PRESERVED',
      ].join('\n'),
    });

    expect(prompt).toContain('SUBTASK_PROJECT_RULE_HEAD');
    expect(prompt).toContain('project instructions truncated');
    expect(prompt).toContain('SUBTASK_PROJECT_RULE_TAIL_PRESERVED');
  });

  it('requires contract-aware code quality without default commits', () => {
    const prompt = buildAutocodeSubtaskPrompt({
      specDir: 'E:/project/.autocode/specs/001-task',
      projectDir: 'E:/project',
      subtask: {
        id: '4.1',
        description: 'Fix settings persistence',
        filesToModify: ['src/settings/store.ts'],
        patternsFrom: ['src/settings/store.test.ts'],
      },
    });

    expect(prompt).toContain('Identify the local implementation contract');
    expect(prompt).toContain('without placeholder code');
    expect(prompt).toContain('closest regression test');
    expect(prompt).toContain('Do not commit or push');
    expect(prompt).toContain('changed files/contracts');
    expect(prompt).toContain('No console.log/print debugging statements, placeholders');
    expect(prompt).not.toContain('git commit -m');
  });
});
