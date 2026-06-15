import { describe, expect, it } from 'vitest';

import { MemoryObserver } from './memory-observer.js';

describe('MemoryObserver candidate text compaction', () => {
  it('folds repeated reasoning lines before promoting acute memory candidates', async () => {
    const observer = new MemoryObserver('session-1', 'terminal', 'project-1');
    const repeatedLine = 'OBSERVER_REPEAT: duplicate signal.';

    observer.observe({
      type: 'memory:reasoning',
      stepNumber: 3,
      text: [
        'Reasoning head.',
        ...Array.from({ length: 80 }, () => repeatedLine),
        'Wait, actual fact is in observer formatter.',
      ].join('\n'),
    });

    const candidates = await observer.finalize('success');
    const candidate = candidates.find((item) => item.signalType === 'self_correction');

    expect(candidate?.content).toContain('Self-correction detected');
    expect(candidate?.content).toContain('79 repeated line(s) omitted for prompt budget');
    expect(candidate?.content).toContain('observer formatter');
    expect((candidate?.content.match(/OBSERVER_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
