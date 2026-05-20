/**
 * Glob File Search Tool
 * =====================
 *
 * Fast file pattern matching tool using glob patterns.
 * Returns matching file paths sorted by modification time.
 * Integrates with path-containment security.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';

import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import { truncateToolOutput } from '../truncation';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used.',
    ),
});

/** Maximum number of file results to return before truncation */
const MAX_RESULTS = 300;
const SUMMARY_THRESHOLD = 300;
const SUMMARY_SAMPLE_SIZE = 100;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.autocode',
  '.claude',
  '.codex',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'third-party',
  'extern',
  'external',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'bin',
  'obj',
  '__pycache__',
]);

function normalizePathSegments(fileName: string): string[] {
  return fileName.replace(/\\/g, '/').split('/').filter(Boolean);
}

function shouldExcludeGlobPath(fileName: string): boolean {
  return normalizePathSegments(fileName).some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()));
}

function summarizePathsByDirectory(paths: string[], rootDir: string, totalMatches: number): string {
  const directoryCounts = new Map<string, number>();
  for (const filePath of paths) {
    const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const dir = path.dirname(rel);
    const key = dir === '.' ? '<root>' : dir.split('/').slice(0, 3).join('/');
    directoryCounts.set(key, (directoryCounts.get(key) ?? 0) + 1);
  }

  const topDirectories = Array.from(directoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([dir, count]) => `- ${dir}: ${count}`);

  const sample = paths.slice(0, SUMMARY_SAMPLE_SIZE);
  return [
    `Glob matched ${totalMatches} files. Returning a compact summary to avoid flooding the model context.`,
    '',
    'Top directories:',
    ...topDirectories,
    '',
    `First ${sample.length} recently modified files:`,
    ...sample,
    '',
    'Narrow the pattern or path before reading files.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const globTool = Tool.define({
  metadata: {
    name: 'Glob',
    description:
      'Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    const searchDir = input.path ?? context.cwd;
    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: ensure search directory is within an allowed project boundary
    assertPathContained(searchDir, allowedRoots);

    // Resolve the search directory
    const resolvedDir = path.isAbsolute(searchDir)
      ? searchDir
      : path.resolve(context.projectDir, searchDir);

    if (!fs.existsSync(resolvedDir)) {
      return `Error: Directory not found: ${searchDir}`;
    }

    // Use Node.js built-in fs.globSync (available in Node 22+)
    const matches = fs.globSync(input.pattern, {
      cwd: resolvedDir,
      exclude: (fileName: string) => {
        return shouldExcludeGlobPath(fileName);
      },
    });

    // Convert to absolute paths and filter out directories
    const absolutePaths: string[] = [];
    for (const match of matches) {
      const absPath = path.isAbsolute(match)
        ? match
        : path.resolve(resolvedDir, match);
      try {
        const stat = fs.statSync(absPath);
        if (stat.isFile()) {
          absolutePaths.push(absPath);
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }

    if (absolutePaths.length === 0) {
      return 'No files found';
    }

    // Sort by modification time (most recently modified first)
    const withMtime = absolutePaths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, mtime: stat.mtimeMs };
      } catch {
        return { filePath, mtime: 0 };
      }
    });

    withMtime.sort((a, b) => b.mtime - a.mtime);

    // Cap results to prevent massive context window consumption
    const totalMatches = withMtime.length;
    const sortedPaths = withMtime.map((entry) => entry.filePath);
    const output = totalMatches > SUMMARY_THRESHOLD
      ? summarizePathsByDirectory(sortedPaths, resolvedDir, totalMatches)
      : sortedPaths.slice(0, MAX_RESULTS).join('\n');

    // Apply disk-spillover truncation for very large outputs
    const result = truncateToolOutput(output, 'Glob', context.projectDir);
    return result.content;
  },
});
