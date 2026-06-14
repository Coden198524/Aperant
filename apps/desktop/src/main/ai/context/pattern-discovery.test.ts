import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  discoverPatterns,
  PATTERN_FILE_READ_MAX_BYTES,
  PATTERN_SNIPPET_MAX_CHARS,
} from './pattern-discovery';
import type { FileMatch } from './types';

describe('discoverPatterns', () => {
  it('preserves the tail of long pattern snippets for implementation guidance', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-pattern-discovery-'));

    try {
      const srcDir = join(projectDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'memory.ts'),
        [
          'export function buildMemoryContext() {',
          '  const context = "memory head";',
          `  const compact = "memory ${'verbose context '.repeat(30)}FINAL_PATTERN_TAIL_GUARD";`,
          '  return compact;',
          '}',
        ].join('\n'),
        'utf8',
      );

      const referenceFiles: FileMatch[] = [{
        path: 'src/memory.ts',
        service: 'main',
        reason: 'Contains: memory',
        relevanceScore: 10,
        matchingLines: [],
      }];

      const patterns = discoverPatterns(projectDir, referenceFiles, ['MEMORY']);
      const pattern = patterns.memory_pattern;

      expect(pattern).toContain('From src/memory.ts');
      expect(pattern).toContain('memory head');
      expect(pattern).toContain('pattern middle omitted');
      expect(pattern).toContain('FINAL_PATTERN_TAIL_GUARD');
      expect(pattern.length).toBeLessThanOrEqual(PATTERN_SNIPPET_MAX_CHARS + 'From src/memory.ts:\n'.length);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('samples large pattern files from the head and tail while preserving tail patterns', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-pattern-large-file-'));

    try {
      const srcDir = join(projectDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(
        join(srcDir, 'large-memory.ts'),
        [
          'export const intro = "large pattern file";',
          'x'.repeat(PATTERN_FILE_READ_MAX_BYTES + 10_000),
          'export function buildMemoryTailPattern() {',
          '  const memory = "FINAL_LARGE_PATTERN_TAIL_GUARD";',
          '  return memory;',
          '}',
        ].join('\n'),
        'utf8',
      );

      const referenceFiles: FileMatch[] = [{
        path: 'src/large-memory.ts',
        service: 'main',
        reason: 'Contains: memory',
        relevanceScore: 10,
        matchingLines: [],
      }];

      const patterns = discoverPatterns(projectDir, referenceFiles, ['memory']);
      const pattern = patterns.memory_pattern;

      expect(pattern).toContain('From src/large-memory.ts');
      expect(pattern).toContain('FINAL_LARGE_PATTERN_TAIL_GUARD');
      expect(pattern.length).toBeLessThanOrEqual(PATTERN_SNIPPET_MAX_CHARS + 'From src/large-memory.ts:\n'.length);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('samples reference files from the head and tail before discovering patterns', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-pattern-reference-tail-'));

    try {
      const srcDir = join(projectDir, 'src');
      mkdirSync(srcDir, { recursive: true });
      const referenceFiles: FileMatch[] = [];

      for (let index = 1; index <= 7; index++) {
        const fileName = `reference-${index}.ts`;
        writeFileSync(
          join(srcDir, fileName),
          index === 7
            ? [
                'export function buildTailOnlyPattern() {',
                '  const memory = "FINAL_REFERENCE_FILE_TAIL_PATTERN";',
                '  return memory;',
                '}',
              ].join('\n')
            : `export const unrelated${index} = "no relevant keyword here";\n`,
          'utf8',
        );
        referenceFiles.push({
          path: `src/${fileName}`,
          service: 'main',
          reason: 'Reference candidate',
          relevanceScore: 1,
          matchingLines: [],
        });
      }

      const patterns = discoverPatterns(projectDir, referenceFiles, ['memory'], 5);
      const pattern = patterns.memory_pattern;

      expect(pattern).toContain('From src/reference-7.ts');
      expect(pattern).toContain('FINAL_REFERENCE_FILE_TAIL_PATTERN');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
