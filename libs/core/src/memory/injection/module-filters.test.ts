import { describe, expect, it } from 'vitest';

import { normalizeMemoryModuleFilters } from './module-filters.js';

describe('normalizeMemoryModuleFilters', () => {
  it('normalizes and deduplicates module filters', () => {
    expect(
      normalizeMemoryModuleFilters([' auth ', 'AUTH', ' billing ', 'billing']),
    ).toEqual(['auth', 'billing']);
  });

  it('splits newline-separated module candidates before applying budgets', () => {
    const repeatedModule =
      'apps/desktop/src/main/ai/memory/injection/prefetch-builder';

    expect(
      normalizeMemoryModuleFilters([
        Array.from({ length: 8 }, () => repeatedModule).join('\n'),
        ' qa-context \nQA-CONTEXT\nplanner-memory ',
      ]),
    ).toEqual([
      repeatedModule,
      'qa-context',
      'planner-memory',
    ]);
  });

  it('keeps the module filter count bounded after splitting lines', () => {
    const modules = normalizeMemoryModuleFilters(
      Array.from({ length: 4 }, (_, groupIndex) =>
        Array.from(
          { length: 5 },
          (_, index) => `module-${groupIndex}-${index}`,
        ).join('\n'),
      ),
    );

    expect(modules).toHaveLength(12);
    expect(modules[0]).toBe('module-0-0');
    expect(modules.at(-1)).toBe('module-2-1');
  });
});
