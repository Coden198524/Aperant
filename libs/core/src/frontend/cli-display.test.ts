import { describe, expect, it } from 'vitest';

import {
  getAutocodeBuiltinCliOptionLabels,
  getAutocodeCliLabel,
  getAutocodeConfiguredCliOptionLabels,
} from './cli-display.js';

describe('Autocode CLI display helpers', () => {
  it('keeps unknown CLI labels stable instead of requiring source-code registration', () => {
    expect(getAutocodeCliLabel('claude-code')).toBe('Claude');
    expect(getAutocodeCliLabel('future-code')).toBe('future-code');
  });

  it('builds option labels from runtime routes for future Direct CLIs', () => {
    expect(getAutocodeConfiguredCliOptionLabels([
      {
        id: 'future-code-direct-cli',
        displayName: 'Future Code',
        cli: 'future-code',
        condition: {
          provider: 'future-ai',
          modelIdPrefix: 'future-',
        },
      },
      {
        id: 'future-code-duplicate',
        displayName: 'Future Code Duplicate',
        cli: 'future-code',
        condition: {
          provider: 'future-ai',
          authSource: 'oauth',
        },
      },
      {
        id: 'future-custom-cli',
        displayName: 'Future Custom',
        cli: 'custom',
        customCommand: 'future-code run',
        condition: {
          provider: 'future-ai',
        },
      },
    ])).toEqual([
      { value: 'future-code', label: 'Future Code' },
    ]);
  });

  it('derives built-in options from the CLI catalog', () => {
    expect(getAutocodeBuiltinCliOptionLabels()).toEqual(expect.arrayContaining([
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'codex', label: 'Codex CLI' },
      { value: 'deepseek', label: 'DeepSeek' },
    ]));
    expect(getAutocodeBuiltinCliOptionLabels().some((option) => option.value === 'custom')).toBe(false);
  });
});
