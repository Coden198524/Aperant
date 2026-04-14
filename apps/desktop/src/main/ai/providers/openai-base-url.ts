const OPENAI_API_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/embeddings',
  '/models',
  '/completions',
  '/images/generations',
  '/audio/speech',
  '/audio/transcriptions',
  '/audio/translations',
] as const;

export function isOfficialOpenAIBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true;

  try {
    const { hostname } = new URL(baseURL);
    return (
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com')
    );
  } catch {
    return false;
  }
}

export function normalizeOpenAICompatibleBaseUrl(baseURL: string | undefined): string | undefined {
  if (!baseURL) return baseURL;

  if (isOfficialOpenAIBaseUrl(baseURL)) {
    return baseURL;
  }

  try {
    const url = new URL(baseURL);
    const pathname = url.pathname;

    if (pathname.endsWith('/v1') || pathname.endsWith('/v1/')) {
      return baseURL;
    }

    if (pathname.includes('/v1/') || pathname.includes('/v1')) {
      return baseURL;
    }

    url.pathname = pathname.replace(/\/+$/, '') + '/v1';
    return url.toString();
  } catch {
    return baseURL;
  }
}

export function buildAlternateOpenAICompatibleUrl(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    const suffix = OPENAI_API_SUFFIXES.find((candidate) => url.pathname.endsWith(candidate));
    if (!suffix) return null;

    const prefix = url.pathname.slice(0, -suffix.length);
    const alternatePrefix = prefix.endsWith('/v1')
      ? prefix.slice(0, -3)
      : `${prefix.replace(/\/+$/, '')}/v1`;

    const alternatePath = `${alternatePrefix}${suffix}` || suffix;
    if (alternatePath === url.pathname) return null;

    url.pathname = alternatePath.replace(/\/{2,}/g, '/');
    return url.toString();
  } catch {
    return null;
  }
}

function shouldRetryWithAlternateUrl(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 406 ||
    response.status === 415 ||
    (response.ok && contentType.startsWith('text/html'))
  );
}

export function createOpenAICompatibleEndpointFetch(): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const primaryRequest = input instanceof Request && !init
      ? input
      : new Request(input, init);

    const primaryResponse = await globalThis.fetch(primaryRequest.clone());
    if (!shouldRetryWithAlternateUrl(primaryResponse)) {
      return primaryResponse;
    }

    const alternateUrl = buildAlternateOpenAICompatibleUrl(primaryRequest.url);
    if (!alternateUrl || alternateUrl === primaryRequest.url) {
      return primaryResponse;
    }

    try {
      return await globalThis.fetch(new Request(alternateUrl, primaryRequest.clone()));
    } catch {
      return primaryResponse;
    }
  };
}
