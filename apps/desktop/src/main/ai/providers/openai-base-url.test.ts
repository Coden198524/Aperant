import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAlternateOpenAICompatibleUrl,
  createOpenAICompatibleEndpointFetch,
  normalizeOpenAICompatibleBaseUrl,
} from './openai-base-url';

describe('openai-base-url', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes custom base URLs to /v1', () => {
    expect(normalizeOpenAICompatibleBaseUrl('https://cc-vibe.com')).toBe('https://cc-vibe.com/v1');
    expect(normalizeOpenAICompatibleBaseUrl('https://cc-vibe.com/api/openai')).toBe('https://cc-vibe.com/api/openai/v1');
    expect(normalizeOpenAICompatibleBaseUrl('https://cc-vibe.com/v1')).toBe('https://cc-vibe.com/v1');
  });

  it('builds alternate URLs by toggling the /v1 segment', () => {
    expect(buildAlternateOpenAICompatibleUrl('https://cc-vibe.com/chat/completions'))
      .toBe('https://cc-vibe.com/v1/chat/completions');
    expect(buildAlternateOpenAICompatibleUrl('https://cc-vibe.com/v1/chat/completions'))
      .toBe('https://cc-vibe.com/chat/completions');
  });

  it('retries the alternate URL when the primary response looks like an endpoint mismatch', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const wrappedFetch = createOpenAICompatibleEndpointFetch();
    const response = await wrappedFetch('https://cc-vibe.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe('https://cc-vibe.com/chat/completions');
    expect((fetchMock.mock.calls[1]?.[0] as Request).url).toBe('https://cc-vibe.com/v1/chat/completions');
    expect(response.status).toBe(200);
  });
});
