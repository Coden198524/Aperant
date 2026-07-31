const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface StoredCodexTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id?: string;
  id_token?: string;
}

export function extractChatGptAccountId(
  accessToken: string | undefined,
  idToken?: string,
): string | undefined {
  for (const token of [accessToken, idToken]) {
    const payload = decodeJwtPayload(token);
    if (!payload) continue;

    const directAccountId = readNonEmptyString(
      payload.chatgpt_account_id,
      payload.account_id,
    );
    if (directAccountId) return directAccountId;

    const authClaim = asRecord(payload[OPENAI_AUTH_CLAIM]);
    const nestedAccountId = readNonEmptyString(
      authClaim?.chatgpt_account_id,
      authClaim?.account_id,
    );
    if (nestedAccountId) return nestedAccountId;
  }

  return undefined;
}

export function resolveStoredCodexAccountId(
  tokens: Pick<StoredCodexTokens, 'access_token' | 'account_id' | 'id_token'>,
): string | undefined {
  return readNonEmptyString(tokens.account_id) ??
    extractChatGptAccountId(tokens.access_token, tokens.id_token);
}

export function parseStoredCodexTokens(value: unknown): StoredCodexTokens | null {
  const record = asRecord(value);
  if (!record) return null;

  const accessToken = readNonEmptyString(record.access_token);
  const refreshToken = readNonEmptyString(record.refresh_token);
  const expiresAt = typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)
    ? record.expires_at
    : null;
  if (!accessToken || !refreshToken || expiresAt === null) {
    return null;
  }

  const idToken = readNonEmptyString(record.id_token);
  const accountId = readNonEmptyString(record.account_id) ??
    extractChatGptAccountId(accessToken, idToken);

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    ...(accountId ? { account_id: accountId } : {}),
    ...(idToken ? { id_token: idToken } : {}),
  };
}

export function buildStoredCodexTokens(input: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  idToken?: string;
  previous?: Partial<StoredCodexTokens>;
}): StoredCodexTokens {
  const idToken = readNonEmptyString(input.idToken, input.previous?.id_token);
  const accountId = readNonEmptyString(input.accountId) ??
    extractChatGptAccountId(input.accessToken, idToken) ??
    readNonEmptyString(input.previous?.account_id);

  return {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    expires_at: input.expiresAt,
    ...(accountId ? { account_id: accountId } : {}),
    ...(idToken ? { id_token: idToken } : {}),
  };
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  try {
    const decoded = Buffer.from(segments[1], 'base64url').toString('utf8');
    return asRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
