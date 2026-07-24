import { describe, it, expect, vi, beforeEach } from 'vitest';

import { grepTool } from '../grep';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const mockFindExecutable = vi.fn(() => '/usr/bin/rg');

vi.mock('../../../../platform/index', () => ({
  findExecutable: (_name: string, _additionalPaths?: string[]) => mockFindExecutable(),
}));

vi.mock('../../../security/path-containment', () => ({
  assertPathContained: vi.fn((_filePath: string, _projectDir: string | string[]) => ({
    contained: true,
    resolvedPath: _filePath,
  })),
}));

import { assertPathContained } from '../../../security/path-containment';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

/**
 * Set up mockExecFile to invoke the callback with the provided rg output values.
 */
function setupRg(stdout: string, stderr: string, exitCode: number) {
  mockExecFile.mockImplementation(
    (
      _rgPath: unknown,
      _args: unknown,
      _opts: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = exitCode !== 0 ? Object.assign(new Error('exit'), { code: exitCode }) : null;
      callback(err, stdout, stderr);
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Grep Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set after clearAllMocks wipes the return value
    mockFindExecutable.mockReturnValue('/usr/bin/rg');
    vi.mocked(assertPathContained).mockImplementation((_filePath: string, _projectDir: string | string[]) => ({
      contained: true,
      resolvedPath: _filePath,
    }));
  });

  it('should have correct metadata', () => {
    expect(grepTool.metadata.name).toBe('Grep');
    expect(grepTool.metadata.permission).toBe('read_only');
  });

  it('should return matching files in files_with_matches mode (default)', async () => {
    setupRg('/test/project/src/index.ts\n/test/project/src/utils.ts\n', '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'myFunction' },
      baseContext,
    ) as string;

    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils.ts');
    expect(result).not.toContain('/test/project/src');
  });

  it('should summarize broad files_with_matches results by directory', async () => {
    const output = Array.from(
      { length: 150 },
      (_, index) => `/test/project/src/feature-${index}/file.ts`,
    ).join('\n');
    setupRg(output, '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'useEffect' },
      baseContext,
    ) as string;

    expect(result).toContain('Grep matched 150 files');
    expect(result).toContain('Top directories:');
    expect(result).toContain('... 138 more directories omitted');
    expect(result).toContain('First 30 matching files:');
    expect(result).toContain('src/feature-0/file.ts');
    expect(result).not.toContain('src/feature-30/file.ts');
    expect(result).not.toContain('/test/project/src');
  });

  it('should relativize content-mode rg output while preserving line numbers and text', async () => {
    setupRg('/test/project/src/auth.ts:10:const auth = true;\n', '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'auth', output_mode: 'content' },
      baseContext,
    ) as string;

    expect(result).toBe('src/auth.ts:10:const auth = true;');
  });

  it('should compact long content-mode rg lines while preserving the tail', async () => {
    setupRg(`/test/project/src/generated.ts:1:HEAD_${'middle_'.repeat(300)}TAIL_SENTINEL\n`, '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'HEAD', output_mode: 'content' },
      baseContext,
    ) as string;

    expect(result).toContain('src/generated.ts:1:HEAD_');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result).not.toContain('/test/project/src/generated.ts');
  });

  it('should return "No matches found" when rg exits with code 1 and no stderr', async () => {
    setupRg('', '', 1);

    const result = await grepTool.config.execute(
      { pattern: 'nonexistent_pattern_xyz' },
      baseContext,
    );

    expect(result).toBe('No matches found');
  });

  it('should return "No matches found" when stdout is empty', async () => {
    setupRg('   \n', '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'something' },
      baseContext,
    );

    expect(result).toBe('No matches found');
  });

  it('should return error message when rg exits with code > 1 and stderr', async () => {
    setupRg('', 'rg: error: unknown file type\n', 2);

    const result = await grepTool.config.execute(
      { pattern: 'test', type: 'unknowntype' },
      baseContext,
    ) as string;

    expect(result).toContain('Error:');
    expect(result).toContain('unknown file type');
  });

  it('should use the built-in search fallback when ripgrep is not installed', async () => {
    mockFindExecutable.mockReturnValue(null as unknown as string);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation((filePath) => ({
      isDirectory: () => String(filePath) === '/test/project',
      size: 20,
    }) as fs.Stats);
    vi.mocked(fs.readdirSync).mockImplementation((dirPath) => {
      if (String(dirPath) === '/test/project') {
        return [
          { name: 'src', isDirectory: () => true, isFile: () => false },
          { name: 'README.md', isDirectory: () => false, isFile: () => true },
        ] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('hello from fallback\n'));

    const result = await grepTool.config.execute(
      { pattern: 'fallback', output_mode: 'content' },
      baseContext,
    ) as string;

    expect(result).toContain('README.md:1:hello from fallback');
  });

  it('should return project-relative paths from the built-in fallback for subdirectory searches', async () => {
    mockFindExecutable.mockReturnValue(null as unknown as string);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation((filePath) => {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      return {
        isDirectory: () => normalizedPath === '/test/project/sub',
        size: 20,
      } as fs.Stats;
    });
    vi.mocked(fs.readdirSync).mockImplementation((dirPath) => {
      const normalizedPath = String(dirPath).replace(/\\/g, '/');
      if (normalizedPath === '/test/project/sub') {
        return [
          { name: 'file.ts', isDirectory: () => false, isFile: () => true },
        ] as unknown as ReturnType<typeof fs.readdirSync>;
      }
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('subdir fallback match\n'));

    const result = await grepTool.config.execute(
      { pattern: 'fallback', path: '/test/project/sub', output_mode: 'content' },
      baseContext,
    ) as string;

    expect(result).toContain('sub/file.ts:1:subdir fallback match');
    expect(result).not.toContain('\nfile.ts:');
    expect(result).not.toContain('/test/project/sub/file.ts');
  });

  it('should preserve built-in fallback regex errors in default mode', async () => {
    mockFindExecutable.mockReturnValue(null as unknown as string);

    const result = await grepTool.config.execute(
      { pattern: '\\' },
      baseContext,
    ) as string;

    expect(result).toContain('Error: invalid regular expression:');
    expect(result).not.toContain('Top directories:');
  });

  it('should include --files-with-matches flag in default mode', async () => {
    setupRg('/test/project/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--files-with-matches');
  });

  it('should limit ripgrep searches to text-sized files', async () => {
    setupRg('/test/project/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--max-filesize');
    expect(args).toContain('1M');
  });

  it('should include --line-number flag in content mode', async () => {
    setupRg('src/a.ts:10:const hello = 1;\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', output_mode: 'content' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--line-number');
    expect(args).not.toContain('--files-with-matches');
    expect(args).not.toContain('--count');
  });

  it('should include --count flag in count mode', async () => {
    setupRg('src/a.ts:5\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', output_mode: 'count' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--count');
  });

  it('should preserve compact per-file counts for small count-mode results', async () => {
    setupRg('/test/project/src/a.ts:5\n/test/project/src/b.ts:2\n', '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'hello', output_mode: 'count' },
      baseContext,
    ) as string;

    expect(result).toBe('src/a.ts:5\nsrc/b.ts:2');
  });

  it('should summarize broad count-mode results by directory and match totals', async () => {
    const output = Array.from(
      { length: 150 },
      (_, index) => `/test/project/src/feature-${index}/file.ts:${index + 1}`,
    ).join('\n');
    setupRg(output, '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'hello', output_mode: 'count' },
      baseContext,
    ) as string;

    expect(result).toContain('Grep counted 150 matching files');
    expect(result).toContain('total matches');
    expect(result).toContain('Top directories:');
    expect(result).toContain('... 138 more directories omitted');
    expect(result).toContain('Top 30 matching file counts:');
    expect(result).toContain('src/feature-149/file.ts:150');
    expect(result).not.toContain('src/feature-30/file.ts');
    expect(result).not.toContain('/test/project/src');
  });

  it('should add -C flag when context lines are specified in content mode', async () => {
    setupRg('match output\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', output_mode: 'content', context: 3 },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('-C');
    expect(args).toContain('3');
  });

  it('should add --type flag when type is specified', async () => {
    setupRg('/test/project/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', type: 'ts' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--type');
    expect(args).toContain('ts');
  });

  it('should add --glob flag when glob is specified', async () => {
    setupRg('/test/project/src/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', glob: '*.{ts,tsx}' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--glob');
    expect(args).toContain('*.{ts,tsx}');
  });

  it('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const longOutput = [
      '/test/project/first-match.ts:1:first match',
      ...Array.from({ length: 2000 }, (_, index) => `/test/project/middle-${index}.ts:1:${'body '.repeat(10)}`),
      '/test/project/final-match-sentinel.ts:1:final match',
    ].join('\n');
    setupRg(longOutput, '', 0);

    const result = await grepTool.config.execute(
      { pattern: 'test', output_mode: 'content' },
      baseContext,
    ) as string;

    expect(result).toContain('[Output truncated');
    expect(result).toContain('first-match.ts');
    expect(result).toContain('final-match-sentinel.ts');
    expect(result).not.toContain('/test/project/middle-');
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it('should call assertPathContained for path security', async () => {
    setupRg('/test/project/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello' },
      baseContext,
    );

    expect(assertPathContained).toHaveBeenCalledWith('/test/project', '/test/project');
  });

  it('should throw when search path is outside project boundary', async () => {
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error("Path '/etc' is outside the project directory");
    });

    await expect(
      grepTool.config.execute(
        { pattern: 'root', path: '/etc' },
        baseContext,
      ),
    ).rejects.toThrow('outside the project directory');
  });

  it('does not grant search access through exact-file Read authorization', async () => {
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error('outside the project directory');
    });

    await expect(grepTool.config.execute(
      { pattern: 'secret', path: '/external' },
      {
        ...baseContext,
        allowedExactFilePaths: ['/external/attachment.md'],
      },
    )).rejects.toThrow('outside the project directory');

    expect(assertPathContained).toHaveBeenCalledWith('/external', '/test/project');
  });

  it('should use provided path for search instead of cwd', async () => {
    setupRg('/test/project/sub/a.ts\n', '', 0);

    await grepTool.config.execute(
      { pattern: 'hello', path: '/test/project/sub' },
      baseContext,
    );

    const args = mockExecFile.mock.calls[0][1] as string[];
    // The resolved search path should be the last argument before the pattern
    expect(args).toContain('/test/project/sub');
  });
});
