import { ensureAutocodeAbsolutePath } from '@autocode/core/platform/path-helpers';

export function ensureAbsolutePath(p: string): string {
  return ensureAutocodeAbsolutePath(p);
}
