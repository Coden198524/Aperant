import type { ProviderAccount } from '../../shared/types/provider-account';
import { buildAutocodeProviderQueueResolutionErrorMessage } from '@autocode/core/runtime/agent-provider-errors';

export function buildProviderQueueResolutionErrorMessage(
  requestedModel: string,
  requestedProvider: string | null | undefined,
  accounts: ProviderAccount[],
): string {
  return buildAutocodeProviderQueueResolutionErrorMessage(
    requestedModel,
    requestedProvider,
    accounts,
  );
}
