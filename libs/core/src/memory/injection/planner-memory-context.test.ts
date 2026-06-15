import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../types.js';
import { buildPlannerMemoryContext } from './planner-memory-context.js';

describe('buildPlannerMemoryContext', () => {
  it('compacts repeated task description lines before workflow recipe search', async () => {
    const recipeQueries: string[] = [];
    const repeatedLine =
      'PLANNER_RECIPE_REPEAT: same planner trace repeated without new signal.';
    const taskDescription = [
      'Plan the auth callback hardening work.',
      ...Array.from({ length: 8 }, () => repeatedLine),
      'Preserve the final verification signal.',
    ].join('\n');

    await buildPlannerMemoryContext(
      taskDescription,
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
    expect(recipeQueries[0]).toContain('Preserve the final verification signal.');
    expect(recipeQueries[0].length).toBeLessThanOrEqual(800);
    expect(
      recipeQueries[0].match(/PLANNER_RECIPE_REPEAT/g) ?? [],
    ).toHaveLength(1);
    expect(recipeQueries[0].length).toBeLessThan(taskDescription.length);
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
