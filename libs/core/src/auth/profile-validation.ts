const MASK_PLACEHOLDER = '\u2022\u2022\u2022\u2022';

export function validateAutocodeBaseUrl(baseUrl: string): boolean {
  if (!baseUrl || baseUrl.trim() === '') {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateAutocodeApiKey(apiKey: string): boolean {
  if (!apiKey || apiKey.trim() === '') {
    return false;
  }

  const trimmed = apiKey.trim();
  if (trimmed.length < 12) {
    return false;
  }

  return /^[a-zA-Z0-9\-_+.]+$/.test(trimmed);
}

export function maskAutocodeSecret(secret: string | null | undefined): string {
  if (!secret || secret.length <= 4) {
    return MASK_PLACEHOLDER;
  }

  return `${MASK_PLACEHOLDER}${secret.slice(-4)}`;
}

export function normalizeAutocodeApiBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function getAutocodeApiBaseUrlSuggestions(baseUrl: string): string[] {
  const normalized = normalizeAutocodeApiBaseUrl(baseUrl);
  if (!normalized) {
    return [];
  }

  const suggestions = new Set<string>();
  suggestions.add(normalized);

  if (normalized.endsWith('/v1')) {
    suggestions.add(normalized.slice(0, -3));
  } else {
    suggestions.add(`${normalized}/v1`);
  }

  return [...suggestions];
}
