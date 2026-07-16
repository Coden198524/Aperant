import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  hydrateAutocodeSlimRuntimeLedger,
  parseAutocodeImplementationPlanMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
  stringifyAutocodeTaskDefinitionsMarkdown,
  updateAutocodePlanSubtask,
} from './plan-store.js';
import { buildStandardDesignV5Fixture } from './standard-design-v5.test-fixture.js';

function firstPhaseSubtasks(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>) {
  return plan.phases[0]?.subtasks ?? [];
}

describe('implementation plan markdown', () => {
  it('preserves logical dependencies while removing runtime state from task definitions', () => {
    const markdown = stringifyAutocodeTaskDefinitionsMarkdown({
      phases: [{
        id: '1',
        name: 'Implementation',
        subtasks: [
          {
            id: '1.1',
            title: 'Create the contract',
            status: 'completed',
            completion_summary: 'Old runtime result',
            started_at: '2026-07-15T01:00:00.000Z',
          },
          {
            id: '1.2',
            title: 'Use the contract',
            status: 'in_progress',
            depends_on: ['1.1'],
            retry_count: 2,
          },
        ],
      }],
    });

    expect(markdown).toContain('Tasks-Contract: 1');
    expect(markdown).toContain('_Depends on: 1.1_');
    expect(markdown).not.toContain('Old runtime result');
    expect(markdown).not.toContain('2026-07-15T01:00:00.000Z');
    expect(markdown).not.toContain('retry_count');
    expect(markdown).not.toContain('[x]');

    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);
    expect(parsed.phases?.[0]?.subtasks?.[1]).toMatchObject({
      status: 'pending',
      depends_on: ['1.1'],
    });
  });

  it('hydrates a slim runtime ledger without replacing persisted fingerprints', () => {
    const specDir = mkdtempSync(join(tmpdir(), 'autocode-slim-ledger-'));
    try {
      const designPackage = buildStandardDesignV5Fixture();
      writeFileSync(join(specDir, 'tasks.md'), [
        '# Tasks',
        '',
        'Tasks-Contract: 1',
        'Feature: Hydrated work',
        '',
        '- [ ] 1. Implementation',
        '',
        '  - [ ] 1.1 Update renderer shell',
        '    - Keep the renderer shell aligned with the observable contract.',
        '    - _Files to modify: src/page.ts_',
        '    - _Depends on: none_',
        '    - _Requirements: R1, AC1_',
        '    - _Design: SYS-001, DES-001, IMP-001_',
        '    - _Evidence: E1; src/page.ts existing shell_',
        '    - _Verification: npm test -- page.test.ts_',
        '',
      ].join('\n'), 'utf8');
      const designArtifacts = [
        ['design.md', designPackage.designMarkdown],
        ['requirement_model.md', designPackage.requirementModelMarkdown],
        ['domain_model.md', designPackage.domainModelMarkdown],
        ['design_model.md', designPackage.designModelMarkdown],
        ['implementation_model.md', designPackage.implementationModelMarkdown],
      ] as const;
      for (const [fileName, markdown] of designArtifacts) {
        writeFileSync(join(specDir, fileName), markdown, 'utf8');
      }

      const parsed = parseAutocodeImplementationPlanMarkdown([
        '# Runtime Execution Ledger',
        '',
        '<!-- autocode-plan-meta: {"source_task":{"tasks":"tasks.md","runtime_ledger_schema":"autocode-runtime-ledger/v1","design_contract":{"version":5,"path":"design.md","paths":["design.md","requirement_model.md","domain_model.md","design_model.md","implementation_model.md"]}},"subtaskMetadata":{"wp-1":{"work_package":true,"upstream_task_ids":["1.1"],"depends_on":[],"definition_fingerprint":"persisted-package","source_task_fingerprints":{"1.1":"persisted-task"}}}} -->',
        '',
        '- [ ] wp. Runtime work packages',
        '',
        '  - [ ] wp-1 Work package',
        '    - _Depends on: none_',
        '',
      ].join('\n'));
      const hydrated = hydrateAutocodeSlimRuntimeLedger(parsed, specDir);
      const workPackage = hydrated.phases?.[0]?.subtasks?.[0];

      expect(workPackage).toMatchObject({
        title: 'Update renderer shell',
        files_to_modify: ['src/page.ts'],
        requirements: ['1.1', 'R1', 'AC1'],
        definition_fingerprint: 'persisted-package',
        source_task_fingerprints: { '1.1': 'persisted-task' },
        design_task_fingerprints: { '1.1': expect.any(String) },
      });
      const rewritten = stringifyAutocodeImplementationPlanMarkdown(hydrated);
      expect(rewritten).not.toContain('src/page.ts');
      expect(rewritten).not.toContain('_Requirements:');
      expect(rewritten).toContain('persisted-package');
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('renders long task descriptions as a Markdown section instead of one metadata line', () => {
    const description = [
      '# 增强记忆筛选和待审处理反馈',
      '',
      '为记忆视图增加分组数量、筛选结果数量和树内“清除筛选”操作。',
      '',
      '## Rationale',
      '',
      '根分组没有显示数量，筛选后也缺少就地清除入口。',
      '',
      '## Affected Components',
      '',
      '- src/providers/memoryExplorerProvider.ts',
      '- src/commands/memoryCommands.ts',
    ].join('\n');

    const markdown = stringifyAutocodeImplementationPlanMarkdown({
      feature: '增强记忆筛选和待审处理反馈',
      description,
      status: 'pending',
      created_at: '2026-06-14T02:51:43.938Z',
      updated_at: '2026-06-14T02:51:43.938Z',
      phases: [
        {
          id: '1',
          name: '实现',
          subtasks: [
            {
              id: '1.1',
              title: '显示分组计数',
              description: '在记忆树根分组上展示记录数量。',
              status: 'pending',
            },
          ],
        },
      ],
    });

    expect(markdown).toContain('Feature: 增强记忆筛选和待审处理反馈');
    expect(markdown).not.toContain('Description: # 增强记忆筛选和待审处理反馈');
    expect(markdown).toContain([
      '## Description',
      '',
      '# 增强记忆筛选和待审处理反馈',
      '',
      '为记忆视图增加分组数量、筛选结果数量和树内“清除筛选”操作。',
      '',
      '## Rationale',
    ].join('\n'));
    expect(markdown).toContain('- [ ] 1. 实现');

    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);
    expect(parsed.description).toBe(description);
  });

  it('expands legacy inline description metadata into readable Markdown', () => {
    const markdown = [
      '# Implementation Plan',
      '',
      'Feature: 增强记忆筛选和待审处理反馈',
      'Description: # 增强记忆筛选和待审处理反馈 为记忆视图增加分组数量、筛选结果数量和树内“清除筛选”操作。 ## Rationale 根分组没有显示数量，筛选后也缺少就地清除入口。 ## Affected Components - src/providers/memoryExplorerProvider.ts - src/commands/memoryCommands.ts',
      'Status: pending',
      'Created: 2026-06-14T02:51:43.938Z',
      '',
      '- [ ] 1. 实现',
    ].join('\n');

    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);
    expect(parsed.description).toContain('# 增强记忆筛选和待审处理反馈\n\n为记忆视图增加分组数量');
    expect(parsed.description).toContain('## Rationale\n\n根分组没有显示数量');
    expect(parsed.description).toContain('## Affected Components\n\n- src/providers/memoryExplorerProvider.ts');
    expect(parsed.description).toContain('\n- src/commands/memoryCommands.ts');

    const rewritten = stringifyAutocodeImplementationPlanMarkdown(parsed);
    expect(rewritten).not.toContain('Description: # 增强记忆筛选和待审处理反馈');
    expect(rewritten).toContain('## Description\n\n# 增强记忆筛选和待审处理反馈\n\n为记忆视图增加分组数量');
  });

  it('roundtrips active work item timing metadata', () => {
    const markdown = stringifyAutocodeImplementationPlanMarkdown({
      feature: 'Timing metadata',
      status: 'in_progress',
      phases: [
        {
          id: '1',
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: 'Run active work item',
              description: 'Exercise active_started_at persistence.',
              status: 'in_progress',
              started_at: '2026-01-01T00:00:00.000Z',
              active_started_at: '2026-01-01T00:05:00.000Z',
              duration_ms: 60000,
            },
          ],
        },
      ],
    });

    expect(markdown).toContain('active_started_at');
    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);
    expect(firstPhaseSubtasks(parsed)[0]?.active_started_at).toBe('2026-01-01T00:05:00.000Z');
  });

  it('roundtrips plan revision and historical work package metadata', () => {
    const markdown = stringifyAutocodeImplementationPlanMarkdown({
      feature: 'Planning synchronization',
      planRevision: 12,
      phases: [
        {
          id: '1',
          name: 'History',
          subtasks: [
            {
              id: 'history-1',
              title: 'Completed historical package',
              description: 'Keep prior work visible during iteration.',
              status: 'completed',
              history_only: true,
              depends_on: [],
            },
          ],
        },
      ],
    });

    const parsed = parseAutocodeImplementationPlanMarkdown(markdown);
    expect(parsed.planRevision).toBe(12);
    expect(firstPhaseSubtasks(parsed)[0]).toMatchObject({
      id: 'history-1',
      status: 'completed',
      history_only: true,
      depends_on: [],
    });
  });
  it('parses combined create/modify file metadata as write intent', () => {
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create game shell',
      '    - Build the initial browser shell.',
      '    - _Files to create/modify: package.json, index.html, src/main.js_',
      '    - _Depends on: none_',
      '',
    ].join('\n'));

    expect(firstPhaseSubtasks(parsed)[0]?.files_to_modify).toEqual([
      'package.json',
      'index.html',
      'src/main.js',
    ]);
  });

  it('parses flat localized planner metadata with external colons and file intent prose', () => {
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1.1 建立合法初始状态',
      '  - _Depends on_: 无',
      '  - _Requirements_: R1 / AC1；R3 / AC3',
      '  - _Design_: ADR-005；DOM-001；IMP-002',
      '  - _File intent_: 新建 `game-logic.mjs` 并导出 `createInitialState`；新建 `tests/game-logic.test.mjs`，使用 `node:assert/strict`。',
      '  - _Done when_: 合法配置生成可重复结果。',
      '',
      '## 覆盖说明',
      '',
      'IMP-002 由任务 1.1 覆盖，不属于任务描述。',
      '',
    ].join('\n'));

    const subtask = parsed.phases?.[0]?.subtasks?.[0];
    expect(subtask).toMatchObject({
      id: '1.1',
      depends_on: [],
      requirements: ['R1 / AC1', 'R3 / AC3'],
      design_refs: ['ADR-005', 'DOM-001', 'IMP-002'],
      files_to_modify: ['game-logic.mjs', 'tests/game-logic.test.mjs'],
    });
    expect(subtask?.description).not.toContain('覆盖说明');
    expect(subtask?.description).not.toContain('不属于任务描述');
  });

  it('roundtrips localized and English architecture metadata as one structured field', () => {
    const architecture = 'static entry layer; HTML structure contract strategy; requirements.md R1';
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create HTML entry',
      '    - Create the browser application shell.',
      `    - _\u67B6\u6784: ${architecture}_`,
      '    - _Architecture: duplicate label that should not enter the description_',
      '    - _Files to create: index.html_',
      '    - _Requirements: R1, AC1.1_',
      '    - _Evidence: spec.md Requirements R1; requirements.md Evidence Sources_',
      '',
    ].join('\n'));

    const subtask = firstPhaseSubtasks(parsed)[0] as Record<string, unknown>;
    expect(subtask.architecture).toBe(architecture);
    expect(subtask.description).toBe('Create the browser application shell.');

    const rewritten = stringifyAutocodeImplementationPlanMarkdown(parsed);
    expect(rewritten.match(/Architecture:/g)).toHaveLength(1);
    expect(rewritten).not.toContain('\u67B6\u6784:');
    expect(rewritten).not.toContain('duplicate label');
  });

  it('parses localized and full-width task metadata fields', () => {
    const parsed = parseAutocodeImplementationPlanMarkdown([
      '# Tasks',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Create browser game shell',
      '    - Build a focused static game entry point.',
      '    - 文件写入意图：index.html, src/main.js',
      '    - 依赖：none',
      '    - 需求覆盖：R1, AC1',
      '    - 证据：spec.md Requirements R1; requirements.md Evidence Sources',
      '    - 验证：Open index.html in a browser',
      '',
      '  - [ ] 1.2 Wire keyboard controls',
      '    - Connect keyboard actions to game commands.',
      '    - **Files to modify:** src/main.js',
      '    - **Requirements:** R3; AC6',
      '    - **Evidence:** spec.md Requirements R3; requirements.md Evidence Sources',
      '',
    ].join('\n'));

    expect(firstPhaseSubtasks(parsed)[0]?.files_to_modify).toEqual(['index.html', 'src/main.js']);
    expect(firstPhaseSubtasks(parsed)[0]?.depends_on).toEqual([]);
    expect(firstPhaseSubtasks(parsed)[0]?.requirements).toEqual(['R1', 'AC1']);
    expect(firstPhaseSubtasks(parsed)[0]?.evidence).toBe('spec.md Requirements R1; requirements.md Evidence Sources');
    expect(firstPhaseSubtasks(parsed)[0]?.verification).toEqual({
      type: 'manual',
      run: 'Open index.html in a browser',
    });
    expect(firstPhaseSubtasks(parsed)[1]?.files_to_modify).toEqual(['src/main.js']);
    expect(firstPhaseSubtasks(parsed)[1]?.evidence).toBe('spec.md Requirements R3; requirements.md Evidence Sources');
  });

  it('compacts stored completion summaries written through subtask updates', () => {
    const plan = {
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1.1', title: 'Implement compact summary', status: 'pending' },
          ],
        },
      ],
    };
    const longSummary = [
      '| Item | Details |',
      '| --- | --- |',
      `| What changed | ${'Detailed implementation notes for downstream review. '.repeat(60)} |`,
      '| Verification | Targeted test passed. |',
      '| Review notes | Ready for manual review. |',
    ].join('\n');

    const updated = updateAutocodePlanSubtask(plan, '1.1', {
      status: 'completed',
      completionSummary: longSummary,
    });

    const subtask = plan.phases[0].subtasks[0] as { completion_summary?: string; notes?: string };
    expect(updated).toBe(true);
    expect(subtask.completion_summary).toContain('| Item | Details |');
    expect(subtask.completion_summary?.length).toBeLessThanOrEqual(1200);
    expect(subtask.notes).toBe(subtask.completion_summary);
  });

  it('stamps and clears active work item timing when updating subtask status', () => {
    const plan = {
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1.1', title: 'Run active work item', status: 'pending' },
          ],
        },
      ],
    };

    expect(updateAutocodePlanSubtask(plan, '1.1', {
      status: 'in_progress',
      now: '2026-01-01T00:05:00.000Z',
    })).toBe(true);
    const activeSubtask = plan.phases[0].subtasks[0] as { started_at?: string; active_started_at?: string };
    expect(activeSubtask.started_at).toBe('2026-01-01T00:05:00.000Z');
    expect(activeSubtask.active_started_at).toBe('2026-01-01T00:05:00.000Z');

    expect(updateAutocodePlanSubtask(plan, '1.1', {
      status: 'completed',
      now: '2026-01-01T00:06:00.000Z',
      completionSummary: '| Item | Details |\n| --- | --- |\n| What changed | Done. |\n| Verification | Checked. |\n| Review notes | Ready. |',
    })).toBe(true);
    expect(activeSubtask.active_started_at).toBeUndefined();
  });

  it('folds repeated stored completion summary lines before updating plans', () => {
    const plan = {
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1.1', title: 'Store compact repeated summary', status: 'pending' },
          ],
        },
      ],
    };
    const repeatedLine = 'PLAN STORE REPEAT: same verification output without new signal.';
    const summary = [
      'PLAN STORE HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'PLAN STORE TAIL',
    ].join('\n');

    const updated = updateAutocodePlanSubtask(plan, '1.1', {
      status: 'completed',
      completionSummary: summary,
    });

    const subtask = plan.phases[0].subtasks[0] as { completion_summary?: string; notes?: string };
    expect(updated).toBe(true);
    expect(subtask.completion_summary).toContain('PLAN STORE HEAD');
    expect(subtask.completion_summary).toContain('PLAN STORE TAIL');
    expect(subtask.completion_summary).toContain('119 repeated line(s) omitted for prompt budget');
    expect((subtask.completion_summary?.match(/PLAN STORE REPEAT/g) ?? [])).toHaveLength(1);
    expect(subtask.notes).toBe(subtask.completion_summary);
  });
});
