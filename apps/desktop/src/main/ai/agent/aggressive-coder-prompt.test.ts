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
});
