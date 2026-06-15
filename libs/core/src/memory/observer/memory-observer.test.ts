import { describe, expect, it } from 'vitest';

import { MemoryObserver } from './memory-observer.js';

describe('MemoryObserver candidate text compaction', () => {
  it('tracks path tool args for file accesses and edits', () => {
    const observer = new MemoryObserver('session-1', 'terminal', 'project-1');

    observer.observe({
      type: 'memory:tool-call',
      toolName: 'Read',
      args: { path: './src/runtime/path-reader.ts/' },
      stepNumber: 1,
    });
    observer.observe({
      type: 'memory:tool-call',
      toolName: 'Edit',
      args: { path: 'src\\runtime\\path-reader.ts' },
      stepNumber: 2,
    });

    const scratchpad = observer.getScratchpad();
    expect(scratchpad.analytics.fileAccessCounts.get('src/runtime/path-reader.ts')).toBe(2);
    expect(scratchpad.analytics.fileFirstAccess.get('src/runtime/path-reader.ts')).toBe(1);
    expect(scratchpad.analytics.fileLastAccess.get('src/runtime/path-reader.ts')).toBe(2);
    expect(scratchpad.analytics.fileEditSet.has('src/runtime/path-reader.ts')).toBe(true);
  });

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
