import { describe, expect, it, vi } from 'vitest';

const isCommandAvailable = vi.fn();
const isSearchProviderConfigured = vi.fn();

vi.mock('../../../env-utils', () => ({
  isCommandAvailable,
}));

vi.mock('../providers', () => ({
  isSearchProviderConfigured,
}));

describe('buildToolRegistry', () => {
  it('does not register unavailable shell/search tools', async () => {
    vi.resetModules();
    isCommandAvailable.mockReturnValue(false);
    isSearchProviderConfigured.mockReturnValue(false);

    const { buildToolRegistry } = await import('../build-registry');
    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Read');
    expect(names).toContain('Glob');
    expect(names).toContain('WebFetch');
    expect(names).not.toContain('Grep');
    expect(names).not.toContain('WebSearch');
    expect(isCommandAvailable).toHaveBeenCalledWith('rg');
  });

  it('registers grep and web search when their providers are available', async () => {
    vi.resetModules();
    isCommandAvailable.mockReturnValue(true);
    isSearchProviderConfigured.mockReturnValue(true);

    const { buildToolRegistry } = await import('../build-registry');
    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Grep');
    expect(names).toContain('WebSearch');
  });
});
