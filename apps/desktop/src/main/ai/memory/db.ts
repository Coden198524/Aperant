/**
 * Database Client Factory
 *
 * Supports three deployment modes:
 * 1. Free/offline (Electron, no login) - local libSQL file
 * 2. Cloud user (Electron, logged in) - embedded replica with Turso sync
 * 3. Web app (Next.js SaaS) - pure cloud libSQL
 */

import type { Client, Config } from '@libsql/client/sqlite3';
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { getMemoriesDir } from '../../config-paths';
import { MEMORY_PRAGMA_SQL, MEMORY_SCHEMA_SQL } from './schema';

export const DEFAULT_MEMORY_DATABASE = 'auto_claude_memory';

export interface LocalMemoryDatabaseOptions {
  dbPath?: string;
  database?: string;
}

export interface MemoryClientOptions extends LocalMemoryDatabaseOptions {
  tursoSyncUrl?: string;
  authToken?: string;
}

/**
 * Lazy-load @libsql/client via CJS require().
 *
 * @libsql/client depends on native platform-specific modules (@libsql/darwin-arm64,
 * @libsql/linux-x64-gnu, etc.). In packaged Electron apps these live in
 * Resources/node_modules/ (via extraResources). ESM import() can't resolve them
 * from within app.asar, but CJS require() works because Module.globalPaths is
 * patched at startup in index.ts to include Resources/node_modules/.
 *
 * Using a lazy getter avoids a static import that would crash at startup before
 * the globalPaths patch runs.
 */
let _createClient: ((config: Config) => Client) | null = null;

function loadCreateClient(): (config: Config) => Client {
  if (!_createClient) {
    // In Electron: globalThis.require is set up in index.ts with Module.globalPaths
    // patched to include Resources/node_modules/ for extraResources packages.
    // In tests/dev: fall back to createRequire (deps are in normal node_modules).
    const req = globalThis.require ?? createRequire(import.meta.url);
    let mod: Record<string, unknown>;
    try {
      mod = req('@libsql/client/sqlite3');
    } catch (err) {
      throw new Error(
        `Failed to load @libsql/client/sqlite3: ${(err as Error).message}. ` +
        'Ensure native modules are available in Resources/node_modules/'
      );
    }
    if (typeof mod.createClient !== 'function') {
      throw new Error(
        `@libsql/client/sqlite3 did not export createClient (got ${typeof mod.createClient}). ` +
        'Check that native modules are available in Resources/node_modules/'
      );
    }
    _createClient = mod.createClient as (config: Config) => Client;
  }
  return _createClient!;
}

let _client: Client | null = null;
let _clientPath: string | null = null;

function expandHomePath(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }

  if (inputPath.startsWith(`~${sep}`) || inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function normalizeDatabaseFilename(database?: string): string {
  const name = (database || DEFAULT_MEMORY_DATABASE).trim() || DEFAULT_MEMORY_DATABASE;
  return name.toLowerCase().endsWith('.db') ? name : `${name}.db`;
}

/**
 * Resolve the local memory database file path.
 *
 * GRAPHITI_DB_PATH is treated as a storage directory; GRAPHITI_DATABASE is the
 * database name. Defaults to ~/.autocode/memories/auto_claude_memory.db.
 */
export function resolveMemoryDatabasePath(dbPath?: string, database?: string): string {
  const basePath = expandHomePath((dbPath || getMemoriesDir()).trim() || getMemoriesDir());
  const absoluteBasePath = isAbsolute(basePath) ? basePath : resolve(basePath);
  return join(absoluteBasePath, normalizeDatabaseFilename(database));
}

function ensureMemoryDatabaseDirectory(localPath: string): void {
  mkdirSync(dirname(localPath), { recursive: true });
}

async function initializeMemoryClient(client: Client): Promise<void> {
  for (const pragma of MEMORY_PRAGMA_SQL.split('\n').filter((line) => line.trim())) {
    try {
      await client.execute(pragma);
    } catch {
      // Some PRAGMAs may not be supported in all libSQL modes.
    }
  }

  await client.executeMultiple(MEMORY_SCHEMA_SQL);
}

/**
 * Ensure the configured local memory database exists and has the current schema.
 * Uses a short-lived client so settings changes do not disturb the singleton
 * memory service client.
 */
export async function initializeLocalMemoryDatabase(
  options: LocalMemoryDatabaseOptions = {},
): Promise<{ path: string }> {
  const localPath = resolveMemoryDatabasePath(options.dbPath, options.database);
  ensureMemoryDatabaseDirectory(localPath);

  const client = loadCreateClient()({ url: `file:${localPath}` });
  try {
    await initializeMemoryClient(client);
  } finally {
    client.close();
  }

  return { path: localPath };
}

/**
 * Get or create the Electron memory database client.
 * Uses local libSQL file by default; optionally syncs to Turso Cloud.
 *
 * @param tursoSyncUrlOrOptions - Optional Turso URL or client options
 * @param authToken - Required when tursoSyncUrl is provided
 */
export async function getMemoryClient(
  tursoSyncUrlOrOptions?: string | MemoryClientOptions,
  authToken?: string,
): Promise<Client> {
  const options: MemoryClientOptions = typeof tursoSyncUrlOrOptions === 'object'
    ? tursoSyncUrlOrOptions
    : { tursoSyncUrl: tursoSyncUrlOrOptions, authToken };
  const localPath = resolveMemoryDatabasePath(options.dbPath, options.database);

  if (_client) {
    if (_clientPath === localPath) {
      return _client;
    }
    _client.close();
    _client = null;
    _clientPath = null;
  }

  ensureMemoryDatabaseDirectory(localPath);

  _client = loadCreateClient()({
    url: `file:${localPath}`,
    ...(options.tursoSyncUrl && options.authToken
      ? { syncUrl: options.tursoSyncUrl, authToken: options.authToken, syncInterval: 60 }
      : {}),
  });
  _clientPath = localPath;

  await initializeMemoryClient(_client);

  // libSQL has native vector support (vector_distance_cos, F32_BLOB), so no
  // sqlite-vec extension is needed for either local or cloud mode.
  return _client;
}

/**
 * Close and reset the singleton client.
 * Call this on app quit or when switching projects.
 */
export async function closeMemoryClient(): Promise<void> {
  if (_client) {
    _client.close();
    _client = null;
    _clientPath = null;
  }
}

export function getMemoryClientPath(): string | null {
  return _clientPath;
}

/**
 * Get a web app (Next.js) memory client for pure cloud access.
 * Not a singleton; each call creates a new client.
 *
 * @param tursoUrl - Turso Cloud database URL
 * @param authToken - Auth token for the database
 */
export async function getWebMemoryClient(
  tursoUrl: string,
  authToken: string,
): Promise<Client> {
  const client = loadCreateClient()({ url: tursoUrl, authToken });
  await initializeMemoryClient(client);
  return client;
}

/**
 * Create an in-memory client for tests.
 */
export async function getInMemoryClient(): Promise<Client> {
  const client = loadCreateClient()({ url: ':memory:' });
  await client.executeMultiple(MEMORY_SCHEMA_SQL);
  return client;
}
