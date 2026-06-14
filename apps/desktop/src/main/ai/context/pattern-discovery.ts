/**
 * Pattern Discovery
 *
 * Discovers code patterns from reference files to guide implementation.
 * See apps/desktop/src/main/ai/context/pattern-discovery.ts for the TypeScript implementation.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FileMatch } from './types.js';

export const PATTERN_SNIPPET_MAX_CHARS = 300;
export const PATTERN_FILE_READ_MAX_BYTES = 200_000;
const PATTERN_FILE_READ_HEAD_RATIO = 0.65;
const PATTERN_REFERENCE_FILE_HEAD_RATIO = 0.65;

/**
 * Discover code snippets that demonstrate how a keyword is used in the project.
 *
 * For each keyword, the first occurrence found across the top `maxFiles`
 * reference files is extracted with ±3 lines of context.
 *
 * @param projectDir     Absolute path to the project root.
 * @param referenceFiles Reference FileMatch objects to analyze.
 * @param keywords       Keywords to search for within those files.
 * @param maxFiles       Maximum number of files to analyse.
 * @returns Map of `<keyword>_pattern` → code snippet string.
 */
export function discoverPatterns(
  projectDir: string,
  referenceFiles: FileMatch[],
  keywords: string[],
  maxFiles = 5,
): Record<string, string> {
  const patterns: Record<string, string> = {};
  const normalizedKeywords = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);

  for (const match of selectPatternReferenceFiles(referenceFiles, maxFiles)) {
    const filePath = path.join(projectDir, match.path);
    const content = readPatternFileContent(filePath);
    if (content === null) {
      continue;
    }

    const lines = content.split('\n');
    const contentLower = content.toLowerCase();

    for (const keyword of normalizedKeywords) {
      const patternKey = `${keyword}_pattern`;
      if (patternKey in patterns) continue;
      if (!contentLower.includes(keyword)) continue;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword)) {
          const start = Math.max(0, i - 3);
          const end = Math.min(lines.length, i + 4);
          const snippet = lines.slice(start, end).join('\n');
          patterns[patternKey] = `From ${match.path}:\n${compactPatternSnippet(snippet)}`;
          break;
        }
      }
    }
  }

  return patterns;
}

function selectPatternReferenceFiles(referenceFiles: readonly FileMatch[], maxFiles: number): FileMatch[] {
  if (maxFiles <= 0) {
    return [];
  }
  if (referenceFiles.length <= maxFiles) {
    return [...referenceFiles];
  }
  if (maxFiles === 1) {
    return [referenceFiles[0]];
  }

  const headCount = Math.ceil(maxFiles * PATTERN_REFERENCE_FILE_HEAD_RATIO);
  const tailCount = Math.max(0, maxFiles - headCount);
  return [
    ...referenceFiles.slice(0, headCount),
    ...referenceFiles.slice(referenceFiles.length - tailCount),
  ];
}

function readPatternFileContent(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= PATTERN_FILE_READ_MAX_BYTES) {
      return fs.readFileSync(filePath, 'utf8');
    }

    const marker = `\n[... pattern source middle omitted, ${stat.size} bytes total ...]\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const budget = Math.max(0, PATTERN_FILE_READ_MAX_BYTES - markerBytes);
    if (budget <= 0) {
      return '';
    }

    const headBytes = Math.ceil(budget * PATTERN_FILE_READ_HEAD_RATIO);
    const tailBytes = Math.max(0, budget - headBytes);
    const file = fs.openSync(filePath, 'r');
    try {
      const headBuffer = Buffer.alloc(headBytes);
      const headRead = fs.readSync(file, headBuffer, 0, headBytes, 0);
      const tailBuffer = Buffer.alloc(tailBytes);
      const tailStart = Math.max(0, stat.size - tailBytes);
      const tailRead = fs.readSync(file, tailBuffer, 0, tailBytes, tailStart);
      return `${headBuffer.subarray(0, headRead).toString('utf8')}${marker}${tailBuffer.subarray(0, tailRead).toString('utf8')}`;
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return null;
  }
}

function compactPatternSnippet(snippet: string): string {
  if (snippet.length <= PATTERN_SNIPPET_MAX_CHARS) {
    return snippet;
  }

  const marker = `\n[... pattern middle omitted, ${snippet.length} chars total ...]\n`;
  const budget = PATTERN_SNIPPET_MAX_CHARS - marker.length;
  if (budget <= 0) {
    return snippet.slice(0, PATTERN_SNIPPET_MAX_CHARS);
  }

  const headChars = Math.ceil(budget * 0.6);
  const tailChars = Math.max(0, budget - headChars);
  return `${snippet.slice(0, headChars).trimEnd()}${marker}${snippet.slice(-tailChars).trimStart()}`;
}
