import * as path from 'node:path';
import { AUTOCODE_COMMON_IGNORED_DIR_NAMES } from '../workspace/ignore-rules.js';

export const SEARCH_EXCLUDED_DIRS = [
  ...AUTOCODE_COMMON_IGNORED_DIR_NAMES,
] as const;

const SEARCH_EXCLUDED_DIR_SET: ReadonlySet<string> = new Set(SEARCH_EXCLUDED_DIRS);

export const GLOB_MAX_RESULTS = 300;
export const GLOB_SUMMARY_THRESHOLD = 120;
export const GLOB_SUMMARY_SAMPLE_SIZE = 50;

export const GREP_DEFAULT_OUTPUT_MODE = 'files_with_matches';
export const GREP_MAX_OUTPUT_LENGTH = 12_000;
export const GREP_MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
export const GREP_MAX_FALLBACK_FILES = 10_000;

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export interface GrepSearchInput {
  pattern: string;
  path?: string;
  output_mode?: GrepOutputMode;
  context?: number;
  type?: string;
  glob?: string;
}

export interface GrepFallbackMatch {
  file: string;
  line?: number;
  text?: string;
  count?: number;
}

export function normalizeSearchPathSegments(fileName: string): string[] {
  return fileName.replace(/\\/g, '/').split('/').filter(Boolean);
}

export function shouldExcludeSearchPath(fileName: string): boolean {
  return normalizeSearchPathSegments(fileName).some((segment) =>
    SEARCH_EXCLUDED_DIR_SET.has(segment.toLowerCase()),
  );
}

export function shouldSkipSearchDir(dirName: string): boolean {
  return SEARCH_EXCLUDED_DIR_SET.has(dirName.toLowerCase());
}

export function summarizePathsByDirectory(
  paths: string[],
  rootDir: string,
  totalMatches: number,
  sampleSize: number = GLOB_SUMMARY_SAMPLE_SIZE,
): string {
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

  const sample = paths.slice(0, sampleSize);
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

export function buildRipgrepArgs(
  input: GrepSearchInput,
  searchPath: string,
): string[] {
  const args: string[] = [];
  const mode = input.output_mode ?? GREP_DEFAULT_OUTPUT_MODE;

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

  args.push('--no-heading', '--color', 'never');
  for (const dir of SEARCH_EXCLUDED_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
  }

  args.push(input.pattern, searchPath);
  return args;
}

export function toPortableSearchPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function matchesSearchType(filePath: string, type?: string): boolean {
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

export function isProbablyBinaryBuffer(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function formatGrepFallbackResults(
  matches: GrepFallbackMatch[],
  mode?: GrepOutputMode,
): string {
  if (matches.length === 0) return 'No matches found';
  const outputMode = mode ?? GREP_DEFAULT_OUTPUT_MODE;
  if (outputMode === 'files_with_matches') {
    return Array.from(new Set(matches.map((match) => match.file))).join('\n');
  }
  if (outputMode === 'count') {
    return matches
      .filter((match) => (match.count ?? 0) > 0)
      .map((match) => `${match.file}:${match.count}`)
      .join('\n') || 'No matches found';
  }
  return matches
    .map((match) => `${match.file}:${match.line}:${match.text ?? ''}`)
    .join('\n');
}

export function truncateSearchOutput(
  output: string,
  maxLength: number = GREP_MAX_OUTPUT_LENGTH,
): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}\n\n[Output truncated - ${output.length} characters total]`;
}
