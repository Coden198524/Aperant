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
import {
  TASK_LOG_SUMMARY_BYTES,
  buildLargeReadFileNote,
  decodeTextBuffer,
  formatImageReadResult,
  formatPdfReadResult,
  formatReadContent,
  getEffectiveReadLineLimit,
  isActiveTaskLogFile,
  isImageFile,
  isPdfFile,
  isTaskLogFile,
  joinReadNotes,
  normalizeReadPathInput,
  summarizeTaskLog,
} from '@autocode/core';
import { z } from 'zod/v3';

import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import type { FileContentCache } from '../cache/file-cache';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('The zero-based line offset to start reading from. Only provide if the file is too large to read at once'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The number of lines to read. Only provide if the file is too large to read at once.'),
  pages: z
    .string()
    .optional()
    .describe('Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.'),
});

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

    file_path = normalizeReadPathInput(file_path);

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
        const { lineLimit, isLargeFileDefault } = getEffectiveReadLineLimit(
          cachedSize,
          context.workflowMode,
          hasExplicitRange,
          limit,
        );
        return formatReadContent(
          cached,
          offset ?? 0,
          lineLimit,
          isLargeFileDefault
            ? {
                note: buildLargeReadFileNote(cachedSize, lineLimit),
              }
            : undefined,
        );
      }
    }

    // Open fd once; all subsequent stat/read operations use this fd to avoid TOCTOU.
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

      // Image files: read from the same fd.
      if (isImageFile(resolvedPath)) {
        const buffer = fs.readFileSync(fd);
        const base64 = buffer.toString('base64');
        return formatImageReadResult(resolvedPath, base64);
      }

      // PDF files: size comes from the same fstat.
      if (isPdfFile(resolvedPath)) {
        return formatPdfReadResult(resolvedPath, stat.size, pages);
      }

      // Text files: read from the same fd.
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
      const { lineLimit, isLargeFileDefault } = getEffectiveReadLineLimit(
        stat.size,
        context.workflowMode,
        hasExplicitRange,
        limit,
      );

      const note = joinReadNotes(
        decoded.note,
        isLargeFileDefault
          ? buildLargeReadFileNote(stat.size, lineLimit)
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
