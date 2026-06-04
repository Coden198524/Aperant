/**
 * File Content Cache
 * ==================
 *
 * Session-scoped cache for file contents to avoid redundant disk I/O.
 * Uses mtime-based invalidation to detect external file modifications.
 *
 * Performance benefits:
 * - 10-50x faster for repeated reads of the same file
 * - Reduces disk I/O and SSD wear
 * - Keeps long sessions bounded with LRU eviction
 */

import * as fs from 'node:fs';

interface CacheEntry {
  content: string;
  mtime: number;
  bytes: number;
}

export interface FileContentCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export class FileContentCache {
  private cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: FileContentCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /**
   * Get cached file content if available and still valid.
   * Returns null if cache miss or file has been modified.
   */
  async get(filePath: string): Promise<string | null> {
    const cached = this.cache.get(filePath);
    if (!cached) {
      this.misses++;
      return null;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs === cached.mtime) {
        this.hits++;
        this.markRecentlyUsed(filePath, cached);
        return cached.content;
      }

      this.deleteEntry(filePath);
      this.misses++;
      return null;
    } catch {
      this.deleteEntry(filePath);
      this.misses++;
      return null;
    }
  }

  /**
   * Synchronous version of get() for use in sync code paths.
   */
  getSync(filePath: string): string | null {
    const cached = this.cache.get(filePath);
    if (!cached) {
      this.misses++;
      return null;
    }

    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === cached.mtime) {
        this.hits++;
        this.markRecentlyUsed(filePath, cached);
        return cached.content;
      }

      this.deleteEntry(filePath);
      this.misses++;
      return null;
    } catch {
      this.deleteEntry(filePath);
      this.misses++;
      return null;
    }
  }

  /**
   * Store file content in cache with mtime for validation.
   */
  set(filePath: string, content: string, mtime: number): void {
    const bytes = Buffer.byteLength(content, 'utf-8');
    this.deleteEntry(filePath);

    if (bytes > this.maxBytes) {
      return;
    }

    this.cache.set(filePath, { content, mtime, bytes });
    this.totalBytes += bytes;
    this.enforceLimits();
  }

  /**
   * Invalidate cache entry for a specific file.
   * Called after Write/Edit operations.
   */
  invalidate(filePath: string): void {
    this.deleteEntry(filePath);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalBytes = 0;
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
    bytes: number;
    maxEntries: number;
    maxBytes: number;
  } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
      bytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    };
  }

  private markRecentlyUsed(filePath: string, entry: CacheEntry): void {
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);
  }

  private deleteEntry(filePath: string): void {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return;
    }

    this.totalBytes -= entry.bytes;
    this.cache.delete(filePath);
  }

  private enforceLimits(): void {
    while (this.cache.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestPath = this.cache.keys().next().value;
      if (!oldestPath) {
        break;
      }
      this.deleteEntry(oldestPath);
    }
  }
}
