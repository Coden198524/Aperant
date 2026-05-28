/**
 * Edit File Tool
 * ==============
 *
 * Performs exact string replacements in files.
 * Supports single replacement (default) and replace_all mode.
 * Integrates with path-containment security.
 */

import * as fs from 'node:fs';
import {
  buildEditPlan,
  formatEditFileNotFound,
  getEditInputValidationError,
  normalizeFileMutationPathInput,
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
    .describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('Replace all occurrences of old_string (default false)'),
});

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const editTool = Tool.define({
  metadata: {
    name: 'Edit',
    description:
      'Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file (unless replace_all is true). Provide enough surrounding context in old_string to make it unique.',
    permission: ToolPermission.RequiresApproval,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    let { file_path, old_string, new_string, replace_all } = input;

    file_path = normalizeFileMutationPathInput(file_path);

    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: ensure path is within an allowed project boundary
    const { resolvedPath } = assertPathContained(file_path, allowedRoots);

    const inputError = getEditInputValidationError(old_string, new_string);
    if (inputError) {
      return inputError;
    }

    // Read the file
    let content: string;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return formatEditFileNotFound(file_path);
      }
      throw err;
    }

    const editPlan = buildEditPlan(
      content,
      file_path,
      old_string,
      new_string,
      replace_all,
    );
    if (!editPlan.ok) {
      return editPlan.error;
    }

    fs.writeFileSync(resolvedPath, editPlan.content, 'utf-8');

    // Invalidate cache after edit
    const cache = context.fileCache as FileContentCache | undefined;
    cache?.invalidate(resolvedPath);

    return editPlan.message;
  },
});
