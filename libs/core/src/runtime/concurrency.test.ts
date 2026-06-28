import { describe, expect, it } from 'vitest';

import { resolveAutocodeTaskRuntimeConcurrency } from './concurrency.js';

describe('Autocode runtime concurrency', () => {
  it('uses five concurrent workers by default for Standard tasks', () => {
    expect(resolveAutocodeTaskRuntimeConcurrency({ developmentMode: 'standard' })).toMatchObject({
      mode: 'concurrent',
      workers: 5,
    });
  });

  it('keeps Direct tasks serial', () => {
    expect(resolveAutocodeTaskRuntimeConcurrency({ developmentMode: 'direct' })).toMatchObject({
      mode: 'serial',
      workers: 1,
    });
  });

  it('preserves explicit worker overrides', () => {
    expect(resolveAutocodeTaskRuntimeConcurrency({
      developmentMode: 'standard',
      runtimeConcurrency: { mode: 'concurrent', workers: 3 },
    })).toMatchObject({
      mode: 'concurrent',
      workers: 3,
    });
  });

  it('caps explicit worker overrides at five', () => {
    expect(resolveAutocodeTaskRuntimeConcurrency({
      developmentMode: 'standard',
      runtimeConcurrency: { mode: 'concurrent', workers: 8 },
    })).toMatchObject({
      mode: 'concurrent',
      workers: 5,
    });
  });
});
