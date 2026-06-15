import { describe, expect, it } from 'vitest';

import { Scratchpad } from '../observer/scratchpad.js';
import type { Memory, MemoryService } from '../types.js';
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

  it('omits empty gotcha file chips when content already names the files', async () => {
    const memory = makeMemory({
      id: 'gotcha-inline-files',
      type: 'gotcha',
      content: 'Check src/auth/session.ts and token.ts before changing retry flow.',
      relatedFiles: ['src/auth/session.ts', 'src/auth/token.ts'],
    });
    const decider = new StepInjectionDecider(
      createNoopMemoryService({ search: async () => [memory] }),
      new Scratchpad('session-step', 'terminal'),
      'project-a',
    );

    const injection = await decider.decide(2, {
      toolCalls: [
        {
          toolName: 'Read',
          args: { file_path: 'src/auth/session.ts' },
        },
      ],
      injectedMemoryIds: new Set(),
    });

    expect(injection?.type).toBe('gotcha_injection');
    expect(injection?.content).toContain(
      '- [gotcha]: Check src/auth/session.ts and token.ts before changing retry flow.',
    );
    expect(injection?.content).not.toContain('[gotcha] ():');
  });
});

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-1',
    type: 'gotcha',
    content: 'Use the auth helper before editing retry flow.',
    confidence: 0.9,
    tags: [],
    relatedFiles: [],
    relatedModules: [],
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-a',
    ...overrides,
  };
}

function createNoopMemoryService(overrides: Partial<MemoryService> = {}): MemoryService {
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
