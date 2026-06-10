import type { TFunction } from 'i18next';
import { resolveAutocodeLinearErrorMessage } from '@autocode/core/frontend/error-localizers';

export function localizeLinearErrorMessage(
  t: TFunction,
  error: string | null | undefined
): string | null {
  if (!error) {
    return null;
  }

  const resolved = resolveAutocodeLinearErrorMessage(error);
  if (!resolved) {
    return error;
  }

  return t(resolved.key, {
    ns: resolved.ns,
    defaultValue: resolved.defaultValue,
    ...resolved.values,
  });
}
