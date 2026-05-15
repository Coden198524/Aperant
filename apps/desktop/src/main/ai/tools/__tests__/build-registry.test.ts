import { describe, expect, it, vi } from 'vitest';

const isSearchProviderConfigured = vi.fn();

vi.mock('../providers', () => ({
  isSearchProviderConfigured,
}));

describe('buildToolRegistry', () => {
  it('always registers local file tools and omits unavailable web search', async () => {
    vi.resetModules();
    isSearchProviderConfigured.mockReturnValue(false);

    const { buildToolRegistry } = await import('../build-registry');
    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Read');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('WebFetch');
    expect(names).not.toContain('WebSearch');
  });

  it('registers web search when its provider is available', async () => {
    vi.resetModules();
    isSearchProviderConfigured.mockReturnValue(true);

    const { buildToolRegistry } = await import('../build-registry');
    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Grep');
    expect(names).toContain('WebSearch');
  });
});
