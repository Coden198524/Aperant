import { describe, expect, it } from 'vitest';
import { formatYunxiaoDescriptionContent, normalizeYunxiaoDescriptionValue } from '../description';

describe('formatYunxiaoDescriptionContent', () => {
  it('converts html to markdown text and appends images', () => {
    const output = formatYunxiaoDescriptionContent(
      '<article><p>Hello <strong>World</strong></p><img src="https://example.com/a.png" /></article>'
    );

    expect(output).toContain('Hello **World**');
    expect(output).toContain('## Images');
    expect(output).toContain('![Yunxiao Image 1](https://example.com/a.png)');
    expect(output).not.toContain('<article>');
  });

  it('supports serialized description payloads with htmlValue/jsonMLValue', () => {
    const payload = JSON.stringify({
      htmlValue: '<article><p>HTML 描述</p><img src="https://example.com/html.png" /></article>',
      jsonMLValue: ['root', {}, ['p', {}, ['span', { 'data-type': 'leaf' }, 'JSONML 描述']]]
    });

    const output = formatYunxiaoDescriptionContent(payload);
    expect(output).toContain('HTML 描述');
    expect(output).toContain('![Yunxiao Image 1](https://example.com/html.png)');
  });

  it('falls back to jsonML text and extracts jsonML image urls', () => {
    const output = formatYunxiaoDescriptionContent({
      jsonMLValue: [
        'root',
        {},
        ['p', {}, ['span', { 'data-type': 'leaf' }, '根据大部分玩家的等级算出世界等级']],
        ['img', { src: 'https://example.com/world-level.png' }]
      ]
    });

    expect(output).toContain('根据大部分玩家的等级算出世界等级');
    expect(output).toContain('![Yunxiao Image 1](https://example.com/world-level.png)');
  });

  it('keeps plain markdown descriptions unchanged', () => {
    const plain = '已有描述\n\n![Screenshot](https://example.com/existing.png)';
    const output = formatYunxiaoDescriptionContent(plain);
    expect(output).toBe(plain);
  });
});

describe('normalizeYunxiaoDescriptionValue', () => {
  it('serializes object descriptions into json strings', () => {
    const value = normalizeYunxiaoDescriptionValue({
      htmlValue: '<p>test</p>',
      jsonMLValue: ['root', {}, ['p', {}, 'test']]
    });

    expect(value).toBeTypeOf('string');
    expect(value).toContain('htmlValue');
  });
});
