import { getAutocodeProviderModelLabel } from '@autocode/core/frontend/model-display';
import type { BuiltinProvider } from '../types/provider-account';

export function getProviderModelLabel(
  modelShorthand: string,
  provider: BuiltinProvider,
  userOverrides?: Record<string, Partial<Record<BuiltinProvider, unknown>>>
): string {
  return getAutocodeProviderModelLabel(
    modelShorthand,
    provider as Parameters<typeof getAutocodeProviderModelLabel>[1],
    userOverrides as Parameters<typeof getAutocodeProviderModelLabel>[2]
  );
}
