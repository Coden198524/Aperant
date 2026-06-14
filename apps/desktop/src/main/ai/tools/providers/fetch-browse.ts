/**
 * Fetch Browse Provider
 * =====================
 *
 * BrowseProvider implementation using native fetch().
 * Returns raw HTML content — no markdown conversion.
 * Used as a fallback when Jina is unavailable.
 */

import type { BrowseOptions, BrowseProvider, BrowseResult } from './types';
import { compactBrowseContent } from './content-compaction';

const DEFAULT_TIMEOUT = 30_000;

export class FetchBrowseProvider implements BrowseProvider {
  readonly name = 'fetch';

  async browse(url: string, options?: BrowseOptions): Promise<BrowseResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Autocode/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const content = await response.text();

      return { url, content: compactBrowseContent(content) };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
