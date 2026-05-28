import type { ProviderAccount } from '../../shared/types/provider-account';
import { isOfficialOpenAIBaseUrl, isResponsesApiModel } from '@autocode/core';

export function buildProviderQueueResolutionErrorMessage(
  requestedModel: string,
  requestedProvider: string | null | undefined,
  accounts: ProviderAccount[],
): string {
  const hasCustomOpenAIAccount = accounts.some((account) => (
    account.provider === 'openai' &&
    account.authType === 'api-key' &&
    account.baseUrl &&
    !isOfficialOpenAIBaseUrl(account.baseUrl)
  ));

  if (
    requestedProvider === 'openai' &&
    isResponsesApiModel(requestedModel) &&
    hasCustomOpenAIAccount
  ) {
    return (
      `No compatible account available for model "${requestedModel}". ` +
      'The configured OpenAI account uses a custom base URL. Verify that it points ' +
      'to the provider API endpoint (usually ending with /v1), or configure the ' +
      'account as openai-compatible in Settings > Accounts.'
    );
  }

  return (
    `No compatible account available for model "${requestedModel}". ` +
    'Add a compatible account or adjust the task provider/model in Settings > Accounts.'
  );
}
