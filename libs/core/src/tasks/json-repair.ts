export function repairAutocodeJson(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch (originalError) {
    return applyAutocodeJsonRepairs(raw, originalError as SyntaxError);
  }
}

export function safeParseAutocodeJson<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(repairAutocodeJson(raw)) as T;
  } catch {
    return null;
  }
}

function applyAutocodeJsonRepairs(raw: string, originalError: SyntaxError): string {
  let text = raw;

  text = text.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
  text = text.replace(/,(\s*[}\]])/g, '$1');
  text = text.replace(/([}\]"0-9]|true|false|null)\s*\n(\s*[{["])/g, '$1,\n$2');

  try {
    JSON.parse(text);
    return text;
  } catch {
    // Continue to the more permissive whitespace repair below.
  }

  text = text.replace(/([}\]"])\s+([{["])/g, (_match, before: string, after: string) => `${before}, ${after}`);

  try {
    JSON.parse(text);
    return text;
  } catch {
    throw originalError;
  }
}
