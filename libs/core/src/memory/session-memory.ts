import { join } from 'node:path';

import { safeParseAutocodeJson } from '../tasks/json-repair.js';

export const AUTOCODE_SESSION_MEMORY_DIR_NAME = 'memory';
export const AUTOCODE_SESSION_CODEBASE_MAP_FILE_NAME = 'codebase_map.json';
export const AUTOCODE_SESSION_GOTCHAS_FILE_NAME = 'gotchas.md';
export const AUTOCODE_SESSION_PATTERNS_FILE_NAME = 'patterns.md';

export const AUTOCODE_NO_SESSION_MEMORY_MESSAGE = 'No session memory found. This appears to be the first session.';
export const AUTOCODE_NO_SESSION_CONTEXT_MESSAGE = 'No session context available yet.';

export interface AutocodeSessionDiscovery {
  description: string;
  category: string;
  discovered_at: string;
}

export interface AutocodeSessionCodebaseMap {
  discovered_files: Record<string, AutocodeSessionDiscovery>;
  last_updated: string | null;
}

export interface RecordAutocodeSessionDiscoveryInput {
  filePath: string;
  description: string;
  category?: string;
}

export interface FormatAutocodeGotchaInput {
  gotcha: string;
  context?: string;
}

export interface BuildAutocodeSessionContextInput {
  codebaseMap?: AutocodeSessionCodebaseMap | null;
  gotchasMarkdown?: string | null;
  patternsMarkdown?: string | null;
  maxDiscoveries?: number;
  maxMarkdownChars?: number;
}

export function getAutocodeSessionMemoryDir(specDir: string): string {
  return join(specDir, AUTOCODE_SESSION_MEMORY_DIR_NAME);
}

export function getAutocodeSessionCodebaseMapPath(specDir: string): string {
  return join(getAutocodeSessionMemoryDir(specDir), AUTOCODE_SESSION_CODEBASE_MAP_FILE_NAME);
}

export function getAutocodeSessionGotchasPath(specDir: string): string {
  return join(getAutocodeSessionMemoryDir(specDir), AUTOCODE_SESSION_GOTCHAS_FILE_NAME);
}

export function getAutocodeSessionPatternsPath(specDir: string): string {
  return join(getAutocodeSessionMemoryDir(specDir), AUTOCODE_SESSION_PATTERNS_FILE_NAME);
}

export function createEmptyAutocodeSessionCodebaseMap(): AutocodeSessionCodebaseMap {
  return {
    discovered_files: {},
    last_updated: null,
  };
}

export function parseAutocodeSessionCodebaseMap(raw: string): AutocodeSessionCodebaseMap | null {
  const parsed = safeParseAutocodeJson<unknown>(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const discoveredFiles = normalizeDiscoveredFiles(record.discovered_files);
  const lastUpdated = typeof record.last_updated === 'string' ? record.last_updated : null;

  return {
    discovered_files: discoveredFiles,
    last_updated: lastUpdated,
  };
}

export function stringifyAutocodeSessionCodebaseMap(map: AutocodeSessionCodebaseMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

export function recordAutocodeSessionDiscovery(
  map: AutocodeSessionCodebaseMap,
  input: RecordAutocodeSessionDiscoveryInput,
  now: Date = new Date(),
): AutocodeSessionCodebaseMap {
  const timestamp = now.toISOString();
  return {
    discovered_files: {
      ...map.discovered_files,
      [input.filePath]: {
        description: input.description,
        category: input.category ?? 'general',
        discovered_at: timestamp,
      },
    },
    last_updated: timestamp,
  };
}

export function formatAutocodeGotchaTimestamp(date: Date = new Date()): string {
  return [
    date.getUTCFullYear(),
    '-',
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    '-',
    String(date.getUTCDate()).padStart(2, '0'),
    ' ',
    String(date.getUTCHours()).padStart(2, '0'),
    ':',
    String(date.getUTCMinutes()).padStart(2, '0'),
  ].join('');
}

export function formatAutocodeGotchasFileHeader(): string {
  return '# Gotchas & Pitfalls\n\nThings to watch out for in this codebase.\n';
}

export function formatAutocodeGotchaMarkdownEntry(
  input: FormatAutocodeGotchaInput,
  now: Date = new Date(),
): string {
  let entry = `\n## [${formatAutocodeGotchaTimestamp(now)}]\n${input.gotcha}`;
  if (input.context) {
    entry += `\n\n_Context: ${input.context}_`;
  }
  return `${entry}\n`;
}

export function buildAutocodeSessionContext(input: BuildAutocodeSessionContextInput): string {
  const maxDiscoveries = input.maxDiscoveries ?? 20;
  const maxMarkdownChars = input.maxMarkdownChars ?? 1000;
  const parts: string[] = [];

  const discoveries = Object.entries(input.codebaseMap?.discovered_files ?? {});
  if (discoveries.length > 0) {
    parts.push('## Codebase Discoveries');
    for (const [filePath, info] of discoveries.slice(0, maxDiscoveries)) {
      parts.push(`- \`${filePath}\`: ${info.description || 'No description'}`);
    }
  }

  const gotchas = input.gotchasMarkdown?.trim() ? input.gotchasMarkdown : '';
  if (gotchas) {
    parts.push('\n## Gotchas');
    parts.push(tailText(gotchas, maxMarkdownChars));
  }

  const patterns = input.patternsMarkdown?.trim() ? input.patternsMarkdown : '';
  if (patterns) {
    parts.push('\n## Patterns');
    parts.push(tailText(patterns, maxMarkdownChars));
  }

  return parts.length === 0 ? AUTOCODE_NO_SESSION_CONTEXT_MESSAGE : parts.join('\n');
}

function normalizeDiscoveredFiles(value: unknown): Record<string, AutocodeSessionDiscovery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const files: Record<string, AutocodeSessionDiscovery> = {};
  for (const [filePath, rawInfo] of Object.entries(value as Record<string, unknown>)) {
    if (!rawInfo || typeof rawInfo !== 'object' || Array.isArray(rawInfo)) {
      continue;
    }

    const info = rawInfo as Record<string, unknown>;
    const description = typeof info.description === 'string' ? info.description : '';
    if (!description) {
      continue;
    }

    files[filePath] = {
      description,
      category: typeof info.category === 'string' ? info.category : 'general',
      discovered_at: typeof info.discovered_at === 'string' ? info.discovered_at : '',
    };
  }
  return files;
}

function tailText(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) {
    return value;
  }
  return value.slice(-maxChars);
}
