import { describe, expect, it } from 'vitest';

import {
  parseAutocodeImplementationPlanMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
  updateAutocodePlanSubtask,
} from './plan-store.js';

describe('implementation plan markdown', () => {
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

    expect(parsed.phases[0].subtasks[0].files_to_modify).toEqual([
      'package.json',
      'index.html',
      'src/main.js',
    ]);
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

    const subtask = parsed.phases[0].subtasks[0] as Record<string, unknown>;
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

    expect(parsed.phases[0].subtasks[0].files_to_modify).toEqual(['index.html', 'src/main.js']);
    expect(parsed.phases[0].subtasks[0].depends_on).toEqual([]);
    expect(parsed.phases[0].subtasks[0].requirements).toEqual(['R1', 'AC1']);
    expect(parsed.phases[0].subtasks[0].evidence).toBe('spec.md Requirements R1; requirements.md Evidence Sources');
    expect(parsed.phases[0].subtasks[0].verification).toEqual({
      type: 'manual',
      run: 'Open index.html in a browser',
    });
    expect(parsed.phases[0].subtasks[1].files_to_modify).toEqual(['src/main.js']);
    expect(parsed.phases[0].subtasks[1].evidence).toBe('spec.md Requirements R3; requirements.md Evidence Sources');
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
