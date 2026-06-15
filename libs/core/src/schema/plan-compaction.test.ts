import { describe, expect, it } from 'vitest';

import { compactImplementationPlan } from './plan-compaction.js';

describe('implementation plan compaction', () => {
  it('folds repeated completion summary lines before compacting plans', () => {
    const repeatedLine = 'PLAN_COMPACTION_REPEAT: same verification detail without new signal.';
    const result = compactImplementationPlan({
      feature: 'Reduce prompt budget waste',
      workflow_type: 'feature',
      phases: [
        {
          id: '1',
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: 'Completed token optimization',
              description: 'Implement focused token compaction.',
              status: 'completed',
              files_to_modify: ['libs/core/src/runtime/example.ts'],
              completion_summary: [
                'PLAN_COMPACTION_HEAD',
                ...Array.from({ length: 120 }, () => repeatedLine),
                'PLAN_COMPACTION_TAIL',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    const phase = result?.plan.phases as Array<{ subtasks: Array<{ completion_summary?: string }> }>;
    const summary = phase[0]?.subtasks[0]?.completion_summary ?? '';

    expect(summary).toContain('PLAN_COMPACTION_HEAD');
    expect(summary).toContain('PLAN_COMPACTION_TAIL');
    expect(summary).toContain('119 repeated line(s) omitted for plan budget');
    expect((summary.match(/PLAN_COMPACTION_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
