import { describe, expect, it } from 'vitest';

import {
  buildAutocodePlanQualityRetryPrompt,
  hasOnlyAutocodePlanTaskGranularityErrors,
  hasOnlyAutocodePlanRecoverableQualityErrors,
  isAutocodePlanArchitectureGuidanceError,
  isAutocodePlanRecoverableQualityError,
  validateAutocodeStandardPlanArtifacts,
} from './plan-quality.js';

describe('standard plan quality', () => {
  it('includes reader-first documentation guidance in retry prompts', () => {
    const prompt = buildAutocodePlanQualityRetryPrompt([
      'tasks.md missing reader-first documentation structure.',
    ]);

    expect(prompt).toContain('reader-first');
    expect(prompt).toContain('Conclusion Snapshot');
    expect(prompt).toContain('Main Flow');
    expect(prompt).toContain('scenario-based sections');
    expect(prompt).toContain('evidence/verification templates near the end or in appendices');
  });

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

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects spec evidence that is only generic Standard scaffolding', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      specMarkdown: [
        '# Spec',
        '',
        '## Requirements',
        '',
        '- The task should satisfy the request.',
        '',
        '## Evidence',
        '',
        '- requirements.md captures the user request and planning constraints for this task.',
        '- tasks.md maps the implementation work back to the generated Standard requirements.',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('Evidence section is only generic Standard scaffolding');
  });

  it('rejects manual Standard planning seed specs before concrete planning', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireSpecEvidence: true,
      specMarkdown: [
        '# Implement web Tetris',
        '',
        '## Type',
        'Standard mode task',
        '',
        '## Request',
        'Implement a browser Tetris game.',
        '',
        '## Execution',
        'Use Standard Autocode planning. Preserve the local Autocode workflow: spec.md, tasks.md, and implementation_plan.md stay inside this task directory.',
        '',
        '## Done',
        '- The change satisfies the request.',
        '',
        '## Evidence',
        '',
        '- User request - initial scope: Implement a browser Tetris game.',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('manual Standard planning seed');
  });

  it('rejects placeholder Standard requirements even when task description and evidence exist', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireRequirementsEvidence: true,
      requirementsMarkdown: [
        '# Requirements',
        '',
        '## Task Description',
        'Create a browser Path of Exile style game.',
        '',
        '## Workflow Type',
        'feature',
        '',
        '## User Requirements',
        '- None',
        '',
        '## Acceptance Criteria',
        '- None',
        '',
        '## Evidence Sources',
        '- User task description',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('User Requirements section must list');
    expect(result.errors.join('\n')).toContain('Acceptance Criteria section must list');
  });

  it('accepts concrete Standard requirements with acceptance criteria and evidence', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireRequirementsEvidence: true,
      requirementsMarkdown: [
        '# Requirements',
        '',
        '## Task Description',
        'Create a browser Path of Exile style game.',
        '',
        '## Workflow Type',
        'feature',
        '',
        '## User Requirements',
        '- R1: The project provides a playable browser game loop with movement and combat.',
        '- R2: The game exposes character progression, loot, and inventory interactions.',
        '',
        '## Acceptance Criteria',
        '- AC1: Opening the page shows a non-blank playable scene with responsive controls.',
        '- AC2: A player can defeat an enemy, receive loot, and see updated state.',
        '',
        '## Evidence Sources',
        '- User task description captured by Autocode.',
        '- spec.md planning scope and success criteria.',
        '',
      ].join('\n'),
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts Standard requirements written as R-subsections with concrete paragraphs', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireRequirementsEvidence: true,
      requirementsMarkdown: [
        '# Requirements',
        '',
        '## Task Description',
        'Create a browser Gomoku game.',
        '',
        '## User Requirements',
        '',
        '### R1 Browser entry',
        '',
        'The app must run as a browser-native single page application with stable DOM anchors.',
        '',
        '### R2 Game rules',
        '',
        'The rules module must maintain a 15x15 board and reject illegal moves.',
        '',
        '## Acceptance Criteria',
        '',
        '### R1 Acceptance Criteria',
        '',
        '- AC1.1 `index.html` loads the module entry point.',
        '- AC1.2 The page exposes a canvas, status text, and restart button.',
        '',
        '## Evidence Sources',
        '',
        '- spec.md captures the user request.',
        '- src/game.js shows the current rules boundary.',
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
    expect(result.errors.join('\n')).toContain('focused leaf tasks');
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

  it('does not count architecture and done metadata as broad task behavior', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser Gomoku',
        'Workflow: feature',
        'Status: pending',
        '',
        '## Architecture And Design Pattern References',
        '',
        '- Task 2.11 UI orchestration layer: follow the src/main.js event handler strategy and keep restart behavior behind the existing createGame state boundary.',
        '- Task 2.11 rules boundary: follow src/game.js createGame so restart does not duplicate rule state construction in browser glue code.',
        '- Task 2.11 verification boundary: follow tests/ui-status.test.mjs focused DOM status checks for restart button behavior.',
        '- Task 2.11 source reference: index.html restart-button anchor and src/main.js bootstrap entry define the affected integration boundary.',
        '',
        '- [ ] 2. Browser board interaction',
        '',
        '  - [ ] 2.11 Bind restart button',
        '    - In `src/main.js`, bind `#restart-button` so the app starts a new game from the existing state factory.',
        '    - _Architecture: UI orchestration layer; recreate rule state and refresh view strategy; source/reference `index.html` restart-button anchor and `src/game.js` createGame._',
        '    - _Files to create/modify: `src/main.js`, `tests/ui-status.test.mjs`_',
        '    - _Depends on: 2.1, 2.9_',
        '    - _Requirements: R4 / AC4.10_',
        '    - _Evidence: `requirements.md` AC4.10; `index.html` has the restart button; `src/game.js` exposes `createGame`._',
        '    - _Done when: clicking restart clears the board, restores black to move, clears interaction hints, rerenders, and the focused status test passes._',
        '    - _Verification: Open index.html in a browser, click restart, confirm canvas rendered, and check no console/resource-load/blank-screen errors._',
        '',
      ].join('\n'),
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects duplicate localized and English architecture metadata on the same task', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser Gomoku',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create HTML entry',
        '    - Create `index.html` with the browser game shell.',
        '    - _Files to create: index.html_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _\u67B6\u6784: static entry layer; HTML structure contract strategy; requirements.md R1_',
        '    - _Architecture: static entry layer; HTML structure contract strategy; requirements.md R1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: index.html contains canvas, status text, restart control, stylesheet link, and module script._',
        '    - _Verification: node --check src/main.js_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('task 1.1 has duplicate architecture metadata');
  });

  it('rejects localized architecture metadata keys in task metadata', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser Gomoku',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create HTML entry',
        '    - Create `index.html` with the browser game shell.',
        '    - _Files to create: index.html_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _\u67B6\u6784: static entry layer; HTML structure contract strategy; requirements.md R1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: index.html contains canvas, status text, restart control, stylesheet link, and module script._',
        '    - _Verification: Open index.html in Chrome/browser smoke, confirm canvas rendered, and check console/resource-load/blank-screen status._',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('uses localized architecture metadata');
    expect(result.errors.join('\n')).toContain('_Architecture: ..._');
  });

  it('rejects runnable browser deliverables that only have static verification', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser Gomoku',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create HTML entry',
        '    - Create `index.html` and `src/main.js` for a browser game page with canvas controls.',
        '    - _Files to create: index.html, src/main.js_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: index.html contains the browser page shell and module entry._',
        '    - _Verification: node --check src/main.js_',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('has no runtime-readiness verification');
    expect(result.errors.join('\n')).toContain('node --check');
  });

  it('accepts runnable browser deliverables with a real runtime-readiness task', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser Gomoku',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create HTML entry',
        '    - Create `index.html` and `src/main.js` for the browser game page.',
        '    - _Files to create: index.html, src/main.js_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: index.html contains the page shell and module entry._',
        '    - _Verification: node --check src/main.js_',
        '',
        '  - [ ] 1.2 Run browser startup smoke',
        '    - Open the generated page in a browser and exercise the initial canvas view.',
        '    - _Files to modify: none_',
        '    - _Depends on: 1.1_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: the page opens, the canvas renders non-blank, and no console or resource-load errors are observed._',
        '    - _Verification: Open index.html in Chrome/browser smoke, confirm canvas rendered, and check console/resource-load/blank-screen status._',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('requires runtime readiness for non-web CLI deliverables too', () => {
    const staticOnly = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: CLI report tool',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create CLI command',
        '    - Add `src/cli.js` as a command-line report generator.',
        '    - _Files to create: src/cli.js_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: the CLI source exists and exports the command handler._',
        '    - _Verification: node --check src/cli.js_',
        '',
      ].join('\n'),
    });
    expect(staticOnly.errors.join('\n')).toContain('has no runtime-readiness verification');

    const runtimeChecked = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: CLI report tool',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Create CLI command',
        '    - Add `src/cli.js` as a command-line report generator.',
        '    - _Files to create: src/cli.js_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: the CLI source exists and exports the command handler._',
        '    - _Verification: node --check src/cli.js_',
        '',
        '  - [ ] 1.2 Run CLI smoke',
        '    - Start the command-line report generator with a sample input.',
        '    - _Files to modify: none_',
        '    - _Depends on: 1.1_',
        '    - _Requirements: R1, AC1.1_',
        '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
        '    - _Done when: the CLI command starts, exercises the primary path, and exits with status 0 without startup errors._',
        '    - _Verification: Run the CLI command smoke with sample input and confirm exit code 0 plus no startup/runtime errors._',
        '',
      ].join('\n'),
    });
    expect(runtimeChecked.errors).toEqual([]);
    expect(runtimeChecked.valid).toBe(true);
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

  it('does not require implementation architecture references for documentation-only analysis plans', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Analyze auth_server login flow',
        'Workflow: analysis / documentation',
        'Status: pending',
        '',
        '- [ ] 1. Login analysis',
        '',
        '  - [ ] 1.1 Map login state transition boundaries',
        '    - Review `ArcheAge/x2/trunk/Code/server/auth_server/login_session.cpp` and document the LoginSession state machine boundaries in `login_system_analysis.md`.',
        '    - _Files to modify: .autocode/specs/002-task/login_system_analysis.md_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1_',
        '    - _Evidence: requirements.md R1; ArcheAge/x2/trunk/Code/server/auth_server/login_session.cpp state machine symbols_',
        '    - _Done when: the document lists the authentication and world queue state transitions with source references._',
        '    - _Verification: Manually review login_system_analysis.md against login_session.cpp symbol references._',
        '',
        '  - [ ] 1.2 Explain service time rejection behavior',
        '    - Analyze service-time and restriction checks and write the documented login denial path into `login_system_analysis.md`.',
        '    - _Files to modify: .autocode/specs/002-task/login_system_analysis.md_',
        '    - _Depends on: 1.1_',
        '    - _Requirements: R2, AC2_',
        '    - _Evidence: requirements.md R2; ArcheAge/x2/trunk/Code/x2share/p_auth_to_client.h denial reason enum_',
        '    - _Done when: the document states the configured condition, response packet, and known limitation._',
        '    - _Verification: Manually review login_system_analysis.md against p_auth_to_client.h references._',
        '',
        '  - [ ] 1.3 Explain world queue configuration behavior',
        '    - Analyze queue configuration and console command references and document how crowded login enters the world queue flow.',
        '    - _Files to modify: .autocode/specs/002-task/login_system_analysis.md_',
        '    - _Depends on: 1.1_',
        '    - _Requirements: R3, AC3_',
        '    - _Evidence: requirements.md R3; ArcheAge/x2/trunk/Code/server/auth_server/a_config.h TestWorldEntranceConfig_',
        '    - _Done when: the document records queue length, shrink speed, notify interval, and operation commands._',
        '    - _Verification: Manually review login_system_analysis.md against a_config.h references._',
        '',
        '  - [ ] 1.4 Consolidate validation and limitations',
        '    - Document the manual validation path and blocked runtime prerequisites for the login analysis deliverable.',
        '    - _Files to modify: .autocode/specs/002-task/login_system_analysis.md_',
        '    - _Depends on: 1.2, 1.3_',
        '    - _Requirements: R4, AC4_',
        '    - _Evidence: requirements.md R4; spec.md Evidence source list_',
        '    - _Done when: the document has a validation checklist and clearly marks unavailable runtime checks as blocked._',
        '    - _Verification: Manually review login_system_analysis.md coverage against requirements.md R1-R4 and AC1-AC4._',
        '',
      ].join('\n'),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
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

  it('accepts Chinese architecture references with boundary, strategy, source, and task scope', () => {
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
        '- 页面/DOM 边界：`index.html` 承载语义结构，`src/styles.css` 负责响应式布局，`src/main.js` 负责 DOM 与游戏模块装配；来源为 `spec.md` Design Notes、`context.md` 空仓库证据和 Vite 官方文档；适用任务 1.1、2.1、2.2。',
        '- 游戏状态/渲染边界：`src/game.js` 管理实体、规则、碰撞和局内生命周期，`src/render.js` 消费状态快照绘制 Canvas；来源为 `requirements.md` AC2.2 和 MDN Canvas API；适用任务 2.3、3.1、3.2。',
        '- 输入边界：`src/input.js` 将键盘、按钮和 Pointer Events 归一为移动、射击、暂停等意图，不直接承载游戏结算规则；来源为 MDN `KeyboardEvent.key` 和 Pointer Events；适用任务 2.4、2.5、5.1。',
        '- 验证边界：Playwright 使用 `webServer` 启动本地页面，并统一检查 `console.error`、`pageerror`、关键视口布局和 Canvas 非空像素；来源为 Playwright 官方文档；适用任务 1.2、6.1。',
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

  it('does not reject focused leaf tasks that touch implementation modules plus one e2e file', () => {
    const result = validateAutocodeStandardPlanArtifacts({
      requireTaskEvidence: true,
      tasksMarkdown: [
        '# Tasks',
        '',
        'Feature: Browser shooter',
        'Workflow: feature',
        'Status: pending',
        '',
        '- [ ] 2.5 Implement Space key shooting and bullet drawing',
        '  - Bind Space to the shooting intent, create player bullets, draw bullets on Canvas, and move bullets upward each animation frame without enemy-hit handling.',
        '  - _Files to create/modify: src/input.js, src/game.js, src/render.js, tests/e2e/player.spec.js_',
        '  - _Depends on: 2.3_',
        '  - _Requirements: R2, AC2.1_',
        '  - _Architecture: input boundary; shared shooting-intent strategy; MDN KeyboardEvent.key reference_',
        '  - _Evidence: requirements.md R2/AC2.1; spec.md Design Notes_',
        '  - _Done when: Space creates a visible bullet and the bullet moves upward._',
        '  - _Verification: npm run test:e2e -- --grep "@keyboard-shoot"_',
        '',
      ].join('\n'),
    });

    expect(result.errors.join('\n')).not.toContain('task 2.5 is too broad');
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
    const broadTaskError = 'tasks.md task 1.1 is too broad; split it into focused leaf tasks by behavior.';
    const architectureGuidanceError = 'tasks.md complex task(s) missing _Architecture: ..._ guidance (1.3, 2.1); each non-read-only executable task must name boundary, pattern/strategy, and source/reference or labeled general guidance.';
    const hardMetadataError = 'tasks.md task 1.2 missing _Evidence: ..._ metadata.';

    expect(hasOnlyAutocodePlanTaskGranularityErrors([
      broadTaskError,
    ])).toBe(true);
    expect(hasOnlyAutocodePlanTaskGranularityErrors([
      broadTaskError,
      architectureGuidanceError,
    ])).toBe(false);
    expect(isAutocodePlanArchitectureGuidanceError(architectureGuidanceError)).toBe(true);
    expect(isAutocodePlanRecoverableQualityError(broadTaskError)).toBe(true);
    expect(isAutocodePlanRecoverableQualityError(architectureGuidanceError)).toBe(true);
    expect(isAutocodePlanRecoverableQualityError(hardMetadataError)).toBe(false);
    expect(hasOnlyAutocodePlanRecoverableQualityErrors([
      broadTaskError,
      architectureGuidanceError,
    ])).toBe(true);
    expect(hasOnlyAutocodePlanRecoverableQualityErrors([
      broadTaskError,
      hardMetadataError,
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
