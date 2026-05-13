import { describe, expect, it } from 'vitest';
import type { TaskLogEntry } from '../../../shared/types';
import { buildDisplayLogEntries, formatLogMarkdownForDisplay, mergeStreamingTextContent } from './task-log-display';

function createTextEntry(timestamp: string, content: string): TaskLogEntry {
  return {
    timestamp,
    type: 'text',
    content,
    phase: 'planning',
  };
}

describe('task-log-display', () => {
  it('merges adjacent streamed text entries into a single display block', () => {
    const entries: TaskLogEntry[] = [
      createTextEntry('2026-04-14T14:59:01.000Z', '已完成项目结构分析，并将结果写入：\n\n`E:\\Work\\Game'),
      createTextEntry('2026-04-14T14:59:02.000Z', '\\SSLM\\.autocode\\specs\\005-task\\'),
      createTextEntry('2026-04-14T14:59:03.000Z', 'context.json`'),
    ];

    const displayEntries = buildDisplayLogEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0].content).toContain('E:\\Work\\Game\\SSLM\\.autocode\\specs\\005-task\\context.json');
    expect(displayEntries[0].mergedEntryCount).toBe(3);
    expect(displayEntries[0].mergedEndTimestamp).toBe('2026-04-14T14:59:03.000Z');
  });

  it('keeps separate blocks when a non-text entry appears between streamed chunks', () => {
    const entries: TaskLogEntry[] = [
      createTextEntry('2026-04-14T14:59:01.000Z', 'First block'),
      {
        timestamp: '2026-04-14T14:59:02.000Z',
        type: 'tool_start',
        content: '[Read] src/main.ts',
        phase: 'planning',
        tool_name: 'Read',
      },
      createTextEntry('2026-04-14T14:59:03.000Z', 'Second block'),
    ];

    const displayEntries = buildDisplayLogEntries(entries);

    expect(displayEntries).toHaveLength(3);
  });

  it('adds a newline before markdown-style blocks when joining streamed text', () => {
    expect(
      mergeStreamingTextContent('结论摘要：', '- 这是一个自研 C++ 游戏引擎项目')
    ).toBe('结论摘要：\n- 这是一个自研 C++ 游戏引擎项目');
  });
});

describe('formatLogMarkdownForDisplay', () => {
  it('wraps raw code-like model output in markdown code fences', () => {
    const formatted = formatLogMarkdownForDisplay([
      'Updated src/app.ts:',
      'import { createRoot } from "react-dom/client";',
      'const enabled = true;',
      'export function App() {',
      '  return enabled;',
      '}',
    ].join('\n'));

    expect(formatted).toContain('```ts\nimport { createRoot } from "react-dom/client";');
    expect(formatted).toContain('export function App() {');
    expect(formatted).toContain('\n```');
  });

  it('wraps raw unified diffs in markdown diff fences', () => {
    const formatted = formatLogMarkdownForDisplay([
      'Patch:',
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n'));

    expect(formatted).toContain('```diff\ndiff --git a/src/app.ts b/src/app.ts');
    expect(formatted).toContain('-old');
    expect(formatted).toContain('+new');
  });

  it('preserves authored markdown tables without wrapping them as code', () => {
    const formatted = formatLogMarkdownForDisplay([
      '| Item | Details |',
      '| --- | --- |',
      '| What changed | Added output rendering. |',
    ].join('\n'));

    expect(formatted).not.toContain('```');
    expect(formatted).toContain('| Item | Details |');
  });
});
