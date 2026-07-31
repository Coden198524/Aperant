import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  buildStoredCodexTokens,
  parseStoredCodexTokens,
  resolveStoredCodexAccountId,
  type StoredCodexTokens,
} from '../auth/codex-token';
import { readOAuthErrorMessage } from '../auth/oauth-error';

const DEBUG = process.env.DEBUG === 'true' || process.argv.includes('--debug');

export const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_RESPONSES_ENDPOINT = `${CODEX_API_BASE_URL}/responses`;
export const CODEX_OAUTH_RESPONSES_TRANSPORT = 'openai.codex-oauth.responses';

export type CodexResponsesDiagnosticPhase =
  | 'response'
  | 'transport_error'
  | 'stream_error';

export interface CodexResponsesDiagnostic {
  phase: CodexResponsesDiagnosticPhase;
  endpoint: string;
  status: number | null;
  statusText: string | null;
  requestId: string | null;
  model: string | null;
  requestFields: string[];
  inputItemTypes: string[];
  toolCount: number;
  streamEventType?: string;
  errorType?: string;
  errorCode?: string;
}

export interface CodexOAuthFetchOptions {
  /**
   * Receives allowlisted request diagnostics only. Prompts, request bodies,
   * credentials, headers, tool definitions, and provider error messages are
   * deliberately excluded.
   */
  onDiagnostic?: (diagnostic: Readonly<CodexResponsesDiagnostic>) => void;
}

const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_ORIGINATOR = 'autocode';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_SSE_DIAGNOSTIC_BUFFER_LENGTH = 64 * 1024;

const CODEX_RESPONSES_ALLOWED_FIELDS = new Set([
  'client_metadata',
  'include',
  'input',
  'instructions',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'reasoning',
  'service_tier',
  'store',
  'stream',
  'stream_options',
  'text',
  'tool_choice',
  'tools',
]);

export interface CodexOAuthCredentials {
  accessToken: string;
  accountId: string;
  expiresAt: number;
}

function debugLog(message: string, data?: unknown): void {
  if (!DEBUG) return;
  const prefix = `[CodexOAuthFetch ${new Date().toISOString()}]`;
  if (data === undefined) {
    console.log(prefix, message);
    return;
  }
  console.log(prefix, message, data);
}

function readTokenFile(tokenFilePath: string): StoredCodexTokens | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
    const tokens = parseStoredCodexTokens(parsed);
    debugLog('Read token file', {
      path: tokenFilePath,
      expiresAt: tokens?.expires_at,
      hasAccountId: Boolean(tokens?.account_id),
    });
    return tokens;
  } catch {
    debugLog('Failed to read token file', { path: tokenFilePath });
    return null;
  }
}

function writeTokenFile(tokenFilePath: string, tokens: StoredCodexTokens): void {
  const temporaryPath = join(
    dirname(tokenFilePath),
    `.${randomUUID()}.codex-token.tmp`,
  );
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, JSON.stringify(tokens, null, 2), 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, tokenFilePath);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temp path may already have been atomically renamed.
    }
    throw new Error(
      'Failed to persist refreshed Codex OAuth credentials.',
      { cause: error },
    );
  }
  try {
    fs.chmodSync(tokenFilePath, 0o600);
  } catch {
    // chmod may fail on Windows; the user-data directory still provides the
    // platform ACL boundary.
  }
  debugLog('Wrote refreshed token file', {
    path: tokenFilePath,
    expiresAt: tokens.expires_at,
    hasAccountId: Boolean(tokens.account_id),
  });
}

async function refreshCodexOAuthTokens(
  stored: StoredCodexTokens,
  tokenFilePath: string,
): Promise<StoredCodexTokens | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: CODEX_CLIENT_ID,
  });
  const response = await globalThis.fetch(CODEX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorMessage = await readOAuthErrorMessage(response);
    debugLog('Token refresh failed', { status: response.status, error: errorMessage });
    return null;
  }

  const data = await response.json() as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) {
    debugLog('Token refresh response is missing access_token');
    return null;
  }

  const expiresIn = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
    ? data.expires_in
    : 3600;
  const refreshed = buildStoredCodexTokens({
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim()
      ? data.refresh_token
      : stored.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: typeof data.account_id === 'string' ? data.account_id : undefined,
    idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
    previous: stored,
  });
  writeTokenFile(tokenFilePath, refreshed);
  return refreshed;
}

export async function ensureValidCodexOAuthCredentials(
  tokenFilePath: string,
): Promise<CodexOAuthCredentials | null> {
  let stored = readTokenFile(tokenFilePath);
  if (!stored) return null;

  if (stored.expires_at - Date.now() <= REFRESH_THRESHOLD_MS) {
    try {
      stored = await refreshCodexOAuthTokens(stored, tokenFilePath);
    } catch (error) {
      debugLog('Token refresh request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (!stored) return null;

  const accountId = resolveStoredCodexAccountId(stored);
  if (!accountId) {
    debugLog('OAuth token does not contain a ChatGPT account id');
    return null;
  }

  return {
    accessToken: stored.access_token,
    accountId,
    expiresAt: stored.expires_at,
  };
}

export async function ensureValidCodexOAuthToken(
  tokenFilePath: string,
): Promise<string | null> {
  return (await ensureValidCodexOAuthCredentials(tokenFilePath))?.accessToken ?? null;
}

export function normalizeCodexResponsesPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex OAuth Responses request body must be a JSON object.');
  }

  const source = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(source).filter(([key]) => CODEX_RESPONSES_ALLOWED_FIELDS.has(key)),
  );
  normalized.store = false;

  const model = typeof normalized.model === 'string' ? normalized.model : undefined;
  if (isReasoningModel(model)) {
    const include = Array.isArray(normalized.include)
      ? normalized.include.filter((item): item is string => typeof item === 'string')
      : [];
    if (!include.includes('reasoning.encrypted_content')) {
      include.push('reasoning.encrypted_content');
    }
    normalized.include = include;
  }

  if (DEBUG) {
    const removedFields = Object.keys(source)
      .filter((key) => !CODEX_RESPONSES_ALLOWED_FIELDS.has(key))
      .sort();
    debugLog('Normalized Responses request', {
      fields: Object.keys(normalized).sort(),
      removedFields,
      inputItemTypes: readInputItemTypes(normalized.input),
      toolCount: Array.isArray(normalized.tools) ? normalized.tools.length : 0,
    });
  }

  return normalized;
}

export function createCodexOAuthFetch(
  tokenFilePath: string,
  options: CodexOAuthFetchOptions = {},
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const credentials = await ensureValidCodexOAuthCredentials(tokenFilePath);
    if (!credentials) {
      throw new Error(
        'Codex OAuth credentials are missing an access token or ChatGPT account id. ' +
        'Please re-authenticate.',
      );
    }

    const url = resolveRequestUrl(input);
    if (normalizeUrl(url) !== normalizeUrl(CODEX_RESPONSES_ENDPOINT)) {
      throw new Error(
        `Codex OAuth transport only supports ${CODEX_RESPONSES_ENDPOINT}; received ${url}.`,
      );
    }

    const headers = mergeRequestHeaders(input, init?.headers);
    headers.delete('authorization');
    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('ChatGPT-Account-ID', credentials.accountId);
    headers.set('originator', CODEX_ORIGINATOR);
    headers.delete('content-length');

    const rawBody = await readRequestBody(input, init?.body);
    if (!rawBody) {
      throw new Error('Codex OAuth Responses request is missing a JSON body.');
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      throw new Error('Codex OAuth Responses request body is not valid JSON.');
    }
    const normalizedBody = normalizeCodexResponsesPayload(parsedBody);
    const body = JSON.stringify(normalizedBody);
    const requestDiagnostic = createRequestDiagnostic(normalizedBody);

    let response: Response;
    try {
      response = await globalThis.fetch(CODEX_RESPONSES_ENDPOINT, {
        ...init,
        method: init?.method ?? (input instanceof Request ? input.method : 'POST'),
        headers,
        body,
      });
    } catch (error) {
      emitResponsesDiagnostic(
        {
          ...requestDiagnostic,
          phase: 'transport_error',
        },
        options.onDiagnostic,
      );
      throw error;
    }

    const responseDiagnostic: CodexResponsesDiagnostic = {
      ...requestDiagnostic,
      phase: 'response',
      status: response.status,
      statusText: response.statusText || null,
      requestId: response.headers.get('x-request-id'),
    };
    emitResponsesDiagnostic(responseDiagnostic, options.onDiagnostic);

    if (
      response.ok &&
      normalizedBody.stream === true &&
      response.body &&
      response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
    ) {
      return monitorResponsesEventStream(
        response,
        responseDiagnostic,
        options.onDiagnostic,
      );
    }
    return response;
  };
}

function createRequestDiagnostic(
  body: Record<string, unknown>,
): Omit<CodexResponsesDiagnostic, 'phase'> {
  return {
    endpoint: CODEX_RESPONSES_ENDPOINT,
    status: null,
    statusText: null,
    requestId: null,
    model: typeof body.model === 'string' ? body.model : null,
    requestFields: Object.keys(body).sort(),
    inputItemTypes: readInputItemTypes(body.input),
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
  };
}

function emitResponsesDiagnostic(
  diagnostic: CodexResponsesDiagnostic,
  listener: CodexOAuthFetchOptions['onDiagnostic'],
): void {
  const snapshot = freezeDiagnostic(diagnostic);
  try {
    listener?.(snapshot);
  } catch {
    // Diagnostics must never alter provider request behavior.
  }

  if (DEBUG) {
    debugLog('Responses request diagnostic', snapshot);
    return;
  }

  if (
    diagnostic.phase === 'transport_error' ||
    diagnostic.phase === 'stream_error' ||
    (diagnostic.phase === 'response' &&
      diagnostic.status !== null &&
      (diagnostic.status < 200 || diagnostic.status >= 300))
  ) {
    console.warn(
      `[CodexOAuthFetch ${new Date().toISOString()}] Responses request diagnostic`,
      snapshot,
    );
  }
}

function freezeDiagnostic(
  diagnostic: CodexResponsesDiagnostic,
): Readonly<CodexResponsesDiagnostic> {
  return Object.freeze({
    ...diagnostic,
    requestFields: Object.freeze([...diagnostic.requestFields]),
    inputItemTypes: Object.freeze([...diagnostic.inputItemTypes]),
  }) as Readonly<CodexResponsesDiagnostic>;
}

function monitorResponsesEventStream(
  response: Response,
  responseDiagnostic: CodexResponsesDiagnostic,
  listener: CodexOAuthFetchOptions['onDiagnostic'],
): Response {
  const responseBody = response.body;
  if (!responseBody) return response;

  const decoder = new TextDecoder();
  let bufferedText = '';
  const emittedErrors = new Set<string>();
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspectText(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      inspectText(decoder.decode());
      inspectBufferedEvents(true);
    },
  });

  function inspectText(text: string): void {
    bufferedText += text;
    if (bufferedText.length > MAX_SSE_DIAGNOSTIC_BUFFER_LENGTH) {
      const lastBoundary = Math.max(
        bufferedText.lastIndexOf('\n\n'),
        bufferedText.lastIndexOf('\r\n\r\n'),
      );
      bufferedText = lastBoundary >= 0
        ? bufferedText.slice(lastBoundary + (bufferedText[lastBoundary] === '\r' ? 4 : 2))
        : bufferedText.slice(-MAX_SSE_DIAGNOSTIC_BUFFER_LENGTH);
    }
    inspectBufferedEvents(false);
  }

  function inspectBufferedEvents(flush: boolean): void {
    const normalized = bufferedText.replace(/\r\n/g, '\n');
    const events = normalized.split('\n\n');
    bufferedText = flush ? '' : (events.pop() ?? '');
    if (flush && events.length === 0 && normalized) {
      events.push(normalized);
    }

    for (const eventText of events) {
      const event = readSafeStreamError(eventText);
      if (!event) continue;
      const fingerprint = `${event.streamEventType ?? ''}:${event.errorType ?? ''}:${event.errorCode ?? ''}`;
      if (emittedErrors.has(fingerprint)) continue;
      emittedErrors.add(fingerprint);
      emitResponsesDiagnostic(
        {
          ...responseDiagnostic,
          phase: 'stream_error',
          ...event,
        },
        listener,
      );
    }
  }

  const monitored = new Response(responseBody.pipeThrough(transformer), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  preserveResponseMetadata(response, monitored);
  return monitored;
}

function readSafeStreamError(eventText: string): Pick<
  CodexResponsesDiagnostic,
  'streamEventType' | 'errorType' | 'errorCode'
> | null {
  const data = eventText
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]' || data.length > MAX_SSE_DIAGNOSTIC_BUFFER_LENGTH) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const streamEventType = readSafeDiagnosticToken(record.type);
  let error: Record<string, unknown> | null = null;
  if (streamEventType === 'error') {
    error = readRecord(record.error) ?? record;
  } else if (streamEventType === 'response.failed') {
    const responseRecord = readRecord(record.response);
    error = readRecord(responseRecord?.error);
  }
  if (!error) return null;

  return {
    streamEventType,
    errorType: readSafeDiagnosticToken(error.type),
    errorCode: readSafeDiagnosticToken(error.code),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSafeDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  return /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : undefined;
}

function preserveResponseMetadata(source: Response, target: Response): void {
  for (const key of ['url', 'redirected', 'type'] as const) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        value: source[key],
      });
    } catch {
      // These fields are diagnostic conveniences; status, headers, and body
      // are already preserved by the Response constructor.
    }
  }
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function mergeRequestHeaders(
  input: RequestInfo | URL,
  initHeaders: HeadersInit | undefined,
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  return headers;
}

async function readRequestBody(
  input: RequestInfo | URL,
  initBody: BodyInit | null | undefined,
): Promise<string | null> {
  if (typeof initBody === 'string') return initBody;
  if (initBody instanceof URLSearchParams) return initBody.toString();
  if (initBody instanceof ArrayBuffer) return Buffer.from(initBody).toString('utf8');
  if (ArrayBuffer.isView(initBody)) {
    return Buffer.from(initBody.buffer, initBody.byteOffset, initBody.byteLength).toString('utf8');
  }
  if (initBody != null) {
    throw new Error('Codex OAuth Responses request body must be JSON text.');
  }
  if (input instanceof Request) {
    return input.clone().text();
  }
  return null;
}

function isReasoningModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-');
}

function readInputItemTypes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return typeof item;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type === 'string') return record.type;
    if (typeof record.role === 'string') return record.role;
    return 'object';
  });
}
