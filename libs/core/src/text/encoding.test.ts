import { describe, expect, it } from 'vitest';

import { repairAutocodeChineseMojibakeText } from './encoding.js';

describe('Autocode text encoding repair', () => {
  it('repairs UTF-8 punctuation decoded as GBK in CLI output', () => {
    expect(repairAutocodeChineseMojibakeText('I鈥檒l read the task spec.')).toBe(
      'I’ll read the task spec.',
    );
    expect(repairAutocodeChineseMojibakeText('I鈥檓 checking it鈥檚 valid.')).toBe(
      'I’m checking it’s valid.',
    );
  });
});
