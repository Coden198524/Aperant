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
import { minimatch } from 'minimatch';
import { z } from 'zod/v3';

import { findExecutable } from '../../../platform/index';
import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_MODE = 'files_with_matches';
const MAX_OUTPUT_LENGTH = 12_000;
const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
const MAX_FALLBACK_FILES = 10_000;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.autocode',
  '.claude',
  '.codex',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  'bower_components',
  'vendor',
  'third_party',
  'third-party',
  'extern',
  'external',
  'target',
  'bin',
  'obj',
  '__pycache__',
]);

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
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") — maps to rg --glob'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRgArgs(
  input: z.infer<typeof inputSchema>,
  searchPath: string,
): string[] {
  const args: string[] = [];

  const mode = input.output_mode ?? DEFAULT_OUTPUT_MODE;

  switch (mode) {
    case 'files_with_matches':
      args.push('--files-with-matches');
      break;
    case 'count':
      args.push('--count');
      break;
    case 'content':
      args.push('--line-number');
      if (input.context !== undefined) {
        args.push('-C', String(input.context));
      }
      break;
  }

  if (input.type) {
    args.push('--type', input.type);
  }

  if (input.glob) {
    args.push('--glob', input.glob);
  }

  // Always add these defaults
  args.push('--no-heading', '--color', 'never');
  for (const dir of EXCLUDED_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
  }

  args.push(input.pattern, searchPath);

  return args;
}

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

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function shouldSkipDir(dirName: string): boolean {
  return EXCLUDED_DIRS.has(dirName);
}

function matchesType(filePath: string, type?: string): boolean {
  if (!type) return true;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const normalized = type.toLowerCase();
  const aliases: Record<string, string[]> = {
    js: ['js', 'jsx', 'mjs', 'cjs'],
    ts: ['ts', 'tsx', 'mts', 'cts'],
    py: ['py'],
    rust: ['rs'],
    go: ['go'],
    java: ['java'],
    cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
    c: ['c', 'h'],
    cs: ['cs'],
    json: ['json'],
    md: ['md', 'markdown'],
    html: ['html', 'htm'],
    css: ['css', 'scss', 'sass', 'less'],
  };
  return (aliases[normalized] ?? [normalized]).includes(ext);
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
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
        if (!shouldSkipDir(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length >= MAX_FALLBACK_FILES) return files;
      }
    }
  }
  return files;
}

function formatFallbackResults(
  matches: Array<{ file: string; line?: number; text?: string; count?: number }>,
  mode: z.infer<typeof inputSchema>['output_mode'],
): string {
  if (matches.length === 0) return 'No matches found';
  const outputMode = mode ?? DEFAULT_OUTPUT_MODE;
  if (outputMode === 'files_with_matches') {
    return Array.from(new Set(matches.map((m) => m.file))).join('\n');
  }
  if (outputMode === 'count') {
    return matches
      .filter((m) => (m.count ?? 0) > 0)
      .map((m) => `${m.file}:${m.count}`)
      .join('\n') || 'No matches found';
  }
  return matches
    .map((m) => `${m.file}:${m.line}:${m.text ?? ''}`)
    .join('\n');
}

async function runBuiltinSearch(
  input: z.infer<typeof inputSchema>,
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
  const outputMode = input.output_mode ?? DEFAULT_OUTPUT_MODE;
  const matches: Array<{ file: string; line?: number; text?: string; count?: number }> = [];

  for (const filePath of files) {
    if (abortSignal?.aborted) break;
    if (!matchesType(filePath, input.type)) continue;
    if (input.glob) {
      const portable = toPortablePath(path.relative(searchPath, filePath) || path.basename(filePath));
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
    if (stat.size > MAX_FALLBACK_FILE_BYTES) continue;

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;

    const content = buffer.toString('utf8');
    const relativeFile = toPortablePath(path.relative(searchPath, filePath) || filePath);
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

  return formatFallbackResults(matches, outputMode);
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

    const args = buildRgArgs(input, resolvedPath);
    const { stdout, stderr, exitCode } = await runRipgrep(
      args,
      context.cwd,
      context.abortSignal,
    );

    if (exitCode === 127) {
      const fallbackOutput = await runBuiltinSearch(input, resolvedPath, context.abortSignal);
      if (fallbackOutput.length > MAX_OUTPUT_LENGTH) {
        return `${fallbackOutput.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated - ${fallbackOutput.length} characters total]`;
      }
      return fallbackOutput;
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

    if (stdout.length > MAX_OUTPUT_LENGTH) {
      return `${stdout.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated - ${stdout.length} characters total]`;
    }

    return stdout.trimEnd();
  },
});
