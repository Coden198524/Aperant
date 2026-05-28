/**
 * Grep Search Tool
 * ================
 *
 * Ripgrep-style content search tool.
 * Supports regex patterns, file type/glob filtering, and multiple output modes.
 * Integrates with path-containment security.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GREP_DEFAULT_OUTPUT_MODE,
  GREP_MAX_FALLBACK_FILE_BYTES,
  GREP_MAX_FALLBACK_FILES,
  buildRipgrepArgs,
  formatGrepFallbackResults,
  isProbablyBinaryBuffer,
  matchesSearchType,
  shouldSkipSearchDir,
  toPortableSearchPath,
  truncateSearchOutput,
  type GrepFallbackMatch,
  type GrepOutputMode,
  type GrepSearchInput,
} from '@autocode/core';
import { minimatch } from 'minimatch';
import { z } from 'zod/v3';

import { findExecutable } from '../../../platform/index';
import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search in. Defaults to current working directory.'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.',
    ),
  context: z
    .number()
    .optional()
    .describe('Number of lines to show before and after each match (rg -C). Requires output_mode: "content".'),
  type: z
    .string()
    .optional()
    .describe('File type to search (rg --type). Common types: js, py, rust, go, java, etc.'),
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
});

type GrepToolInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runRipgrep(
  args: string[],
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const rgPath = findExecutable('rg');
  if (!rgPath) {
    return Promise.resolve({
      stdout: '',
      stderr: 'ripgrep (rg) not found. Please install ripgrep: https://github.com/BurntSushi/ripgrep',
      exitCode: 127,
    });
  }

  return new Promise((resolve) => {
    execFile(
      rgPath,
      args,
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? ('code' in error && typeof error.code === 'number'
              ? error.code
              : 1)
          : 0;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
        });
      },
    );
  });
}

function listFiles(root: string, abortSignal?: AbortSignal): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    if (abortSignal?.aborted) break;
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipSearchDir(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length >= GREP_MAX_FALLBACK_FILES) return files;
      }
    }
  }
  return files;
}

async function runBuiltinSearch(
  input: GrepToolInput,
  searchPath: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, 'u');
  } catch (error) {
    return `Error: invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }

  const rootStat = fs.existsSync(searchPath) ? fs.statSync(searchPath) : null;
  if (!rootStat) return 'No matches found';
  const files = rootStat.isDirectory() ? listFiles(searchPath, abortSignal) : [searchPath];
  const outputMode = input.output_mode ?? GREP_DEFAULT_OUTPUT_MODE;
  const matches: GrepFallbackMatch[] = [];

  for (const filePath of files) {
    if (abortSignal?.aborted) break;
    if (!matchesSearchType(filePath, input.type)) continue;
    if (input.glob) {
      const portable = toPortableSearchPath(path.relative(searchPath, filePath) || path.basename(filePath));
      if (!minimatch(portable, input.glob, { dot: true, nocase: process.platform === 'win32' })) {
        continue;
      }
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > GREP_MAX_FALLBACK_FILE_BYTES) continue;

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch {
      continue;
    }
    if (isProbablyBinaryBuffer(buffer)) continue;

    const content = buffer.toString('utf8');
    const relativeFile = toPortableSearchPath(path.relative(searchPath, filePath) || filePath);
    if (outputMode === 'files_with_matches') {
      if (regex.test(content)) matches.push({ file: relativeFile });
      regex.lastIndex = 0;
      continue;
    }

    const lines = content.split(/\r?\n/);
    let count = 0;
    for (let index = 0; index < lines.length; index += 1) {
      regex.lastIndex = 0;
      if (!regex.test(lines[index])) continue;
      count += 1;
      if (outputMode === 'content') {
        matches.push({ file: relativeFile, line: index + 1, text: lines[index] });
      }
    }
    if (outputMode === 'count' && count > 0) {
      matches.push({ file: relativeFile, count });
    }
  }

  return formatGrepFallbackResults(matches, outputMode as GrepOutputMode);
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const grepTool = Tool.define({
  metadata: {
    name: 'Grep',
    description:
      'A powerful search tool built on ripgrep. Supports full regex syntax, file type/glob filtering, and multiple output modes (content, files_with_matches, count).',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    const searchPath = input.path ?? context.cwd;
    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: ensure search path is within an allowed project boundary
    assertPathContained(searchPath, allowedRoots);

    const resolvedPath = path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(context.projectDir, searchPath);

    const args = buildRipgrepArgs(input as GrepSearchInput, resolvedPath);
    const { stdout, stderr, exitCode } = await runRipgrep(
      args,
      context.cwd,
      context.abortSignal,
    );

    if (exitCode === 127) {
      const fallbackOutput = await runBuiltinSearch(input, resolvedPath, context.abortSignal);
      return truncateSearchOutput(fallbackOutput);
    }

    // Exit code 1 means no matches (not an error for rg)
    if (exitCode === 1 && !stderr) {
      return 'No matches found';
    }

    if (exitCode > 1 && stderr) {
      return `Error: ${stderr.trim()}`;
    }

    if (!stdout.trim()) {
      return 'No matches found';
    }

    return truncateSearchOutput(stdout).trimEnd();
  },
});
