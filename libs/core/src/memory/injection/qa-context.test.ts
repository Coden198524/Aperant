import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../types.js';
import { buildQaSessionContext } from './qa-context.js';

describe('buildQaSessionContext', () => {
  it('compacts repeated spec description lines before workflow recipe search', async () => {
    const recipeQueries: string[] = [];
    const repeatedLine =
      'QA_RECIPE_REPEAT: same browser failure trace repeated without new signal.';
    const specDescription = [
      'Validate the auth callback workflow.',
      ...Array.from({ length: 8 }, () => repeatedLine),
      'Keep the final regression assertion visible.',
    ].join('\n');

    await buildQaSessionContext(
      specDescription,
      [],
      createMemoryService({
        searchWorkflowRecipe: async (query) => {
          recipeQueries.push(query);
          return [];
        },
      }),
      'project-a',
    );

    expect(recipeQueries).toHaveLength(1);
    expect(recipeQueries[0]).toContain(
      '7 repeated line(s) omitted for prompt budget',
    );
    expect(recipeQueries[0]).toContain('Keep the final regression assertion visible.');
    expect(recipeQueries[0].length).toBeLessThanOrEqual(800);
    expect(recipeQueries[0].match(/QA_RECIPE_REPEAT/g) ?? []).toHaveLength(1);
    expect(recipeQueries[0].length).toBeLessThan(specDescription.length);
  });
});

function createMemoryService(
  overrides: Partial<MemoryService> = {},
): MemoryService {
  return {
    store: async () => '',
    search: async () => [],
    searchByPattern: async () => null,
    insertUserTaught: async () => '',
    searchWorkflowRecipe: async () => [],
    updateAccessCount: async () => {},
    deprecateMemory: async () => {},
    verifyMemory: async () => {},
    pinMemory: async () => {},
    deleteMemory: async () => {},
    ...overrides,
  };
}
