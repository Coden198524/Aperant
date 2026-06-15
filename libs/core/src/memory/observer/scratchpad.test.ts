import { describe, expect, it } from 'vitest';

import { Scratchpad } from './scratchpad.js';

describe('Scratchpad error text compaction', () => {
  it('tracks Read/Edit/Write file accesses from path args', () => {
    const scratchpad = new Scratchpad('session-1', 'terminal');

    scratchpad.recordToolCall('Read', { path: './src/auth.ts/' }, 1);
    scratchpad.recordToolCall('Edit', { path: 'src\\auth.ts' }, 2);
    scratchpad.recordToolCall('Write', { path: 'src/auth.ts' }, 3);

    expect(scratchpad.analytics.fileAccessCounts.get('src/auth.ts')).toBe(3);
    expect(scratchpad.analytics.fileFirstAccess.get('src/auth.ts')).toBe(1);
    expect(scratchpad.analytics.fileLastAccess.get('src/auth.ts')).toBe(3);
  });

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
