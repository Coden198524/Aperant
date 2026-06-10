export interface GitHubRateLimitInfo {
  remaining: number;
  reset: Date;
  limit: number;
}

export interface GitHubRateLimitHeadersLike {
  headers: {
    get(name: string): string | null;
  };
}

export interface GitHubETagCacheEntry {
  etag: string;
  data: unknown;
  lastUpdated: Date;
}

export type GitHubETagCache = Record<string, GitHubETagCacheEntry>;

export const GITHUB_ETAG_CACHE_TTL_MS = 30 * 60 * 1000;
export const GITHUB_ETAG_CACHE_MAX_SIZE = 200;
export const GITHUB_ETAG_EVICTION_INTERVAL = 10;

export function extractGitHubRateLimitInfo(response: GitHubRateLimitHeadersLike): GitHubRateLimitInfo | null {
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');
  const limit = response.headers.get('X-RateLimit-Limit');

  if (remaining === null || reset === null) {
    return null;
  }

  return {
    remaining: Number.parseInt(remaining, 10),
    reset: new Date(Number.parseInt(reset, 10) * 1000),
    limit: limit ? Number.parseInt(limit, 10) : 5000,
  };
}

export function normalizeGitHubRepoReference(repo: string): string {
  if (!repo) return '';

  let normalized = repo.replace(/\.git$/, '');

  if (normalized.startsWith('https://github.com/')) {
    normalized = normalized.replace('https://github.com/', '');
  } else if (normalized.startsWith('http://github.com/')) {
    normalized = normalized.replace('http://github.com/', '');
  } else if (normalized.startsWith('git@github.com:')) {
    normalized = normalized.replace('git@github.com:', '');
  }

  return normalized.trim();
}

export function clearGitHubETagCache(cache: GitHubETagCache): void {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}

export function clearGitHubETagCacheForProject(cache: GitHubETagCache, ownerRepo: string): void {
  const prefix = `https://api.github.com/repos/${ownerRepo}`;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(prefix)) {
      delete cache[key];
    }
  }
}

export function evictGitHubETagCacheEntries(
  cache: GitHubETagCache,
  now = Date.now(),
  ttlMs = GITHUB_ETAG_CACHE_TTL_MS,
  maxSize = GITHUB_ETAG_CACHE_MAX_SIZE,
): void {
  const keys = Object.keys(cache);

  for (const key of keys) {
    if (now - cache[key].lastUpdated.getTime() > ttlMs) {
      delete cache[key];
    }
  }

  const remainingKeys = Object.keys(cache);
  if (remainingKeys.length <= maxSize) {
    return;
  }

  const sorted = remainingKeys.sort(
    (a, b) => cache[a].lastUpdated.getTime() - cache[b].lastUpdated.getTime(),
  );
  const toRemove = sorted.slice(0, sorted.length - maxSize);
  for (const key of toRemove) {
    delete cache[key];
  }
}
