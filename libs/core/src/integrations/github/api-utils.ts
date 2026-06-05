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
