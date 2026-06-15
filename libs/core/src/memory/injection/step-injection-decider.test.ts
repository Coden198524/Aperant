import { describe, expect, it } from 'vitest';

import { Scratchpad } from '../observer/scratchpad.js';
import type { MemoryService } from '../types.js';
import { StepInjectionDecider } from './step-injection-decider.js';

describe('StepInjectionDecider memory context compaction', () => {
  it('folds repeated scratchpad lines before injecting step memory context', async () => {
    const scratchpad = new Scratchpad('session-step', 'terminal');
    const repeatedLine = 'SCRATCHPAD_STEP_REPEAT: same retry observation.';
    scratchpad.acuteCandidates.push({
      signalType: 'error_retry',
      priority: 0.9,
      stepNumber: 3,
      capturedAt: 100,
      rawData: {
        triggeringText: [
          'HEAD_OK',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'TAIL_OK',
        ].join('\n'),
      },
    });

    const decider = new StepInjectionDecider(
      createNoopMemoryService(),
      scratchpad,
      'project-a',
    );

    const injection = await decider.decide(4, {
      toolCalls: [],
      injectedMemoryIds: new Set(),
    });

    expect(injection?.type).toBe('scratchpad_reflection');
    expect(injection?.content).toContain('HEAD_OK');
    expect(injection?.content).toContain('TAIL_OK');
    expect(injection?.content).toContain('119 repeated line(s) omitted for prompt budget');
    expect((injection?.content.match(/SCRATCHPAD_STEP_REPEAT/g) ?? [])).toHaveLength(1);
  });
});

function createNoopMemoryService(): MemoryService {
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
  };
}
