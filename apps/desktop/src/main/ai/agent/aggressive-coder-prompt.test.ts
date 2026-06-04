import { describe, expect, it } from 'vitest';

import { buildAggressiveCoderPrompt } from './aggressive-coder-prompt';

describe('buildAggressiveCoderPrompt', () => {
  it('requires status update immediately after verification before final narrative', () => {
    const prompt = buildAggressiveCoderPrompt();

    expect(prompt).toContain('immediately call update_subtask_status');
    expect(prompt).toContain('before any final narrative');
    expect(prompt).toContain('Do not write a long final summary before update_subtask_status');
    expect(prompt).toContain('After the status update succeeds');
  });

  it('keeps aggressive verification failures compact', () => {
    const prompt = buildAggressiveCoderPrompt();

    expect(prompt).toContain('first 3-5 relevant error lines');
    expect(prompt).toContain('filter noisy output');
    expect(prompt).toContain('create or overwrite/update the listed target files directly');
  });

  it('discourages repeated shell verification retries', () => {
    const prompt = buildAggressiveCoderPrompt();

    expect(prompt).toContain('Run at most one targeted verification');
    expect(prompt).toContain('do not try multiple equivalent checks');
    expect(prompt).toContain('single existence/key-content check is enough');
    expect(prompt).toContain('read the current narrow context');
    expect(prompt).toContain('legacy or non-UTF-8 files as encoding-sensitive');
    expect(prompt).toContain('avoid nested cmd/powershell quoting');
    expect(prompt).toContain('Never use Bash here-documents');
    expect(prompt).toContain('Avoid Python -c or Node -e checks containing non-ASCII text');
    expect(prompt).toContain('never mix CommonJS `require(...)` with top-level `await`');
    expect(prompt).toContain('Avoid brittle smoke assertions against initial or transient task status');
    expect(prompt).toContain('do not keep rewriting commands');
  });
});
