import { buildAlternateOpenAICompatibleUrl } from '@autocode/core';

export {
  buildAlternateOpenAICompatibleUrl,
  isOfficialOpenAIBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
} from '@autocode/core';

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
