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
          completion_summary: '| Item | Details |\n| --- | --- |\n| What changed | done |',
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

    expect(context).toMatchObject({
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
      completedSummaries: [],
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

    expect(message).toContain('Implement subtask "ui-2" only');
    expect(message).toContain('## Current Work Item');
    expect(message).toContain('src/renderer/components/TaskBadge.tsx');
    expect(message).toContain('src/renderer/TaskBoard.tsx');
    expect(message).toContain('src/renderer/PlanProgress.tsx');
    expect(message).toContain('npm run typecheck');
    expect(message).toContain('Do not read spec.md or implementation_plan.md before implementation');
    expect(message).toContain('one compatible alternative at most');
    expect(message).toContain('Run at most one listed verification');
    expect(message).toContain('Do not try multiple equivalent checks');
    expect(message).toContain('single existence/key-content check is enough');
    expect(message).toContain('avoid nested cmd/powershell quoting');
    expect(message).toContain('Never use Bash here-documents');
    expect(message).toContain('never mix CommonJS `require(...)` with top-level `await`');
    expect(message).toContain('Avoid brittle smoke assertions against initial or transient task status');
    expect(message).toContain('do not keep rewriting commands');
    expect(message).toContain('Do not re-plan completed work');
    expect(message).toContain('few grouped Edits');
    expect(message).toContain('read the current narrow context');
    expect(message).toContain('legacy or non-UTF-8 files as encoding-sensitive');
    expect(message).toContain('do not reread the whole file');
    expect(message).toContain('do not read it back unless verification fails');
    expect(message).toContain('avoid python/node one-liners with non-ASCII quoting');
    expect(message).toContain('actual launch/open/use-path smoke check');
    expect(message).toContain('failed or unavailable startup/use-path check blocks completion');
    expect(message).toContain('Do not call update_subtask_status with status completed for user-facing or runnable work');
    expect(message).toContain('immediately call update_subtask_status');
    expect(message).toContain('before writing any final summary');
    expect(message).toContain('provide only a compact review matrix');
  });

  it('keeps documentation workflow quality while avoiding redundant output checks', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/010',
      '/project',
      '1-1',
      {
        id: '1-1',
        workflowType: 'documentation',
        title: 'Analyze source and generate documentation',
        description: 'Analyze game source and generate a markdown implementation document.',
        filesToModify: [],
        filesToCreate: ['docs/analysis.md'],
        patternFiles: ['CMakeLists.txt', 'src/main.cpp', 'src/Game.h'],
      },
    );

    expect(message).toContain('Quality comes first');
    expect(message).toContain('reading all product source files is acceptable');
    expect(message).toContain('doc_outline.md');
    expect(message).toContain('evidence_index.md');
    expect(message).toContain('Every major conclusion');
    expect(message).toContain('data/state flow');
    expect(message).toContain('Do not pre-create the parent directory with Bash unless Write fails');
    expect(message).toContain('After Write succeeds, do not read generated files back');
    expect(message).toContain('Treat successful Write results as verification');
    expect(message).not.toContain('at most 6 additional source files');
  });

  it('adds MMO documentation execution rules for game project documentation', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/011',
      '/project',
      '1-1',
      {
        id: '1-1',
        workflowType: 'documentation',
        projectType: 'game-mmo',
        documentationProfile: 'game-mmo-source',
        documentationFocus: ['server authority, network sync, anti-cheat, live operations'],
        title: 'Analyze MMO source documentation',
        description: 'Generate professional MMO source documentation.',
        filesToModify: [],
        filesToCreate: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        patternFiles: ['GameServer.cpp', 'Client/Game.cpp'],
      },
    );

    expect(message).toContain('large-online-game/MMO engineering');
    expect(message).toContain('server authority');
    expect(message).toContain('network sync/protocol');
    expect(message).toContain('GM/editor tools');
    expect(message).toContain('anti-cheat');
    expect(message).toContain('system matrices');
  });

  it('adds MMO coding quality rules for game implementation subtasks', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/012',
      '/project',
      '2-3',
      {
        id: '2-3',
        projectType: 'game-mmo',
        title: 'Implement combat replication',
        description: 'Update server combat replication and client reconciliation.',
        filesToModify: ['Server/Combat.cpp', 'Client/CombatPrediction.cpp'],
        filesToCreate: [],
        patternFiles: ['Server/Replication.cpp'],
      },
    );

    expect(message).toContain('MMO implementation quality');
    expect(message).toContain('server-authoritative');
    expect(message).toContain('replication');
    expect(message).toContain('protocol/save/tooling contracts');
    expect(message).toContain('completion summary');
  });

  it('includes prior completion summaries to avoid rereading completed subtask files', () => {
    const message = buildFocusedCoderKickoffMessageFromContext(
      '/specs/006',
      '/project',
      '3.4',
      {
        id: '3.4',
        title: 'Implement current pass',
        description: 'Continue the rendering pipeline.',
        phaseName: 'Rendering',
        filesToModify: ['src/render/pass.cpp'],
        filesToCreate: [],
        patternFiles: ['src/render/existing-pass.cpp'],
        completedSummaries: [
          {
            id: '3.2',
            title: 'Create shader',
            summary: '| Item | Details | | What changed | Added shader resource bindings |',
          },
        ],
      },
    );

    expect(message).toContain('## Prior Completed Work In This Phase');
    expect(message).toContain('3.2 Create shader');
    expect(message).toContain('Added shader resource bindings');
    expect(message).toContain('instead of rereading completed subtask files');
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
