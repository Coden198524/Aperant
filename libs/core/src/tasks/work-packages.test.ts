import { describe, expect, it } from 'vitest';
import {
  type AutocodeRuntimeTask,
  buildAutocodeRuntimeImplementationPlanFromTasksMarkdown,
  buildAutocodeRuntimeWorkPackagePhases,
  completeAutocodeRuntimeTaskDependencyGraph,
  estimateAutocodeRuntimeTaskEffort,
  flattenAutocodeRuntimeTasks,
  groupAutocodeRuntimeTasksIntoWorkPackages,
} from './work-packages.js';
import { parseAutocodeImplementationPlanMarkdown } from './plan-store.js';
import { validateImplementationPlanLanguage } from '../schema/plan-language.js';

function makeTask(overrides: Partial<AutocodeRuntimeTask> & { id: string }): AutocodeRuntimeTask {
  return {
    id: overrides.id,
    title: `Task ${overrides.id}`,
    description: `Implement task ${overrides.id}.`,
    status: 'pending',
    phaseId: '1',
    phaseName: 'Implementation',
    filesToCreate: [],
    filesToModify: [],
    patternFiles: [],
    dependsOn: [],
    requirements: [],
    verification: '',
    ...overrides,
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
