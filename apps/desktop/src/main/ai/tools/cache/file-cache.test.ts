/**
 * File Content Cache Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileContentCache } from './file-cache';

describe('FileContentCache', () => {
  let cache: FileContentCache;
  let testFile: string;

  beforeEach(() => {
    cache = new FileContentCache();
    testFile = join(tmpdir(), `test-cache-${Date.now()}.txt`);
    writeFileSync(testFile, 'initial content');
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch {
      // File may not exist
    }
  });

  it('should return null on cache miss', async () => {
    const result = await cache.get(testFile);
    expect(result).toBeNull();
  });

  it('should cache file content after set', () => {
    const stat = statSync(testFile);
    cache.set(testFile, 'cached content', stat.mtimeMs);

    const result = cache.getSync(testFile);
    expect(result).toBe('cached content');
  });

  it('should invalidate cache when file is modified', async () => {
    const stat = statSync(testFile);
    cache.set(testFile, 'cached content', stat.mtimeMs);

    // Wait a bit to ensure mtime changes
    await new Promise(resolve => setTimeout(resolve, 10));

    // Modify file
    writeFileSync(testFile, 'modified content');

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
  });

  it('should invalidate cache on explicit invalidate call', () => {
    const stat = statSync(testFile);
    cache.set(testFile, 'cached content', stat.mtimeMs);

    cache.invalidate(testFile);

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
  });

  it('should track cache hits and misses', async () => {
    const stat = statSync(testFile);
    cache.set(testFile, 'cached content', stat.mtimeMs);

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
    const stat = statSync(testFile);
    cache.set(testFile, 'cached content', stat.mtimeMs);

    cache.clear();

    const result = cache.getSync(testFile);
    expect(result).toBeNull();
    expect(cache.getStats().size).toBe(0);
  });
});
