/**
 * Read File Tool
 * ==============
 *
 * Reads a file from the local filesystem with support for:
 * - Line offset and limit for partial reads
 * - Image file detection (returns base64 for multimodal)
 * - PDF file detection with page range support
 * - Line number prefixing (cat -n style)
 *
 * Integrates with path-containment security to prevent
 * reads outside the project directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod/v3';

import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import type { FileContentCache } from '../cache/file-cache';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LINE_LIMIT = 500;
const BALANCED_DEFAULT_LINE_LIMIT = 400;
const AGGRESSIVE_DEFAULT_LINE_LIMIT = 120;
const LARGE_TEXT_FILE_BYTES = 512 * 1024;
const LARGE_TEXT_DEFAULT_LINE_LIMIT = 200;
const TASK_LOG_SUMMARY_BYTES = 256 * 1024;
const MAX_LINE_LENGTH = 2000;
const LEGACY_TEXT_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'windows-1252'] as const;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
]);

const PDF_EXTENSION = '.pdf';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .optional()
    .describe('The line number to start reading from. Only provide if the file is too large to read at once'),
  limit: z
    .number()
    .optional()
    .describe('The number of lines to read. Only provide if the file is too large to read at once.'),
  pages: z
    .string()
    .optional()
    .describe('Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWithLineNumbers(
  content: string,
  offset: number,
): string {
  const lines = content.split(/\r?\n/);
  const maxLineNum = offset + lines.length;
  const padWidth = String(maxLineNum).length;

  return lines
    .map((line, i) => {
      const lineNum = String(offset + i + 1).padStart(padWidth, ' ');
      const truncated =
        line.length > MAX_LINE_LENGTH
          ? `${line.slice(0, MAX_LINE_LENGTH)}... (truncated)`
          : line;
      return `${lineNum}\t${truncated}`;
    })
    .join('\n');
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === PDF_EXTENSION;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isTaskLogFile(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === 'task_logs.json';
}

function isActiveTaskLogFile(filePath: string, specDir: string): boolean {
  return normalizePath(filePath) === normalizePath(path.join(specDir, 'task_logs.json'));
}

function getDefaultLineLimit(workflowMode: string | undefined): number {
  if (workflowMode === 'aggressive') {
    return AGGRESSIVE_DEFAULT_LINE_LIMIT;
  }
  if (workflowMode === 'balanced') {
    return BALANCED_DEFAULT_LINE_LIMIT;
  }
  return DEFAULT_LINE_LIMIT;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function scoreDecodedText(text: string): number {
  const replacementCount = countMatches(text, /\uFFFD/g);
  const controlCount = countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);
  const extendedLatinCount = countMatches(text, /[\u00A0-\u00FF]/g);
  const cjkCount = countMatches(text, /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/g);
  const singleCjkPenalty = cjkCount > 0 && cjkCount < 2 ? 10 : 0;
  const cjkBonus = cjkCount >= 2 ? Math.min(cjkCount, 100) * 2 : 0;
  return (replacementCount * 1000) + (controlCount * 100) + (extendedLatinCount * 3) + singleCjkPenalty - cjkBonus;
}

function decodeTextBuffer(input: Buffer | string): { content: string; note?: string } {
  if (typeof input === 'string') {
    return { content: input };
  }

  const utf8 = input.toString('utf8');
  const utf8ReplacementCount = countMatches(utf8, /\uFFFD/g);
  if (utf8ReplacementCount === 0) {
    return { content: utf8 };
  }

  const candidates: Array<{ encoding: string; content: string; score: number }> = [
    { encoding: 'utf-8', content: utf8, score: scoreDecodedText(utf8) },
  ];

  for (const encoding of LEGACY_TEXT_ENCODINGS) {
    try {
      const content = new TextDecoder(encoding).decode(input);
      candidates.push({ encoding, content, score: scoreDecodedText(content) });
    } catch {
      // Ignore encodings not supported by the current Node/ICU build.
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || best.encoding === 'utf-8') {
    return { content: utf8 };
  }

  return {
    content: best.content,
    note: `[Decoded as ${best.encoding}; file was not valid UTF-8.]`,
  };
}

function joinReadNotes(...notes: Array<string | undefined>): string | undefined {
  const filtered = notes.filter((note): note is string => Boolean(note));
  return filtered.length > 0 ? filtered.join('\n') : undefined;
}

function formatReadContent(
  content: string,
  startLine: number,
  lineLimit: number,
  options: { note?: string } = {},
): string {
  const lines = content.split(/\r?\n/);
  const sliced = lines.slice(startLine, startLine + lineLimit);
  const result = formatWithLineNumbers(sliced.join('\n'), startLine);

  const totalLines = lines.length;
  const prefix = options.note ? `${options.note}\n\n` : '';
  if (startLine + lineLimit < totalLines) {
    return `${prefix}${result}\n\n[Showing lines ${startLine + 1}-${startLine + lineLimit} of ${totalLines} total lines]`;
  }

  return `${prefix}${result}`;
}

function summarizeTaskLog(content: string, filePath: string): string {
  const count = (pattern: RegExp) => (content.match(pattern) ?? []).length;
  return [
    `[Task log file: ${filePath}]`,
    `Size: ${Buffer.byteLength(content, 'utf-8')} bytes`,
    `Entries: tool_start=${count(/"type"\s*:\s*"tool_start"/g)}, tool_end=${count(/"type"\s*:\s*"tool_end"/g)}, text=${count(/"type"\s*:\s*"text"/g)}, error=${count(/"type"\s*:\s*"error"/g)}`,
    `Tools: Read=${count(/"tool_name"\s*:\s*"Read"/g)}, Glob=${count(/"tool_name"\s*:\s*"Glob"/g)}, Grep=${count(/"tool_name"\s*:\s*"Grep"/g)}, Bash=${count(/"tool_name"\s*:\s*"Bash"/g)}, Write=${count(/"tool_name"\s*:\s*"Write"/g)}, Edit=${count(/"tool_name"\s*:\s*"Edit"/g)}`,
    '',
    'Full task logs are intentionally not returned by default because they can contain large prior tool outputs and amplify context usage.',
    'Use explicit offset/limit only when this task is specifically debugging the log file.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const readTool = Tool.define({
  metadata: {
    name: 'Read',
    description:
      'Reads a file from the local filesystem. Supports line offset/limit for partial reads, image files (returns base64), and PDF files with page ranges. Results are returned with line numbers.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    let { file_path, offset, limit, pages } = input;

    // 兜底：标准化路径，将 Windows 反斜杠转换为正斜杠
    // 这样即使 AI 生成了错误格式的路径，也能正常工作
    file_path = file_path.replace(/\\/g, '/');

    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: ensure path is within an allowed project boundary
    const { resolvedPath } = assertPathContained(file_path, allowedRoots);

    // Try cache first (if available)
    const cache = context.fileCache as FileContentCache | undefined;
    if (cache && !pages) {
      const cached = cache.getSync(resolvedPath);
      if (cached) {
        if (cached.length === 0) {
          return `[File exists but is empty: ${file_path}]`;
        }
        const cachedSize = Buffer.byteLength(cached, 'utf-8');
        if (
          isTaskLogFile(resolvedPath) &&
          isActiveTaskLogFile(resolvedPath, context.specDir) &&
          offset === undefined &&
          limit === undefined &&
          cachedSize > TASK_LOG_SUMMARY_BYTES
        ) {
          return summarizeTaskLog(cached, file_path);
        }
        const hasExplicitRange = offset !== undefined || limit !== undefined;
        const largeFileDefault = cachedSize > LARGE_TEXT_FILE_BYTES && !hasExplicitRange;
        const lineLimit = limit ?? (largeFileDefault
          ? LARGE_TEXT_DEFAULT_LINE_LIMIT
          : getDefaultLineLimit(context.workflowMode));
        return formatReadContent(
          cached,
          offset ?? 0,
          lineLimit,
          largeFileDefault
            ? {
                note: `[Large file: ${Math.round(cachedSize / 1024)}KB. Showing the first ${lineLimit} lines by default; use offset/limit for a specific range.]`,
              }
            : undefined,
        );
      }
    }

    // Open fd once — all subsequent stat/read go through this fd to avoid TOCTOU
    let fd: number;
    try {
      fd = fs.openSync(resolvedPath, 'r');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return `Error: File not found: ${file_path}`;
      }
      if (code === 'EISDIR') {
        return `Error: '${file_path}' is a directory, not a file. Use the Bash tool with ls to list directory contents.`;
      }
      throw err;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (stat.isDirectory()) {
        return `Error: '${file_path}' is a directory, not a file. Use the Bash tool with ls to list directory contents.`;
      }

      // Image files — read from same fd
      if (isImageFile(resolvedPath)) {
        const buffer = fs.readFileSync(fd);
        const base64 = buffer.toString('base64');
        const ext = path.extname(resolvedPath).toLowerCase().slice(1);
        const mimeType =
          ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        return `[Image file: ${path.basename(resolvedPath)}]\ndata:${mimeType};base64,${base64}`;
      }

      // PDF files — size from same fstat
      if (isPdfFile(resolvedPath)) {
        if (pages) {
          return `[PDF file: ${path.basename(resolvedPath)}, pages: ${pages}]\nPDF reading requires external tooling. File exists at: ${resolvedPath}`;
        }
        const fileSizeKb = Math.round(stat.size / 1024);
        return `[PDF file: ${path.basename(resolvedPath)}, size: ${fileSizeKb}KB]\nUse the 'pages' parameter to read specific page ranges.`;
      }

      // Text files — read from same fd
      const decoded = decodeTextBuffer(fs.readFileSync(fd));
      const content = decoded.content;

      if (
        isTaskLogFile(resolvedPath) &&
        isActiveTaskLogFile(resolvedPath, context.specDir) &&
        offset === undefined &&
        limit === undefined &&
        stat.size > TASK_LOG_SUMMARY_BYTES
      ) {
        return summarizeTaskLog(content, file_path);
      }

      // Cache the content if no offset/limit (full file read)
      if (cache && !offset && !limit) {
        cache.set(resolvedPath, content, stat.mtimeMs);
      }

      if (content.length === 0) {
        return `[File exists but is empty: ${file_path}]`;
      }

      const startLine = offset ?? 0;
      const hasExplicitRange = offset !== undefined || limit !== undefined;
      const largeFileDefault = stat.size > LARGE_TEXT_FILE_BYTES && !hasExplicitRange;
      const lineLimit = limit ?? (largeFileDefault
        ? LARGE_TEXT_DEFAULT_LINE_LIMIT
        : getDefaultLineLimit(context.workflowMode));

      const note = joinReadNotes(
        decoded.note,
        largeFileDefault
          ? `[Large file: ${Math.round(stat.size / 1024)}KB. Showing the first ${lineLimit} lines by default; use offset/limit for a specific range.]`
          : undefined,
      );

      return formatReadContent(
        content,
        startLine,
        lineLimit,
        note ? { note } : undefined,
      );
    } finally {
      fs.closeSync(fd);
    }
  },
});
