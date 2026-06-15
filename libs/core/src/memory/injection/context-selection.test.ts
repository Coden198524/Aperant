import { describe, expect, it } from 'vitest';

import type { Memory } from '../types.js';
import { selectMemoryContextItems } from './context-selection.js';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    type: 'pattern',
    content: 'Remember the important project behavior.',
    confidence: 0.8,
    tags: [],
    relatedFiles: [],
    relatedModules: ['auth'],
    createdAt: '2026-06-14T00:00:00.000Z',
    lastAccessedAt: '2026-06-14T00:00:00.000Z',
    accessCount: 0,
    scope: 'module',
    source: 'agent_explicit',
    sessionId: 'session-1',
    provenanceSessionIds: [],
    projectId: 'project-1',
    ...overrides,
  };
}

describe('selectMemoryContextItems', () => {
  it('keeps distinct memories that share a long prefix but differ in the tail', () => {
    const sharedPrefix = 'Shared migration lesson '.repeat(30);
    const selected = selectMemoryContextItems([
      memory({
        id: 'alpha',
        content: `${sharedPrefix}TAIL_ALPHA`,
        confidence: 0.9,
      }),
      memory({
        id: 'beta',
        content: `${sharedPrefix}TAIL_BETA`,
        confidence: 0.89,
      }),
    ], { maxItems: 5 });

    expect(selected.map((item) => item.id)).toEqual(['alpha', 'beta']);
  });

  it('deduplicates exact normalized duplicates while keeping the highest scored memory', () => {
    const selected = selectMemoryContextItems([
      memory({
        id: 'low',
        content: 'Use Shared Writer for settings.',
        confidence: 0.7,
      }),
      memory({
        id: 'high',
        content: 'use shared writer for settings',
        confidence: 0.95,
      }),
    ], { maxItems: 5 });

    expect(selected.map((item) => item.id)).toEqual(['high']);
  });

  it('deduplicates near-duplicate memories after ranking', () => {
    const selected = selectMemoryContextItems([
      memory({
        id: 'lower-score-duplicate',
        content: 'When editing auth refresh flow, update token cache before notifying listeners and keep retry guard enabled.',
        confidence: 0.75,
      }),
      memory({
        id: 'higher-score-duplicate',
        content: 'When editing auth refresh flow update token cache before notifying listener and keep retry guard enabled.',
        confidence: 0.92,
      }),
      memory({
        id: 'distinct',
        content: 'Mock the OAuth clock before testing refresh retries.',
        confidence: 0.82,
      }),
    ], { maxItems: 3 });

    expect(selected.map((item) => item.id)).toEqual(['higher-score-duplicate', 'distinct']);
  });

  it('uses shared seen content to deduplicate across separate selection passes', () => {
    const seenContents: string[] = [];
    const first = selectMemoryContextItems([
      memory({
        id: 'requirement',
        content: 'Auth callback tests must wait for token cache refresh before asserting listener notifications.',
        confidence: 0.9,
      }),
    ], { maxItems: 2, seenContents });
    const second = selectMemoryContextItems([
      memory({
        id: 'duplicate-error-pattern',
        content: 'Auth callback tests should wait for token cache refresh before asserting listener notification.',
        confidence: 0.95,
      }),
      memory({
        id: 'distinct-error-pattern',
        content: 'OAuth retry tests need a mocked clock to avoid flaky expiry assertions.',
        confidence: 0.82,
      }),
    ], { maxItems: 2, seenContents });

    expect(first.map((item) => item.id)).toEqual(['requirement']);
    expect(second.map((item) => item.id)).toEqual(['distinct-error-pattern']);
  });

  it('deduplicates using caller-provided rendered content', () => {
    const selected = selectMemoryContextItems([
      memory({
        id: 'lower',
        content: 'Raw lower confidence detail that renders the same.',
        confidence: 0.7,
      }),
      memory({
        id: 'higher',
        content: 'Different raw detail that renders the same.',
        confidence: 0.95,
      }),
    ], {
      maxItems: 5,
      getContent: () => 'Rendered memory line after compaction.',
    });

    expect(selected.map((item) => item.id)).toEqual(['higher']);
  });

  it('uses low-value filtered content for default selection', () => {
    const selected = selectMemoryContextItems([
      memory({
        id: 'status-only',
        content: [
          'All tests passed.',
          'No issues found.',
          'Duration: 1234ms',
        ].join('\n'),
        confidence: 0.99,
      }),
      memory({
        id: 'actionable',
        content: [
          'Mock the OAuth clock before testing refresh retries.',
          'npm run typecheck passed.',
          'No issues found.',
        ].join('\n'),
        confidence: 0.8,
      }),
    ], { maxItems: 5 });

    expect(selected.map((item) => item.id)).toEqual(['actionable']);
  });
});
