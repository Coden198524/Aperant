import { describe, expect, it } from 'vitest';

import { getQuickCliOptionLabels } from './cli-display';

describe('renderer CLI display helpers', () => {
  it('adds configured Direct CLI routes and selected external CLIs to quick options', () => {
    const options = getQuickCliOptionLabels([
      {
        id: 'future-direct-cli',
        displayName: 'Future Direct CLI',
        cli: 'future-code',
        condition: {
          provider: 'future-ai',
          modelIdPrefix: 'future-',
        },
      },
    ], ['manually-selected-cli']);

    expect(options).toEqual(expect.arrayContaining([
      { value: 'claude-code', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'future-code', label: 'Future Direct CLI' },
      { value: 'manually-selected-cli', label: 'manually-selected-cli' },
    ]));
  });
});