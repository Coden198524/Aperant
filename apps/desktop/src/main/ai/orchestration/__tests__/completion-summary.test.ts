import { describe, expect, it } from 'vitest';

import { summarizeSessionCompletion } from '../completion-summary';
import type { SessionResult } from '../../session/types';

function makeSessionResult(content: string): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 3,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    messages: [{ role: 'assistant', content }],
    durationMs: 1,
    toolCallCount: 2,
  };
}

describe('summarizeSessionCompletion', () => {
  it('preserves the tail of long fallback completion summaries', () => {
    const summary = summarizeSessionCompletion(makeSessionResult([
      'Implemented the settings persistence update.',
      'Verbose implementation detail '.repeat(80),
      'FINAL VERIFICATION TAIL OK',
    ].join('\n')));

    expect(summary).toContain('Implemented the settings persistence update.');
    expect(summary).toContain('truncated middle');
    expect(summary).toContain('FINAL VERIFICATION TAIL OK');
    expect(summary).toContain('| Verification |');
  });
});
