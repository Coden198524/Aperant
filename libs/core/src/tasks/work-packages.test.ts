import { describe, expect, it } from 'vitest';
import {
  type AutocodeRuntimeTask,
  buildAutocodeRuntimeImplementationPlanFromTasksMarkdown,
  buildAutocodeRuntimeWorkPackagePhases,
  completeAutocodeRuntimeTaskDependencyGraph,
  estimateAutocodeRuntimeTaskEffort,
  flattenAutocodeRuntimeTasks,
  groupAutocodeRuntimeTasksIntoWorkPackages,
  preserveAutocodeRuntimePlanCompletedStateFromPreviousMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
} from './work-packages.js';
import { parseAutocodeImplementationPlanMarkdown } from './plan-store.js';
import { validateImplementationPlanLanguage } from '../schema/plan-language.js';

function makeTask(overrides: Partial<AutocodeRuntimeTask> & { id: string }): AutocodeRuntimeTask {
  const { id, ...taskOverrides } = overrides;
  return {
    id,
    title: `Task ${id}`,
    description: `Implement task ${id}.`,
    status: 'pending',
    phaseId: '1',
    phaseName: 'Implementation',
    filesToCreate: [],
    filesToModify: [],
    patternFiles: [],
    dependsOn: [],
    requirements: [],
    designRefs: [],
    verification: '',
    ...taskOverrides,
  };
}

function packageEffort(tasks: AutocodeRuntimeTask[]): number {
  return tasks.reduce((sum, task) => sum + estimateAutocodeRuntimeTaskEffort(task), 0);
}

describe('runtime work package balancing', () => {
  it('omits completed upstream tasks when deriving a fresh runtime plan', () => {
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [ ] 1.2 Fix start button behavior',
      '    - Repair the changed start button behavior.',
      '    - _Files to modify: src/main.js_',
      '    - _Depends on: 1.1_',
      '    - _Requirements: R7, AC7_',
      '    - _Evidence: spec.md E5; requirements.md R7_',
      '    - _Done when: the button starts the game_',
      '    - _Verification: click the start button_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: false,
      requireTaskEvidence: true,
    });

    const subtasks = plan.phases[0].subtasks ?? [];

    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].status).toBe('pending');
    expect(subtasks[0].upstream_task_ids).toEqual(['1.2']);
    expect(subtasks[0].depends_on).toEqual([]);
  });

  it('preserves completed runtime work package state for unchanged Standard iteration tasks', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });
    const previousSubtask = previousPlan.phases[0].subtasks?.[0];
    if (previousSubtask) {
      previousSubtask.completed_at = '2026-06-18T00:10:00.000Z';
      previousSubtask.completion_summary = 'Previously implemented page shell.';
    }

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });

    expect(nextPlan.phases[0].subtasks?.[0]?.status).toBe('pending');

    const preservedPlan = preserveAutocodeRuntimePlanCompletedStateFromPreviousMarkdown(
      nextPlan,
      stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    );

    const preservedSubtask = preservedPlan.phases[0].subtasks?.[0];
    expect(preservedSubtask?.status).toBe('completed');
    expect(preservedSubtask?.completed_at).toBe('2026-06-18T00:10:00.000Z');
    expect(preservedSubtask?.completion_summary).toBe('Previously implemented page shell.');
  });

  it('retains the old completed work package and keeps changed iteration work pending', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });


    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R9, AC9_',
      '    - _Evidence: spec.md E9; requirements.md R9_',
      '    - _Verification: inspect index.html for the new feedback_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });

    const preservedPlan = preserveAutocodeRuntimePlanCompletedStateFromPreviousMarkdown(
      nextPlan,
      stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    );

    const subtasks = preservedPlan.phases[0].subtasks ?? [];

    expect(subtasks).toHaveLength(2);
    const historicalSubtask = subtasks.find((subtask) => subtask.history_only === true);
    expect(historicalSubtask?.history_only).toBe(true);
    expect(historicalSubtask?.status).toBe('completed');
    expect(historicalSubtask?.upstream_task_ids).toEqual(['1.1']);
    expect(historicalSubtask?.depends_on).toEqual([]);
    expect(historicalSubtask?.requirements).toBeUndefined();
    expect(subtasks.some((subtask) =>
      subtask.history_only !== true &&
      subtask.status === 'pending' &&
      subtask.requirements?.includes('R9')
    )).toBe(true);
  });
  it('uses the previous runtime plan instead of tasks.md checkboxes during Standard iteration', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });
    const previousSubtask = previousPlan.phases[0].subtasks?.[0];
    if (previousSubtask) {
      previousSubtask.completed_at = '2026-06-18T00:10:00.000Z';
      previousSubtask.completion_summary = 'Previously implemented page shell.';
    }

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [x] 1.2 Add focused follow-up',
      '    - Add the newly requested focused behavior.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; requirements.md R2_',
      '    - _Done when: focused follow-up exists_',
      '    - _Verification: inspect index.html for focused follow-up_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      preserveCompletedStateFromPreviousPlanMarkdown: stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    });

    const subtasks = nextPlan.phases[0].subtasks ?? [];
    expect(subtasks.some((subtask) =>
      subtask.status === 'completed' && subtask.upstream_task_ids?.includes('1.1')
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('1.2')
    )).toBe(true);
  });
  it('retains completed runtime work packages omitted by Standard iteration planning', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [x] 1.2 Add base styling',
      '    - Add the existing base stylesheet.',
      '    - _Files to modify: styles.css_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: spec.md E2; requirements.md R2_',
      '    - _Done when: base styling exists_',
      '    - _Verification: inspect styles.css_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });
    const previousSubtask = previousPlan.phases[0].subtasks?.[0];
    if (previousSubtask) {
      previousSubtask.completed_at = '2026-06-18T00:10:00.000Z';
      previousSubtask.completion_summary = 'Previously implemented shell and styling.';
    }

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 2. Follow-up',
      '',
      '  - [ ] 2.1 Add focused follow-up',
      '    - Add only the newly requested focused behavior.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R3, AC3_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; requirements.md R3_',
      '    - _Done when: focused follow-up exists_',
      '    - _Verification: inspect index.html for focused follow-up_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      preserveCompletedStateFromPreviousPlanMarkdown: stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    });

    const subtasks = nextPlan.phases[0].subtasks ?? [];
    const ids = subtasks.map((subtask) => subtask.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(subtasks.some((subtask) =>
      subtask.status === 'completed' &&
      subtask.completed_at === '2026-06-18T00:10:00.000Z' &&
      subtask.upstream_task_ids?.includes('1.1') &&
      subtask.upstream_task_ids?.includes('1.2')
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('2.1')
    )).toBe(true);
  });

  it('does not duplicate a completed work package when the same upstream task is unchanged', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      preserveCompletedStateFromPreviousPlanMarkdown: stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    });

    const subtasks = nextPlan.phases[0].subtasks ?? [];

    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].status).toBe('completed');
    expect(subtasks[0].upstream_task_ids).toEqual(['1.1']);
  });

  it('retains completed work packages when a new iteration reuses upstream task ids for new work', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });

    const previousSubtask = previousPlan.phases[0].subtasks?.[0];
    if (previousSubtask) {
      previousSubtask.completed_at = '2026-06-18T00:10:00.000Z';
      previousSubtask.completion_summary = 'Completed by Autocode CLI runner.';
    }

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Revise page shell',
      '    - Revise the page shell for the latest feedback.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R9, AC9_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; requirements.md R9_',
      '    - _Done when: revised shell exists_',
      '    - _Verification: inspect index.html for revised shell_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      preserveCompletedStateFromPreviousPlanMarkdown: stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    });

    const subtasks = nextPlan.phases[0].subtasks ?? [];
    const ids = subtasks.map((subtask) => subtask.id);

    expect(subtasks).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(subtasks.some((subtask) =>
      subtask.history_only === true &&
      subtask.status === 'completed' &&
      subtask.upstream_task_ids?.includes('1.1') &&
      subtask.completed_at === '2026-06-18T00:10:00.000Z'
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.history_only !== true &&
      subtask.status === 'pending' &&
      String(subtask.title).includes('Revise page shell')
    )).toBe(true);
  });

  it('preserves completed upstream task state before regrouping Standard iteration work packages', () => {
    const previousPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [x] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
    });

    const nextPlan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Create the existing HTML shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md E1; requirements.md R1_',
      '    - _Done when: page shell exists_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [ ] 1.2 Add focused follow-up',
      '    - Add only the newly requested focused behavior.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: HUMAN_INPUT.md latest change request; requirements.md R2_',
      '    - _Done when: focused follow-up exists_',
      '    - _Verification: inspect index.html for focused follow-up_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:20:00.000Z',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      preserveCompletedStateFromPreviousPlanMarkdown: stringifyAutocodeImplementationPlanMarkdown(previousPlan),
    });

    const subtasks = nextPlan.phases[0].subtasks ?? [];
    expect(subtasks.some((subtask) =>
      subtask.status === 'completed' && subtask.upstream_task_ids?.includes('1.1')
    )).toBe(true);
    expect(subtasks.some((subtask) =>
      subtask.status === 'pending' && subtask.upstream_task_ids?.includes('1.2')
    )).toBe(true);
  });
  it('accepts localized evidence metadata when building runtime work packages', () => {
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create `src/game.js` board factory',
      '    - Add `BOARD_WIDTH`, `BOARD_HEIGHT`, and `createEmptyBoard()` in `src/game.js`.',
      '    - 文件写入意图：src/game.js',
      '    - 依赖：none',
      '    - 需求覆盖：R2; AC2',
      '    - 证据：spec.md Requirements R2; requirements.md Evidence Sources',
      '    - 完成条件：`createEmptyBoard()` returns a 20-row by 10-column empty board.',
      '    - 验证：npm test -- src/game.test.js',
      '',
    ].join('\n'));

    const phases = buildAutocodeRuntimeWorkPackagePhases({
      parsedPhases: parsed.phases as Array<Record<string, unknown>>,
      requireTaskEvidence: true,
      sourceName: 'Autocode',
    });

    expect(phases[0].subtasks).toHaveLength(1);
  });

  it('preserves architecture guidance in runtime work packages without duplicating labels', () => {
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create HTML entry',
      '    - Create `index.html` with the browser game shell.',
      '    - _Files to create: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1.1_',
      '    - _Architecture: static entry layer; HTML structure contract strategy; requirements.md R1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '    - _Done when: index.html contains canvas, status text, restart control, stylesheet link, and module script._',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'));

    const phases = buildAutocodeRuntimeWorkPackagePhases({
      parsedPhases: parsed.phases as Array<Record<string, unknown>>,
      requireTaskEvidence: true,
      sourceName: 'Autocode',
    });
    const subtask = phases[0].subtasks?.[0] as Record<string, unknown>;

    expect(subtask.architecture).toBe('static entry layer; HTML structure contract strategy; requirements.md R1');
    expect(String(subtask.description)).toContain('Architecture: static entry layer; HTML structure contract strategy; requirements.md R1');
    expect(String(subtask.description).match(/Architecture:/g)).toHaveLength(1);
  });

  it('normalizes vague runtime task evidence when deriving work packages', () => {
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Game rules',
      '',
      '  - [ ] 1.1 Define `game.js` board state',
      '    - Add the board dimensions and empty board state for the browser game.',
      '    - _Files to modify: game.js_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: planner note for the board state task_',
      '    - _Done when: the board state can be initialized for gameplay._',
      '    - _Verification: inspect game.js board initialization_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      requireTaskEvidence: true,
      sourcePath: 'tasks.md',
    });

    const evidence = String(plan.phases[0].subtasks?.[0]?.evidence ?? '');

    expect(evidence).toContain('planner note for the board state task');
    expect(evidence).toContain('spec.md Requirements');
    expect(evidence).toContain('requirements.md Evidence Sources');
    expect(evidence).toContain('tasks.md task 1.1');
  });

  it('keeps task state labels out of derived runtime work package titles', () => {
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 obsolete - Split previous broad task',
      '    - Historical task that should not be executed after replanning.',
      '    - _Files to modify: src/game.js_',
      '    - _Depends on: none_',
      '    - _Requirements: R1_',
      '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
      '    - _Verification: inspect history_',
      '',
      '  - [ ] 1.2 needs_revision - Repair start button behavior',
      '    - needs_revision - Repair the playable start button behavior.',
      '    - _Files to modify: src/game.js_',
      '    - _Depends on: none_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
      '    - _Verification: open index.html and click Start_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      includeCompletedTasks: false,
      requireTaskEvidence: true,
    });

    const [workPackage] = plan.phases[0].subtasks ?? [];

    expect(workPackage.upstream_task_ids).toEqual(['1.2']);
    expect(workPackage.title).toBe('Work package: Repair start button behavior');
    expect(workPackage.description).toContain('- 1.2 Repair start button behavior');
    expect(workPackage.description).not.toContain('needs_revision -');
    expect(workPackage.description).not.toContain('obsolete -');
  });

  it('uses a localized fallback feature when Chinese tasks omit Feature metadata', () => {
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. 建立静态 Web 游戏骨架',
      '',
      '  - [ ] 1.1 创建项目脚本与目录约定',
      '    - 在空项目中创建最小原生 Web 项目结构。',
      '    - _Files to modify: package.json_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md Requirements; requirements.md Evidence Sources_',
      '    - _Done when: npm run check 可执行。_',
      '    - _Verification: npm run check_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      requireTaskEvidence: true,
      language: 'zh-CN',
    });

    expect(plan.feature).toBe('Autocode 任务');
    expect(validateImplementationPlanLanguage(plan as never, 'zh-CN')).toEqual([]);
  });

  it('accepts pending dependency chains when deriving runtime work packages', () => {
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Add the static page shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: none_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [ ] 1.2 Add page styling',
      '    - Add the visual layout after the shell exists.',
      '    - _Files to modify: styles.css_',
      '    - _Depends on: 1.1_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
      '    - _Verification: inspect styles.css_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      requireTaskEvidence: true,
    });

    const subtasks = plan.phases[0].subtasks ?? [];

    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].upstream_task_ids).toEqual(['1.1', '1.2']);
    expect(subtasks[0].status).toBe('pending');
  });

  it('normalizes dependencies that point at non-executable phase headings', () => {
    const markdown = [
      '# Tasks',
      '',
      '- [ ] 1. Static app shell',
      '',
      '  - [ ] 1.1 Create semantic HTML shell',
      '    - Add the primary page structure.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: 1_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
      '    - _Verification: inspect index.html_',
      '',
      '  - [ ] 1.2 Add responsive layout',
      '    - Add CSS after the shell exists.',
      '    - _Files to modify: styles.css_',
      '    - _Depends on: 1_',
      '    - _Requirements: R2, AC2_',
      '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
      '    - _Verification: inspect styles.css_',
      '',
      '- [ ] 2. Game rules',
      '',
      '  - [ ] 2.1 Implement board state',
      '    - Add the board state after shell work finishes.',
      '    - _Files to modify: src/game.js_',
      '    - _Depends on: 1_',
      '    - _Requirements: R3, AC3_',
      '    - _Evidence: spec.md R3; requirements.md Evidence Sources_',
      '    - _Verification: inspect board state_',
      '',
      '  - [ ] 2.2 Wire keyboard input',
      '    - Add input handling after board state exists.',
      '    - _Files to modify: src/game.js_',
      '    - _Depends on: 2.1_',
      '    - _Requirements: R4, AC4_',
      '    - _Evidence: spec.md R4; requirements.md Evidence Sources_',
      '    - _Verification: test keyboard controls_',
      '',
      '- [ ] 3. End-to-end verification',
      '  - Validate the browser flow.',
      '  - _Files to modify: none_',
      '  - _Depends on: 2_',
      '  - _Requirements: AC1, AC2, AC3, AC4_',
      '  - _Evidence: spec.md Acceptance Criteria; requirements.md Evidence Sources_',
      '  - _Verification: run the browser smoke test_',
      '',
    ].join('\n');
    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);

    const tasks = completeAutocodeRuntimeTaskDependencyGraph(
      flattenAutocodeRuntimeTasks(parsed.phases as Array<Record<string, unknown>>),
    );
    const dependsOnById = new Map(tasks.map((task) => [task.id, task.dependsOn]));

    expect(dependsOnById.get('1.1')).toEqual([]);
    expect(dependsOnById.get('1.2')).toEqual(['1.1']);
    expect(dependsOnById.get('2.1')).toEqual(['1.2']);
    expect(dependsOnById.get('2.2')).toEqual(['2.1']);
    expect(dependsOnById.get('3')).toEqual(['2.2']);
    expect(() => buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(markdown, {
      now: '2026-06-18T00:00:00.000Z',
      requireTaskEvidence: true,
    })).not.toThrow();
  });

  it('still rejects truly missing dependency references', () => {
    expect(() => buildAutocodeRuntimeImplementationPlanFromTasksMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create page shell',
      '    - Add the static page shell.',
      '    - _Files to modify: index.html_',
      '    - _Depends on: 9.9_',
      '    - _Requirements: R1, AC1_',
      '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
      '    - _Verification: inspect index.html_',
      '',
    ].join('\n'), {
      now: '2026-06-18T00:00:00.000Z',
      requireTaskEvidence: true,
    })).toThrow(/missing work item 9\.9/);
  });

  it('splits a linear dependency chain by estimated effort instead of raw task count', () => {
    const tasks = [
      makeTask({
        id: '1.1',
        title: 'Refactor authentication architecture',
        description: 'Refactor shared authentication architecture and permission persistence contracts.',
        filesToModify: [
          'src/auth/service.ts',
          'src/auth/session.ts',
          'src/auth/permissions.ts',
          'src/auth/storage.ts',
          'src/auth/index.ts',
          'src/shared/auth.ts',
        ],
      }),
      makeTask({ id: '1.2', title: 'Rename login label', dependsOn: ['1.1'] }),
      makeTask({ id: '1.3', title: 'Update docs copy', dependsOn: ['1.2'] }),
      makeTask({ id: '1.4', title: 'Adjust empty state text', dependsOn: ['1.3'] }),
      makeTask({ id: '1.5', title: 'Refresh README note', dependsOn: ['1.4'] }),
    ];

    const packages = groupAutocodeRuntimeTasksIntoWorkPackages(tasks);
    const efforts = packages.map((workPackage) => packageEffort(workPackage.tasks));

    expect(packages).toHaveLength(2);
    expect(packages[0].tasks.map((task) => task.id)).toEqual(['1.1']);
    expect(packages[1].tasks.map((task) => task.id)).toEqual(['1.2', '1.3', '1.4', '1.5']);
    expect(packages[1].dependsOn).toEqual(['wp-1']);
    expect(Math.max(...efforts)).toBeLessThan(packageEffort(tasks));
  });

  it('packs independent light tasks together while keeping heavy tasks balanced', () => {
    const tasks = [
      makeTask({
        id: '1.1',
        title: 'Refactor billing persistence architecture',
        description: 'Refactor billing persistence architecture and shared schema migration contracts.',
        filesToModify: [
          'src/billing/store.ts',
          'src/billing/schema.ts',
          'src/billing/migration.ts',
          'src/billing/service.ts',
          'src/shared/billing.ts',
          'src/config/billing.ts',
        ],
      }),
      makeTask({ id: '1.2', title: 'Update settings label' }),
      makeTask({ id: '1.3', title: 'Refresh help docs' }),
      makeTask({ id: '1.4', title: 'Rename empty state copy' }),
      makeTask({ id: '1.5', title: 'Adjust button text' }),
      makeTask({
        id: '1.6',
        title: 'Refactor invoice workflow orchestration',
        description: 'Refactor invoice workflow orchestration and validation pipeline behavior.',
        filesToModify: [
          'src/invoices/workflow.ts',
          'src/invoices/validation.ts',
          'src/invoices/service.ts',
          'src/invoices/events.ts',
          'src/shared/invoices.ts',
          'src/config/invoices.ts',
        ],
      }),
    ];

    const packages = groupAutocodeRuntimeTasksIntoWorkPackages(tasks);
    const efforts = packages.map((workPackage) => packageEffort(workPackage.tasks));

    expect(packages).toHaveLength(2);
    expect(packages.map((workPackage) => workPackage.tasks.length).sort((left, right) => left - right)).toEqual([
      2,
      4,
    ]);
    expect(packages.every((workPackage) => workPackage.tasks.length <= 5)).toBe(true);
    expect(Math.max(...efforts) - Math.min(...efforts)).toBeLessThanOrEqual(1);
  });
});

const TRACKED_DESIGN = [
  '# Design: Tracked work packages',
  'Design-Contract: 5',
  'Design-Depth: local',
  'Design-Revision: 1',
  '',
  '## Risks And Evolution',
  'Preserve both existing contracts.',
  '',
].join('\n');

const TRACKED_REQUIREMENT_MODEL = [
  '# Requirement Model: Tracked work packages',
  'Design-Contract: 5',
  'Design-Revision: 1',
  'Design-Root: design.md',
  'Model-Kind: requirement',
  '',
  '### FUN-001 First behavior',
  'Update the first behavior.',
  '### FUN-002 Second behavior',
  'Update the second behavior.',
  '',
].join('\n');

const TRACKED_DOMAIN_MODEL = [
  '# Domain Model: Tracked work packages',
  'Design-Contract: 5',
  'Design-Revision: 1',
  'Design-Root: design.md',
  'Model-Kind: domain',
  '',
  '### DOM-001 Tracked behavior',
  'Represents behavior retained across iterations.',
  '',
].join('\n');

const TRACKED_DESIGN_MODEL = [
  '# Design Model: Tracked work packages',
  'Design-Contract: 5',
  'Design-Revision: 1',
  'Design-Root: design.md',
  'Model-Kind: design',
  '',
  '### DES-001 First responsibility',
  'Keep the first behavior inside src/first.ts.',
  '### FLOW-001 First flow',
  'The first caller uses the existing contract.',
  '### DES-002 Second responsibility',
  'Keep the second behavior inside src/second.ts.',
  '### FLOW-002 Second flow',
  'The second caller uses the existing contract.',
  '',
].join('\n');

const TRACKED_IMPLEMENTATION_MODEL = [
  '# Implementation Model: Tracked work packages',
  'Design-Contract: 5',
  'Design-Revision: 1',
  'Design-Root: design.md',
  'Model-Kind: implementation',
  '',
  '### LANG-001 TypeScript rules',
  'Use the observed TypeScript toolchain.',
  '### IMP-001 First implementation',
  'Modify src/first.ts and its focused test.',
  '### IMP-002 Second implementation',
  'Modify src/second.ts and its focused test.',
  '',
].join('\n');

function makeTrackedTasks(completed: boolean): string {
  const checkbox = completed ? 'x' : ' ';
  return [
    '# Tasks',
    '',
    'Feature: Tracked work packages',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
    `  - [${checkbox}] 1.1 Update first behavior`,
    '    - Update the first behavior without changing its public contract.',
    '    - _Files to modify: src/first.ts_',
    '    - _Depends on: none_',
    '    - _Requirements: R1, AC1_',
    '    - _Design: FUN-001, DES-001, FLOW-001, LANG-001, IMP-001_',
    '    - _Evidence: spec.md R1; requirements.md Evidence Sources_',
    '    - _Done when: the first behavior passes its focused check_',
    '    - _Verification: npm test -- first.test.ts_',
    '',
    `  - [${checkbox}] 1.2 Update second behavior`,
    '    - Update the second behavior without changing its public contract.',
    '    - _Files to modify: src/second.ts_',
    '    - _Depends on: none_',
    '    - _Requirements: R2, AC2_',
    '    - _Design: FUN-002, DES-002, FLOW-002, LANG-001, IMP-002_',
    '    - _Evidence: spec.md R2; requirements.md Evidence Sources_',
    '    - _Done when: the second behavior passes its focused check_',
    '    - _Verification: npm test -- second.test.ts_',
    '',
  ].join('\n');
}

function buildTrackedPlan(
  designMarkdown: string,
  completed: boolean,
  previousPlanMarkdown?: string,
  designModelMarkdown = TRACKED_DESIGN_MODEL,
) {
  return buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
    makeTrackedTasks(completed),
    {
      now: completed ? '2026-07-12T00:00:00.000Z' : '2026-07-12T01:00:00.000Z',
      sourcePath: 'tasks.md',
      includeCompletedTasks: true,
      requireTaskEvidence: true,
      designMarkdown,
      requirementModelMarkdown: TRACKED_REQUIREMENT_MODEL,
      domainModelMarkdown: TRACKED_DOMAIN_MODEL,
      designModelMarkdown,
      implementationModelMarkdown: TRACKED_IMPLEMENTATION_MODEL,
      designPath: 'design.md',
      preserveCompletedStateFromPreviousPlanMarkdown: previousPlanMarkdown,
    },
  );
}

function activeSubtasks(plan: ReturnType<typeof buildTrackedPlan>) {
  return (plan.phases[0]?.subtasks ?? []).filter((subtask) => !subtask.history_only);
}

describe('runtime design fingerprint preservation', () => {
  it('rejects an incomplete v5 design package before runtime plan creation', () => {
    expect(() => buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      makeTrackedTasks(false),
      {
        now: '2026-07-12T01:00:00.000Z',
        sourcePath: 'tasks.md',
        requireTaskEvidence: true,
        designMarkdown: TRACKED_DESIGN,
        requirementModelMarkdown: TRACKED_REQUIREMENT_MODEL,
        domainModelMarkdown: TRACKED_DOMAIN_MODEL,
        designModelMarkdown: TRACKED_DESIGN_MODEL,
      },
    )).toThrow('implementation_model.md is missing from the Design-Contract: 5 package.');
  });

  it.each([3, 4])('rejects a v%s model document before runtime plan creation', (version) => {
    expect(() => buildTrackedPlan(
      TRACKED_DESIGN,
      false,
      undefined,
      TRACKED_DESIGN_MODEL.replace('Design-Contract: 5', `Design-Contract: ${version}`),
    )).toThrow('design_model.md must declare Design-Contract: 5.');
  });

  it('preserves completed work when referenced design sections are unchanged', () => {
    const previous = buildTrackedPlan(TRACKED_DESIGN, true);
    const next = buildTrackedPlan(
      TRACKED_DESIGN,
      false,
      stringifyAutocodeImplementationPlanMarkdown(previous),
    );

    expect(activeSubtasks(next).every((subtask) => subtask.status === 'completed')).toBe(true);
    expect(previous.source_task).toMatchObject({
      design_contract: {
        version: 5,
        path: 'design.md',
        paths: [
          'design.md',
          'requirement_model.md',
          'domain_model.md',
          'design_model.md',
          'implementation_model.md',
        ],
      },
    });
  });

  it('resets only work that references a changed design section', () => {
    const previous = buildTrackedPlan(TRACKED_DESIGN, true);
    const changedDesignModel = TRACKED_DESIGN_MODEL.replace(
      'Keep the first behavior inside src/first.ts.',
      'Keep the first behavior inside src/first.ts and preserve its new lifecycle rule.',
    );
    const next = buildTrackedPlan(
      TRACKED_DESIGN,
      false,
      stringifyAutocodeImplementationPlanMarkdown(previous),
      changedDesignModel,
    );
    const subtasks = activeSubtasks(next);

    expect(subtasks.find((subtask) => subtask.upstream_task_ids?.includes('1.1'))?.status).toBe('pending');
    expect(subtasks.find((subtask) => subtask.upstream_task_ids?.includes('1.2'))?.status).toBe('completed');
  });

  it('does not reset work for an unrelated design section change', () => {
    const previous = buildTrackedPlan(TRACKED_DESIGN, true);
    const changedDesign = TRACKED_DESIGN.replace(
      'Preserve both existing contracts.',
      'Preserve both existing contracts and monitor the same residual risk.',
    );
    const next = buildTrackedPlan(
      changedDesign,
      false,
      stringifyAutocodeImplementationPlanMarkdown(previous),
    );

    expect(activeSubtasks(next).every((subtask) => subtask.status === 'completed')).toBe(true);
  });
});
