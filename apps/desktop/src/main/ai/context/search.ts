/**
 * Code Search Functionality
 *
 * Searches the codebase for relevant files based on keywords.
 * See apps/desktop/src/main/ai/context/search.ts for the TypeScript implementation.
 * Uses Node.js fs — no AI SDK dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shouldSkipAutocodeWorkspaceDir } from '@autocode/core/workspace/ignore-rules';

import type { FileMatch } from './types.js';

/** File extensions considered code files. */
const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.go', '.rs', '.rb', '.php',
]);
export const SEARCH_MATCHING_LINE_MAX_CHARS = 100;
export const SEARCH_FILE_READ_MAX_BYTES = 200_000;
export const SEARCH_MAX_MATCHES = 20;
const SEARCH_REFERENCE_MATCHES_MAX = 6;
const SEARCH_MATCHING_LINES_PER_KEYWORD = 5;
const SEARCH_MATCHING_LINES_PER_FILE = 5;
const SEARCH_FILE_READ_HEAD_RATIO = 0.65;

interface SearchableFileContent {
  content: string;
  sampled: boolean;
}

/** Recursively yield all code file paths under a directory. */
function* iterCodeFiles(directory: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (shouldSkipAutocodeWorkspaceDir(entry.name)) continue;

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* iterCodeFiles(fullPath);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

/**
 * Search a directory for files that match any of the given keywords.
 *
 * @param serviceDir   Absolute path to the directory to search.
 * @param serviceName  Label used in returned FileMatch objects.
 * @param keywords     Keywords to look for inside file content.
 * @param projectDir   Project root used to compute relative paths.
 * @returns Up to 20 matches, sorted by descending relevance score.
 */
export function searchService(
  serviceDir: string,
  serviceName: string,
  keywords: string[],
  projectDir: string,
): FileMatch[] {
  const matches: FileMatch[] = [];
  const normalizedKeywords = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);

  if (!fs.existsSync(serviceDir) || normalizedKeywords.length === 0) return matches;

  for (const filePath of iterCodeFiles(serviceDir)) {
    const searchable = readSearchableFileContent(filePath);
    if (!searchable) {
      continue;
    }
    const { content, sampled } = searchable;

    const contentLower = content.toLowerCase();
    let score = 0;
    const matchingKeywords: string[] = [];
    const matchingLines: Array<[number, string]> = [];
    const lines = content.split('\n');

    for (const keyword of normalizedKeywords) {
      if (!contentLower.includes(keyword)) continue;

      // Count occurrences, capped at 10 per keyword
      let count = 0;
      let idx = 0;
      while ((idx = contentLower.indexOf(keyword, idx)) !== -1) {
        count++;
        idx += keyword.length;
      }
      score += Math.min(count, 10);
      matchingKeywords.push(keyword);

      const keywordLines: Array<[number, string]> = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword)) {
          keywordLines.push([i + 1, compactSearchLine(lines[i])]);
        }
      }
      matchingLines.push(...selectHeadTailMatchingLines(keywordLines, SEARCH_MATCHING_LINES_PER_KEYWORD));
    }

    if (score > 0) {
      const relPath = path.relative(projectDir, filePath);
      matches.push({
        path: relPath,
        service: serviceName,
        reason: `Contains: ${matchingKeywords.join(', ')}${sampled ? ' (head/tail file sample)' : ''}`,
        relevanceScore: score,
        matchingLines: selectHeadTailMatchingLines(matchingLines, SEARCH_MATCHING_LINES_PER_FILE),
      });
    }
  }

  return selectSearchMatches(matches);
}

function readSearchableFileContent(filePath: string): SearchableFileContent | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= SEARCH_FILE_READ_MAX_BYTES) {
      return {
        content: fs.readFileSync(filePath, 'utf8'),
        sampled: false,
      };
    }

    const marker = `\n[... search file middle omitted, ${stat.size} bytes total ...]\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const budget = Math.max(0, SEARCH_FILE_READ_MAX_BYTES - markerBytes);
    if (budget <= 0) {
      return { content: '', sampled: true };
    }

    const headBytes = Math.ceil(budget * SEARCH_FILE_READ_HEAD_RATIO);
    const tailBytes = Math.max(0, budget - headBytes);
    const file = fs.openSync(filePath, 'r');
    try {
      const headBuffer = Buffer.alloc(headBytes);
      const headRead = fs.readSync(file, headBuffer, 0, headBytes, 0);
      const tailBuffer = Buffer.alloc(tailBytes);
      const tailStart = Math.max(0, stat.size - tailBytes);
      const tailRead = fs.readSync(file, tailBuffer, 0, tailBytes, tailStart);
      return {
        content: `${headBuffer.subarray(0, headRead).toString('utf8')}${marker}${tailBuffer.subarray(0, tailRead).toString('utf8')}`,
        sampled: true,
      };
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return null;
  }
}

function compactSearchLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, ' ');
  if (normalized.length <= SEARCH_MATCHING_LINE_MAX_CHARS) {
    return normalized;
  }

  const marker = ' ... [line middle omitted] ... ';
  const budget = SEARCH_MATCHING_LINE_MAX_CHARS - marker.length;
  if (budget <= 0) {
    return normalized.slice(0, SEARCH_MATCHING_LINE_MAX_CHARS);
  }

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = Math.max(0, budget - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}

function selectHeadTailMatchingLines(
  lines: Array<[number, string]>,
  limit: number,
): Array<[number, string]> {
  const unique = lines.filter((line, index) => (
    lines.findIndex((candidate) => candidate[0] === line[0]) === index
  ));
  if (limit <= 0) {
    return [];
  }
  if (unique.length <= limit) {
    return unique;
  }

  const headCount = Math.ceil(limit * 0.6);
  const tailCount = Math.max(0, limit - headCount);
  return [
    ...unique.slice(0, headCount),
    ...unique.slice(unique.length - tailCount),
  ];
}

function selectSearchMatches(matches: FileMatch[]): FileMatch[] {
  const sorted = [...matches].sort(compareSearchMatches);
  const primary = sorted.filter((match) => !isReferenceLikePath(match.path));
  const references = sorted.filter((match) => isReferenceLikePath(match.path));

  if (primary.length === 0) {
    return references.slice(0, SEARCH_MAX_MATCHES);
  }

  const keptReferences = references.slice(0, SEARCH_REFERENCE_MATCHES_MAX);
  const primaryBudget = Math.max(0, SEARCH_MAX_MATCHES - keptReferences.length);
  return [
    ...primary.slice(0, primaryBudget),
    ...keptReferences,
  ];
}

function compareSearchMatches(a: FileMatch, b: FileMatch): number {
  const scoreDelta = b.relevanceScore - a.relevanceScore;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  const rankDelta = searchPathRank(a.path) - searchPathRank(b.path);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return a.path.localeCompare(b.path);
}

function searchPathRank(filePath: string): number {
  return isReferenceLikePath(filePath) ? 1 : 0;
}

function isReferenceLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? normalized;
  return segments.some((segment) => (
    segment === '__tests__' ||
    segment === '__mocks__' ||
    segment === 'fixtures' ||
    segment === 'fixture' ||
    segment === 'test' ||
    segment === 'tests' ||
    segment === 'spec' ||
    segment === 'specs' ||
    segment === 'examples' ||
    segment === 'example' ||
    segment === 'samples' ||
    segment === 'sample'
  )) ||
    /\.(?:test|spec|stories|story|mock|fixture|sample|example)\.[^.]+$/.test(basename);
}
