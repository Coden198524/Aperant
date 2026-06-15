import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  withAutocodeRuntimeFileWriteLockSync,
} from '../runtime/workspace-claims.js';
import { safeParseAutocodeJson } from '../tasks/json-repair.js';
import { estimateTokens } from './retrieval/context-packer.js';

export const AUTOCODE_SESSION_MEMORY_DIR_NAME = 'memory';
export const AUTOCODE_SESSION_CODEBASE_MAP_FILE_NAME = 'codebase_map.json';
export const AUTOCODE_SESSION_GOTCHAS_FILE_NAME = 'gotchas.md';
export const AUTOCODE_SESSION_PATTERNS_FILE_NAME = 'patterns.md';

export const AUTOCODE_NO_SESSION_MEMORY_MESSAGE = 'No session memory found. This appears to be the first session.';
export const AUTOCODE_NO_SESSION_CONTEXT_MESSAGE = 'No session context available yet.';
const AUTOCODE_SESSION_DISCOVERY_DESCRIPTION_MAX_CHARS = 220;
const AUTOCODE_SESSION_DISCOVERY_DESCRIPTION_MAX_TOKENS = 80;
const AUTOCODE_SESSION_DISCOVERY_PATH_MAX_CHARS = 180;
const AUTOCODE_SESSION_DISCOVERY_PATH_MAX_TOKENS = 80;
const AUTOCODE_SESSION_DISCOVERY_STORED_DESCRIPTION_MAX_CHARS = 800;
const AUTOCODE_SESSION_DISCOVERY_STORED_DESCRIPTION_MAX_TOKENS = 220;
const AUTOCODE_SESSION_GOTCHA_STORED_TEXT_MAX_CHARS = 800;
const AUTOCODE_SESSION_GOTCHA_STORED_TEXT_MAX_TOKENS = 220;
const AUTOCODE_SESSION_GOTCHA_STORED_CONTEXT_MAX_CHARS = 500;
const AUTOCODE_SESSION_GOTCHA_STORED_CONTEXT_MAX_TOKENS = 150;
const AUTOCODE_SESSION_MARKDOWN_OMISSION_MARKER =
  '\n...[session memory middle omitted; inspect memory files for exact omitted detail]...\n';
const AUTOCODE_SESSION_STORED_OMISSION_MARKER =
  '\n...[session memory entry middle omitted before storage]...\n';
const AUTOCODE_SESSION_CONTEXT_HEAD_RATIO = 0.35;

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

export interface RecordAutocodeSessionDiscoveryFileInput extends RecordAutocodeSessionDiscoveryInput {
  specDir: string;
  now?: Date;
}

export interface AppendAutocodeSessionGotchaInput extends FormatAutocodeGotchaInput {
  specDir: string;
  now?: Date;
}

export interface AppendAutocodeSessionGotchaResult {
  filePath: string;
  entry: string;
  isNew: boolean;
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

export function loadAutocodeSessionCodebaseMapSync(specDir: string): AutocodeSessionCodebaseMap | null {
  const mapPath = getAutocodeSessionCodebaseMapPath(specDir);
  if (!existsSync(mapPath)) {
    return null;
  }
  return parseAutocodeSessionCodebaseMap(readFileSync(mapPath, 'utf-8'));
}

export function recordAutocodeSessionDiscovery(
  map: AutocodeSessionCodebaseMap,
  input: RecordAutocodeSessionDiscoveryInput,
  now: Date = new Date(),
): AutocodeSessionCodebaseMap {
  const timestamp = now.toISOString();
  const filePath = normalizeSessionDiscoveryPath(input.filePath);
  if (!filePath) {
    return map;
  }

  const discoveredFiles = removeEquivalentSessionDiscoveryPath(map.discovered_files, filePath);
  return {
    discovered_files: {
      ...discoveredFiles,
      [filePath]: {
        description: compactAutocodeSessionStoredText(
          input.description,
          AUTOCODE_SESSION_DISCOVERY_STORED_DESCRIPTION_MAX_CHARS,
          AUTOCODE_SESSION_DISCOVERY_STORED_DESCRIPTION_MAX_TOKENS,
        ),
        category: input.category ?? 'general',
        discovered_at: timestamp,
      },
    },
    last_updated: timestamp,
  };
}

export function recordAutocodeSessionDiscoveryInFile(
  input: RecordAutocodeSessionDiscoveryFileInput,
): AutocodeSessionCodebaseMap {
  const mapPath = getAutocodeSessionCodebaseMapPath(input.specDir);
  const scope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(input.specDir);

  return withAutocodeRuntimeFileWriteLockSync(
    {
      ...scope,
      filePath: mapPath,
      ownerId: `session-memory:discovery:${input.filePath}`,
    },
    () => {
      mkdirSync(getAutocodeSessionMemoryDir(input.specDir), { recursive: true });
      const current = loadAutocodeSessionCodebaseMapSync(input.specDir) ?? createEmptyAutocodeSessionCodebaseMap();
      const next = recordAutocodeSessionDiscovery(
        current,
        {
          filePath: input.filePath,
          description: input.description,
          category: input.category,
        },
        input.now,
      );
      writeAutocodeSessionCodebaseMapAtomic(mapPath, next);
      return next;
    },
  );
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
  const gotcha = compactAutocodeSessionStoredText(
    input.gotcha,
    AUTOCODE_SESSION_GOTCHA_STORED_TEXT_MAX_CHARS,
    AUTOCODE_SESSION_GOTCHA_STORED_TEXT_MAX_TOKENS,
  );
  const context = input.context
    ? compactAutocodeSessionStoredText(
        input.context,
        AUTOCODE_SESSION_GOTCHA_STORED_CONTEXT_MAX_CHARS,
        AUTOCODE_SESSION_GOTCHA_STORED_CONTEXT_MAX_TOKENS,
      )
    : '';
  let entry = `\n## [${formatAutocodeGotchaTimestamp(now)}]\n${gotcha}`;
  if (context) {
    entry += `\n\n_Context: ${context}_`;
  }
  return `${entry}\n`;
}

export function appendAutocodeSessionGotcha(
  input: AppendAutocodeSessionGotchaInput,
): AppendAutocodeSessionGotchaResult {
  const gotchasPath = getAutocodeSessionGotchasPath(input.specDir);
  const scope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(input.specDir);

  return withAutocodeRuntimeFileWriteLockSync(
    {
      ...scope,
      filePath: gotchasPath,
      ownerId: 'session-memory:gotcha',
    },
    () => {
      mkdirSync(getAutocodeSessionMemoryDir(input.specDir), { recursive: true });
      const isNew = isMissingOrEmptyFile(gotchasPath);
      const entry = formatAutocodeGotchaMarkdownEntry(
        {
          gotcha: input.gotcha,
          context: input.context,
        },
        input.now,
      );
      writeFileSync(
        gotchasPath,
        `${isNew ? formatAutocodeGotchasFileHeader() : ''}${entry}`,
        { flag: isNew ? 'w' : 'a', encoding: 'utf-8' },
      );
      return {
        filePath: gotchasPath,
        entry,
        isNew,
      };
    },
  );
}

export function buildAutocodeSessionContext(input: BuildAutocodeSessionContextInput): string {
  const maxDiscoveries = input.maxDiscoveries ?? 20;
  const maxMarkdownChars = input.maxMarkdownChars ?? 1000;
  const parts: string[] = [];

  const discoveries = selectRecentSessionDiscoveries(
    Object.entries(input.codebaseMap?.discovered_files ?? {}),
    maxDiscoveries,
  );
  if (discoveries.length > 0) {
    parts.push('## Codebase Discoveries');
    for (const [filePath, info] of discoveries) {
      const compactPath = compactAutocodeSessionContextText(
        filePath,
        AUTOCODE_SESSION_DISCOVERY_PATH_MAX_CHARS,
        AUTOCODE_SESSION_DISCOVERY_PATH_MAX_TOKENS,
      );
      const compactDescription = compactAutocodeSessionContextText(
        info.description || 'No description',
        AUTOCODE_SESSION_DISCOVERY_DESCRIPTION_MAX_CHARS,
        AUTOCODE_SESSION_DISCOVERY_DESCRIPTION_MAX_TOKENS,
      );
      parts.push(`- \`${compactPath}\`: ${compactDescription}`);
    }
  }

  const gotchas = input.gotchasMarkdown?.trim() ? input.gotchasMarkdown : '';
  if (gotchas) {
    parts.push('\n## Gotchas');
    parts.push(compactAutocodeSessionContextText(
      gotchas,
      maxMarkdownChars,
      estimateAutocodeSessionMarkdownTokenBudget(maxMarkdownChars),
    ));
  }

  const patterns = input.patternsMarkdown?.trim() ? input.patternsMarkdown : '';
  if (patterns) {
    parts.push('\n## Patterns');
    parts.push(compactAutocodeSessionContextText(
      patterns,
      maxMarkdownChars,
      estimateAutocodeSessionMarkdownTokenBudget(maxMarkdownChars),
    ));
  }

  return parts.length === 0 ? AUTOCODE_NO_SESSION_CONTEXT_MESSAGE : parts.join('\n');
}

function selectRecentSessionDiscoveries(
  discoveries: Array<[string, AutocodeSessionDiscovery]>,
  maxDiscoveries: number,
): Array<[string, AutocodeSessionDiscovery]> {
  if (maxDiscoveries <= 0) {
    return [];
  }

  return dedupeSessionDiscoveryEntries(discoveries)
    .sort((a, b) => {
      const aTime = Number.isFinite(a.timestamp) ? a.timestamp : 0;
      const bTime = Number.isFinite(b.timestamp) ? b.timestamp : 0;
      return bTime - aTime || a.index - b.index;
    })
    .slice(0, maxDiscoveries)
    .map((entry) => [entry.filePath, entry.info]);
}

interface RankedSessionDiscovery {
  filePath: string;
  info: AutocodeSessionDiscovery;
  index: number;
  timestamp: number;
}

function dedupeSessionDiscoveryEntries(
  discoveries: Array<[string, AutocodeSessionDiscovery]>,
): RankedSessionDiscovery[] {
  const byPath = new Map<string, RankedSessionDiscovery>();

  discoveries.forEach(([rawFilePath, info], index) => {
    const filePath = normalizeSessionDiscoveryPath(rawFilePath);
    if (!filePath) {
      return;
    }
    const key = normalizeSessionDiscoveryPathKey(filePath);
    const candidate = {
      filePath,
      info,
      index,
      timestamp: Date.parse(info.discovered_at),
    };
    const existing = byPath.get(key);
    if (!existing || isNewerSessionDiscovery(candidate, existing)) {
      byPath.set(key, candidate);
    }
  });

  return [...byPath.values()];
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

    const normalizedFilePath = normalizeSessionDiscoveryPath(filePath);
    if (!normalizedFilePath) {
      continue;
    }

    upsertSessionDiscovery(files, normalizedFilePath, {
      description,
      category: typeof info.category === 'string' ? info.category : 'general',
      discovered_at: typeof info.discovered_at === 'string' ? info.discovered_at : '',
    });
  }
  return files;
}

function upsertSessionDiscovery(
  files: Record<string, AutocodeSessionDiscovery>,
  filePath: string,
  discovery: AutocodeSessionDiscovery,
): void {
  const existingKey = findEquivalentSessionDiscoveryPath(files, filePath);
  if (!existingKey) {
    files[filePath] = discovery;
    return;
  }

  if (!isNewerSessionDiscovery(
    {
      filePath,
      info: discovery,
      index: 0,
      timestamp: Date.parse(discovery.discovered_at),
    },
    {
      filePath: existingKey,
      info: files[existingKey],
      index: 0,
      timestamp: Date.parse(files[existingKey].discovered_at),
    },
  )) {
    return;
  }

  if (existingKey !== filePath) {
    delete files[existingKey];
  }
  files[filePath] = discovery;
}

function isNewerSessionDiscovery(
  candidate: RankedSessionDiscovery,
  existing: RankedSessionDiscovery,
): boolean {
  const candidateTime = Number.isFinite(candidate.timestamp) ? candidate.timestamp : 0;
  const existingTime = Number.isFinite(existing.timestamp) ? existing.timestamp : 0;
  return candidateTime > existingTime || (candidateTime === existingTime && candidate.index < existing.index);
}

function removeEquivalentSessionDiscoveryPath(
  files: Record<string, AutocodeSessionDiscovery>,
  filePath: string,
): Record<string, AutocodeSessionDiscovery> {
  const next = { ...files };
  const existingKey = findEquivalentSessionDiscoveryPath(next, filePath);
  if (existingKey) {
    delete next[existingKey];
  }
  return next;
}

function findEquivalentSessionDiscoveryPath(
  files: Record<string, AutocodeSessionDiscovery>,
  filePath: string,
): string | null {
  const key = normalizeSessionDiscoveryPathKey(filePath);
  return Object.keys(files).find((existingPath) =>
    normalizeSessionDiscoveryPathKey(existingPath) === key,
  ) ?? null;
}

function normalizeSessionDiscoveryPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function normalizeSessionDiscoveryPathKey(filePath: string): string {
  return normalizeSessionDiscoveryPath(filePath).toLowerCase();
}

function writeAutocodeSessionCodebaseMapAtomic(
  mapPath: string,
  map: AutocodeSessionCodebaseMap,
): void {
  const tmpPath = `${mapPath}.tmp`;
  try {
    writeFileSync(tmpPath, stringifyAutocodeSessionCodebaseMap(map), 'utf-8');
    renameSync(tmpPath, mapPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors and rethrow the original write failure.
    }
    throw error;
  }
}

function isMissingOrEmptyFile(filePath: string): boolean {
  try {
    return statSync(filePath).size === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

function compactAutocodeSessionContextText(value: string, maxChars: number, maxTokens: number): string {
  return compactAutocodeSessionText(value, maxChars, maxTokens, AUTOCODE_SESSION_MARKDOWN_OMISSION_MARKER);
}

function compactAutocodeSessionStoredText(value: string, maxChars: number, maxTokens: number): string {
  return compactAutocodeSessionText(value, maxChars, maxTokens, AUTOCODE_SESSION_STORED_OMISSION_MARKER);
}

function compactAutocodeSessionText(value: string, maxChars: number, maxTokens: number, marker: string): string {
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  if (value.length <= maxChars && estimateTokens(value) <= maxTokens) {
    return value;
  }

  const charBounded = compactAutocodeSessionTextByChars(value, maxChars, marker);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, value.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactAutocodeSessionTextByChars(value, midpoint, marker);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactAutocodeSessionTextByChars(value: string, maxChars: number, marker: string): string {
  if (maxChars <= 0 || value.length <= maxChars) {
    return value.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }

  const effectiveMarker = marker.length >= maxChars - 2 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headChars = Math.ceil(budget * AUTOCODE_SESSION_CONTEXT_HEAD_RATIO);
  const tailChars = Math.max(0, budget - headChars);
  return [
    value.slice(0, headChars).trimEnd(),
    effectiveMarker,
    tailChars > 0 ? value.slice(-tailChars).trimStart() : '',
  ].join('');
}

function estimateAutocodeSessionMarkdownTokenBudget(maxChars: number): number {
  return Math.max(0, Math.ceil(maxChars / 4));
}
