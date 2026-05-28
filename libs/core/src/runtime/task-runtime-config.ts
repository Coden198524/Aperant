import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_ID_MAP,
  type ModelShorthand,
  type Phase,
} from '../config/types.js';
import type { SupportedProvider } from '../providers/types.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import type { AutocodeTaskWorkflowMode } from '../tasks/spec-store.js';

export type AutocodeRuntimePhase = Phase;

export interface AutocodeTaskRuntimeMetadataConfig {
  isAutoProfile?: boolean;
  phaseModels?: Partial<Record<AutocodeRuntimePhase, string>>;
  phaseProviders?: Partial<Record<AutocodeRuntimePhase, string>>;
  model?: string;
  provider?: string;
  workflowMode?: AutocodeTaskWorkflowMode | string;
  enableBatchExecution?: boolean;
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
}

export interface ResolveAutocodeTaskPhaseProviderOptions {
  inferPinnedProvider?: (model: string | undefined) => string | null;
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
  const inferPinnedProvider = input.inferPinnedProvider ?? inferAutocodePinnedProviderFromModel;
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
  return (options.inferPinnedProvider ?? inferAutocodePinnedProviderFromModel)(model);
}

export function resolveAutocodeTaskWorkflowMode(
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined,
  defaultWorkflowMode: AutocodeTaskWorkflowMode = 'conservative',
): AutocodeTaskWorkflowMode {
  const workflowMode = metadata?.workflowMode;
  return isAutocodeTaskWorkflowMode(workflowMode) ? workflowMode : defaultWorkflowMode;
}

export function resolveAutocodeTaskEnableBatchExecution(
  metadata: AutocodeTaskRuntimeMetadataConfig | null | undefined,
): boolean {
  return metadata?.enableBatchExecution === true;
}

export function inferAutocodePinnedProviderFromModel(model: string | undefined): SupportedProvider | null {
  if (!model || CROSS_PROVIDER_MODEL_SHORTHANDS.has(model)) {
    return null;
  }

  const directProvider = inferAutocodeProviderFromModelValue(model);
  if (directProvider) {
    return directProvider;
  }

  const resolvedModel = resolveAutocodeModelId(model);
  return resolvedModel === model ? null : inferAutocodeProviderFromModelValue(resolvedModel) ?? null;
}

export function inferAutocodeProviderFromModelValue(modelValue: string): SupportedProvider | undefined {
  if (modelValue in MODEL_ID_MAP) {
    return inferAutocodeProviderFromModelValue(MODEL_ID_MAP[modelValue as ModelShorthand]);
  }
  if (modelValue.startsWith('claude-')) {
    return 'anthropic';
  }
  if (
    modelValue.startsWith('gpt-') ||
    modelValue === 'o3' ||
    modelValue.startsWith('o3-') ||
    modelValue === 'o4-mini' ||
    modelValue.startsWith('o4-') ||
    modelValue.includes('codex')
  ) {
    return 'openai';
  }
  if (modelValue.startsWith('gemini-')) {
    return 'google';
  }
  if (modelValue.startsWith('mistral-') || modelValue.startsWith('codestral-')) {
    return 'mistral';
  }
  if (modelValue.startsWith('grok-')) {
    return 'xai';
  }
  if (modelValue.startsWith('glm-')) {
    return 'zai';
  }
  if (modelValue.startsWith('deepseek-')) {
    return 'deepseek';
  }
  if (modelValue.startsWith('llama-') || modelValue.startsWith('meta-llama/')) {
    return 'groq';
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
