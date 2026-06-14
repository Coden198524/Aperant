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
});
