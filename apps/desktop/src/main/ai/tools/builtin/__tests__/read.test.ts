import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSchema } from 'ai';

import { readTool } from '../read';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs');
vi.mock('../../../security/exact-file-authorization', () => ({
  assertExactFilePathAllowed: vi.fn((_filePath: string) => ({
    contained: true,
    resolvedPath: _filePath,
  })),
  assertOpenedExactFilePathAllowed: vi.fn((_filePath: string) => ({
    contained: true,
    resolvedPath: _filePath,
  })),
}));
vi.mock('../../../security/path-containment', () => ({
  assertPathContained: vi.fn((_filePath: string, _projectDir: string | string[]) => ({
    contained: true,
    resolvedPath: _filePath,
  })),
}));

import * as fs from 'node:fs';
import {
  assertExactFilePathAllowed,
  assertOpenedExactFilePathAllowed,
} from '../../../security/exact-file-authorization';
import { assertPathContained } from '../../../security/path-containment';

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
 * Set up the fs mock sequence for a successful text file read.
 *
 * openSync → fd, fstatSync → stat object, readFileSync → content, closeSync → void
 */
function setupTextFile(content: string, isDir = false) {
  const buffer = Buffer.from(content);
  const fakeFd = 42;
  vi.mocked(fs.openSync).mockReturnValue(fakeFd as unknown as number);
  vi.mocked(fs.fstatSync).mockReturnValue({
    isDirectory: () => isDir,
    isFile: () => !isDir,
    size: buffer.length,
  } as unknown as fs.Stats);
  vi.mocked(fs.readFileSync).mockReturnValue(content);
  setupReadSync(buffer);
  vi.mocked(fs.closeSync).mockImplementation(() => undefined);
}

function setupTextFileBuffer(content: Buffer, isDir = false) {
  const fakeFd = 42;
  vi.mocked(fs.openSync).mockReturnValue(fakeFd as unknown as number);
  vi.mocked(fs.fstatSync).mockReturnValue({
    isDirectory: () => isDir,
    isFile: () => !isDir,
    size: content.length,
  } as unknown as fs.Stats);
  vi.mocked(fs.readFileSync).mockImplementation(() => content as unknown as string);
  setupReadSync(content);
  vi.mocked(fs.closeSync).mockImplementation(() => undefined);
}

function setupReadSync(content: Buffer) {
  vi.mocked(fs.readSync).mockImplementation(((
    _fd: number,
    target: NodeJS.ArrayBufferView,
    targetOffset: number,
    length: number,
    position: number | null,
  ) => {
    const sourceOffset = position ?? 0;
    const bytesRead = Math.max(0, Math.min(length, content.length - sourceOffset));
    if (bytesRead === 0) {
      return 0;
    }
    const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
    content.copy(targetBuffer, targetOffset, sourceOffset, sourceOffset + bytesRead);
    return bytesRead;
  }) as typeof fs.readSync);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Read Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertPathContained).mockImplementation((_filePath: string, _projectDir: string | string[]) => ({
      contained: true,
      resolvedPath: _filePath,
    }));
    vi.mocked(assertExactFilePathAllowed).mockImplementation((_filePath: string) => ({
      contained: true,
      resolvedPath: _filePath,
    }));
    vi.mocked(assertOpenedExactFilePathAllowed).mockImplementation((_filePath: string) => ({
      contained: true,
      resolvedPath: _filePath,
    }));
  });

  it('should have correct metadata', () => {
    expect(readTool.metadata.name).toBe('Read');
    expect(readTool.metadata.permission).toBe('read_only');
  });

  it('should read an entire file with line numbers', async () => {
    setupTextFile('line one\nline two\nline three');

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      baseContext,
    );

    expect(result).toContain('line one');
    expect(result).toContain('line two');
    expect(result).toContain('line three');
    // Line numbers should be present (cat -n style)
    expect(result).toMatch(/\d+\t/);
  });

  it('should format output with correct line numbers', async () => {
    setupTextFile('alpha\nbeta\ngamma');

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      baseContext,
    ) as string;

    const lines = result.split('\n');
    expect(lines[0]).toMatch(/^\s*1\talpha/);
    expect(lines[1]).toMatch(/^\s*2\tbeta/);
    expect(lines[2]).toMatch(/^\s*3\tgamma/);
  });

  it('should compact very long lines while preserving the tail', async () => {
    setupTextFile(`HEAD_${'head_'.repeat(260)}MIDDLE_SHOULD_BE_OMITTED${'tail_'.repeat(260)}TAIL_SENTINEL`);

    const result = await readTool.config.execute(
      { file_path: '/test/project/generated.json' },
      baseContext,
    ) as string;

    expect(result).toMatch(/^\s*1\tHEAD_/);
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result).not.toContain('MIDDLE_SHOULD_BE_OMITTED');
  });

  it('should respect offset and limit parameters', async () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    setupTextFile(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts', offset: 1, limit: 2 },
      baseContext,
    ) as string;

    // offset=1 means start from line index 1 (line2), limit=2 means two lines
    expect(result).toContain('line2');
    expect(result).toContain('line3');
    expect(result).not.toContain('line1');
    expect(result).not.toContain('line4');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should report offset ranges beyond EOF without a phantom line number', async () => {
    setupTextFile('line1\nline2\nline3');

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts', offset: 99, limit: 5 },
      baseContext,
    ) as string;

    expect(result).toBe("[No lines in requested range: offset 99 is beyond the file's 3 total lines.]");
    expect(result).not.toContain('\t');
    expect(result).not.toContain('100\t');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject invalid offset and limit inputs in the schema', () => {
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      offset: -1,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      limit: 0,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      offset: 1.5,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      limit: 501,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      offset: Number.MAX_SAFE_INTEGER,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      byte_limit: 1024,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      byte_offset: 0,
      byte_limit: (8 * 1024) + 1,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      byte_offset: 2,
      offset: 1,
    }).success).toBe(false);
  });

  it('should normalize provider-filled mutually exclusive Read modes', () => {
    const lineResult = readTool.config.inputSchema.safeParse({
      file_path: 'E:\\Work\\Project\\spec.md',
      offset: 0,
      limit: 500,
      byte_offset: 0,
      byte_limit: 8192,
      pages: '1',
    });
    expect(lineResult.success).toBe(true);
    if (lineResult.success) {
      expect(lineResult.data).toEqual({
        file_path: 'E:\\Work\\Project\\spec.md',
        offset: 0,
        limit: 500,
      });
    }

    const byteResult = readTool.config.inputSchema.safeParse({
      file_path: '/test/project/spec.md',
      offset: 0,
      limit: 500,
      byte_offset: 8192,
      byte_limit: 8192,
      pages: '1',
    });
    expect(byteResult.success).toBe(true);
    if (byteResult.success) {
      expect(byteResult.data).toEqual({
        file_path: '/test/project/spec.md',
        byte_offset: 8192,
        byte_limit: 8192,
      });
    }

    const pdfResult = readTool.config.inputSchema.safeParse({
      file_path: '/test/project/spec.pdf',
      offset: 0,
      limit: 500,
      byte_offset: 0,
      byte_limit: 8192,
      pages: '1',
    });
    expect(pdfResult.success).toBe(true);
    if (pdfResult.success) {
      expect(pdfResult.data).toEqual({
        file_path: '/test/project/spec.pdf',
        pages: '1',
      });
    }
  });

  it('should preserve validation for invalid or genuinely ambiguous ranges', () => {
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      offset: -1,
      byte_offset: 0,
      byte_limit: 1024,
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/file.ts',
      offset: 10,
      limit: 5,
      byte_offset: 1024,
      byte_limit: 1024,
    }).success).toBe(false);
  });

  it('should keep the full Read JSON Schema visible through preprocessing', () => {
    const jsonSchema = asSchema(readTool.config.inputSchema).jsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.keys(jsonSchema.properties ?? {})).toEqual([
      'file_path',
      'offset',
      'limit',
      'byte_offset',
      'byte_limit',
      'pages',
    ]);
    expect(jsonSchema.required).toEqual(['file_path']);
  });

  it('should cap default reads in aggressive mode', async () => {
    const content = Array.from({ length: 150 }, (_, i) => `line${i + 1}`).join('\n');
    setupTextFile(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      { ...baseContext, workflowMode: 'aggressive' },
    ) as string;

    expect(result).toContain('line120');
    expect(result).not.toContain('line121');
    expect(result).toContain('Showing lines 1-120 of 150 total lines');
  });

  it('should cap default reads in balanced mode without hiding small files', async () => {
    const content = Array.from({ length: 450 }, (_, i) => `line${i + 1}`).join('\n');
    setupTextFile(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      { ...baseContext, workflowMode: 'balanced' },
    ) as string;

    expect(result).toContain('line400');
    expect(result).not.toContain('line401');
    expect(result).toContain('Showing lines 1-400 of 450 total lines');
  });

  it('should apply workflow line caps when returning cached content', async () => {
    const content = Array.from({ length: 150 }, (_, i) => `line${i + 1}`).join('\n');
    const fakeCache = {
      getSync: vi.fn().mockReturnValue(content),
      set: vi.fn(),
    };

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      { ...baseContext, workflowMode: 'aggressive', fileCache: fakeCache } as unknown as ToolContext,
    ) as string;

    expect(result).toContain('line120');
    expect(result).not.toContain('line121');
    expect(result).toContain('Showing lines 1-120 of 150 total lines');
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('should apply large-file preview limits when returning cached content', async () => {
    const content = Array.from({ length: 500 }, (_, i) => `line${i + 1} ${'x'.repeat(1200)}`).join('\n');
    const fakeCache = {
      getSync: vi.fn().mockReturnValue(content),
      set: vi.fn(),
    };

    const result = await readTool.config.execute(
      { file_path: '/test/project/large.ts' },
      { ...baseContext, fileCache: fakeCache } as unknown as ToolContext,
    ) as string;

    expect(result).toContain('[Large file:');
    expect(result).not.toContain('line201');
    expect(result).toContain('Read output capped at 72KB');
    expect(result).toMatch(/Use offset \d+/);
    expect(result.length).toBeLessThanOrEqual(72 * 1024);
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('should show truncation notice when there are more lines beyond limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    setupTextFile(lines.join('\n'));

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts', offset: 0, limit: 3 },
      baseContext,
    ) as string;

    expect(result).toContain('Showing lines 1-3. More lines are available');
    expect(result).toContain('use offset 3');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should stream a huge ranged read in bounded chunks without loading the whole file', async () => {
    const fakeFd = 42;
    const fileSize = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024);
    for (let index = 0; index < chunk.length; index += 2) {
      chunk[index] = 'x'.charCodeAt(0);
      chunk[index + 1] = '\n'.charCodeAt(0);
    }
    const requestedLengths: number[] = [];

    vi.mocked(fs.openSync).mockReturnValue(fakeFd);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const sourceOffset = position ?? 0;
      requestedLengths.push(length);
      if (sourceOffset >= fileSize) {
        return 0;
      }
      const bytesRead = Math.min(length, fileSize - sourceOffset);
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      chunk.copy(targetBuffer, targetOffset, 0, bytesRead);
      return bytesRead;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/huge.log', offset: 10, limit: 2 },
      baseContext,
    ) as string;

    expect(result).toContain('11\tx');
    expect(result).toContain('12\tx');
    expect(result).toContain('Showing lines 11-12. More lines are available');
    expect(result).toContain('use offset 12');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(requestedLengths).toHaveLength(2);
  }, 15_000);

  it('should stop before a huge line offset at the synchronous byte scan limit', async () => {
    const fileSize = 64 * 1024 * 1024;
    const requestedLengths: number[] = [];
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const sourceOffset = position ?? 0;
      requestedLengths.push(length);
      if (sourceOffset >= fileSize) {
        return 0;
      }
      const bytesRead = Math.min(length, fileSize - sourceOffset);
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      targetBuffer.fill('x', targetOffset, targetOffset + bytesRead);
      return bytesRead;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    try {
      const result = await readTool.config.execute(
        { file_path: '/test/project/one-huge-line.log', offset: 10_000_000, limit: 1 },
        baseContext,
      ) as string;

      expect(result).toContain('stopped after 8MB');
      expect(result).toContain('before line offset 10000000');
      expect(result).toContain('synchronous scan byte limit');
      expect(result).toContain('Use byte_offset 8388608');
      expect(result).not.toMatch(/^\s*10000001\t/m);
      expect(requestedLengths.reduce((sum, length) => sum + length, 0)).toBe(
        (8 * 1024 * 1024) + (64 * 1024),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('should read a deep byte range directly and return an exact continuation offset', async () => {
    const fileSize = 64 * 1024 * 1024;
    const deepOffset = 16 * 1024 * 1024;
    const readPositions: number[] = [];

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const sourceOffset = position ?? 0;
      readPositions.push(sourceOffset);
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      if (sourceOffset === 0) {
        targetBuffer.fill('a', targetOffset, targetOffset + length);
      } else {
        const deepContent = Buffer.from('DEEP_CONTENT_HERE_AND_MORE');
        deepContent.copy(targetBuffer, targetOffset, 0, length);
      }
      return length;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      {
        file_path: '/test/project/huge.txt',
        byte_offset: deepOffset,
        byte_limit: 16,
      },
      baseContext,
    ) as string;

    expect(result).toContain(`Byte range ${deepOffset}-${deepOffset + 15}`);
    expect(result).toContain('DEEP_CONTENT_HER');
    expect(result).toContain('Line numbers are relative to this byte chunk');
    expect(result).toContain(`use byte_offset ${deepOffset + 16}`);
    expect(readPositions).toEqual([0, deepOffset]);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should keep arbitrary multibyte byte fragments explicit', async () => {
    const deepOffset = 1024;
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 4096,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      if ((position ?? 0) === 0) {
        targetBuffer.fill('a', targetOffset, targetOffset + length);
      } else {
        Buffer.from([0x82, 0xac, 0x20, 0x6f, 0x6b]).copy(targetBuffer, targetOffset);
      }
      return length;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      {
        file_path: '/test/project/utf8.txt',
        byte_offset: deepOffset,
        byte_limit: 5,
      },
      baseContext,
    ) as string;

    expect(result).toContain('may be fragments when the range splits a multibyte character');
    expect(result).toContain('\uFFFD');
    expect(result).toContain(`use byte_offset ${deepOffset + 5}`);
  });

  it('should align odd byte offsets for BOM-detected UTF-16 text', async () => {
    const content = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('ABCD', 'utf16le'),
    ]);
    setupTextFileBuffer(content);

    const result = await readTool.config.execute(
      {
        file_path: '/test/project/utf16.txt',
        byte_offset: 3,
        byte_limit: 4,
      },
      baseContext,
    ) as string;

    expect(result).toContain('aligned down to 2 for utf-16le code-unit alignment');
    expect(result).toContain('Decoded as utf-16le; BOM detected');
    expect(result).toMatch(/^\s*1\tAB/m);
    expect(result).toContain('use byte_offset 6');
  });

  it('should reject binary content discovered inside a requested byte chunk', async () => {
    const deepOffset = 2048;
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 4096,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      if ((position ?? 0) === 0) {
        targetBuffer.fill('a', targetOffset, targetOffset + length);
      } else {
        targetBuffer.fill(0, targetOffset, targetOffset + length);
      }
      return length;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      {
        file_path: '/test/project/mixed.txt',
        byte_offset: deepOffset,
        byte_limit: 32,
      },
      baseContext,
    ) as string;

    expect(result).toContain('Binary data in requested byte range');
    expect(result).toContain('bounded byte range contains binary control bytes');
    expect(result).toContain(`use byte_offset ${deepOffset + 32}`);
  });

  it('should not repeat the same byte continuation after a concurrent truncation', async () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 4096,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      if ((position ?? 0) === 0) {
        const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
        targetBuffer.fill('a', targetOffset, targetOffset + Math.min(length, 16));
        return Math.min(length, 16);
      }
      return 0;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      {
        file_path: '/test/project/shrinking.txt',
        byte_offset: 1024,
        byte_limit: 32,
      },
      baseContext,
    ) as string;

    expect(result).toContain('file changed after the 4096-byte snapshot');
    expect(result).toContain('Retry Read to obtain a fresh snapshot');
    expect(result).not.toContain('use byte_offset 1024');
  });

  it('should stop synchronous scans at the time budget', async () => {
    const fileSize = 64 * 1024 * 1024;
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(101);

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
    ) => {
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      targetBuffer.fill('x', targetOffset, targetOffset + length);
      return length;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    try {
      const result = await readTool.config.execute(
        { file_path: '/test/project/slow-line.log', offset: 5, limit: 1 },
        baseContext,
      ) as string;

      expect(result).toContain('synchronous scan time limit');
      expect(result).toContain('before line offset 5');
      expect(fs.readSync).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('should honor an already-aborted Read without opening the file', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      { ...baseContext, abortSignal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it('should preserve BOM handling for ranged reads', async () => {
    setupTextFileBuffer(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('alpha\nbeta'),
    ]));

    const result = await readTool.config.execute(
      { file_path: '/test/project/bom.txt', offset: 0, limit: 1 },
      baseContext,
    ) as string;

    expect(result).toMatch(/^\s*1\talpha/);
    expect(result).not.toContain('\uFEFF');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should preserve legacy encoding detection for ranged reads', async () => {
    setupTextFileBuffer(Buffer.from([
      0xc4, 0xe3, 0xba, 0xc3, 0x0a,
      0xca, 0xc0, 0xbd, 0xe7,
    ]));

    const result = await readTool.config.execute(
      { file_path: '/test/project/legacy.lua', offset: 1, limit: 1 },
      baseContext,
    ) as string;

    expect(result).toContain('[Decoded as gb18030');
    expect(result).toMatch(/\s*2\t[^\n]+/);
    expect(result).not.toContain('\uFFFD');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should preserve long-line head and tail compaction for ranged reads', async () => {
    const content = Buffer.from(
      `HEAD_${'head_'.repeat(20_000)}MIDDLE_SHOULD_BE_OMITTED${'tail_'.repeat(20_000)}TAIL_SENTINEL\nnext`,
    );
    setupTextFileBuffer(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/generated.json', offset: 0, limit: 1 },
      baseContext,
    ) as string;

    expect(result).toMatch(/^\s*1\tHEAD_/);
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result).not.toContain('MIDDLE_SHOULD_BE_OMITTED');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should default large text files to a smaller preview', async () => {
    const content = Array.from({ length: 500 }, (_, i) => `line${i + 1}`).join('\n');
    setupTextFile(content);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 600 * 1024,
      mtimeMs: 123,
    } as unknown as fs.Stats);

    const result = await readTool.config.execute(
      { file_path: '/test/project/large.ts' },
      baseContext,
    ) as string;

    expect(result).toContain('[Large file: 600KB');
    expect(result).toContain('line200');
    expect(result).not.toContain('line201');
    expect(result).toContain('Showing lines 1-200. More lines are available');
    expect(result).toContain('use offset 200');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should keep streamed text output below the Read character budget', async () => {
    const content = Array.from(
      { length: 500 },
      (_, index) => `line${index + 1}_${'x'.repeat(2_000)}`,
    ).join('\n');
    setupTextFile(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/wide.log', offset: 0, limit: 500 },
      baseContext,
    ) as string;

    expect(result.length).toBeLessThanOrEqual(72 * 1024);
    expect(result).toContain('More lines are available');
    expect(result).toMatch(/use offset \d+/);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should cap default reads in normal mode', async () => {
    const content = Array.from({ length: 550 }, (_, i) => `line${i + 1}`).join('\n');
    setupTextFile(content);

    const result = await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      baseContext,
    ) as string;

    expect(result).toContain('line500');
    expect(result).not.toContain('line501');
    expect(result).toContain('Showing lines 1-500 of 550 total lines');
  });

  it('should decode legacy Chinese text files when UTF-8 is invalid', async () => {
    setupTextFileBuffer(Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xca, 0xc0, 0xbd, 0xe7]));

    const result = await readTool.config.execute(
      { file_path: '/test/project/legacy.lua' },
      baseContext,
    ) as string;

    expect(result).toContain('[Decoded as gb18030');
    expect(result).toContain('你好');
    expect(result).toContain('世界');
    expect(result).not.toContain('\uFFFD');
  });

  it('should summarize the active task log instead of returning full large content', async () => {
    const content = [
      '{"record_type":"entry","entry":{"type":"tool_start","tool_name":"Read","phase":"coding","timestamp":"2026-01-01T00:00:00.000Z","content":"read"}}',
      '{"record_type":"entry","entry":{"type":"tool_end","tool_name":"Read","phase":"coding","timestamp":"2026-01-01T00:00:01.000Z","content":"done"}}',
      '{"record_type":"entry","entry":{"type":"text","phase":"coding","timestamp":"2026-01-01T00:00:02.000Z","content":"hello"}}',
      '{"record_type":"entry","entry":{"type":"error","phase":"coding","timestamp":"2026-01-01T00:00:03.000Z","content":"bad"}}',
    ].join('\n');
    setupTextFile(content);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 300 * 1024,
      mtimeMs: 123,
    } as unknown as fs.Stats);

    const result = await readTool.config.execute(
      { file_path: '/test/specs/001/task_logs.jsonl' },
      baseContext,
    ) as string;

    expect(result).toContain('[Task log file:');
    expect(result).toContain('tool_start=1');
    expect(result).toContain('Full task logs are intentionally not returned');
    expect(result).not.toContain('record_type');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should mark an active task-log summary as partial at the scan byte limit', async () => {
    const fileSize = 64 * 1024 * 1024;
    const record = Buffer.from('{"type":"tool_start","tool_name":"Read"}\n');
    const chunk = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < chunk.length; offset += record.length) {
      record.copy(chunk, offset, 0, Math.min(record.length, chunk.length - offset));
    }
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const sourceOffset = position ?? 0;
      if (sourceOffset >= fileSize) {
        return 0;
      }
      const bytesRead = Math.min(length, fileSize - sourceOffset);
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      chunk.copy(targetBuffer, targetOffset, 0, bytesRead);
      return bytesRead;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    try {
      const result = await readTool.config.execute(
        { file_path: '/test/specs/001/task_logs.jsonl' },
        baseContext,
      ) as string;

      expect(result).toContain('Summary scope: partial prefix only (8MB scanned; synchronous scan byte limit reached).');
      expect(result).toContain('tool_start=');
      expect(result).toContain('Full task logs are intentionally not returned');
      expect(fs.readFileSync).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('should return error when file not found', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(fs.openSync).mockImplementation(() => { throw enoentError; });

    const result = await readTool.config.execute(
      { file_path: '/test/project/missing.ts' },
      baseContext,
    );

    expect(result).toContain('Error: File not found');
  });

  it('should return error when path is a directory (EISDIR)', async () => {
    const eisdirError = Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    vi.mocked(fs.openSync).mockImplementation(() => { throw eisdirError; });

    const result = await readTool.config.execute(
      { file_path: '/test/project/somedir' },
      baseContext,
    );

    expect(result).toContain('is a directory');
  });

  it('should return empty file message when file has no content', async () => {
    setupTextFile('');

    const result = await readTool.config.execute(
      { file_path: '/test/project/empty.ts' },
      baseContext,
    );

    expect(result).toContain('File exists but is empty');
  });

  it('should reject non-regular files before attempting to read them', async () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
      size: 1024,
    } as unknown as fs.Stats);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/named-pipe' },
      baseContext,
    ) as string;

    expect(result).toContain('is not a regular file');
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should return image file as base64 data URI', async () => {
    const fakeFd = 42;
    const imageBuffer = Buffer.from('fake-png-data');
    vi.mocked(fs.openSync).mockReturnValue(fakeFd as unknown as number);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: imageBuffer.length,
    } as unknown as fs.Stats);
    setupReadSync(imageBuffer);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/image.png' },
      baseContext,
    ) as string;

    expect(result).toContain('[Image file:');
    expect(result).toContain('data:image/png;base64,');
  });

  it('should reject oversized images before reading or base64 encoding', async () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: (48 * 1024) + 1,
    } as unknown as fs.Stats);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/huge.png' },
      baseContext,
    ) as string;

    expect(result).toContain('exceeds the 48KB inline Read limit');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('should reject an image that grows past the inline limit after fstat', async () => {
    const grownImage = Buffer.alloc((48 * 1024) + 1, 0x61);
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 16,
    } as unknown as fs.Stats);
    setupReadSync(grownImage);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/growing.png' },
      baseContext,
    ) as string;

    expect(result).toContain('exceeds the 48KB inline Read limit');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.readSync).toHaveBeenCalled();
  });

  it('should switch a concurrently grown small text file to bounded scanning', async () => {
    const grownContent = Buffer.from(
      `HEAD_${'x'.repeat(600 * 1024)}_TAIL_SENTINEL`,
    );
    const requestedLengths: number[] = [];

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync)
      .mockReturnValueOnce({
        isDirectory: () => false,
        isFile: () => true,
        size: 16,
        mtimeMs: 1,
      } as unknown as fs.Stats)
      .mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: grownContent.length,
        mtimeMs: 2,
      } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
      position: number | null,
    ) => {
      const sourceOffset = position ?? 0;
      requestedLengths.push(length);
      const bytesRead = Math.max(0, Math.min(length, grownContent.length - sourceOffset));
      if (bytesRead > 0) {
        const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
        grownContent.copy(targetBuffer, targetOffset, sourceOffset, sourceOffset + bytesRead);
      }
      return bytesRead;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/growing.txt' },
      baseContext,
    ) as string;

    expect(result).toContain('[Large file:');
    expect(result).toContain('[line middle omitted]');
    expect(result).toContain('TAIL_SENTINEL');
    expect(result.length).toBeLessThanOrEqual(72 * 1024);
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(64 * 1024);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should reject likely binary files after a bounded probe', async () => {
    const fileSize = 8 * 1024 * 1024 * 1024;
    const binaryPrefix = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]);
    const requestedLengths: number[] = [];
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: fileSize,
    } as unknown as fs.Stats);
    vi.mocked(fs.readSync).mockImplementation(((
      _fd: number,
      target: NodeJS.ArrayBufferView,
      targetOffset: number,
      length: number,
    ) => {
      requestedLengths.push(length);
      const targetBuffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      binaryPrefix.copy(targetBuffer, targetOffset);
      return binaryPrefix.length;
    }) as typeof fs.readSync);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/random.bin' },
      baseContext,
    ) as string;

    expect(result).toContain('[Binary file: random.bin');
    expect(result).toContain('bounded file prefix');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(requestedLengths).toEqual([64 * 1024]);
  });

  it('should return PDF info without pages parameter', async () => {
    const fakeFd = 42;
    vi.mocked(fs.openSync).mockReturnValue(fakeFd as unknown as number);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 102400,
    } as unknown as fs.Stats);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/doc.pdf' },
      baseContext,
    ) as string;

    expect(result).toContain('[PDF file:');
    expect(result).toContain('reports PDF metadata only');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should validate PDF page ranges and describe them as metadata only', async () => {
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/doc.pdf',
      pages: '0',
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/doc.pdf',
      pages: '5-4',
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/doc.pdf',
      pages: '1-21',
    }).success).toBe(false);
    expect(readTool.config.inputSchema.safeParse({
      file_path: '/test/project/doc.pdf',
      pages: '100-119',
    }).success).toBe(true);

    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.fstatSync).mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 102400,
    } as unknown as fs.Stats);
    vi.mocked(fs.closeSync).mockImplementation(() => undefined);

    const result = await readTool.config.execute(
      { file_path: '/test/project/doc.pdf', pages: '3-5' },
      baseContext,
    ) as string;

    expect(result).toContain('requested pages: 3-5');
    expect(result).toContain('does not extract page content');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('should call assertPathContained for path security', async () => {
    setupTextFile('content');

    await readTool.config.execute(
      { file_path: '/test/project/file.ts' },
      baseContext,
    );

    expect(assertPathContained).toHaveBeenCalledWith('/test/project/file.ts', '/test/project');
  });

  it('should use exact-file authorization only after project containment fails', async () => {
    setupTextFile('external content');
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error('outside the project directory');
    });

    const result = await readTool.config.execute(
      { file_path: '/external/attachment.md' },
      {
        ...baseContext,
        allowedExactFilePaths: ['/external/attachment.md'],
      },
    ) as string;

    expect(result).toContain('external content');
    expect(assertExactFilePathAllowed).toHaveBeenCalledWith(
      '/external/attachment.md',
      ['/external/attachment.md'],
    );
    expect(assertOpenedExactFilePathAllowed).toHaveBeenCalledWith(
      '/external/attachment.md',
      ['/external/attachment.md'],
      42,
    );
  });

  it('should bypass stale file-cache content for exact external references', async () => {
    setupTextFile('fresh external content');
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error('outside the project directory');
    });
    const fakeCache = {
      getSync: vi.fn().mockReturnValue('stale cached content'),
      set: vi.fn(),
    };

    const result = await readTool.config.execute(
      { file_path: '/external/attachment.md' },
      {
        ...baseContext,
        allowedExactFilePaths: ['/external/attachment.md'],
        fileCache: fakeCache,
      } as unknown as ToolContext,
    ) as string;

    expect(result).toContain('fresh external content');
    expect(result).not.toContain('stale cached content');
    expect(fakeCache.getSync).not.toHaveBeenCalled();
    expect(fakeCache.set).not.toHaveBeenCalled();
  });

  it('should close the fd and reject when exact-file handle identity validation fails', async () => {
    setupTextFile('must not be returned');
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error('outside the project directory');
    });
    vi.mocked(assertOpenedExactFilePathAllowed).mockImplementation(() => {
      throw new Error('changed between authorization and opening');
    });

    await expect(readTool.config.execute(
      { file_path: '/external/attachment.md' },
      {
        ...baseContext,
        allowedExactFilePaths: ['/external/attachment.md'],
      },
    )).rejects.toThrow('changed between authorization and opening');

    expect(fs.closeSync).toHaveBeenCalledWith(42);
    expect(fs.readSync).not.toHaveBeenCalled();
  });

  it('should throw when path is outside project boundary', async () => {
    vi.mocked(assertPathContained).mockImplementation(() => {
      throw new Error("Path '/etc/passwd' is outside the project directory");
    });

    await expect(
      readTool.config.execute(
        { file_path: '/etc/passwd' },
        baseContext,
      ),
    ).rejects.toThrow('outside the project directory');
  });
});
