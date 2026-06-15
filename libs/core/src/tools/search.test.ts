import { describe, expect, it } from 'vitest';

import {
  buildRipgrepArgs,
  formatSearchPathResults,
  GLOB_SUMMARY_SAMPLE_SIZE,
  GREP_COUNT_SUMMARY_THRESHOLD,
  GREP_FILES_WITH_MATCHES_SUMMARY_THRESHOLD,
  GREP_MAX_OUTPUT_LINE_LENGTH,
  GREP_RIPGREP_MAX_FILESIZE,
  relativizeSearchOutputPaths,
  summarizeGrepCountOutput,
  summarizeGrepFilesWithMatchesOutput,
  summarizePathsByDirectory,
  truncateSearchOutput,
} from './search.js';

describe('search result summarization', () => {
  it('limits ripgrep searches to text-sized files like the built-in fallback', () => {
    const args = buildRipgrepArgs({ pattern: 'auth' }, '/repo');

    expect(args).toContain('--max-filesize');
    expect(args).toContain(GREP_RIPGREP_MAX_FILESIZE);
  });

  it('summarizes glob samples with compact relative paths', () => {
    const paths = Array.from(
      { length: GLOB_SUMMARY_SAMPLE_SIZE + 5 },
      (_, index) => `/repo/src/files/file-${index}.ts`,
    );

    const summary = summarizePathsByDirectory(paths, '/repo', paths.length);

    expect(summary).toContain(`First ${GLOB_SUMMARY_SAMPLE_SIZE} recently modified files:`);
    expect(summary).toContain('src/files/file-0.ts');
    expect(summary).not.toContain('/repo/src/files/file-0.ts');
    expect(summary).not.toContain(`src/files/file-${GLOB_SUMMARY_SAMPLE_SIZE}.ts`);
  });

  it('formats ordinary path results with compact relative paths', () => {
    const result = formatSearchPathResults([
      '/repo/src/auth/session.ts',
      '/repo/src/auth/token-cache.ts',
      '/repo/src/auth/unused.ts',
    ], '/repo', 2);

    expect(result).toBe('src/auth/session.ts\nsrc/auth/token-cache.ts');
    expect(result).not.toContain('/repo/src');
    expect(result).not.toContain('unused.ts');
  });

  it('keeps already-relative path results readable from the project root', () => {
    const result = formatSearchPathResults([
      'src/auth/session.ts',
      './src/auth/token-cache.ts',
    ], '/repo');

    expect(result).toBe('src/auth/session.ts\nsrc/auth/token-cache.ts');
  });

  it('formats Windows absolute path results case-insensitively', () => {
    const result = formatSearchPathResults([
      'c:\\repo\\src\\auth\\session.ts',
    ], 'C:\\Repo');

    expect(result).toBe('src/auth/session.ts');
  });

  it('summarizes broad grep files_with_matches output by directory', () => {
    const output = Array.from(
      { length: GREP_FILES_WITH_MATCHES_SUMMARY_THRESHOLD + 5 },
      (_, index) => `src/feature-${index}/file.ts`,
    ).join('\n');

    const result = summarizeGrepFilesWithMatchesOutput(output, '/repo');

    expect(result).toContain(`Grep matched ${GREP_FILES_WITH_MATCHES_SUMMARY_THRESHOLD + 5} files`);
    expect(result).toContain('Top directories:');
    expect(result).toContain('... 113 more directories omitted');
    expect(result).toContain(`First ${GLOB_SUMMARY_SAMPLE_SIZE} matching files:`);
    expect(result).toContain('src/feature-0/file.ts');
    expect(result).not.toContain(`src/feature-${GLOB_SUMMARY_SAMPLE_SIZE}/file.ts`);
    expect(result).toContain('Narrow the pattern, glob, type, or path before reading files.');
  });

  it('preserves grep status output instead of treating it as a path', () => {
    expect(summarizeGrepFilesWithMatchesOutput('No matches found', '/repo')).toBe('No matches found');
    expect(summarizeGrepFilesWithMatchesOutput(
      'Error: invalid regular expression: \\ at end of pattern',
      '/repo',
    )).toBe('Error: invalid regular expression: \\ at end of pattern');
  });

  it('summarizes broad grep count output with directory match totals', () => {
    const output = Array.from(
      { length: GREP_COUNT_SUMMARY_THRESHOLD + 5 },
      (_, index) => `src/feature-${index}/file.ts:${index + 1}`,
    ).join('\n');

    const result = summarizeGrepCountOutput(output, '/repo');

    expect(result).toContain(`Grep counted ${GREP_COUNT_SUMMARY_THRESHOLD + 5} matching files`);
    expect(result).toContain('total matches');
    expect(result).toContain('Top directories:');
    expect(result).toContain('... 113 more directories omitted');
    expect(result).toContain(`Top ${GLOB_SUMMARY_SAMPLE_SIZE} matching file counts:`);
    expect(result).toContain('src/feature-124/file.ts:125');
    expect(result).not.toContain(`src/feature-${GLOB_SUMMARY_SAMPLE_SIZE}/file.ts`);
    expect(result).toContain('Narrow the pattern, glob, type, or path before reading files.');
  });

  it('caps top directory summaries for broad glob matches', () => {
    const paths = Array.from(
      { length: 20 },
      (_, index) => `/repo/src/feature-${index}/file.ts`,
    );

    const summary = summarizePathsByDirectory(paths, '/repo', paths.length, 0);

    expect(summary).toContain('- src/feature-0: 1');
    expect(summary).toContain('- src/feature-11: 1');
    expect(summary).toContain('... 8 more directories omitted');
    expect(summary).not.toContain('- src/feature-12: 1');
  });

  it('relativizes absolute grep output paths under the project root', () => {
    const output = [
      '/repo/src/index.ts',
      '/repo/src/auth.ts:12:export const auth = true;',
      '/external/shared.ts',
    ].join('\n');

    const result = relativizeSearchOutputPaths(output, '/repo');

    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/auth.ts:12:export const auth = true;');
    expect(result).toContain('/external/shared.ts');
    expect(result).not.toContain('/repo/src');
  });

  it('normalizes Windows grep result path separators without changing matched text', () => {
    const output = 'C:\\repo\\src\\auth.ts:4:const fixture = "C:\\repo\\keep-this-string";';

    const result = relativizeSearchOutputPaths(output, 'C:\\repo');

    expect(result).toBe('src/auth.ts:4:const fixture = "C:\\repo\\keep-this-string";');
  });

  it('relativizes Windows grep paths case-insensitively', () => {
    const output = 'c:\\repo\\src\\auth.ts:4:const auth = true;';

    const result = relativizeSearchOutputPaths(output, 'C:\\Repo');

    expect(result).toBe('src/auth.ts:4:const auth = true;');
  });

  it('relativizes slash-style UNC paths case-insensitively', () => {
    const output = '//server/share/repo/src/auth.ts:4:const auth = true;';

    const result = relativizeSearchOutputPaths(output, '//SERVER/Share/Repo');

    expect(result).toBe('src/auth.ts:4:const auth = true;');
  });

  it('compacts long grep output lines before total output truncation', () => {
    const output = `src/generated.ts:1:HEAD_${'middle_'.repeat(300)}TAIL_SENTINEL`;

    const result = truncateSearchOutput(output);

    expect(result).toContain('src/generated.ts:1:HEAD_');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result.length).toBeLessThanOrEqual(GREP_MAX_OUTPUT_LINE_LENGTH);
    expect(result.length).toBeLessThan(output.length);
  });
});
