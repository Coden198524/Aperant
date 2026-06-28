import { describe, expect, it, vi } from 'vitest';

import { createAutocodeAdaptiveConcurrency } from './work-executor-strategy.js';

describe('Autocode adaptive concurrency', () => {
  it('starts at the configured worker ceiling', () => {
    const adaptive = createAutocodeAdaptiveConcurrency(5, vi.fn());

    expect(adaptive.current()).toBe(5);
  });

  it('reduces workers after failure pressure', () => {
    const adaptive = createAutocodeAdaptiveConcurrency(5, vi.fn());

    adaptive.recordGroupResult({
      completed: [],
      failed: ['wp-1'],
      blocked: [],
      sessionResult: { outcome: 'error' },
    }, 'concurrent', null);

    expect(adaptive.current()).toBe(2);
  });
});
