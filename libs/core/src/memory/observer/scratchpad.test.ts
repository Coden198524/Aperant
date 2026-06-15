import { describe, expect, it } from 'vitest';

import { Scratchpad } from './scratchpad.js';

describe('Scratchpad error text compaction', () => {
  it('folds repeated tool error lines before storing fingerprint samples', () => {
    const scratchpad = new Scratchpad('session-1', 'terminal');
    const repeatedLine = 'SCRATCHPAD_REPEAT: same stack frame repeated without new signal.';

    scratchpad.recordToolResult(
      'Bash',
      {
        status: 'failed',
        stderr: [
          'SCRATCHPAD_ERROR_HEAD',
          'Error: build failed in auth module',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'SCRATCHPAD_ERROR_TAIL',
        ].join('\n'),
      },
      7,
    );

    const samples = [...scratchpad.analytics.errorFingerprintSamples.values()];
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain('SCRATCHPAD_ERROR_HEAD');
    expect(samples[0]).toContain('SCRATCHPAD_ERROR_TAIL');
    expect(samples[0]).toContain('119 repeated line(s) omitted for prompt budget');
    expect((samples[0].match(/SCRATCHPAD_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
