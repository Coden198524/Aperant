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
    expect(message).toContain('clang++ -std=c++17');
    expect(message).toContain('Do not re-plan completed work');
    expect(message).toContain('immediately call update_subtask_status');
    expect(message).toContain('before writing any final summary');
    expect(message).toContain('provide only a compact review matrix');
  });

  it('keeps normal workflow budgets lower than the legacy unlimited fallback', () => {
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.spec).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.planning).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.coding).toBeLessThan(1000);
    expect(DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS.qa).toBeLessThan(1000);
  });
});
