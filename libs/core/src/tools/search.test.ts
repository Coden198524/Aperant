import { describe, expect, it } from 'vitest';

import {
  GLOB_SUMMARY_SAMPLE_SIZE,
  GREP_MAX_OUTPUT_LINE_LENGTH,
  relativizeSearchOutputPaths,
  summarizePathsByDirectory,
  truncateSearchOutput,
} from './search.js';

describe('search result summarization', () => {
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

  it('caps top directory summaries for broad glob matches', () => {
    const paths = Array.from(
      { length: 20 },
      (_, index) => `/repo/src/feature-${index}/file.ts`,
    );

    const summary = summarizePathsByDirectory(paths, '/repo', paths.length, 0);

    expect(summary).toContain('- src/feature-0: 1');
    expect(summary).toContain('- src/feature-11: 1');
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
