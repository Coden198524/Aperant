import { createReadStream } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { NativeCliSession } from '../../shared/types';

/**
 * Codex rollout files can grow to several gigabytes. The session metadata and
 * first user message are written near the beginning, so never read an entire
 * rollout merely to populate the history picker.
 */
export const CODEX_SESSION_PREVIEW_BYTES = 64 * 1024;

const CODEX_INDEX_TAIL_BYTES = 32 * 1024 * 1024;
const CODEX_HISTORY_TAIL_BYTES = 32 * 1024 * 1024;
const CODEX_HISTORY_CACHE_TTL_MS = 30_000;
const CODEX_SESSION_FILE_LIMIT = 5_000;
const CODEX_HISTORY_RESULT_LIMIT = 200;
const CODEX_PREVIEW_CONCURRENCY = 8;

interface CodexCatalogSession extends NativeCliSession {
  firstText?: string;
  lastText?: string;
}

export interface CodexSessionPreview {
  id?: string;
  createdAt?: string;
  updatedAt: string;
  projectPath?: string;
  sourcePath: string;
  bytesRead: number;
}

export interface CodexNativeHistoryOptions {
  codexRoot?: string;
  useCache?: boolean;
  maxSessionFiles?: number;
  maxResults?: number;
}

interface CodexHistoryCache {
  root: string;
  expiresAt: number;
  promise: Promise<NativeCliSession[]>;
}

let historyCache: CodexHistoryCache | undefined;

function formatCliSessionTitle(text: unknown, fallback: string): string {
  if (typeof text !== 'string') {
    return fallback;
  }

  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function getCodexSessionIdFromPath(filePath: string): string | undefined {
  const fileName = basename(filePath);
  const match = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

function isPathInProject(sessionPath: string | undefined, projectPath: string | undefined): boolean {
  if (!projectPath) {
    return true;
  }
  if (!sessionPath) {
    return false;
  }

  const normalizedSessionPath = resolve(sessionPath).toLowerCase();
  const normalizedProjectPath = resolve(projectPath).toLowerCase();
  return normalizedSessionPath === normalizedProjectPath
    || normalizedSessionPath.startsWith(`${normalizedProjectPath}${sep}`);
}

function parseJsonLine(line: string): unknown | undefined {
  if (!line) {
    return undefined;
  }

  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function forEachJsonLineFromTail(
  filePath: string,
  maxBytes: number,
  onEntry: (entry: unknown) => void,
): Promise<void> {
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return;
  }

  const start = Math.max(0, fileSize - maxBytes);
  const input = createReadStream(filePath, {
    encoding: 'utf8',
    start,
    highWaterMark: 64 * 1024,
  });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let isFirstLine = true;

  try {
    for await (const line of lines) {
      // A tail read usually starts in the middle of a JSON line.
      if (isFirstLine && start > 0) {
        isFirstLine = false;
        continue;
      }
      isFirstLine = false;

      const entry = parseJsonLine(line);
      if (entry !== undefined) {
        onEntry(entry);
      }
    }
  } catch {
    // Codex may rotate or remove session files while the history view is open.
  } finally {
    lines.close();
    input.destroy();
  }
}

async function findLatestSessionFiles(rootDir: string, limit: number): Promise<string[]> {
  const files: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    if (files.length >= limit) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    // Codex stores sessions under YYYY/MM/DD and rollout filenames contain an
    // ISO timestamp. Descending traversal lets the file limit retain newest
    // sessions without stat'ing every multi-gigabyte rollout.
    entries.sort((left, right) => right.name.localeCompare(left.name));

    for (const entry of entries) {
      if (files.length >= limit) {
        break;
      }

      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }
  };

  await visit(rootDir);
  return files;
}

/**
 * Read only the bounded beginning of one Codex rollout.
 *
 * Exported for a regression test that verifies a multi-gigabyte logical file
 * cannot be materialized as one V8 string.
 */
export async function readCodexSessionPreview(filePath: string): Promise<CodexSessionPreview | undefined> {
  let fileStat: Stats;
  try {
    fileStat = await stat(filePath);
  } catch {
    return undefined;
  }

  const preview: CodexSessionPreview = {
    id: getCodexSessionIdFromPath(filePath),
    updatedAt: fileStat.mtime.toISOString(),
    sourcePath: filePath,
    bytesRead: 0,
  };
  const input = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: CODEX_SESSION_PREVIEW_BYTES - 1,
    highWaterMark: 16 * 1024,
  });
  input.on('data', (chunk: string | Buffer) => {
    preview.bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      const entry = parseJsonLine(line);
      if (entry === undefined) {
        continue;
      }

      const record = entry as { type?: unknown; payload?: unknown };
      if (record.type === 'session_meta') {
        const payload = record.payload as { id?: unknown; timestamp?: unknown; cwd?: unknown } | undefined;
        preview.id = typeof payload?.id === 'string' ? payload.id : preview.id;
        preview.createdAt = typeof payload?.timestamp === 'string'
          ? payload.timestamp
          : preview.createdAt;
        preview.projectPath = typeof payload?.cwd === 'string'
          ? payload.cwd
          : preview.projectPath;
      }

      // session_meta is always the first rollout record. Titles come from the
      // small session index/history files, so stop as soon as project identity
      // is known instead of retaining large prompt payloads from every rollout.
      if (preview.id && preview.projectPath) {
        break;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }

  return preview.id ? preview : undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  };

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function buildCodexHistoryCatalog(
  codexRoot: string,
  maxSessionFiles: number,
): Promise<NativeCliSession[]> {
  const historyPath = join(codexRoot, 'history.jsonl');
  const sessionIndexPath = join(codexRoot, 'session_index.jsonl');
  const sessionsRoot = join(codexRoot, 'sessions');
  const bySession = new Map<string, CodexCatalogSession>();

  const upsertSession = (
    id: string,
    updates: Partial<NativeCliSession> & { firstText?: string; lastText?: string },
  ): void => {
    const existing = bySession.get(id);
    if (!existing) {
      bySession.set(id, {
        id,
        cli: 'codex',
        title: updates.title || formatCliSessionTitle(
          updates.firstText || updates.lastText,
          'Codex session',
        ),
        createdAt: updates.createdAt,
        updatedAt: updates.updatedAt || new Date(0).toISOString(),
        projectPath: updates.projectPath,
        sourcePath: updates.sourcePath,
        firstText: updates.firstText,
        lastText: updates.lastText,
      });
      return;
    }

    const incomingUpdatedAt = updates.updatedAt ? new Date(updates.updatedAt).getTime() : 0;
    const existingUpdatedAt = new Date(existing.updatedAt).getTime();
    if (incomingUpdatedAt >= existingUpdatedAt) {
      existing.updatedAt = updates.updatedAt || existing.updatedAt;
      existing.lastText = updates.lastText || existing.lastText;
      existing.sourcePath = updates.sourcePath || existing.sourcePath;
    }

    existing.createdAt = existing.createdAt || updates.createdAt;
    existing.projectPath = existing.projectPath || updates.projectPath;
    existing.firstText = existing.firstText || updates.firstText;
    if (updates.title) {
      existing.title = updates.title;
    } else if (existing.firstText || existing.lastText) {
      existing.title = formatCliSessionTitle(
        existing.firstText || existing.lastText,
        existing.title || 'Codex session',
      );
    }
  };

  await forEachJsonLineFromTail(sessionIndexPath, CODEX_INDEX_TAIL_BYTES, (entry) => {
    const record = entry as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
    if (typeof record.id !== 'string') {
      return;
    }

    upsertSession(record.id, {
      title: formatCliSessionTitle(record.thread_name, 'Codex session'),
      updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
      sourcePath: sessionIndexPath,
    });
  });

  const sessionFiles = await findLatestSessionFiles(sessionsRoot, maxSessionFiles);
  const previews = await mapWithConcurrency(
    sessionFiles,
    CODEX_PREVIEW_CONCURRENCY,
    readCodexSessionPreview,
  );

  for (const preview of previews) {
    if (!preview?.id) {
      continue;
    }

    upsertSession(preview.id, {
      createdAt: preview.createdAt,
      updatedAt: preview.updatedAt,
      projectPath: preview.projectPath,
      sourcePath: preview.sourcePath,
    });
  }

  await forEachJsonLineFromTail(historyPath, CODEX_HISTORY_TAIL_BYTES, (entry) => {
    const record = entry as { session_id?: unknown; ts?: unknown; text?: unknown };
    if (typeof record.session_id !== 'string' || !bySession.has(record.session_id)) {
      return;
    }

    const timestamp = typeof record.ts === 'number' && Number.isFinite(record.ts)
      ? new Date(record.ts * 1000)
      : undefined;
    const text = typeof record.text === 'string' ? record.text : undefined;

    upsertSession(record.session_id, {
      createdAt: timestamp?.toISOString(),
      updatedAt: timestamp?.toISOString(),
      firstText: text,
      lastText: text,
    });
  });

  return [...bySession.values()].map(({
    firstText: _firstText,
    lastText: _lastText,
    ...session
  }) => session);
}

async function getCodexHistoryCatalog(
  codexRoot: string,
  useCache: boolean,
  maxSessionFiles: number,
): Promise<NativeCliSession[]> {
  if (
    useCache
    && historyCache?.root === codexRoot
    && historyCache.expiresAt > Date.now()
  ) {
    return historyCache.promise;
  }

  const promise = buildCodexHistoryCatalog(codexRoot, maxSessionFiles);
  if (!useCache) {
    return promise;
  }

  const cacheEntry: CodexHistoryCache = {
    root: codexRoot,
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  historyCache = cacheEntry;

  try {
    const catalog = await promise;
    if (historyCache === cacheEntry) {
      cacheEntry.expiresAt = Date.now() + CODEX_HISTORY_CACHE_TTL_MS;
    }
    return catalog;
  } catch (error) {
    if (historyCache === cacheEntry) {
      historyCache = undefined;
    }
    throw error;
  }
}

export async function getCodexNativeHistory(
  projectPath?: string,
  options: CodexNativeHistoryOptions = {},
): Promise<NativeCliSession[]> {
  const codexRoot = options.codexRoot || join(homedir(), '.codex');
  const maxSessionFiles = options.maxSessionFiles ?? CODEX_SESSION_FILE_LIMIT;
  const maxResults = options.maxResults ?? CODEX_HISTORY_RESULT_LIMIT;
  const catalog = await getCodexHistoryCatalog(
    codexRoot,
    options.useCache !== false,
    maxSessionFiles,
  );

  return catalog
    .filter((session) => isPathInProject(session.projectPath, projectPath))
    .sort((left, right) => (
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    ))
    .slice(0, maxResults);
}

export function clearCodexNativeHistoryCacheForTests(): void {
  historyCache = undefined;
}
