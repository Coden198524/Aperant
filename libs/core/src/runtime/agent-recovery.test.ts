import { describe, expect, it } from 'vitest';

import {
  compactAutocodeAgentRecoveryText,
  summarizeAutocodeCodingAttemptFailure,
} from './agent-recovery.js';

describe('agent retry recovery text compaction', () => {
  it('folds repeated retry failure lines before summarizing attempts', () => {
    const repeatedLine = 'RETRY_RECOVERY_REPEAT: same failed command output.';
    const message = [
      'RETRY_RECOVERY_HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'RETRY_RECOVERY_TAIL',
    ].join('\n');

    const compacted = compactAutocodeAgentRecoveryText(message);
    const summary = summarizeAutocodeCodingAttemptFailure(
      {
        id: 'task-1',
        filesToModify: ['src/auth/session.ts'],
      },
      {
        outcome: 'error',
        stepsExecuted: 3,
        toolCallCount: 5,
        error: {
          code: 'tool_error',
          message,
        },
      },
      2,
    );

    expect(compacted).toContain('119 repeated line(s) omitted for prompt budget');
    expect((compacted.match(/RETRY_RECOVERY_REPEAT/g) ?? [])).toHaveLength(1);
    expect(summary).toContain('RETRY_RECOVERY_HEAD');
    expect(summary).toContain('119 repeated line(s) omitted for prompt budget');
    expect((summary.match(/RETRY_RECOVERY_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
