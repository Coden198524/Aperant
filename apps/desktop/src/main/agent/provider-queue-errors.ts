import type { ProviderAccount } from '../../shared/types/provider-account';

function isResponsesStyleOpenAIModelId(modelId: string): boolean {
  return (
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;

  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' ||
      hostname.endsWith('.chatgpt.com')
    );
  } catch {
    return false;
  }
}

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
    isResponsesStyleOpenAIModelId(requestedModel) &&
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
