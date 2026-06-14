import { describe, expect, it } from 'vitest';
import iconvLite from 'iconv-lite';

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

  it('repairs common Simplified Chinese text decoded as GBK', () => {
    const source = '说明产品目标、目标用户、主要流程、领域概念、假设和产品风险。';
    const mojibake = iconvLite.decode(Buffer.from(source, 'utf8'), 'gbk');

    expect(mojibake).toContain('璇存槑');
    expect(repairAutocodeChineseMojibakeText(mojibake)).toBe(source);
  });

  it('repairs logs that were corrupted with dense full-stop separators', () => {
    const source = '{"type":"item.completed","aggregated_output":"# 增强记忆筛选和待审处理反馈\\n"}';
    const corrupted = Array.from(source).map((char) => `。${char}`).join('');

    expect(repairAutocodeChineseMojibakeText(corrupted)).toBe(source);
  });

  it('keeps normal Chinese sentence punctuation intact', () => {
    const source = '第一句。第二句。'.repeat(20);

    expect(repairAutocodeChineseMojibakeText(source)).toBe(source);
  });
});
