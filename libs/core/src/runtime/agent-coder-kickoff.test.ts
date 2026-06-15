import { describe, expect, it } from 'vitest';

import {
  buildAutocodeFocusedCoderKickoffMessageFromContext,
  findAutocodeSubtaskKickoffContext,
} from './agent-coder-kickoff.js';

describe('agent coder kickoff prompt compaction', () => {
  it('folds repeated completed work summaries before coder kickoff prompts', () => {
    const repeatedLine = 'CODER_KICKOFF_REPEAT: same prior verification line without new signal.';
    const plan = {
      workflow_type: 'feature',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: 'Previous work',
              status: 'completed',
              completion_summary: [
                'CODER_KICKOFF_HEAD',
                ...Array.from({ length: 120 }, () => repeatedLine),
                'CODER_KICKOFF_TAIL',
              ].join('\n'),
            },
            {
              id: '1.2',
              title: 'Current work',
              description: 'Implement the current focused change.',
              status: 'pending',
              files_to_modify: ['src/auth/session.ts'],
            },
          ],
        },
      ],
    };

    const context = findAutocodeSubtaskKickoffContext(plan, '1.2');
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/demo',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '1.2',
      context,
    });

    expect(message).toContain('## Prior Completed Work In This Phase');
    expect(message).toContain('CODER_KICKOFF_HEAD');
    expect(message).toContain('CODER_KICKOFF_TAIL');
    expect(message).toContain('119 repeated line(s) omitted for prompt budget');
    expect((message.match(/CODER_KICKOFF_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
