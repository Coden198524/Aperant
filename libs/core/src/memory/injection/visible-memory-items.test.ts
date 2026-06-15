import { describe, expect, it } from 'vitest';

import type { Memory } from '../types.js';
import { getRenderedVisibleMemories } from './visible-memory-items.js';

function makeMemory(id: string): Memory {
  return {
    id,
    type: 'requirement',
    content: `Memory ${id}`,
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
    projectId: 'project-1',
  };
}

describe('getRenderedVisibleMemories', () => {
  it('matches visible rendered lines after whitespace compaction', () => {
    const memory = makeMemory('visible');

    const result = getRenderedVisibleMemories(
      '=== MEMORY CONTEXT FOR QA === - Auth callback tests must wait before assertions. === END MEMORY CONTEXT ===',
      [
        {
          memory,
          renderedLine:
            '- Auth callback tests\n  must   wait before assertions.',
        },
      ],
    );

    expect(result).toEqual([memory]);
  });

  it('matches rendered lines that were folded for repeated prompt content', () => {
    const memory = makeMemory('folded');
    const repeatedLine =
      'REPEATED_MEMORY_LINE: watcher emitted the same reconnect warning without new state.';
    const rawRenderedLine = [
      '- Investigation note:',
      ...Array.from({ length: 8 }, () => repeatedLine),
    ].join('\n');

    const result = getRenderedVisibleMemories(
      [
        '=== MEMORY CONTEXT FOR QA ===',
        '- Investigation note:',
        repeatedLine,
        '[... 7 repeated line(s) omitted for prompt budget ...]',
        '=== END MEMORY CONTEXT ===',
      ].join('\n'),
      [
        {
          memory,
          renderedLine: rawRenderedLine,
        },
      ],
    );

    expect(result).toEqual([memory]);
  });

  it('skips memories whose rendered line was only partially retained', () => {
    const visible = makeMemory('visible');
    const partial = makeMemory('partial');

    const result = getRenderedVisibleMemories(
      '=== MEMORY CONTEXT FOR QA === - Visible requirement remains intact. ... [middle omitted] ... partial tail only === END MEMORY CONTEXT ===',
      [
        {
          memory: visible,
          renderedLine: '- Visible requirement remains intact.',
        },
        {
          memory: partial,
          renderedLine: '- Hidden requirement with partial tail only',
        },
      ],
    );

    expect(result).toEqual([visible]);
  });

  it('does not treat a rendered line as visible when it is only a prefix of a longer line', () => {
    const shortPrefix = makeMemory('short-prefix');
    const longLine = makeMemory('long-line');

    const result = getRenderedVisibleMemories(
      '=== MEMORY CONTEXT FOR QA === - Auth callback must wait before listener assertions. === END MEMORY CONTEXT ===',
      [
        {
          memory: shortPrefix,
          renderedLine: '- Auth callback must wait',
        },
        {
          memory: longLine,
          renderedLine: '- Auth callback must wait before listener assertions.',
        },
      ],
    );

    expect(result).toEqual([longLine]);
  });
});
