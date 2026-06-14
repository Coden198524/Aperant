import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SEARCH_FILE_READ_MAX_BYTES,
  SEARCH_MAX_MATCHES,
  searchService,
  SEARCH_MATCHING_LINE_MAX_CHARS,
} from './search';

describe('searchService', () => {
  it('preserves late matching lines and long line tails in compact search matches', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-context-search-'));

    try {
      const srcDir = join(projectDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'memory.ts'),
        [
          'export const first = "memory head";',
          'export const second = "memory middle";',
          'export const third = "memory extra";',
          `export const longLine = "memory ${'verbose diagnostic '.repeat(20)}FINAL_MEMORY_LINE_TAIL";`,
          'export const finalConstraint = "memory FINAL_LATE_MEMORY_CONSTRAINT";',
        ].join('\n'),
        'utf8',
      );

      const matches = searchService(srcDir, 'main', ['MEMORY'], projectDir);

      expect(matches).toHaveLength(1);
      const lines = matches[0].matchingLines.map(([, line]) => line);
      expect(lines.join('\n')).toContain('memory head');
      expect(lines.join('\n')).toContain('FINAL_MEMORY_LINE_TAIL');
      expect(lines.join('\n')).toContain('FINAL_LATE_MEMORY_CONSTRAINT');
      expect(lines.some((line) => line.includes('line middle omitted'))).toBe(true);
      expect(lines.every((line) => line.length <= SEARCH_MATCHING_LINE_MAX_CHARS)).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('samples large files from the head and tail instead of reading them wholesale', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-context-search-large-'));

    try {
      const srcDir = join(projectDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'large-memory.ts'),
        [
          'export const intro = "large generated file";',
          'x'.repeat(SEARCH_FILE_READ_MAX_BYTES + 10_000),
          'export const finalMemoryConstraint = "memory FINAL_LARGE_FILE_TAIL";',
        ].join('\n'),
        'utf8',
      );

      const matches = searchService(srcDir, 'main', ['memory'], projectDir);

      expect(matches).toHaveLength(1);
      expect(matches[0].reason).toContain('head/tail file sample');
      expect(matches[0].matchingLines.map(([, line]) => line).join('\n')).toContain('FINAL_LARGE_FILE_TAIL');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps production matches when many test files also match', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-context-search-priority-'));

    try {
      const srcDir = join(projectDir, 'src');
      const testsDir = join(projectDir, '__tests__');
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'MemoryFeature.ts'),
        'export function MemoryFeature() { return "memory production implementation"; }\n',
        'utf8',
      );
      for (let index = 0; index < SEARCH_MAX_MATCHES + 5; index++) {
        writeFileSync(
          join(testsDir, `memory-${index}.test.ts`),
          `it('covers memory ${index}', () => expect('memory').toBe('memory'));\n`,
          'utf8',
        );
      }

      const matches = searchService(projectDir, 'main', ['memory'], projectDir);
      const paths = matches.map((match) => match.path.replace(/\\/g, '/'));
      const testMatches = paths.filter((filePath) => filePath.includes('__tests__/'));

      expect(paths).toContain('src/MemoryFeature.ts');
      expect(testMatches.length).toBeLessThanOrEqual(6);
      expect(matches.length).toBeLessThanOrEqual(SEARCH_MAX_MATCHES);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
