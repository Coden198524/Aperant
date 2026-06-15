/**
 * WebSearch Tool
 * ==============
 *
 * Performs web searches via a pluggable SearchProvider.
 * Supports domain filtering (allow/block lists).
 * Provider-agnostic — works with any LLM provider.
 *
 * Default provider: Tavily (requires TAVILY_API_KEY).
 */

import { z } from 'zod/v3';

import { Tool } from '../define';
import { createSearchProvider } from '../providers';
import type { SearchResult } from '../providers/types';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;
const MAX_SNIPPET_LENGTH = 240;
const SEARCH_SNIPPET_OMISSION_MARKER = ' ... [omitted] ... ';

interface PreparedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  query: z.string().min(2).describe('The search query to use'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe('Only include search results from these domains'),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Never include search results from these domains'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const webSearchTool = Tool.define({
  metadata: {
    name: 'WebSearch',
    description:
      'Searches the web and returns results to inform responses. Provides up-to-date information for current events and recent data. Supports domain filtering.',
    permission: ToolPermission.ReadOnly,
    executionOptions: {
      ...DEFAULT_EXECUTION_OPTIONS,
      timeoutMs: SEARCH_TIMEOUT_MS,
    },
  },
  inputSchema,
  execute: async (input) => {
    const { query, allowed_domains, blocked_domains } = input;

    try {
      const provider = createSearchProvider();

      const results = await provider.search(query, {
        maxResults: MAX_RESULTS,
        includeDomains: allowed_domains?.length ? allowed_domains : undefined,
        excludeDomains: blocked_domains?.length ? blocked_domains : undefined,
        timeout: SEARCH_TIMEOUT_MS,
      });

      if (!results.length) {
        return `No search results found for: ${query}`;
      }

      const preparedResults = prepareSearchResults(results);
      if (!preparedResults.length) {
        return `No search results found for: ${query}`;
      }

      const formatted = preparedResults.map((r, i) => (
        `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
      ));

      const omittedCount = results.length - preparedResults.length;
      const omissionSummary = omittedCount > 0
        ? `\n(${preparedResults.length} unique results shown, ${omittedCount} duplicate/empty results omitted)`
        : '';

      return `Search results for: ${query}${omissionSummary}\n\n${formatted.join('\n\n')}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  },
});

function prepareSearchResults(results: SearchResult[]): PreparedSearchResult[] {
  const seenUrls = new Set<string>();
  const prepared: PreparedSearchResult[] = [];

  for (const result of results) {
    const url = result.url.trim();
    if (!url) {
      continue;
    }

    const urlKey = normalizeSearchResultUrl(url);
    if (seenUrls.has(urlKey)) {
      continue;
    }
    seenUrls.add(urlKey);

    const title = normalizeSearchResultText(result.title) || 'Untitled result';
    const snippet = compactSearchSnippet(result.content ?? '');
    prepared.push({ title, url, snippet });
  }

  return prepared;
}

function normalizeSearchResultUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    if (parsed.pathname !== '/') {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

function compactSearchSnippet(value: string): string {
  const normalized = normalizeSearchResultText(value);
  if (normalized.length <= MAX_SNIPPET_LENGTH) {
    return normalized;
  }

  const available = MAX_SNIPPET_LENGTH - SEARCH_SNIPPET_OMISSION_MARKER.length;
  const headLength = Math.ceil(available * 0.65);
  const tailLength = Math.floor(available * 0.35);

  return [
    normalized.slice(0, headLength).trimEnd(),
    SEARCH_SNIPPET_OMISSION_MARKER,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}

function normalizeSearchResultText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
