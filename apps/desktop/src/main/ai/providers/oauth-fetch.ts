/**
 * Backward-compatible exports for callers that still use the historical
 * generic OAuth helper name. OpenAI file-based OAuth is a Codex subscription
 * transport and is implemented separately from the public OpenAI API.
 */

import {
  createCodexOAuthFetch,
  ensureValidCodexOAuthToken,
} from './codex-oauth-fetch';

export {
  createCodexOAuthFetch,
  ensureValidCodexOAuthCredentials,
  ensureValidCodexOAuthToken,
} from './codex-oauth-fetch';

export async function ensureValidOAuthToken(
  tokenFilePath: string,
  provider = 'openai',
): Promise<string | null> {
  if (provider !== 'openai') return null;
  return ensureValidCodexOAuthToken(tokenFilePath);
}

export function createOAuthProviderFetch(
  tokenFilePath: string,
  provider = 'openai',
): typeof globalThis.fetch {
  if (provider !== 'openai') {
    throw new Error(`Unsupported file-based OAuth provider: ${provider}`);
  }
  return createCodexOAuthFetch(tokenFilePath);
}
