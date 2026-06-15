import { describe, expect, it } from 'vitest';

import {
  BASH_MAX_OUTPUT_LINE_LENGTH,
  BASH_REPEATED_LINE_THRESHOLD,
  collapseRepeatedBashOutputLines,
  formatBashExecutionResult,
  truncateCompilerOutput,
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

  it('folds consecutive repeated output lines before truncation', () => {
    const output = [
      'setup',
      ...Array.from({ length: BASH_REPEATED_LINE_THRESHOLD + 6 }, () => 'same warning'),
      'done',
    ].join('\n');

    const result = collapseRepeatedBashOutputLines(output);

    expect(result).toContain('setup');
    expect(result).toContain('same warning');
    expect(result).toContain(`[... ${BASH_REPEATED_LINE_THRESHOLD + 5} repeated line(s) omitted ...]`);
    expect(result).toContain('done');
    expect(result.match(/same warning/g)).toHaveLength(1);
  });

  it('folds repeated stdout lines in formatted execution results', () => {
    const repeatedLine = 'downloaded unchanged dependency';
    const stdout = [
      'install start',
      ...Array.from({ length: 20 }, () => repeatedLine),
      'install done',
    ].join('\n');

    const result = formatBashExecutionResult({
      command: 'npm install',
      stdout,
      stderr: '',
      exitCode: 0,
    });

    expect(result).toContain('install start');
    expect(result).toContain(repeatedLine);
    expect(result).toContain('[... 19 repeated line(s) omitted ...]');
    expect(result).toContain('install done');
    expect(result.length).toBeLessThan(stdout.length);
  });

  it('folds repeated compiler diagnostics before selecting diagnostic lines', () => {
    const repeatedWarning = 'src/main.cpp:10:5: warning: repeated template diagnostic';
    const output = [
      'In file included from src/main.cpp:1:',
      ...Array.from({ length: 30 }, () => repeatedWarning),
      'src/main.cpp:20:3: error: build failed',
    ].join('\n');

    const result = truncateCompilerOutput(output, 500);

    expect(result).toContain(repeatedWarning);
    expect(result).toContain('[... 29 repeated line(s) omitted ...]');
    expect(result).toContain('build failed');
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
