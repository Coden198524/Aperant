import { describe, expect, it } from 'vitest';

import {
  buildFocusedCoderKickoffMessageFromContext,
  DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS,
  findSubtaskKickoffContext,
} from './session-efficiency';

describe('session-efficiency', () => {
  it('extracts focused kickoff context for a single subtask', () => {
    const context = findSubtaskKickoffContext({
      phases: [{
        name: 'UI polish',
        subtasks: [{
          id: 'ui-2',
          title: 'Show plan progress',
          description: 'Render planning progress next to the task badge.',
          files_to_modify: ['src/renderer/TaskBoard.tsx'],
          files_to_create: ['src/renderer/PlanProgress.tsx'],
          pattern_files: ['src/renderer/components/TaskBadge.tsx'],
          verification: {
            type: 'command',
            run: 'npm run typecheck',
            expected: 'passes',
          },
        }],
      }],
    }, 'ui-2');

    expect(context).toEqual({
      id: 'ui-2',
      title: 'Show plan progress',
      description: 'Render planning progress next to the task badge.',
      phaseName: 'UI polish',
      filesToModify: ['src/renderer/TaskBoard.tsx'],
      filesToCreate: ['src/renderer/PlanProgress.tsx'],
      patternFiles: ['src/renderer/components/TaskBadge.tsx'],
      verification: {
        type: 'command',
        run: 'npm run typecheck',
        expected: 'passes',
      },
    });
  });

  it('builds a focused coder kickoff message with file and verification guidance', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/006',
      '/project',
      'ui-2',
      {
        id: 'ui-2',
        title: 'Show plan progress',
        description: 'Render planning progress next to the task badge.',
        phaseName: 'UI polish',
        filesToModify: ['src/renderer/TaskBoard.tsx'],
        filesToCreate: ['src/renderer/PlanProgress.tsx'],
        patternFiles: ['src/renderer/components/TaskBadge.tsx'],
        verification: {
          type: 'command',
          run: 'npm run typecheck',
        },
      },
    );

    expect(message).toContain('Implement ONLY subtask "ui-2"');
    expect(message).toContain('## Current Subtask');
    expect(message).toContain('src/renderer/components/TaskBadge.tsx');
    expect(message).toContain('src/renderer/TaskBoard.tsx');
    expect(message).toContain('src/renderer/PlanProgress.tsx');
    expect(message).toContain('npm run typecheck');
    expect(message).toContain('Do not read spec.md or implementation_plan.json before implementation');
    expect(message).toContain('one compatible alternative at most');
    expect(message).toContain('Do not re-plan completed work');
    expect(message).toContain('immediately call update_subtask_status');
    expect(message).toContain('before writing any final summary');
    expect(message).toContain('provide only a compact review matrix');
  });

  it('keeps Windows project paths usable in Bash commands', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      'E:/Work/Test/aitest/.autocode/specs/002-c',
      'E:/Work/Test/aitest',
      'impl-1',
      {
        id: 'impl-1',
        filesToModify: [],
        filesToCreate: ['src/main.cpp'],
        patternFiles: [],
      },
    );

    expect(message).toContain('cd /d E:\\Work\\Test\\aitest');
    expect(message).toContain('do not convert it to Unix-style paths');
  });

  it('does not ask for discovery or reads when the subtask only creates listed files', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/006',
      '/project',
      'doc-1',
      {
        id: 'doc-1',
        title: 'Create answer',
        description: 'Write the answer to a new markdown file.',
        filesToModify: [],
        filesToCreate: ['README.md'],
        patternFiles: [],
      },
    );

    expect(message).toContain('No existing file read is required');
    expect(message).toContain('overwrite/update');
    expect(message).toContain('README.md');
    expect(message).not.toContain('minimal target discovery');
    expect(message).not.toContain('clang++');
  });

  it('limits discovery when the plan has no file focus', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/006',
      '/project',
      'impl-1',
      {
        id: 'impl-1',
        title: 'Implement task',
        description: 'Build the requested app.',
        filesToModify: [],
        filesToCreate: [],
        patternFiles: [],
      },
    );

    expect(message).toContain('No file focus was provided by the plan');
    expect(message).toContain('at most one narrow root-file check');
    expect(message).toContain('Do not run repeated globs');
    expect(message).not.toContain('No file list is provided');
  });

  it('keeps normal workflow budgets lower than the legacy unlimited fallback', () => {
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.spec).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.planning).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.coding).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.qa).toBeLessThan(1000);
  });
});
