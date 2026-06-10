import {
  maskAutocodeSecret,
  validateAutocodeApiKey,
  validateAutocodeBaseUrl,
} from '@autocode/core/auth/profile-validation';

export function maskApiKey(key: string): string {
  return maskAutocodeSecret(key);
}

export function isValidUrl(url: string): boolean {
  return validateAutocodeBaseUrl(url);
}

export function isValidApiKey(key: string): boolean {
  return validateAutocodeApiKey(key);
}
