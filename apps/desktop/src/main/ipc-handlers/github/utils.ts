/**
 * GitHub utility functions
 */

import { existsSync, readFileSync } from 'fs';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getAutocodeProjectEnvPath } from '@autocode/core';
import {
  GITHUB_ETAG_CACHE_MAX_SIZE,
  GITHUB_ETAG_CACHE_TTL_MS,
  GITHUB_ETAG_EVICTION_INTERVAL,
  clearGitHubETagCache,
  clearGitHubETagCacheForProject,
  evictGitHubETagCacheEntries,
  extractGitHubRateLimitInfo,
  normalizeGitHubRepoReference,
  type GitHubETagCache,
  type GitHubETagCacheEntry,
  type GitHubRateLimitInfo,
} from '@autocode/core/integrations/github';
import type { Project } from '../../../shared/types';
import { parseEnvFile } from '../utils';
import type { GitHubConfig } from './types';
import { getAugmentedEnv } from '../../env-utils';
import { getToolPath } from '../../cli-tool-manager';

const execFileAsync = promisify(execFile);

/**
 * ETag cache entry for conditional requests
 */
export type ETagCacheEntry = GitHubETagCacheEntry;

/**
 * ETag cache for storing conditional request data
 */
export type ETagCache = GitHubETagCache;

/**
 * Rate limit information extracted from GitHub API response headers
 */
export type RateLimitInfo = GitHubRateLimitInfo;

/**
 * Response from githubFetchWithETag including cache status and rate limit info
 */
export interface GitHubFetchWithETagResult {
  data: unknown;
  fromCache: boolean;
  rateLimitInfo: RateLimitInfo | null;
}

/**
 * Maximum age for cache entries (30 minutes)
 */
const ETAG_CACHE_TTL_MS = GITHUB_ETAG_CACHE_TTL_MS;

/**
 * Maximum number of cache entries before evicting oldest
 */
const ETAG_CACHE_MAX_SIZE = GITHUB_ETAG_CACHE_MAX_SIZE;

/**
 * Run eviction every N cache writes to amortize cost
 */
const ETAG_EVICTION_INTERVAL = GITHUB_ETAG_EVICTION_INTERVAL;

/**
 * Counter for cache writes since last eviction
 */
let evictionWriteCounter = 0;

/**
 * Module-level ETag cache instance
 */
const etagCache: ETagCache = {};

/**
 * Get the ETag cache (for testing or external access)
 */
export function getETagCache(): ETagCache {
  return etagCache;
}

/**
 * Clear all ETag cache entries (for testing)
 */
export function clearETagCache(): void {
  clearGitHubETagCache(etagCache);
  evictionWriteCounter = 0;
}

/**
 * Clear ETag cache entries whose URL contains the given repo path (owner/repo).
 * Used when stopping polling for a specific project so other projects' caches remain valid.
 */
export function clearETagCacheForProject(ownerRepo: string): void {
  clearGitHubETagCacheForProject(etagCache, ownerRepo);
}

/**
 * Evict stale entries (older than TTL) and enforce max size by removing oldest entries.
 */
function evictStaleCacheEntries(): void {
  evictGitHubETagCacheEntries(
    etagCache,
    Date.now(),
    ETAG_CACHE_TTL_MS,
    ETAG_CACHE_MAX_SIZE
  );
}

/**
 * Extract rate limit information from GitHub API response headers
 */
export function extractRateLimitInfo(response: Response): RateLimitInfo | null {
  return extractGitHubRateLimitInfo(response);
}

/**
 * Get GitHub token from gh CLI if available (async to avoid blocking main thread)
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
async function getTokenFromGhCliAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(getToolPath('gh'), ['auth', 'token'], {
      encoding: 'utf-8',
      env: getAugmentedEnv()
    });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get GitHub token from gh CLI if available (sync version for getGitHubConfig)
 * Uses augmented PATH to find gh CLI in common locations (e.g., Homebrew on macOS)
 */
function getTokenFromGhCliSync(): string | null {
  try {
    const token = execFileSync(getToolPath('gh'), ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: getAugmentedEnv()
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get a fresh GitHub token for subprocess use (async to avoid blocking main thread)
 * Always fetches fresh from gh CLI - no caching to ensure account changes are reflected
 * @returns The current GitHub token or null if not authenticated
 */
export async function getGitHubTokenForSubprocess(): Promise<string | null> {
  return getTokenFromGhCliAsync();
}

/**
 * Get GitHub configuration from project environment file
 * Falls back to gh CLI token if GITHUB_TOKEN not in .env
 */
export function getGitHubConfig(project: Project): GitHubConfig | null {
  if (!project.autoBuildPath) return null;
  const envPath = getAutocodeProjectEnvPath(project.path, project.autoBuildPath);
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars = parseEnvFile(content);
    let token: string | undefined = vars['GITHUB_TOKEN'];
    const repo = vars['GITHUB_REPO'];

    // If no token in .env, try to get it from gh CLI (sync version for sync function)
    if (!token) {
      const ghToken = getTokenFromGhCliSync();
      if (ghToken) {
        token = ghToken;
      }
    }

    if (!token || !repo) return null;
    return { token, repo };
  } catch {
    return null;
  }
}

/**
 * Normalize a GitHub repository reference to owner/repo format
 * Handles:
 * - owner/repo (already normalized)
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
export function normalizeRepoReference(repo: string): string {
  return normalizeGitHubRepoReference(repo);
}

/**
 * Make a request to the GitHub API
 */
export async function githubFetch(
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  // CodeQL: file data in outbound request - validate token is a non-empty string before use
  const safeToken = typeof token === 'string' && token.length > 0 ? token : '';
  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${safeToken}`,
      'User-Agent': 'Autocode',
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Request failed');
    throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

/**
 * Make a request to the GitHub API with ETag caching support
 * Uses If-None-Match header for conditional requests.
 * Returns 304 responses from cache without counting against rate limit.
 */
export async function githubFetchWithETag(
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<GitHubFetchWithETagResult> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const cached = etagCache[url];
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Autocode'
  };

  // Add If-None-Match header if we have a cached ETag
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers
    }
  });

  const rateLimitInfo = extractRateLimitInfo(response);

  // Handle 304 Not Modified - return cached data
  if (response.status === 304 && cached) {
    return {
      data: cached.data,
      fromCache: true,
      rateLimitInfo
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Request failed');
    throw new Error(`GitHub API error: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();

  // Store new ETag if present
  const newETag = response.headers.get('ETag');
  if (newETag) {
    etagCache[url] = {
      etag: newETag,
      data,
      lastUpdated: new Date()
    };
    evictionWriteCounter++;
    if (evictionWriteCounter >= ETAG_EVICTION_INTERVAL) {
      evictionWriteCounter = 0;
      evictStaleCacheEntries();
    }
  }

  return {
    data,
    fromCache: false,
    rateLimitInfo
  };
}
