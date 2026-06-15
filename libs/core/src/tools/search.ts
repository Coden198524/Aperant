import * as path from 'node:path';
import { AUTOCODE_COMMON_IGNORED_DIR_NAMES } from '../workspace/ignore-rules.js';

export const SEARCH_EXCLUDED_DIRS = [
  ...AUTOCODE_COMMON_IGNORED_DIR_NAMES,
] as const;

const SEARCH_EXCLUDED_DIR_SET: ReadonlySet<string> = new Set(SEARCH_EXCLUDED_DIRS);

export const GLOB_MAX_RESULTS = 300;
export const GLOB_SUMMARY_THRESHOLD = 120;
export const GLOB_SUMMARY_SAMPLE_SIZE = 30;
const GLOB_SUMMARY_TOP_DIRECTORY_COUNT = 12;

export const GREP_DEFAULT_OUTPUT_MODE = 'files_with_matches';
export const GREP_COUNT_SUMMARY_THRESHOLD = 120;
export const GREP_FILES_WITH_MATCHES_SUMMARY_THRESHOLD = 120;
export const GREP_MAX_OUTPUT_LENGTH = 12_000;
export const GREP_MAX_OUTPUT_LINE_LENGTH = 1000;
export const GREP_MAX_FALLBACK_FILE_BYTES = 1024 * 1024;
export const GREP_MAX_FALLBACK_FILES = 10_000;
export const GREP_RIPGREP_MAX_FILESIZE = '1M';
const SEARCH_OUTPUT_TRUNCATION_HEAD_RATIO = 0.65;
const SEARCH_LINE_OMISSION_MARKER = ' ... [line middle omitted] ... ';

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

interface SearchPathSummaryOptions {
  toolName?: string;
  sampleHeading?: (sampleCount: number) => string;
  guidance?: string;
}

interface GrepCountEntry {
  file: string;
  count: number;
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
  options: SearchPathSummaryOptions = {},
): string {
  const directoryCounts = new Map<string, number>();
  for (const filePath of paths) {
    const rel = toPortableRelativeSearchPath(filePath, rootDir);
    const dir = path.dirname(rel);
    const key = dir === '.' ? '<root>' : dir.split('/').slice(0, 3).join('/');
    directoryCounts.set(key, (directoryCounts.get(key) ?? 0) + 1);
  }

  const topDirectories = Array.from(directoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, GLOB_SUMMARY_TOP_DIRECTORY_COUNT)
    .map(([dir, count]) => `- ${dir}: ${count}`);
  const omittedDirectoryCount = Math.max(0, directoryCounts.size - topDirectories.length);
  if (omittedDirectoryCount > 0) {
    topDirectories.push(`... ${omittedDirectoryCount} more directories omitted`);
  }

  const sample = paths.slice(0, sampleSize).map((filePath) => formatSearchPathResult(filePath, rootDir));
  const toolName = options.toolName ?? 'Glob';
  const sampleHeading = options.sampleHeading?.(sample.length) ??
    `First ${sample.length} recently modified files:`;
  return [
    `${toolName} matched ${totalMatches} files. Returning a compact summary to avoid flooding the model context.`,
    '',
    'Top directories:',
    ...topDirectories,
    '',
    sampleHeading,
    ...sample,
    '',
    options.guidance ?? 'Narrow the pattern or path before reading files.',
  ].join('\n');
}

export function summarizeGrepFilesWithMatchesOutput(
  output: string,
  rootDir: string,
  threshold: number = GREP_FILES_WITH_MATCHES_SUMMARY_THRESHOLD,
): string {
  if (isSearchStatusOutput(output)) {
    return output;
  }

  const paths = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (paths.length <= threshold) {
    return formatSearchPathResults(paths, rootDir, Number.MAX_SAFE_INTEGER);
  }

  return summarizePathsByDirectory(paths, rootDir, paths.length, GLOB_SUMMARY_SAMPLE_SIZE, {
    toolName: 'Grep',
    sampleHeading: (sampleCount) => `First ${sampleCount} matching files:`,
    guidance: 'Narrow the pattern, glob, type, or path before reading files.',
  });
}

function isSearchStatusOutput(output: string): boolean {
  const trimmed = output.trimStart();
  return trimmed.startsWith('Error:') || trimmed === 'No matches found';
}

export function summarizeGrepCountOutput(
  output: string,
  rootDir: string,
  threshold: number = GREP_COUNT_SUMMARY_THRESHOLD,
): string {
  const entries = parseGrepCountEntries(output);
  if (!entries) {
    return output;
  }
  if (entries.length <= threshold) {
    return entries
      .map((entry) => `${formatSearchPathResult(entry.file, rootDir)}:${entry.count}`)
      .join('\n');
  }

  const directoryCounts = new Map<string, { files: number; matches: number }>();
  let totalMatches = 0;
  for (const entry of entries) {
    totalMatches += entry.count;
    const rel = formatSearchPathResult(entry.file, rootDir);
    const dir = path.dirname(rel);
    const key = dir === '.' ? '<root>' : dir.split('/').slice(0, 3).join('/');
    const current = directoryCounts.get(key) ?? { files: 0, matches: 0 };
    current.files += 1;
    current.matches += entry.count;
    directoryCounts.set(key, current);
  }

  const topDirectories = Array.from(directoryCounts.entries())
    .sort((a, b) => b[1].matches - a[1].matches || b[1].files - a[1].files)
    .slice(0, GLOB_SUMMARY_TOP_DIRECTORY_COUNT)
    .map(([dir, stats]) => `- ${dir}: ${stats.files} files, ${stats.matches} matches`);
  const omittedDirectoryCount = Math.max(0, directoryCounts.size - topDirectories.length);
  if (omittedDirectoryCount > 0) {
    topDirectories.push(`... ${omittedDirectoryCount} more directories omitted`);
  }

  const sample = [...entries]
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, GLOB_SUMMARY_SAMPLE_SIZE)
    .map((entry) => `${formatSearchPathResult(entry.file, rootDir)}:${entry.count}`);

  return [
    `Grep counted ${entries.length} matching files with ${totalMatches} total matches. Returning a compact summary to avoid flooding the model context.`,
    '',
    'Top directories:',
    ...topDirectories,
    '',
    `Top ${sample.length} matching file counts:`,
    ...sample,
    '',
    'Narrow the pattern, glob, type, or path before reading files.',
  ].join('\n');
}

function parseGrepCountEntries(output: string): GrepCountEntry[] | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const entries: GrepCountEntry[] = [];
  for (const line of lines) {
    const match = /^(.+):(\d+)$/.exec(line);
    if (!match) {
      return null;
    }
    entries.push({ file: match[1], count: Number(match[2]) });
  }
  return entries;
}

export function formatSearchPathResults(
  paths: string[],
  rootDir: string,
  maxResults: number = GLOB_MAX_RESULTS,
): string {
  return paths
    .slice(0, maxResults)
    .map((filePath) => formatSearchPathResult(filePath, rootDir))
    .join('\n');
}

export function formatSearchPathResult(filePath: string, rootDir: string): string {
  return toPortableRelativeSearchPath(filePath, rootDir);
}

function toPortableRelativeSearchPath(filePath: string, rootDir: string): string {
  if (!isAbsoluteSearchPath(filePath)) {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  const prefixes = buildSearchRootPrefixes(rootDir);
  for (const prefix of prefixes) {
    const matchLength = getSearchRootPrefixMatchLength(filePath, prefix);
    if (matchLength === null) {
      continue;
    }
    if (matchLength === filePath.length) {
      return '.';
    }
    return toPortableSearchPath(filePath.slice(matchLength + 1));
  }

  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath.replace(/\\/g, '/');
}

function isAbsoluteSearchPath(filePath: string): boolean {
  return path.isAbsolute(filePath) ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith('\\\\') ||
    filePath.startsWith('//');
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

  args.push('--no-heading', '--color', 'never', '--max-filesize', GREP_RIPGREP_MAX_FILESIZE);
  for (const dir of SEARCH_EXCLUDED_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
  }

  args.push(input.pattern, searchPath);
  return args;
}

export function toPortableSearchPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function relativizeSearchOutputPaths(output: string, rootDir: string): string {
  const prefixes = buildSearchRootPrefixes(rootDir);
  if (prefixes.length === 0 || output.length === 0) {
    return output;
  }

  return output
    .split('\n')
    .map((line) => relativizeSearchOutputLine(line, prefixes))
    .join('\n');
}

function buildSearchRootPrefixes(rootDir: string): string[] {
  const trimmed = rootDir.replace(/[\\/]+$/g, '');
  if (!trimmed) {
    return [];
  }
  return Array.from(new Set([
    trimmed.replace(/\\/g, '/'),
    trimmed.replace(/\//g, '\\'),
  ]));
}

function relativizeSearchOutputLine(line: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    const matchLength = getSearchRootPrefixMatchLength(line, prefix);
    if (matchLength === null) {
      continue;
    }
    if (matchLength === line.length) {
      return '.';
    }
    return normalizeRelativeSearchOutputLine(line.slice(matchLength + 1));
  }
  return line;
}

function getSearchRootPrefixMatchLength(line: string, prefix: string): number | null {
  const comparableLine = shouldMatchSearchPrefixCaseInsensitive(prefix)
    ? line.toLowerCase()
    : line;
  const comparablePrefix = shouldMatchSearchPrefixCaseInsensitive(prefix)
    ? prefix.toLowerCase()
    : prefix;

  if (comparableLine === comparablePrefix) {
    return prefix.length;
  }
  if (
    comparableLine.startsWith(`${comparablePrefix}/`) ||
    comparableLine.startsWith(`${comparablePrefix}\\`)
  ) {
    return prefix.length;
  }
  return null;
}

function shouldMatchSearchPrefixCaseInsensitive(prefix: string): boolean {
  return /^[a-z]:[\\/]/i.test(prefix) || prefix.startsWith('\\\\') || prefix.startsWith('//');
}

function normalizeRelativeSearchOutputLine(line: string): string {
  const lineNumberDelimiter = /^(.+?)([:-]\d+(?:[:-]|$))/.exec(line);
  if (!lineNumberDelimiter) {
    return toPortableSearchPath(line);
  }

  const pathPart = lineNumberDelimiter[1];
  return `${toPortableSearchPath(pathPart)}${line.slice(pathPart.length)}`;
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
  const compactOutput = compactSearchOutputLines(output, GREP_MAX_OUTPUT_LINE_LENGTH);
  if (compactOutput.length <= maxLength) return compactOutput;

  const marker = `\n\n[Output truncated - ${output.length} characters total; showing head and tail]\n\n`;
  if (marker.length >= maxLength - 2) {
    return compactOutput.slice(0, maxLength);
  }

  const budget = maxLength - marker.length;
  const headLength = Math.ceil(budget * SEARCH_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    compactOutput.slice(0, headLength).trimEnd(),
    marker,
    tailLength > 0 ? compactOutput.slice(-tailLength).trimStart() : '',
  ].join('');
}

function compactSearchOutputLines(output: string, maxLineLength: number): string {
  return output
    .split('\n')
    .map((line) => compactSearchOutputLine(line, maxLineLength))
    .join('\n');
}

function compactSearchOutputLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }
  if (maxLength <= SEARCH_LINE_OMISSION_MARKER.length + 2) {
    return line.slice(0, maxLength);
  }

  const budget = maxLength - SEARCH_LINE_OMISSION_MARKER.length;
  const headLength = Math.ceil(budget * SEARCH_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    line.slice(0, headLength).trimEnd(),
    SEARCH_LINE_OMISSION_MARKER,
    tailLength > 0 ? line.slice(-tailLength).trimStart() : '',
  ].join('');
}
