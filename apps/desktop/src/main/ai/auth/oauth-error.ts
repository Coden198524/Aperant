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

export function extractOAuthErrorMessage(payload: unknown, fallback: string): string {
  const extracted = extractErrorValue(payload);
  if (extracted) return extracted;
  return stringifyErrorPayload(payload) ?? fallback;
}

export async function readOAuthErrorMessage(response: Response): Promise<string> {
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
