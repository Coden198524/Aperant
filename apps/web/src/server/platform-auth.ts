import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IncomingMessage } from 'node:http';
import type {
  WebPlatformAccount,
  WebPlatformAuthLoginRequest,
  WebPlatformAuthSetupRequest,
  WebPlatformAuthStatus,
} from '../shared/api.js';

const SESSION_COOKIE_NAME = 'autocode_web_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
} as const;

interface PlatformAuthStoreFile {
  version: 1;
  accounts: StoredPlatformAccount[];
  sessions: StoredPlatformSession[];
}

interface StoredPlatformAccount {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  lastLoginAt?: string;
}

interface StoredPlatformSession {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface PlatformAuthSessionResult {
  status: WebPlatformAuthStatus;
  sessionToken: string;
}

export class WebPlatformAuthStore {
  constructor(
    private readonly dataDir: string,
    private readonly storeFile = 'platform-auth.json',
  ) {}

  async getStatus(sessionToken?: string | null): Promise<WebPlatformAuthStatus> {
    const store = await this.readStore();
    const { account, changed } = findSessionAccount(store, sessionToken);
    if (changed) {
      await this.writeStore(store);
    }

    return {
      configured: store.accounts.length > 0,
      authenticated: Boolean(account),
      ...(account ? { account: toPublicAccount(account) } : {}),
    };
  }

  async createFirstAccount(input: WebPlatformAuthSetupRequest): Promise<PlatformAuthSessionResult> {
    const store = await this.readStore();
    if (store.accounts.length > 0) {
      throw new PlatformAuthError(409, 'Platform account has already been configured.');
    }

    const username = normalizeUsername(input.username);
    validatePassword(input.password);

    const now = new Date().toISOString();
    const account: StoredPlatformAccount = {
      id: randomUUID(),
      username,
      passwordHash: await hashPassword(input.password),
      createdAt: now,
      lastLoginAt: now,
    };
    store.accounts.push(account);

    const { session, token } = createSession(account.id);
    store.sessions.push(session);
    await this.writeStore(store);

    return {
      status: {
        configured: true,
        authenticated: true,
        account: toPublicAccount(account),
      },
      sessionToken: token,
    };
  }

  async login(input: WebPlatformAuthLoginRequest): Promise<PlatformAuthSessionResult> {
    const store = await this.readStore();
    const username = normalizeUsername(input.username);
    const account = store.accounts.find((candidate) => candidate.username === username);
    if (!account || typeof input.password !== 'string' || !(await verifyPassword(input.password, account.passwordHash))) {
      throw new PlatformAuthError(401, 'Invalid username or password.');
    }

    account.lastLoginAt = new Date().toISOString();
    store.sessions = store.sessions.filter((session) => session.accountId !== account.id);
    const { session, token } = createSession(account.id);
    store.sessions.push(session);
    await this.writeStore(store);

    return {
      status: {
        configured: true,
        authenticated: true,
        account: toPublicAccount(account),
      },
      sessionToken: token,
    };
  }

  async logout(sessionToken?: string | null): Promise<void> {
    if (!sessionToken) return;

    const store = await this.readStore();
    const tokenHash = hashSessionToken(sessionToken);
    const nextSessions = store.sessions.filter((session) => session.tokenHash !== tokenHash);
    if (nextSessions.length === store.sessions.length) return;

    await this.writeStore({
      ...store,
      sessions: nextSessions,
    });
  }

  private get storePath(): string {
    return join(this.dataDir, this.storeFile);
  }

  private async readStore(): Promise<PlatformAuthStoreFile> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, 'utf-8')) as PlatformAuthStoreFile;
      if (raw.version === 1 && Array.isArray(raw.accounts) && Array.isArray(raw.sessions)) {
        return {
          version: 1,
          accounts: raw.accounts.filter(isStoredAccount),
          sessions: raw.sessions.filter(isStoredSession),
        };
      }
    } catch {
      // Missing or malformed auth data falls back to first-run setup.
    }

    return {
      version: 1,
      accounts: [],
      sessions: [],
    };
  }

  private async writeStore(store: PlatformAuthStoreFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

export class PlatformAuthError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAuthError';
  }
}

export function readPlatformSessionToken(request: IncomingMessage): string | null {
  const cookies = parseCookies(request.headers.cookie);
  return cookies.get(SESSION_COOKIE_NAME) ?? null;
}

export function buildPlatformSessionCookie(sessionToken: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function buildExpiredPlatformSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function findSessionAccount(
  store: PlatformAuthStoreFile,
  sessionToken?: string | null,
): { account: StoredPlatformAccount | null; changed: boolean } {
  const nowMs = Date.now();
  const beforeCount = store.sessions.length;
  store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > nowMs);
  const changed = store.sessions.length !== beforeCount;
  if (!sessionToken) {
    return { account: null, changed };
  }

  const tokenHash = hashSessionToken(sessionToken);
  const session = store.sessions.find((candidate) => candidate.tokenHash === tokenHash);
  if (!session) {
    return { account: null, changed };
  }

  return {
    account: store.accounts.find((account) => account.id === session.accountId) ?? null,
    changed,
  };
}

function createSession(accountId: string): { session: StoredPlatformSession; token: string } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  return {
    token,
    session: {
      id: randomUUID(),
      accountId,
      tokenHash: hashSessionToken(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    },
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = await scryptBuffer(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return [
    'scrypt',
    String(SCRYPT_OPTIONS.N),
    String(SCRYPT_OPTIONS.r),
    String(SCRYPT_OPTIONS.p),
    salt,
    key.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, expectedKey] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !salt || !expectedKey) {
    return false;
  }

  const cost = Number(n);
  const blockSize = Number(r);
  const parallelization = Number(p);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  const expected = Buffer.from(expectedKey, 'base64url');
  let actual: Buffer;
  try {
    actual = await scryptBuffer(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function scryptBuffer(
  password: string,
  salt: string,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolveScrypt, rejectScrypt) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        rejectScrypt(error);
        return;
      }
      resolveScrypt(derivedKey);
    });
  });
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PlatformAuthError(400, 'Username is required.');
  }

  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new PlatformAuthError(400, 'Username must be 3-64 characters and use letters, numbers, dots, underscores, or hyphens.');
  }
  return username;
}

function validatePassword(value: unknown): void {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    throw new PlatformAuthError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

function toPublicAccount(account: StoredPlatformAccount): WebPlatformAccount {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
    ...(account.lastLoginAt ? { lastLoginAt: account.lastLoginAt } : {}),
  };
}

function parseCookies(cookieHeader: string | string[] | undefined): Map<string, string> {
  const rawHeader = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader ?? '';
  const cookies = new Map<string, string>();
  for (const part of rawHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(valueParts.join('=')));
    } catch {
      cookies.set(name, valueParts.join('='));
    }
  }
  return cookies;
}

function isStoredAccount(value: unknown): value is StoredPlatformAccount {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as StoredPlatformAccount).id === 'string'
    && typeof (value as StoredPlatformAccount).username === 'string'
    && typeof (value as StoredPlatformAccount).passwordHash === 'string'
    && typeof (value as StoredPlatformAccount).createdAt === 'string',
  );
}

function isStoredSession(value: unknown): value is StoredPlatformSession {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as StoredPlatformSession).id === 'string'
    && typeof (value as StoredPlatformSession).accountId === 'string'
    && typeof (value as StoredPlatformSession).tokenHash === 'string'
    && typeof (value as StoredPlatformSession).createdAt === 'string'
    && typeof (value as StoredPlatformSession).expiresAt === 'string',
  );
}
