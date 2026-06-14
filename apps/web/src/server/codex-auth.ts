import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  WebCodexAuthResult,
  WebCodexAuthState,
  WebCodexCliVersionInfo,
} from '../shared/api.js';

const execFileAsync = promisify(execFile);

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPES = 'openid profile email offline_access';
const OAUTH_FLOW_TIMEOUT_MS = 30 * 60 * 1000;

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

let activeLoginPromise: Promise<WebCodexAuthResult> | null = null;

export function getWebCodexAuthState(dataDir: string): WebCodexAuthState {
  const tokens = readStoredTokensSync(dataDir);
  if (!tokens) {
    return { isAuthenticated: false };
  }

  return {
    isAuthenticated: Date.now() < tokens.expires_at,
    expiresAt: tokens.expires_at,
  };
}

export async function clearWebCodexAuth(dataDir: string): Promise<void> {
  await rm(getTokenFilePath(dataDir), { force: true });
}

export async function startWebCodexOAuthFlow(dataDir: string): Promise<WebCodexAuthResult> {
  if (activeLoginPromise) {
    return activeLoginPromise;
  }

  activeLoginPromise = runOAuthFlow(dataDir).finally(() => {
    activeLoginPromise = null;
  });
  return activeLoginPromise;
}

export async function getWebCodexCliVersion(): Promise<WebCodexCliVersionInfo> {
  try {
    const { version, path } = await runCodexVersion();
    return {
      installed: version,
      path,
      detectionResult: {
        found: true,
        path,
        version,
        source: 'system-path',
        message: `Codex CLI found${path ? ` at ${path}` : ''}`,
      },
    };
  } catch (error) {
    return {
      installed: null,
      detectionResult: {
        found: false,
        source: 'system-path',
        message: error instanceof Error ? error.message : 'Codex CLI not found',
      },
    };
  }
}

async function runOAuthFlow(dataDir: string): Promise<WebCodexAuthResult> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('originator', 'autocode');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

  return new Promise<WebCodexAuthResult>((resolve, reject) => {
    let server: Server | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    server = createServer((request, response) => {
      if (!request.url) {
        response.writeHead(404).end();
        return;
      }

      const callbackUrl = new URL(request.url, REDIRECT_URI);
      if (callbackUrl.pathname !== '/auth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }

      const code = callbackUrl.searchParams.get('code');
      const error = callbackUrl.searchParams.get('error');
      const errorDescription = callbackUrl.searchParams.get('error_description');
      const returnedState = callbackUrl.searchParams.get('state');

      if (error || !code) {
        const message = errorDescription ?? error ?? 'No authorization code received';
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderAuthResultPage(false, message));
        settle(() => reject(new Error(`OAuth error: ${message}`)));
        return;
      }

      if (returnedState !== state) {
        const message = 'State parameter mismatch. Please retry authentication.';
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderAuthResultPage(false, message));
        settle(() => reject(new Error(`OAuth error: ${message}`)));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(renderAuthResultPage(true));
      settle(() => {
        exchangeCodeForTokens(code, codeVerifier)
          .then(async (result) => {
            await writeStoredTokens(dataDir, {
              access_token: result.accessToken,
              refresh_token: result.refreshToken,
              expires_at: result.expiresAt,
            });
            resolve(result);
          })
          .catch(reject);
      });
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error('Port 1455 is already in use. Please close the process using it and try again.'));
          return;
        }
        reject(error);
      });
    });

    server.listen(1455, '127.0.0.1', () => {
      try {
        openExternalUrl(authUrl.toString());
      } catch (error) {
        settle(() => reject(error));
        return;
      }

      timeoutHandle = setTimeout(() => {
        settle(() => reject(new Error('OAuth flow timed out after 30 minutes. Please try again.')));
      }, OAUTH_FLOW_TIMEOUT_MS);
    });
  });
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<WebCodexAuthResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const message = await readOAuthErrorMessage(response);
    throw new Error(`Token exchange failed: ${message}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.access_token !== 'string') {
    throw new Error('Token exchange response missing access_token');
  }
  if (typeof payload.refresh_token !== 'string') {
    throw new Error('Token exchange response missing refresh_token');
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(typeof payload.id_token === 'string' ? { email: getEmailFromIdToken(payload.id_token) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveErrorText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function stringifyErrorPayload(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== '{}' ? serialized : null;
  } catch {
    return null;
  }
}

function extractErrorValue(value: unknown): string | null {
  const primitive = primitiveErrorText(value);
  if (primitive) return primitive;

  if (Array.isArray(value)) {
    const messages = value
      .map(item => extractErrorValue(item))
      .filter((item): item is string => !!item);
    return messages.length > 0 ? messages.slice(0, 3).join('; ') : null;
  }

  if (!isRecord(value)) return null;

  const keys = [
    'error_description',
    'message',
    'detail',
    'error_message',
    'description',
    'code',
    'type',
  ];
  for (const key of keys) {
    const text = primitiveErrorText(value[key]);
    if (text) return text;
  }

  return extractErrorValue(value.error) ?? extractErrorValue(value.errors);
}

function extractOAuthErrorMessage(payload: unknown, fallback: string): string {
  const extracted = extractErrorValue(payload);
  if (extracted) return extracted;
  return stringifyErrorPayload(payload) ?? fallback;
}

async function readOAuthErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText
    ? `HTTP ${response.status} ${response.statusText}`
    : `HTTP ${response.status}`;

  let text = '';
  try {
    text = await response.text();
  } catch {
    return fallback;
  }

  const trimmed = text.trim();
  if (!trimmed) return fallback;

  try {
    const payload = JSON.parse(trimmed) as unknown;
    const message = extractOAuthErrorMessage(payload, fallback);
    return message === fallback ? fallback : `${fallback}: ${message}`;
  } catch {
    return `${fallback}: ${trimmed}`;
  }
}

function getEmailFromIdToken(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

function getTokenFilePath(dataDir: string): string {
  return join(dataDir, 'codex-auth.json');
}

function readStoredTokensSync(dataDir: string): StoredTokens | null {
  try {
    const raw = existsSync(getTokenFilePath(dataDir))
      ? readFileSync(getTokenFilePath(dataDir), 'utf-8')
      : '';
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (
      typeof parsed.access_token === 'string'
      && typeof parsed.refresh_token === 'string'
      && typeof parsed.expires_at === 'number'
    ) {
      return parsed as StoredTokens;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeStoredTokens(dataDir: string, tokens: StoredTokens): Promise<void> {
  const tokenPath = getTokenFilePath(dataDir);
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf-8');
}

function openExternalUrl(targetUrl: string): void {
  const child = process.platform === 'win32'
    ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', targetUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    : process.platform === 'darwin'
      ? spawn('open', [targetUrl], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' });

  child.on('error', (error) => {
    console.warn('[WebCodexAuth] Failed to open external browser:', error);
  });
  child.unref();
}

async function runCodexVersion(): Promise<{ version: string; path?: string }> {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'codex';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'codex --version']
    : ['--version'];
  const result = await execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
  const output = String(result.stdout).trim();
  const versionMatch = output.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return {
    version: versionMatch ? versionMatch[1] : output.split('\n')[0] || 'unknown',
    path: await findCodexPath(),
  };
}

async function findCodexPath(): Promise<string | undefined> {
  try {
    const result = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    return String(result.stdout).split(/\r?\n/).find(Boolean)?.trim();
  } catch {
    return undefined;
  }
}

function renderAuthResultPage(success: boolean, message = ''): string {
  const title = success ? 'Authentication successful' : 'Authentication failed';
  const color = success ? '#4ade80' : '#f87171';
  const text = success
    ? 'You can close this tab and return to Autocode.'
    : escapeHtml(message || 'Unknown error');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a1a; color: #e0e0e0;">
  <div style="text-align: center;">
    <h2 style="color: ${color};">${title}</h2>
    <p>${text}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
