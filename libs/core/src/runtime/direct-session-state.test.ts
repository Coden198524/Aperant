import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS,
  AUTOCODE_DIRECT_SESSION_ORIGINAL_REQUEST_MAX_CHARS,
  AUTOCODE_DIRECT_SESSION_STATE_VERSION,
  loadAutocodeDirectSessionState,
  saveAutocodeDirectSessionState,
} from './direct-session-state.js';

describe('direct session state', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'autocode-direct-state-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('limits latestSummary stored for summary-based continuation', () => {
    const longSummary = `summary start ${'repeated direct execution details '.repeat(120)} summary tail`;

    saveAutocodeDirectSessionState(tempRoot, {
      version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
      sessionId: 'direct-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      latestSummary: longSummary,
    });

    const state = loadAutocodeDirectSessionState(tempRoot);

    expect(state?.latestSummary).toContain('summary start');
    expect(state?.latestSummary).toContain('direct session summary middle omitted for continuation budget');
    expect(state?.latestSummary).toContain('summary tail');
    expect(state?.latestSummary?.length).toBeLessThanOrEqual(AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS);
  });

  it('folds repeated latestSummary lines before storing continuation state', () => {
    const repeatedLine = 'REPEATED_SUMMARY_LOG: provider emitted the same retry warning with no new state.';
    const longSummary = [
      'Summary head: completed the focused runtime change.',
      ...Array.from({ length: 180 }, () => repeatedLine),
      'Summary tail: remaining work is focused validation only.',
    ].join('\n');

    saveAutocodeDirectSessionState(tempRoot, {
      version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
      sessionId: 'direct-repeated-summary',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      latestSummary: longSummary,
    });

    const state = loadAutocodeDirectSessionState(tempRoot);

    expect(state?.latestSummary).toContain('Summary head: completed the focused runtime change.');
    expect(state?.latestSummary).toContain('Summary tail: remaining work is focused validation only.');
    expect(state?.latestSummary).toContain('179 repeated line(s) omitted for prompt budget');
    expect((state?.latestSummary?.match(/REPEATED_SUMMARY_LOG/g) ?? [])).toHaveLength(1);
    expect(state?.latestSummary).not.toContain('direct session summary middle omitted');
    expect(state?.latestSummary?.length).toBeLessThan(longSummary.length / 5);
  });

  it('keeps both ends of oversized original requests in persisted state', () => {
    const longRequest = [
      'Opening request rule: keep configuration tables as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large direct request context ${index}: ${'diagnostic noise '.repeat(8)}`,
      ),
      'Closing request rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    saveAutocodeDirectSessionState(tempRoot, {
      version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
      sessionId: 'direct-2',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      originalRequest: longRequest,
    });

    const state = loadAutocodeDirectSessionState(tempRoot);

    expect(state?.originalRequest).toContain('Opening request rule: keep configuration tables as JSON.');
    expect(state?.originalRequest).toContain('original request middle omitted for state budget');
    expect(state?.originalRequest).toContain('Closing request rule: convert only model-readable prose references to Markdown.');
    expect(state?.originalRequest).not.toContain('Large direct request context 160');
    expect(state?.originalRequest?.length).toBeLessThanOrEqual(AUTOCODE_DIRECT_SESSION_ORIGINAL_REQUEST_MAX_CHARS);
  });

  it('folds repeated originalRequest lines before storing direct session state', () => {
    const repeatedLine = 'REPEATED_REQUEST_LOG: renderer printed the same warning without new evidence.';
    const longRequest = [
      'Opening request rule: continue product optimization first.',
      ...Array.from({ length: 220 }, () => repeatedLine),
      'Closing request rule: do not run release verification.',
    ].join('\n');

    saveAutocodeDirectSessionState(tempRoot, {
      version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
      sessionId: 'direct-repeated-request',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      iteration: 1,
      originalRequest: longRequest,
    });

    const state = loadAutocodeDirectSessionState(tempRoot);

    expect(state?.originalRequest).toContain('Opening request rule: continue product optimization first.');
    expect(state?.originalRequest).toContain('Closing request rule: do not run release verification.');
    expect(state?.originalRequest).toContain('219 repeated line(s) omitted for prompt budget');
    expect((state?.originalRequest?.match(/REPEATED_REQUEST_LOG/g) ?? [])).toHaveLength(1);
    expect(state?.originalRequest).not.toContain('original request middle omitted');
    expect(state?.originalRequest?.length).toBeLessThan(longRequest.length / 5);
  });
});
