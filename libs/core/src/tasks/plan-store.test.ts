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
});
