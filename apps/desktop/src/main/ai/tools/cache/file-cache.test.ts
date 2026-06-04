/**
 * File Content Cache Tests
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileContentCache } from './file-cache';

describe('FileContentCache', () => {
  let cache: FileContentCache;
  let testFile: string;
  let tempFiles: string[];

  beforeEach(() => {
    cache = new FileContentCache();
    tempFiles = [];
    testFile = createTempFile('initial content');
  });

  afterEach(() => {
    for (const filePath of tempFiles) {
      try {
        unlinkSync(filePath);
      } catch {
        // File may not exist
      }
    }
  });

  function createTempFile(content: string): string {
    const filePath = join(tmpdir(), `test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    tempFiles.push(filePath);
    writeFileSync(filePath, content);
    return filePath;
  }

  function cacheFile(filePath: string, content: string): void {
    const stat = statSync(filePath);
    cache.set(filePath, content, stat.mtimeMs);
  }

  it('should return null on cache miss', async () => {
    const result = await cache.get(testFile);
    expect(result).toBeNull();
  });

  it('should cache file content after set', () => {
    cacheFile(testFile, 'cached content');

    const result = cache.getSync(testFile);
    expect(result).toBe('cached content');
  });

  it('should invalidate cache when file is modified', async () => {
    cacheFile(testFile, 'cached content');

    // Wait a bit to ensure mtime changes
    await new Promise(resolve => setTimeout(resolve, 10));

    // Modify file
    writeFileSync(testFile, 'modified content');

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
  });

  it('should invalidate cache on explicit invalidate call', () => {
    cacheFile(testFile, 'cached content');

    cache.invalidate(testFile);

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
  });

  it('should track cache hits and misses', async () => {
    cacheFile(testFile, 'cached content');

    // Hit
    cache.getSync(testFile);
    // Miss
    await cache.get('/nonexistent/file.txt');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it('should clear all cache entries', () => {
    cacheFile(testFile, 'cached content');

    cache.clear();

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });

  it('should evict least recently used entries when max entries is reached', () => {
    cache = new FileContentCache({ maxEntries: 2 });
    const first = createTempFile('first');
    const second = createTempFile('second');
    const third = createTempFile('third');

    cacheFile(first, 'first');
    cacheFile(second, 'second');
    expect(cache.getSync(first)).toBe('first');
    cacheFile(third, 'third');

    expect(cache.getSync(first)).toBe('first');
    expect(cache.getSync(second)).toBeNull();
    expect(cache.getSync(third)).toBe('third');
    expect(cache.getStats().size).toBe(2);
  });

  it('should evict oldest entries when total cached bytes is reached', () => {
    cache = new FileContentCache({ maxBytes: 10 });
    const first = createTempFile('aaaaaa');
    const second = createTempFile('bbbbbb');

    cacheFile(first, 'aaaaaa');
    cacheFile(second, 'bbbbbb');

    expect(cache.getSync(first)).toBeNull();
    expect(cache.getSync(second)).toBe('bbbbbb');
    expect(cache.getStats().bytes).toBe(6);
  });

  it('should skip caching a file larger than the total byte limit', () => {
    cache = new FileContentCache({ maxBytes: 5 });

    cacheFile(testFile, 'larger');

    expect(cache.getSync(testFile)).toBeNull();
    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().bytes).toBe(0);
  });
});
