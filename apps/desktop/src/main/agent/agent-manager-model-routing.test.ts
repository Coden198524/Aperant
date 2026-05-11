import { describe, expect, it } from 'vitest';

import { inferPinnedProviderFromModel } from './agent-manager';

describe('AgentManager model routing', () => {
  it('pins explicit Opus 4.7 selections to Anthropic', () => {
    expect(inferPinnedProviderFromModel('opus-4.7')).toBe('anthropic');
    expect(inferPinnedProviderFromModel('claude-opus-4-7')).toBe('anthropic');
  });

  it('keeps legacy cross-provider shorthands queue-routable', () => {
    expect(inferPinnedProviderFromModel('opus')).toBeNull();
    expect(inferPinnedProviderFromModel('sonnet')).toBeNull();
  });

  it('pins concrete non-Anthropic model selections to their provider', () => {
    expect(inferPinnedProviderFromModel('gpt-5.5')).toBe('openai');
    expect(inferPinnedProviderFromModel('gemini-2.5-pro')).toBe('google');
  });
});
