import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_ID_MAP,
  type ModelShorthand,
  type Phase,
} from '../config/types.js';
import {
  detectProviderFromModel,
  parseAutocodeModelProviderRoutes,
  type AutocodeModelProviderRoute,
  type AutocodeModelProviderRouteConfig,
  type AutocodeProviderModelInvocationRouteConfig,
} from '../providers/routing.js';
import type { AutocodeCliRuntimeRoute } from '../tasks/cli-catalog.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import type { AutocodeTaskDevelopmentMode, AutocodeTaskWorkflowMode } from '../tasks/spec-store.js';
import type {
  AutocodeDirectProviderContinuationCapabilityConfig,
  AutocodeDirectProviderFallbackCapabilityConfig,
} from './direct-provider-capabilities.js';
import {
  resolveAutocodeTaskRuntimeConcurrency,
  type AutocodeTaskRuntimeConcurrencyMetadata,
  type AutocodeTaskRuntimeConcurrencyResolved,
} from './concurrency.js';

export type AutocodeRuntimePhase = Phase;

export interface AutocodeTaskRuntimeMetadataConfig {
  isAutoProfile?: boolean;
  phaseModels?: Partial<Record<AutocodeRuntimePhase, string>>;
  phaseProviders?: Partial<Record<AutocodeRuntimePhase, string>>;
  model?: string;
  provider?: string;
  developmentMode?: AutocodeTaskDevelopmentMode | string;
  workflowMode?: AutocodeTaskWorkflowMode | string;
  sourceType?: string;
  upstreamSpecSystem?: string;
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyMetadata;
  cliRuntimeRoutes?: AutocodeCliRuntimeRoute | AutocodeCliRuntimeRoute[];
  autocodeCliRuntimeRoutes?: AutocodeCliRuntimeRoute | AutocodeCliRuntimeRoute[];
  directProviderContinuationCapabilities?: AutocodeDirectProviderContinuationCapabilityConfig | AutocodeDirectProviderContinuationCapabilityConfig[];
  autocodeDirectProviderContinuationCapabilities?: AutocodeDirectProviderContinuationCapabilityConfig | AutocodeDirectProviderContinuationCapabilityConfig[];
  directProviderFallbackCapabilities?: AutocodeDirectProviderFallbackCapabilityConfig | AutocodeDirectProviderFallbackCapabilityConfig[];
  autocodeDirectProviderFallbackCapabilities?: AutocodeDirectProviderFallbackCapabilityConfig | AutocodeDirectProviderFallbackCapabilityConfig[];
  modelProviderRoutes?: AutocodeModelProviderRouteConfig | AutocodeModelProviderRouteConfig[];
  providerModelInvocationRoutes?: AutocodeProviderModelInvocationRouteConfig | AutocodeProviderModelInvocationRouteConfig[];
}

export interface AutocodeProviderModelEquivalent {
  modelId: string;
}

export interface ResolveAutocodeTaskPhaseModelInput {
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined;
  phase: AutocodeRuntimePhase;
  defaultModel?: string;
  resolveModelId?: (model: string) => string;
  inferPinnedProvider?: (model: string | undefined) => string | null;
  resolveModelEquivalent?: (
    modelValue: string,
    targetProvider: string,
  ) => AutocodeProviderModelEquivalent | null | undefined;
  providerPhaseModelResolver?: (
    targetProvider: string,
  ) => Partial<Record<AutocodeRuntimePhase, string>> | null | undefined;
  modelProviderRoutes?: readonly AutocodeModelProviderRoute[];
}

export interface ResolveAutocodeTaskPhaseProviderOptions {
  inferPinnedProvider?: (model: string | undefined) => string | null;
  modelProviderRoutes?: readonly AutocodeModelProviderRoute[];
}

export interface ResolveAutocodeCrossProviderModelRequestOptions {
  resolveModelId?: (model: string) => string;
}

const DEFAULT_TASK_PHASE_MODEL = 'sonnet';
const ANTHROPIC_PROVIDER = 'anthropic';
const CROSS_PROVIDER_MODEL_SHORTHANDS = new Set(['haiku', 'sonnet', 'opus', 'opus-1m']);

export function loadAutocodeTaskRuntimeMetadataConfig(
  specDir: string,
): AutocodeTaskRuntimeMetadataConfig | null {
  try {
    const metadataPath = join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata);
    if (!existsSync(metadataPath)) {
      return null;
    }
    return JSON.parse(readFileSync(metadataPath, 'utf-8')) as AutocodeTaskRuntimeMetadataConfig;
  } catch {
    return null;
  }
}

export function resolveAutocodeTaskPhaseModelId(
  input: ResolveAutocodeTaskPhaseModelInput,
): string {
  const metadata = input.metadata ?? null;
  const resolveModelId = input.resolveModelId ?? resolveAutocodeModelId;
  const modelProviderRoutes = input.modelProviderRoutes ?? parseAutocodeModelProviderRoutes(metadata?.modelProviderRoutes);
  const inferPinnedProvider = input.inferPinnedProvider ?? ((model) => inferAutocodePinnedProviderFromModel(model, modelProviderRoutes));
  let shorthand = getAutocodeTaskPhaseModel(metadata, input.phase);
  const targetProvider = metadata?.phaseProviders?.[input.phase] ?? inferPinnedProvider(shorthand);

  if (!shorthand && targetProvider) {
    shorthand = input.providerPhaseModelResolver?.(targetProvider)?.[input.phase];
  }

  if (shorthand) {
    const baseModelId = resolveModelId(shorthand);

    if (targetProvider && targetProvider !== ANTHROPIC_PROVIDER) {
      const equivalent = input.resolveModelEquivalent?.(shorthand, targetProvider)
        ?? input.resolveModelEquivalent?.(baseModelId, targetProvider);
      return equivalent?.modelId ?? shorthand;
    }

    if (targetProvider === ANTHROPIC_PROVIDER) {
      return baseModelId;
    }

    return shorthand;
  }

  if (targetProvider && targetProvider !== ANTHROPIC_PROVIDER) {
    const equivalent = input.resolveModelEquivalent?.(DEFAULT_TASK_PHASE_MODEL, targetProvider);
    if (equivalent) {
      return equivalent.modelId;
    }
  }

  return input.defaultModel ?? DEFAULT_TASK_PHASE_MODEL;
}

export function resolveAutocodeTaskPhaseProvider(
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined,
  phase: AutocodeRuntimePhase,
  options: ResolveAutocodeTaskPhaseProviderOptions = {},
): string | null {
  const explicitProvider = metadata?.phaseProviders?.[phase];
  if (explicitProvider) {
    return explicitProvider;
  }

  const model = getAutocodeTaskPhaseModel(metadata, phase);
  return options.inferPinnedProvider
    ? options.inferPinnedProvider(model)
    : inferAutocodePinnedProviderFromModel(model, options.modelProviderRoutes ?? parseAutocodeModelProviderRoutes(metadata?.modelProviderRoutes));
}

export function resolveAutocodeTaskWorkflowMode(
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined,
  defaultWorkflowMode: AutocodeTaskWorkflowMode = 'balanced',
): AutocodeTaskWorkflowMode {
  const workflowMode = metadata?.workflowMode;
  return isAutocodeTaskWorkflowMode(workflowMode) ? workflowMode : defaultWorkflowMode;
}

export { resolveAutocodeTaskRuntimeConcurrency };
export type { AutocodeTaskRuntimeConcurrencyMetadata, AutocodeTaskRuntimeConcurrencyResolved };

export function inferAutocodePinnedProviderFromModel(
  model: string | undefined,
  routes: readonly AutocodeModelProviderRoute[] = [],
): string | null {
  if (!model) {
    return null;
  }

  const explicitRouteProvider = routes.find((route) => route.supports(model))?.provider;
  if (explicitRouteProvider) {
    return explicitRouteProvider;
  }

  if (CROSS_PROVIDER_MODEL_SHORTHANDS.has(model)) {
    return null;
  }

  const directProvider = inferAutocodeProviderFromModelValue(model, routes);
  if (directProvider) {
    return directProvider;
  }

  const resolvedModel = resolveAutocodeModelId(model);
  return resolvedModel === model ? null : inferAutocodeProviderFromModelValue(resolvedModel, routes) ?? null;
}

export function inferAutocodeProviderFromModelValue(
  modelValue: string,
  routes: readonly AutocodeModelProviderRoute[] = [],
): string | undefined {
  const directProvider = detectProviderFromModel(modelValue, routes);
  if (directProvider) {
    return directProvider;
  }
  if (modelValue in MODEL_ID_MAP) {
    return inferAutocodeProviderFromModelValue(MODEL_ID_MAP[modelValue as ModelShorthand], routes);
  }
  return undefined;
}

export function resolveAutocodeCrossProviderModelRequest(
  model: string,
  options: ResolveAutocodeCrossProviderModelRequestOptions = {},
): string {
  const resolveModelId = options.resolveModelId ?? resolveAutocodeModelId;
  if (!model) {
    return model;
  }
  if (model === resolveModelId('haiku')) {
    return 'haiku';
  }
  if (model === resolveModelId('sonnet')) {
    return 'sonnet';
  }
  if (model === resolveModelId('opus')) {
    return 'opus';
  }
  if (model.startsWith('claude-haiku-')) {
    return 'haiku';
  }
  if (model.startsWith('claude-sonnet-')) {
    return 'sonnet';
  }
  if (model.startsWith('claude-opus-')) {
    return 'opus';
  }
  return model;
}

export function resolveAutocodeModelId(model: string): string {
  return model in MODEL_ID_MAP ? MODEL_ID_MAP[model as ModelShorthand] : model;
}

function getAutocodeTaskPhaseModel(
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined,
  phase: AutocodeRuntimePhase,
): string | undefined {
  return metadata?.phaseModels?.[phase] || metadata?.model || undefined;
}

function isAutocodeTaskWorkflowMode(value: unknown): value is AutocodeTaskWorkflowMode {
  return value === 'off' ||
    value === 'conservative' ||
    value === 'balanced' ||
    value === 'aggressive';
}
