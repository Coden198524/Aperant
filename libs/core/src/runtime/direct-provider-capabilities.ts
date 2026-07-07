import type {
  AutocodeProviderModelInvocationRouteConfig,
  ProviderModelInvocationMethod,
} from '../providers/routing.js';

export type AutocodeDirectProviderContinuationMode = 'provider';
export type AutocodeDirectProviderOptionPrimitive = string | number | boolean | null;
export type AutocodeDirectProviderOptionValue =
  | AutocodeDirectProviderOptionPrimitive
  | AutocodeDirectProviderOptionValue[]
  | { [key: string]: AutocodeDirectProviderOptionValue };
export type AutocodeDirectProviderOptions = Record<string, Record<string, AutocodeDirectProviderOptionValue>>;
export type AutocodeDirectProviderConditionMatch = string | readonly string[];
export type AutocodeDirectProviderContinuationConditionMatch = AutocodeDirectProviderConditionMatch;

export interface AutocodeDirectProviderConditionConfig {
  provider?: AutocodeDirectProviderConditionMatch;
  providerPrefix?: AutocodeDirectProviderConditionMatch;
  provider_prefix?: AutocodeDirectProviderConditionMatch;
  providerIncludes?: AutocodeDirectProviderConditionMatch;
  provider_includes?: AutocodeDirectProviderConditionMatch;
  modelId?: AutocodeDirectProviderConditionMatch;
  model_id?: AutocodeDirectProviderConditionMatch;
  modelIdPrefix?: AutocodeDirectProviderConditionMatch;
  model_id_prefix?: AutocodeDirectProviderConditionMatch;
  modelIdIncludes?: AutocodeDirectProviderConditionMatch;
  model_id_includes?: AutocodeDirectProviderConditionMatch;
  transport?: AutocodeDirectProviderConditionMatch;
  providerTransport?: AutocodeDirectProviderConditionMatch;
  provider_transport?: AutocodeDirectProviderConditionMatch;
  transportPrefix?: AutocodeDirectProviderConditionMatch;
  transport_prefix?: AutocodeDirectProviderConditionMatch;
  providerTransportPrefix?: AutocodeDirectProviderConditionMatch;
  provider_transport_prefix?: AutocodeDirectProviderConditionMatch;
  transportIncludes?: AutocodeDirectProviderConditionMatch;
  transport_includes?: AutocodeDirectProviderConditionMatch;
  providerTransportIncludes?: AutocodeDirectProviderConditionMatch;
  provider_transport_includes?: AutocodeDirectProviderConditionMatch;
}

export type AutocodeDirectProviderContinuationConditionConfig = AutocodeDirectProviderConditionConfig;

export interface AutocodeDirectProviderContinuationCapabilityConfig {
  id: string;
  mode?: AutocodeDirectProviderContinuationMode;
  condition?: AutocodeDirectProviderContinuationConditionConfig;
  when?: AutocodeDirectProviderContinuationConditionConfig;
  providerOptions?: AutocodeDirectProviderOptions;
  provider_options?: AutocodeDirectProviderOptions;
  continuationProviderOptions?: AutocodeDirectProviderOptions;
  continuation_provider_options?: AutocodeDirectProviderOptions;
  previousProviderOptions?: AutocodeDirectProviderOptions;
  previous_provider_options?: AutocodeDirectProviderOptions;
  providerResponseIdFields?: readonly string[];
  provider_response_id_fields?: readonly string[];
  responseIdFields?: readonly string[];
  response_id_fields?: readonly string[];
}

export interface AutocodeDirectProviderContinuationCapability {
  id: string;
  mode: AutocodeDirectProviderContinuationMode;
  providerOptions?: AutocodeDirectProviderOptions;
  continuationProviderOptions?: AutocodeDirectProviderOptions;
  providerResponseIdFields?: string[];
  supports(input: { provider: unknown; modelId: string; transport?: unknown }): boolean;
}

export interface AutocodeDirectProviderContinuationRuntime {
  capabilityId: string;
  mode: AutocodeDirectProviderContinuationMode;
  providerResponseId?: string;
  providerResponseIdFields?: string[];
  providerOptions?: AutocodeDirectProviderOptions;
  continuationProviderOptions?: AutocodeDirectProviderOptions;
}

export interface AutocodeDirectProviderFallbackErrorMatcherConfig {
  messageIncludes?: readonly string[];
  message_includes?: readonly string[];
}

export interface AutocodeDirectProviderFallbackCapabilityConfig {
  id: string;
  condition?: AutocodeDirectProviderConditionConfig;
  when?: AutocodeDirectProviderConditionConfig;
  fallbackInvocationMethod?: ProviderModelInvocationMethod;
  fallback_invocation_method?: ProviderModelInvocationMethod;
  invocationMethod?: ProviderModelInvocationMethod;
  invocation_method?: ProviderModelInvocationMethod;
  fallbackProviderTransport?: string;
  fallback_provider_transport?: string;
  errorMatchers?: AutocodeDirectProviderFallbackErrorMatcherConfig | readonly AutocodeDirectProviderFallbackErrorMatcherConfig[];
  error_matchers?: AutocodeDirectProviderFallbackErrorMatcherConfig | readonly AutocodeDirectProviderFallbackErrorMatcherConfig[];
  errors?: AutocodeDirectProviderFallbackErrorMatcherConfig | readonly AutocodeDirectProviderFallbackErrorMatcherConfig[];
  resetProviderPersistence?: boolean;
  reset_provider_persistence?: boolean;
}

export interface AutocodeDirectProviderFallbackErrorMatcher {
  messageIncludes: string[];
}

export interface AutocodeDirectProviderFallbackCapability {
  id: string;
  fallbackInvocationMethod: ProviderModelInvocationMethod;
  fallbackProviderTransport?: string;
  errorMatchers: AutocodeDirectProviderFallbackErrorMatcher[];
  resetProviderPersistence: boolean;
  supports(input: { provider: unknown; modelId: string; transport?: unknown }): boolean;
}

export interface AutocodeDirectProviderFallbackRuntime {
  capabilityId: string;
  fallbackInvocationMethod: ProviderModelInvocationMethod;
  fallbackProviderTransport?: string;
  errorMatchers: AutocodeDirectProviderFallbackErrorMatcher[];
  resetProviderPersistence: boolean;
}

export const AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITY_DEFINITIONS = [
  {
    id: 'responses-previous-response',
    mode: 'provider',
    condition: {
      transport: ['openai.responses', 'openai-responses', 'responses'],
    },
    providerOptions: {
      openai: { store: true },
    },
    continuationProviderOptions: {
      openai: {
        store: true,
        previousResponseId: '{providerResponseId}',
      },
    },
    providerResponseIdFields: [
      'openai.responseId',
      'openai.response_id',
      'responseId',
      'response_id',
    ],
  },
] as const;

export const AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITY_DEFINITIONS = [
  {
    id: 'responses-persistence-chatmodel-fallback',
    condition: {
      transport_includes: 'responses',
    },
    fallbackInvocationMethod: 'chatModel',
    errorMatchers: [
      {
        messageIncludes: ['items are not persisted', 'store', 'false'],
      },
      {
        messageIncludes: ['item with id', 'fc_', 'not found', 'responses'],
      },
    ],
    resetProviderPersistence: true,
  },
] as const;

export const AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES: readonly AutocodeDirectProviderContinuationCapability[] =
  parseAutocodeDirectProviderContinuationCapabilities(AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITY_DEFINITIONS);

export const AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES: readonly AutocodeDirectProviderFallbackCapability[] =
  parseAutocodeDirectProviderFallbackCapabilities(AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITY_DEFINITIONS);

export function resolveAutocodeDirectProviderContinuationCapability(input: {
  provider: unknown;
  modelId: string;
  transport?: unknown;
  capabilities?: readonly AutocodeDirectProviderContinuationCapability[];
}): AutocodeDirectProviderContinuationCapability | null {
  return [
    ...(input.capabilities ?? []),
    ...AUTOCODE_DIRECT_PROVIDER_CONTINUATION_CAPABILITIES,
  ].find((capability) => capability.supports(input)) ?? null;
}

export function supportsAutocodeDirectProviderContinuation(input: {
  provider: unknown;
  modelId: string;
  transport?: unknown;
  capabilities?: readonly AutocodeDirectProviderContinuationCapability[];
}): boolean {
  return resolveAutocodeDirectProviderContinuationCapability(input) !== null;
}

export function resolveAutocodeDirectProviderFallbackCapability(input: {
  provider: unknown;
  modelId: string;
  transport?: unknown;
  capabilities?: readonly AutocodeDirectProviderFallbackCapability[];
}): AutocodeDirectProviderFallbackCapability | null {
  return [
    ...(input.capabilities ?? []),
    ...AUTOCODE_DIRECT_PROVIDER_FALLBACK_CAPABILITIES,
  ].find((capability) => capability.supports(input)) ?? null;
}

export function supportsAutocodeDirectProviderFallback(input: {
  provider: unknown;
  modelId: string;
  transport?: unknown;
  capabilities?: readonly AutocodeDirectProviderFallbackCapability[];
}): boolean {
  return resolveAutocodeDirectProviderFallbackCapability(input) !== null;
}

export function buildAutocodeDirectProviderContinuationRuntime(input: {
  capability: AutocodeDirectProviderContinuationCapability;
  providerResponseId?: string;
}): AutocodeDirectProviderContinuationRuntime {
  return {
    capabilityId: input.capability.id,
    mode: input.capability.mode,
    ...(input.providerResponseId ? { providerResponseId: input.providerResponseId } : {}),
    ...(input.capability.providerResponseIdFields
      ? { providerResponseIdFields: [...input.capability.providerResponseIdFields] }
      : {}),
    ...(input.capability.providerOptions
      ? { providerOptions: cloneAutocodeDirectProviderOptions(input.capability.providerOptions) }
      : {}),
    ...(input.capability.continuationProviderOptions
      ? { continuationProviderOptions: cloneAutocodeDirectProviderOptions(input.capability.continuationProviderOptions) }
      : {}),
  };
}

export function buildAutocodeDirectProviderFallbackRuntime(input: {
  capability: AutocodeDirectProviderFallbackCapability;
}): AutocodeDirectProviderFallbackRuntime {
  return {
    capabilityId: input.capability.id,
    fallbackInvocationMethod: input.capability.fallbackInvocationMethod,
    ...(input.capability.fallbackProviderTransport
      ? { fallbackProviderTransport: input.capability.fallbackProviderTransport }
      : {}),
    errorMatchers: input.capability.errorMatchers.map(copyFallbackErrorMatcher),
    resetProviderPersistence: input.capability.resetProviderPersistence,
  };
}

export function buildAutocodeDirectProviderFallbackInvocationRoute(
  runtime: Pick<AutocodeDirectProviderFallbackRuntime, 'fallbackInvocationMethod'>,
  provider: string,
): AutocodeProviderModelInvocationRouteConfig {
  return {
    provider,
    method: runtime.fallbackInvocationMethod,
  };
}

export function resolveAutocodeDirectProviderFallbackTransport(
  runtime: Pick<AutocodeDirectProviderFallbackRuntime, 'fallbackInvocationMethod' | 'fallbackProviderTransport'>,
  provider: string,
): string {
  const template = runtime.fallbackProviderTransport?.trim();
  if (template) {
    return template
      .replace(/\$\{provider\}|\{provider\}/g, provider)
      .replace(/\$\{method\}|\{method\}/g, runtime.fallbackInvocationMethod);
  }
  return provider ? `${provider}.${runtime.fallbackInvocationMethod}` : runtime.fallbackInvocationMethod;
}

export function matchesAutocodeDirectProviderFallbackError(
  runtime: Pick<AutocodeDirectProviderFallbackRuntime, 'errorMatchers'> | null | undefined,
  message: unknown,
): boolean {
  const normalizedMessage = normalizeContinuationString(message);
  if (!runtime || !normalizedMessage) {
    return false;
  }
  return runtime.errorMatchers.some((matcher) =>
    matcher.messageIncludes.every((item) => normalizedMessage.includes(item.toLowerCase()))
  );
}

export function parseAutocodeDirectProviderContinuationCapabilities(
  value: unknown,
): AutocodeDirectProviderContinuationCapability[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map(parseAutocodeDirectProviderContinuationCapability)
    .filter((item): item is AutocodeDirectProviderContinuationCapability => item !== null);
}

export function parseAutocodeDirectProviderFallbackCapabilities(
  value: unknown,
): AutocodeDirectProviderFallbackCapability[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map(parseAutocodeDirectProviderFallbackCapability)
    .filter((item): item is AutocodeDirectProviderFallbackCapability => item !== null);
}

function parseAutocodeDirectProviderContinuationCapability(
  value: unknown,
): AutocodeDirectProviderContinuationCapability | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const mode = readString(record.mode) ?? 'provider';
  const condition = parseContinuationCondition(record.condition ?? record.when);
  if (!id || mode !== 'provider' || !condition) {
    return null;
  }

  const providerOptions = parseDirectProviderOptions(record.providerOptions ?? record.provider_options);
  const continuationProviderOptions = parseDirectProviderOptions(
    record.continuationProviderOptions ??
      record.continuation_provider_options ??
      record.previousProviderOptions ??
      record.previous_provider_options,
  );
  const providerResponseIdFields = readStringList(
    record.providerResponseIdFields ??
      record.provider_response_id_fields ??
      record.responseIdFields ??
      record.response_id_fields,
  );

  return {
    id,
    mode,
    ...(providerOptions ? { providerOptions } : {}),
    ...(continuationProviderOptions ? { continuationProviderOptions } : {}),
    ...(providerResponseIdFields ? { providerResponseIdFields } : {}),
    supports: ({ provider, modelId, transport }) => matchesContinuationCondition(condition, {
      provider: typeof provider === 'string' ? provider : '',
      modelId,
      transport: typeof transport === 'string' ? transport : '',
    }),
  };
}

function parseAutocodeDirectProviderFallbackCapability(
  value: unknown,
): AutocodeDirectProviderFallbackCapability | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const condition = parseContinuationCondition(record.condition ?? record.when);
  const fallbackInvocationMethod = readProviderModelInvocationMethod(
    record.fallbackInvocationMethod ??
      record.fallback_invocation_method ??
      record.invocationMethod ??
      record.invocation_method,
  );
  const errorMatchers = parseFallbackErrorMatchers(
    record.errorMatchers ?? record.error_matchers ?? record.errors,
  );
  if (!id || !condition || !fallbackInvocationMethod || !errorMatchers) {
    return null;
  }

  const fallbackProviderTransport = readString(record.fallbackProviderTransport ?? record.fallback_provider_transport);
  const resetProviderPersistence = readBoolean(record.resetProviderPersistence ?? record.reset_provider_persistence) ?? true;

  return {
    id,
    fallbackInvocationMethod,
    ...(fallbackProviderTransport ? { fallbackProviderTransport } : {}),
    errorMatchers,
    resetProviderPersistence,
    supports: ({ provider, modelId, transport }) => matchesContinuationCondition(condition, {
      provider: typeof provider === 'string' ? provider : '',
      modelId,
      transport: typeof transport === 'string' ? transport : '',
    }),
  };
}

interface ContinuationCondition {
  provider?: string[];
  providerPrefix?: string[];
  providerIncludes?: string[];
  modelId?: string[];
  modelIdPrefix?: string[];
  modelIdIncludes?: string[];
  transport?: string[];
  transportPrefix?: string[];
  transportIncludes?: string[];
}

function parseContinuationCondition(value: unknown): ContinuationCondition | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const condition: ContinuationCondition = {};
  const provider = readStringList(record.provider);
  if (provider) {
    condition.provider = provider;
  }
  const providerPrefix = readStringList(record.providerPrefix ?? record.provider_prefix);
  if (providerPrefix) {
    condition.providerPrefix = providerPrefix;
  }
  const providerIncludes = readStringList(record.providerIncludes ?? record.provider_includes);
  if (providerIncludes) {
    condition.providerIncludes = providerIncludes;
  }
  const modelId = readStringList(record.modelId ?? record.model_id);
  if (modelId) {
    condition.modelId = modelId;
  }
  const modelIdPrefix = readStringList(record.modelIdPrefix ?? record.model_id_prefix);
  if (modelIdPrefix) {
    condition.modelIdPrefix = modelIdPrefix;
  }
  const modelIdIncludes = readStringList(record.modelIdIncludes ?? record.model_id_includes);
  if (modelIdIncludes) {
    condition.modelIdIncludes = modelIdIncludes;
  }
  const transport = readStringList(record.transport ?? record.providerTransport ?? record.provider_transport);
  if (transport) {
    condition.transport = transport;
  }
  const transportPrefix = readStringList(
    record.transportPrefix ??
      record.transport_prefix ??
      record.providerTransportPrefix ??
      record.provider_transport_prefix,
  );
  if (transportPrefix) {
    condition.transportPrefix = transportPrefix;
  }
  const transportIncludes = readStringList(
    record.transportIncludes ??
      record.transport_includes ??
      record.providerTransportIncludes ??
      record.provider_transport_includes,
  );
  if (transportIncludes) {
    condition.transportIncludes = transportIncludes;
  }

  return Object.keys(condition).length > 0 ? condition : null;
}

function matchesContinuationCondition(
  condition: ContinuationCondition,
  input: { provider: string; modelId: string; transport?: string },
): boolean {
  const provider = input.provider.toLowerCase();
  const modelId = input.modelId.toLowerCase();
  if (condition.provider && !condition.provider.some((item) => item.toLowerCase() === provider)) {
    return false;
  }
  if (condition.providerPrefix && !condition.providerPrefix.some((item) => provider.startsWith(item.toLowerCase()))) {
    return false;
  }
  if (condition.providerIncludes && !condition.providerIncludes.some((item) => provider.includes(item.toLowerCase()))) {
    return false;
  }
  if (condition.modelId && !condition.modelId.some((item) => item.toLowerCase() === modelId)) {
    return false;
  }
  if (condition.modelIdPrefix && !condition.modelIdPrefix.some((item) => modelId.startsWith(item.toLowerCase()))) {
    return false;
  }
  if (condition.modelIdIncludes && !condition.modelIdIncludes.some((item) => modelId.includes(item.toLowerCase()))) {
    return false;
  }
  const transportCandidates = getContinuationTransportCandidates(input);
  if (condition.transport && !matchesAnyContinuationValue(transportCandidates, condition.transport, 'exact')) {
    return false;
  }
  if (condition.transportPrefix && !matchesAnyContinuationValue(transportCandidates, condition.transportPrefix, 'prefix')) {
    return false;
  }
  if (condition.transportIncludes && !matchesAnyContinuationValue(transportCandidates, condition.transportIncludes, 'includes')) {
    return false;
  }
  return true;
}

function getContinuationTransportCandidates(input: { provider: string; transport?: string }): string[] {
  const candidates = new Set<string>();
  const explicitTransport = normalizeContinuationString(input.transport);
  for (const value of [explicitTransport, input.provider]) {
    const normalized = normalizeContinuationString(value);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function matchesAnyContinuationValue(
  values: readonly string[],
  matches: readonly string[],
  mode: 'exact' | 'prefix' | 'includes',
): boolean {
  return values.some((value) =>
    matches.some((match) => {
      const normalizedMatch = normalizeContinuationString(match);
      if (!normalizedMatch) {
        return false;
      }
      if (mode === 'prefix') {
        return value.startsWith(normalizedMatch);
      }
      if (mode === 'includes') {
        return value.includes(normalizedMatch);
      }
      return value === normalizedMatch;
    })
  );
}

function normalizeContinuationString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function parseDirectProviderOptions(value: unknown): AutocodeDirectProviderOptions | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const options: AutocodeDirectProviderOptions = {};
  for (const [providerName, providerValue] of Object.entries(record)) {
    const providerOptions = asRecord(providerValue);
    if (!providerName.trim() || !providerOptions) {
      continue;
    }
    const normalizedProviderOptions = normalizeProviderOptionRecord(providerOptions);
    if (normalizedProviderOptions) {
      options[providerName.trim()] = normalizedProviderOptions;
    }
  }
  return Object.keys(options).length > 0 ? options : null;
}

function normalizeProviderOptionRecord(
  record: Record<string, unknown>,
): Record<string, AutocodeDirectProviderOptionValue> | null {
  const normalized: Record<string, AutocodeDirectProviderOptionValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.trim()) {
      continue;
    }
    const optionValue = normalizeProviderOptionValue(value);
    if (optionValue !== undefined) {
      normalized[key.trim()] = optionValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeProviderOptionValue(value: unknown): AutocodeDirectProviderOptionValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeProviderOptionValue)
      .filter((item): item is AutocodeDirectProviderOptionValue => item !== undefined);
  }
  const record = asRecord(value);
  if (record) {
    return normalizeProviderOptionRecord(record) ?? {};
  }
  return undefined;
}

function parseFallbackErrorMatchers(value: unknown): AutocodeDirectProviderFallbackErrorMatcher[] | null {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const matchers = items
    .map(parseFallbackErrorMatcher)
    .filter((item): item is AutocodeDirectProviderFallbackErrorMatcher => item !== null);
  return items.length > 0 && matchers.length > 0 ? matchers : null;
}

function parseFallbackErrorMatcher(value: unknown): AutocodeDirectProviderFallbackErrorMatcher | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const messageIncludes = readStringList(record.messageIncludes ?? record.message_includes);
  return messageIncludes ? { messageIncludes } : null;
}

function readProviderModelInvocationMethod(value: unknown): ProviderModelInvocationMethod | undefined {
  const normalized = normalizeContinuationString(value);
  if (
    normalized === 'call' ||
    normalized === 'chat' ||
    normalized === 'responses' ||
    normalized === 'chatmodel'
  ) {
    return normalized === 'chatmodel' ? 'chatModel' : normalized;
  }
  return undefined;
}

function cloneAutocodeDirectProviderOptions(
  options: AutocodeDirectProviderOptions,
): AutocodeDirectProviderOptions {
  return JSON.parse(JSON.stringify(options)) as AutocodeDirectProviderOptions;
}

function copyFallbackErrorMatcher(
  matcher: AutocodeDirectProviderFallbackErrorMatcher,
): AutocodeDirectProviderFallbackErrorMatcher {
  return {
    messageIncludes: [...matcher.messageIncludes],
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  const single = readString(value);
  if (single) {
    return [single];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map(readString)
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}