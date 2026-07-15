import { describe, expect, it, vi } from 'vitest';
import { buildToolRegistry } from '../build-registry';

const { isSearchProviderConfigured } = vi.hoisted(() => ({
  isSearchProviderConfigured: vi.fn(),
}));

vi.mock('../providers', () => ({
  isSearchProviderConfigured,
}));

describe('buildToolRegistry', () => {
  it('always registers local file tools and omits unavailable web search', () => {
    isSearchProviderConfigured.mockReturnValue(false);

    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Read');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('WebFetch');
    expect(names).not.toContain('WebSearch');
  });

  it('registers web search when its provider is available', () => {
    isSearchProviderConfigured.mockReturnValue(true);

    const names = buildToolRegistry().getRegisteredNames();

    expect(names).toContain('Grep');
    expect(names).toContain('WebSearch');
  });
});
