import type {
  WebApiErrorResponse,
  WebPlatformAccount,
  WebPlatformAuthLoginRequest,
  WebPlatformAuthResponse,
  WebPlatformAuthSetupRequest,
  WebPlatformAuthStatusResponse,
} from '../shared/api';

const SERVICE_BASE_URL = (import.meta.env.VITE_AUTOCODE_SERVICE_URL ?? '').replace(/\/+$/, '');

export class PlatformAuthRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAuthRequestError';
  }
}

export async function getPlatformAuthStatus(): Promise<WebPlatformAuthStatusResponse['auth']> {
  const response = await platformAuthRequest<WebPlatformAuthStatusResponse>('/api/platform-auth/status');
  return response.auth;
}

export async function setupPlatformAccount(
  request: WebPlatformAuthSetupRequest,
): Promise<WebPlatformAccount | undefined> {
  const response = await platformAuthRequest<WebPlatformAuthResponse>('/api/platform-auth/setup', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  return response.auth.account;
}

export async function loginPlatformAccount(
  request: WebPlatformAuthLoginRequest,
): Promise<WebPlatformAccount | undefined> {
  const response = await platformAuthRequest<WebPlatformAuthResponse>('/api/platform-auth/login', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  return response.auth.account;
}

export async function logoutPlatformAccount(): Promise<void> {
  await platformAuthRequest<{ loggedOut: true }>('/api/platform-auth/logout', {
    method: 'POST',
  });
}

async function platformAuthRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${SERVICE_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    let details = response.statusText;
    try {
      const errorBody = await response.json() as WebApiErrorResponse;
      details = errorBody.details ?? errorBody.error ?? details;
    } catch {
      details = await response.text();
    }
    throw new PlatformAuthRequestError(response.status, details || `HTTP ${response.status}`);
  }

  return await response.json() as T;
}
