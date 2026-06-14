import { describe, expect, it } from 'vitest';

import {
  BASH_MAX_OUTPUT_LINE_LENGTH,
  formatBashExecutionResult,
  truncateBashOutput,
} from './bash.js';

describe('bash output formatting', () => {
  it('compacts long output lines while preserving head and tail', () => {
    const output = `HEAD_${'middle_'.repeat(300)}TAIL_SENTINEL`;

    const result = truncateBashOutput(output);

    expect(result).toContain('HEAD_');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_LINE_LENGTH);
    expect(result.length).toBeLessThan(output.length);
  });

  it('compacts stdout and stderr lines in formatted execution results', () => {
    const result = formatBashExecutionResult({
      command: 'node noisy-script.js',
      stdout: `OUT_HEAD_${'stdout_'.repeat(300)}OUT_TAIL`,
      stderr: `ERR_HEAD_${'stderr_'.repeat(300)}ERR_TAIL`,
      exitCode: 1,
    });

    expect(result).toContain('OUT_HEAD_');
    expect(result).toContain('OUT_TAIL');
    expect(result).toContain('STDERR:');
    expect(result).toContain('ERR_HEAD_');
    expect(result).toContain('ERR_TAIL');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('Exit code: 1');
  });
});
