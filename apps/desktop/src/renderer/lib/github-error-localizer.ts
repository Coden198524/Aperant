import type { TFunction } from 'i18next';
import {
  isAutocodeGitHubAutomationModuleMissingError,
  resolveAutocodeGitHubErrorMessage,
} from '@autocode/core/frontend/error-localizers';

export function isGitHubAutomationModuleMissingError(error: string | null | undefined): boolean {
  return isAutocodeGitHubAutomationModuleMissingError(error);
}

export function localizeGitHubErrorMessage(
  t: TFunction,
  error: string | null | undefined
): string | null {
  if (!error) {
    return null;
  }

  const resolved = resolveAutocodeGitHubErrorMessage(error);
  if (!resolved) {
    return error;
  }

  return t(resolved.key, {
    ns: resolved.ns,
    defaultValue: resolved.defaultValue,
    ...resolved.values,
  });
}
