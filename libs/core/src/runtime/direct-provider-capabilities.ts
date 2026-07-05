import { isAutocodeOpenAIResponsesTransport } from './agent-session-policies.js';

export type AutocodeDirectProviderContinuationMode = 'provider';

export interface AutocodeDirectProviderContinuationCapability {
  id: string;
  mode: AutocodeDirectProviderContinuationMode;
  supports(input: { provider: unknown; modelId: string }): boolean;
}

export const AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES: readonly AutocodeDirectProviderContinuationCapability[] = [
  {
    id: 'responses-previous-response',
    mode: 'provider',
    supports: ({ provider, modelId }) => isAutocodeOpenAIResponsesTransport(
      typeof provider === 'string' ? provider : undefined,
      modelId,
    ),
  },
] as const;

export function resolveAutocodeDirectProviderContinuationCapability(input: {
  provider: unknown;
  modelId: string;
}): AutocodeDirectProviderContinuationCapability | null {
  return AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES.find((capability) => capability.supports(input)) ?? null;
}

export function supportsAutocodeDirectProviderContinuation(input: {
  provider: unknown;
  modelId: string;
}): boolean {
  return resolveAutocodeDirectProviderContinuationCapability(input) !== null;
}