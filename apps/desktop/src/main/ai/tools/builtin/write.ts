/**
 * Write File Tool
 * ===============
 *
 * Writes content to a file on the local filesystem.
 * Creates parent directories if needed.
 * Integrates with path-containment security.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  formatWriteSuccess,
  normalizeFileMutationPathInput,
  validateJsonWriteContent,
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
  file_path: z
    .string()
    .describe('The absolute path to the file to write (must be absolute, not relative)'),
  content: z.string().describe('The content to write to the file'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const writeTool = Tool.define({
  metadata: {
    name: 'Write',
    description:
      'Writes a file to the local filesystem. This tool will overwrite the existing file if there is one at the provided path. ALWAYS prefer editing existing files with the Edit tool. NEVER write new files unless explicitly required.',
    permission: ToolPermission.RequiresApproval,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    const file_path = normalizeFileMutationPathInput(input.file_path);
    const { content } = input;
    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: ensure path is within an allowed project boundary
    const { resolvedPath } = assertPathContained(file_path, allowedRoots);

    // Ensure parent directory exists
    const parentDir = path.dirname(resolvedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    validateJsonWriteContent(resolvedPath, content);

    // Write the file
    fs.writeFileSync(resolvedPath, content, 'utf-8');

    // Invalidate cache after write
    const cache = context.fileCache as FileContentCache | undefined;
    cache?.invalidate(resolvedPath);

    return formatWriteSuccess(file_path, content);
  },
});
