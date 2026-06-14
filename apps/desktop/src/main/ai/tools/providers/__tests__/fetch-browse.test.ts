import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FetchBrowseProvider } from '../fetch-browse';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

function mockFetchResponse(body: string, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  };
}

describe('FetchBrowseProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches raw content with browser-like headers', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse('<html>Hello</html>'));

    const provider = new FetchBrowseProvider();
    const result = await provider.browse('https://example.com');

    expect(result).toEqual({
      url: 'https://example.com',
      content: '<html>Hello</html>',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'Autocode/1.0',
        }),
      }),
    );
  });

  it('compacts long raw content with head and tail context', async () => {
    const longContent = [
      '<html><body>CONTENT_HEAD',
      'x'.repeat(40_000),
      'CONTENT_TAIL</body></html>',
    ].join('\n');
    mockFetch.mockResolvedValueOnce(mockFetchResponse(longContent));

    const provider = new FetchBrowseProvider();
    const result = await provider.browse('https://example.com');

    expect(result.content.length).toBeLessThan(longContent.length);
    expect(result.content).toContain('CONTENT_HEAD');
    expect(result.content).toContain('CONTENT_TAIL');
    expect(result.content).toContain('[Content middle omitted for context budget]');
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse('Not Found', 404, 'Not Found'));

    const provider = new FetchBrowseProvider();
    await expect(provider.browse('https://example.com/missing')).rejects.toThrow('404');
  });
});
