import { describe, expect, it } from 'vitest';

import {
  buildAutocodeSessionContext,
  createEmptyAutocodeSessionCodebaseMap,
  formatAutocodeGotchaMarkdownEntry,
  recordAutocodeSessionDiscovery,
  type AutocodeSessionCodebaseMap,
} from './session-memory.js';
import { estimateTokens } from './retrieval/context-packer.js';

function codebaseMap(entries: Array<[string, { description: string; discovered_at: string }]>): AutocodeSessionCodebaseMap {
  return {
    last_updated: entries.at(-1)?.[1].discovered_at ?? null,
    discovered_files: Object.fromEntries(
      entries.map(([filePath, info]) => [
        filePath,
        {
          description: info.description,
          discovered_at: info.discovered_at,
          category: 'general',
        },
      ]),
    ),
  };
}

describe('session memory context formatting', () => {
  it('selects recent discoveries and compacts long descriptions', () => {
    const context = buildAutocodeSessionContext({
      codebaseMap: codebaseMap([
        ['src/old.ts', { description: 'OLD_DISCOVERY_SHOULD_BE_OMITTED', discovered_at: '2026-01-01T00:00:00.000Z' }],
        [
          'src/newer.ts',
          {
            description: `NEW_HEAD ${'implementation detail '.repeat(40)} NEW_TAIL`,
            discovered_at: '2026-01-03T00:00:00.000Z',
          },
        ],
        ['src/newest.ts', { description: 'NEWEST_DISCOVERY', discovered_at: '2026-01-04T00:00:00.000Z' }],
      ]),
      maxDiscoveries: 2,
    });

    expect(context).toContain('src/newest.ts');
    expect(context).toContain('NEWEST_DISCOVERY');
    expect(context).toContain('src/newer.ts');
    expect(context).toContain('NEW_HEAD');
    expect(context).toContain('NEW_TAIL');
    expect(context).toContain('session memory middle omitted');
    expect(context).not.toContain('src/old.ts');
    expect(context).not.toContain('OLD_DISCOVERY_SHOULD_BE_OMITTED');
  });

  it('compacts gotchas and patterns with head and tail context', () => {
    const context = buildAutocodeSessionContext({
      gotchasMarkdown: `# Gotchas\nGOTCHA_HEAD\n${'older gotcha detail '.repeat(80)}GOTCHA_TAIL`,
      patternsMarkdown: `# Patterns\nPATTERN_HEAD\n${'pattern detail '.repeat(80)}PATTERN_TAIL`,
      maxMarkdownChars: 260,
    });

    expect(context).toContain('GOTCHA_HEAD');
    expect(context).toContain('GOTCHA_TAIL');
    expect(context).toContain('PATTERN_HEAD');
    expect(context).toContain('PATTERN_TAIL');
    expect(context).toContain('session memory middle omitted');
  });

  it('keeps localized gotchas and patterns within estimated token budgets', () => {
    const context = buildAutocodeSessionContext({
      gotchasMarkdown: [
        '# Gotchas',
        '会话 gotcha 开头',
        '这是一段会显著增加 token 的中文 gotcha 历史。'.repeat(80),
        '会话 gotcha 尾部',
      ].join('\n'),
      patternsMarkdown: [
        '# Patterns',
        '会话 pattern 开头',
        '这是一段会显著增加 token 的中文 pattern 历史。'.repeat(80),
        '会话 pattern 尾部',
      ].join('\n'),
      maxMarkdownChars: 260,
    });

    expect(context).toContain('会话 gotcha 开头');
    expect(context).toContain('会话 gotcha 尾部');
    expect(context).toContain('会话 pattern 开头');
    expect(context).toContain('会话 pattern 尾部');
    expect(context).toContain('session memory middle omitted');
    expect(estimateTokens(context)).toBeLessThanOrEqual(180);
  });
});

describe('session memory storage formatting', () => {
  it('compacts discovery descriptions before storing session memory', () => {
    const map = recordAutocodeSessionDiscovery(
      createEmptyAutocodeSessionCodebaseMap(),
      {
        filePath: 'src/auth.ts',
        description: `DISCOVERY_HEAD ${'implementation detail '.repeat(120)} DISCOVERY_TAIL`,
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const description = map.discovered_files['src/auth.ts'].description;

    expect(description.length).toBeLessThanOrEqual(800);
    expect(description).toContain('DISCOVERY_HEAD');
    expect(description).toContain('DISCOVERY_TAIL');
    expect(description).toContain('session memory entry middle omitted before storage');
  });

  it('compacts gotcha text and context before writing markdown entries', () => {
    const entry = formatAutocodeGotchaMarkdownEntry(
      {
        gotcha: `GOTCHA_HEAD ${'gotcha detail '.repeat(120)} GOTCHA_TAIL`,
        context: `CONTEXT_HEAD ${'context detail '.repeat(90)} CONTEXT_TAIL`,
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(entry).toContain('GOTCHA_HEAD');
    expect(entry).toContain('GOTCHA_TAIL');
    expect(entry).toContain('CONTEXT_HEAD');
    expect(entry).toContain('CONTEXT_TAIL');
    expect(entry).toContain('session memory entry middle omitted before storage');
    expect(entry.length).toBeLessThan(1400);
  });

  it('compacts localized discovery descriptions before storing session memory', () => {
    const map = recordAutocodeSessionDiscovery(
      createEmptyAutocodeSessionCodebaseMap(),
      {
        filePath: 'src/auth.ts',
        description: [
          '发现开头',
          '这是一段会显著增加 token 的中文 discovery 描述。'.repeat(120),
          '发现尾部',
        ].join(' '),
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const description = map.discovered_files['src/auth.ts'].description;

    expect(description.length).toBeLessThanOrEqual(800);
    expect(estimateTokens(description)).toBeLessThanOrEqual(220);
    expect(description).toContain('发现开头');
    expect(description).toContain('发现尾部');
    expect(description).toContain('session memory entry middle omitted before storage');
  });

  it('compacts localized gotcha text and context before writing markdown entries', () => {
    const entry = formatAutocodeGotchaMarkdownEntry(
      {
        gotcha: [
          'gotcha 开头',
          '这是一段会显著增加 token 的中文 gotcha 内容。'.repeat(120),
          'gotcha 尾部',
        ].join(' '),
        context: [
          'context 开头',
          '这是一段会显著增加 token 的中文上下文。'.repeat(90),
          'context 尾部',
        ].join(' '),
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(entry).toContain('gotcha 开头');
    expect(entry).toContain('gotcha 尾部');
    expect(entry).toContain('context 开头');
    expect(entry).toContain('context 尾部');
    expect(entry).toContain('session memory entry middle omitted before storage');
    expect(estimateTokens(entry)).toBeLessThanOrEqual(430);
  });
});
