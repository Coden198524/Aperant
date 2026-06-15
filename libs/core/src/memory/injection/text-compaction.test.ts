import { describe, expect, it } from 'vitest';

import { compactMemoryInjectionText } from './text-compaction.js';

describe('compactMemoryInjectionText', () => {
  it('folds repeated injection lines before whitespace and budget compaction', () => {
    const repeatedLine = 'INJECTION_REPEAT: same memory alert repeated without new signal.';
    const text = [
      'INJECTION_HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'INJECTION_TAIL',
    ].join('\n');

    const compact = compactMemoryInjectionText(text, 1200, 300);

    expect(compact.length).toBeLessThan(text.length / 4);
    expect(compact).toContain('INJECTION_HEAD');
    expect(compact).toContain('INJECTION_TAIL');
    expect(compact).toContain('119 repeated line(s) omitted for prompt budget');
    expect((compact.match(/INJECTION_REPEAT/g) ?? [])).toHaveLength(1);
  });
});
