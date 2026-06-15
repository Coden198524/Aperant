import { describe, expect, it } from 'vitest';

import { estimateTokens } from './retrieval/context-packer.js';
import {
  type AutocodeSessionCodebaseMap,
  buildAutocodeSessionContext,
  createEmptyAutocodeSessionCodebaseMap,
  formatAutocodeGotchaMarkdownEntry,
  parseAutocodeSessionCodebaseMap,
  recordAutocodeSessionDiscovery,
} from './session-memory.js';

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

  it('deduplicates equivalent discovery paths before building context', () => {
    const context = buildAutocodeSessionContext({
      codebaseMap: codebaseMap([
        [
          'src\\auth\\session-store.ts',
          { description: 'OLD_DUPLICATE_SHOULD_BE_OMITTED', discovered_at: '2026-01-01T00:00:00.000Z' },
        ],
        [
          './SRC/auth/session-store.ts/',
          { description: 'NEW_DUPLICATE_SHOULD_REMAIN', discovered_at: '2026-01-02T00:00:00.000Z' },
        ],
        [
          'src/auth/token-cache.ts',
          { description: 'DISTINCT_DISCOVERY', discovered_at: '2026-01-03T00:00:00.000Z' },
        ],
      ]),
      maxDiscoveries: 10,
    });

    expect(context).toContain('SRC/auth/session-store.ts');
    expect(context).toContain('NEW_DUPLICATE_SHOULD_REMAIN');
    expect(context).toContain('src/auth/token-cache.ts');
    expect(context).toContain('DISTINCT_DISCOVERY');
    expect(context).not.toContain('src\\auth\\session-store.ts');
    expect(context).not.toContain('OLD_DUPLICATE_SHOULD_BE_OMITTED');
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

  it('normalizes and replaces equivalent discovery paths before storing session memory', () => {
    const first = recordAutocodeSessionDiscovery(
      createEmptyAutocodeSessionCodebaseMap(),
      {
        filePath: 'src\\auth\\session-store.ts',
        description: 'OLD_DUPLICATE_SHOULD_BE_REPLACED',
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const second = recordAutocodeSessionDiscovery(
      first,
      {
        filePath: './SRC/auth/session-store.ts/',
        description: 'NEW_DISCOVERY_SHOULD_REPLACE_OLD',
      },
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(Object.keys(second.discovered_files)).toEqual(['SRC/auth/session-store.ts']);
    expect(second.discovered_files['SRC/auth/session-store.ts'].description).toBe('NEW_DISCOVERY_SHOULD_REPLACE_OLD');
  });

  it('normalizes and deduplicates discovery paths when parsing legacy maps', () => {
    const parsed = parseAutocodeSessionCodebaseMap(JSON.stringify({
      discovered_files: {
        'src\\auth\\session-store.ts': {
          description: 'OLD_DUPLICATE_SHOULD_BE_OMITTED',
          category: 'general',
          discovered_at: '2026-01-01T00:00:00.000Z',
        },
        './SRC/auth/session-store.ts/': {
          description: 'NEW_DUPLICATE_SHOULD_REMAIN',
          category: 'auth',
          discovered_at: '2026-01-02T00:00:00.000Z',
        },
        'src/auth/token-cache.ts': {
          description: 'DISTINCT_DISCOVERY',
          category: 'auth',
          discovered_at: '2026-01-03T00:00:00.000Z',
        },
      },
      last_updated: '2026-01-03T00:00:00.000Z',
    }));

    expect(parsed?.discovered_files).toEqual({
      'SRC/auth/session-store.ts': {
        description: 'NEW_DUPLICATE_SHOULD_REMAIN',
        category: 'auth',
        discovered_at: '2026-01-02T00:00:00.000Z',
      },
      'src/auth/token-cache.ts': {
        description: 'DISTINCT_DISCOVERY',
        category: 'auth',
        discovered_at: '2026-01-03T00:00:00.000Z',
      },
    });
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
