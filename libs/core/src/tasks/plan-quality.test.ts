import { describe, expect, it } from 'vitest';

import {
  hasOnlyAutocodePlanTaskGranularityErrors,
  validateAutocodeStandardPlanArtifacts,
} from './plan-quality.js';

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

  it('rejects executable task titles prefixed with revision state labels', () => {
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
        '  - [ ] 1.1 needs_revision - Tighten planner quality gate',
        '    - Update `validateAutocodeStandardPlanArtifacts` so revision markers stay out of executable titles.',
        '    - _Files to modify: libs/core/src/tasks/plan-quality.ts_',
        '    - _Depends on: none_',
        '    - _Requirements: 1.1_',
        '    - _Evidence: libs/core/src/tasks/plan-quality.ts validateTasksEvidence pattern_',
        '    - _Done when: title state labels are rejected before work packages are derived_',
        '    - _Verification: npx vitest libs/core/src/tasks/plan-quality.test.ts_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 has a state label in its title');
  });

  it('accepts localized task metadata when evidence remains traceable', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Tetris game',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create `src/game.js` board factory',
        '    - Add `BOARD_WIDTH`, `BOARD_HEIGHT`, and `createEmptyBoard()` in `src/game.js` for the 10x20 Tetris board.',
        '    - 文件写入意图：src/game.js',
        '    - 依赖：none',
        '    - 需求覆盖：R2; AC2',
        '    - 证据：spec.md Requirements R2; requirements.md Evidence Sources',
        '    - 完成条件：`createEmptyBoard()` returns a 20-row by 10-column empty board and exports the board constants.',
        '    - 验证：npm test -- src/game.test.js',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps vague task evidence as a Standard quality issue', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Tetris game',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create `game.js` board state',
        '    - Add the 10x20 board state for the browser game.',
        '    - _Files to modify: game.js_',
        '    - _Depends on: none_',
        '    - _Requirements: R2, AC2_',
        '    - _Evidence: planner note for board state_',
        '    - _Done when: the board can be initialized._',
        '    - _Verification: inspect game.js_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 has vague _Evidence_');
  });

  it('rejects broad tasks that combine too many behaviors and acceptance references', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Tetris game',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Implement core game state and rules',
        '    - 实现 10x20 可见棋盘、7 种四格方块、当前方块和下一方块、碰撞检测、左右移动、软降、硬降、旋转、锁定、整行消除、生成新方块和无法入场时的游戏结束判定，并为边界碰撞、旋转、锁定、清行和顶出场景添加单元测试。',
        '    - _Files to create/modify: src/game.js, src/tetrominoes.js, tests/game.test.js_',
        '    - _Depends on: none_',
        '    - _Requirements: User Requirements 1-2; Acceptance Criteria 2, 4, 5_',
        '    - _Evidence: requirements.md User Requirements 1-2; context.md Tetris references_',
        '    - _Done when: game logic and all core rule tests pass_',
        '    - _Verification: npm test -- tests/game.test.js_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 is too broad');
    expect(result.errors.join('\n')).toContain('OpenSpec-grade leaf tasks');
  });

  it('does not reject borderline tasks at the documented three-reference threshold', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Planning status',
        'Workflow: bugfix',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Allow authoritative planning restart progress',
        '    - Update the renderer task store so an XState Request Changes restart can switch the task card phase from coding back to planning.',
        '    - _Files to modify: apps/desktop/src/renderer/stores/task-store.ts_',
        '    - _Depends on: none_',
        '    - _Requirements: 1.1, 1.2, 1.3_',
        '    - _Evidence: spec.md Requirements 1.1-1.3; apps/desktop/src/renderer/stores/task-store.ts phase regression guard_',
        '    - _Done when: the authoritative planning restart updates the card phase while stale planning ticks are still ignored_',
        '    - _Verification: npx vitest run apps/desktop/src/renderer/__tests__/task-store.test.ts_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects complex plans without visible architecture and design pattern references', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      requireTaskEvidence: true,
      specMarkdown: [
        '# Spec',
        '',
        '## Scope',
        '',
        '- Build a browser Canvas game with runtime input, storage, rendering, and responsive layout.',
        '',
        '## Evidence',
        '',
        '- src/game.js and src/storage.js show the existing browser runtime boundaries.',
        '',
      ].join('\n'),
      tasksMarkdown: buildComplexBrowserGameTasks(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('no visible Architecture And Design Pattern References section');
  });

  it('accepts complex plans with visible architecture and design pattern references', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      requireTaskEvidence: true,
      specMarkdown: [
        '# Spec',
        '',
        '## Scope',
        '',
        '- Build a browser Canvas game with runtime input, storage, rendering, and responsive layout.',
        '',
        '## Architecture And Design Pattern References',
        '',
        '- Tasks 1.1-1.2 domain layer: follow the src/game-core.js pure function state reducer strategy so deterministic rules stay outside DOM, Canvas, RAF, and browser timers.',
        '- Tasks 1.3-1.5 browser runtime layer: follow the src/game.js game loop orchestration strategy and keep rendering/input adapters outside the domain rules boundary.',
        '- Task 1.6 persistence layer: follow the src/storage.js adapter pattern so localStorage side effects stay behind one storage module contract.',
        '- Task 1.8 verification boundary: follow the tests/browser-start.test.mjs smoke strategy to validate startup, HUD visibility, and input-driven state changes.',
        '',
        '## Evidence',
        '',
        '- src/game.js and src/storage.js show the existing browser runtime boundaries.',
        '',
      ].join('\n'),
      tasksMarkdown: buildComplexBrowserGameTasks({ includeArchitectureGuidance: true }),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects thin complex architecture references and missing task-level guidance', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      requireTaskEvidence: true,
      specMarkdown: [
        '# Spec',
        '',
        '## Scope',
        '',
        '- Build a browser Canvas game with runtime input, storage, rendering, and responsive layout.',
        '',
        '## Architecture And Design Pattern References',
        '',
        '- src/game.js existing Canvas runtime boundary.',
        '- General guidance: keep rules separate.',
        '',
        '## Evidence',
        '',
        '- src/game.js and src/storage.js show the existing browser runtime boundaries.',
        '',
      ].join('\n'),
      tasksMarkdown: buildComplexBrowserGameTasks(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('Architecture And Design Pattern References is too thin');
    expect(result.errors.join('\n')).toContain('missing _Architecture: ..._ guidance');
  });

  it('classifies broad task granularity errors separately from hard metadata failures', () => {
    expect(hasOnlyAutocodePlanTaskGranularityErrors([
      'tasks.md task 1.1 is too broad; split it into OpenSpec-grade leaf tasks by behavior.',
    ])).toBe(true);
    expect(hasOnlyAutocodePlanTaskGranularityErrors([
      'tasks.md task 1.1 is too broad; split it into OpenSpec-grade leaf tasks by behavior.',
      'tasks.md task 1.2 missing _Evidence: ..._ metadata.',
    ])).toBe(false);
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

function buildComplexBrowserGameTasks(options: { includeArchitectureGuidance?: boolean } = {}): string {
  const taskSpecs = [
    ['1.1', 'Create browser game domain state', 'src/game-core.js', 'domain state', 'domain layer; pure function state reducer strategy; src/game-core.js project boundary'],
    ['1.2', 'Add deterministic enemy spawning', 'src/game-core.js', 'enemy spawning', 'domain layer; injected RNG strategy; src/game-core.js project boundary'],
    ['1.3', 'Wire Canvas rendering loop', 'src/game.js', 'Canvas rendering', 'browser runtime layer; game loop orchestration strategy; src/game.js project boundary'],
    ['1.4', 'Bind keyboard input actions', 'src/game.js', 'keyboard input', 'input adapter boundary; event adapter strategy; src/game.js project boundary'],
    ['1.5', 'Bind touch control actions', 'src/game.js', 'touch input', 'input adapter boundary; event adapter strategy; src/game.js project boundary'],
    ['1.6', 'Persist local best record', 'src/storage.js', 'localStorage persistence', 'persistence layer; adapter pattern; src/storage.js project boundary'],
    ['1.7', 'Update responsive game layout', 'src/styles.css', 'responsive layout', 'UI styling boundary; single responsibility layout strategy; src/styles.css project boundary'],
    ['1.8', 'Verify browser startup smoke path', 'tests/browser-start.test.mjs', 'browser startup', 'verification boundary; smoke test strategy; tests/browser-start.test.mjs project boundary'],
  ];
  return [
    '# Tasks',
    '',
    'Feature: Browser Canvas game',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
    ...taskSpecs.flatMap(([id, title, file, behavior, architecture], index) => {
      const lines = [
        `  - [ ] ${id} ${title}`,
        `    - Implement the ${behavior} boundary for the Canvas browser game runtime.`,
        `    - _Files to modify: ${file}_`,
        `    - _Depends on: ${index === 0 ? 'none' : `1.${index}`}_`,
        `    - _Requirements: ${id}_`,
        `    - _Evidence: spec.md Scope; ${file} existing project boundary_`,
        `    - _Done when: ${behavior} is implemented and the focused verification passes_`,
        '    - _Verification: node --test tests/browser-start.test.mjs_',
      ];
      if (options.includeArchitectureGuidance) {
        lines.splice(6, 0, `    - _Architecture: ${architecture}_`);
      }
      return [...lines, ''];
    }),
  ].join('\n');
}
