import {
  ADAPTIVE_THINKING_MODELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  EFFORT_LEVEL_MAP,
  MODEL_BETAS_MAP,
  MODEL_ID_MAP,
  THINKING_BUDGET_MAP,
  type ModelShorthand,
  type Phase,
  type ThinkingLevel,
} from '../config/types.js';
import { sanitizeThinkingLevel } from '../providers/transforms.js';

export type AutocodeEnvLookup = (name: string) => string | undefined;

export interface AutocodeTaskPhaseMetadataConfig {
  isAutoProfile?: boolean;
  phaseModels?: Partial<Record<Phase, string>>;
  phaseThinking?: Partial<Record<Phase, string>>;
  model?: string;
  thinkingLevel?: string;
  workflowMode?: string;
  fastMode?: boolean;
  phaseProviders?: Partial<Record<Phase, string>>;
}

export interface AutocodeThinkingKwargs {
  maxThinkingTokens: number;
  effortLevel?: string;
}

export const AUTOCODE_SPEC_PHASE_THINKING_LEVELS: Record<string, ThinkingLevel> = {
  discovery: 'medium',
  spec_writing: 'medium',
  self_critique: 'medium',
  requirements: 'medium',
  research: 'medium',
  context: 'medium',
  requirement_model: 'xhigh',
  domain_model: 'xhigh',
  design: 'xhigh',
  design_model: 'xhigh',
  implementation_model: 'high',
  design_review: 'xhigh',
  planning: 'high',
  validation: 'medium',
  historical_context: 'medium',
  complexity_assessment: 'medium',
};

const AUTOCODE_PHASE_MODEL_ENV_VAR_MAP: Partial<Record<ModelShorthand, string>> = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'opus-1m': 'ANTHROPIC_DEFAULT_OPUS_MODEL',
};

export function getAutocodePhaseModelEnvVar(model: string): string | undefined {
  return AUTOCODE_PHASE_MODEL_ENV_VAR_MAP[model as ModelShorthand];
}

export function resolveAutocodePhaseModelId(
  model: string,
  env: AutocodeEnvLookup = () => undefined,
): string {
  if (model in MODEL_ID_MAP) {
    const shorthand = model as ModelShorthand;
    const envVar = getAutocodePhaseModelEnvVar(shorthand);
    const envValue = envVar ? env(envVar) : undefined;
    return envValue || MODEL_ID_MAP[shorthand];
  }
  return model;
}

export function getAutocodeModelBetas(modelShort: string): string[] {
  return MODEL_BETAS_MAP[modelShort as ModelShorthand] ?? [];
}

export function getAutocodeThinkingBudget(thinkingLevel: string): number {
  const level = sanitizeThinkingLevel(thinkingLevel);
  return THINKING_BUDGET_MAP[level];
}

export function isAutocodeAdaptiveModel(modelId: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(modelId);
}

export function getAutocodeThinkingKwargsForModel(
  modelId: string,
  thinkingLevel: string,
): AutocodeThinkingKwargs {
  const sanitizedLevel = sanitizeThinkingLevel(thinkingLevel);
  const kwargs: AutocodeThinkingKwargs = {
    maxThinkingTokens: getAutocodeThinkingBudget(sanitizedLevel),
  };

  if (isAutocodeAdaptiveModel(modelId)) {
    kwargs.effortLevel = EFFORT_LEVEL_MAP[sanitizedLevel] ?? 'medium';
  }

  return kwargs;
}

export function resolveAutocodePhaseModel(input: {
  metadata?: AutocodeTaskPhaseMetadataConfig | null;
  phase: Phase;
  cliModel?: string | null;
  env?: AutocodeEnvLookup;
}): string {
  if (input.cliModel) {
    return resolveAutocodePhaseModelId(input.cliModel, input.env);
  }

  const metadata = input.metadata ?? null;
  if (metadata) {
    if (metadata.isAutoProfile && metadata.phaseModels) {
      const model = metadata.phaseModels[input.phase] ?? DEFAULT_PHASE_MODELS[input.phase];
      return resolveAutocodePhaseModelId(model, input.env);
    }
    if (metadata.model) {
      return resolveAutocodePhaseModelId(metadata.model, input.env);
    }
  }

  return resolveAutocodePhaseModelId(DEFAULT_PHASE_MODELS[input.phase], input.env);
}

export function resolveAutocodePhaseThinking(input: {
  metadata?: AutocodeTaskPhaseMetadataConfig | null;
  phase: Phase;
  cliThinking?: string | null;
}): string {
  if (input.cliThinking) {
    return input.cliThinking;
  }

  const metadata = input.metadata ?? null;
  if (metadata) {
    if (metadata.isAutoProfile && metadata.phaseThinking) {
      return metadata.phaseThinking[input.phase] ?? DEFAULT_PHASE_THINKING[input.phase];
    }
    if (metadata.thinkingLevel) {
      return metadata.thinkingLevel;
    }
  }

  return DEFAULT_PHASE_THINKING[input.phase];
}

export function resolveAutocodePhaseConfig(input: {
  metadata?: AutocodeTaskPhaseMetadataConfig | null;
  phase: Phase;
  cliModel?: string | null;
  cliThinking?: string | null;
  env?: AutocodeEnvLookup;
}): [string, string, number] {
  const modelId = resolveAutocodePhaseModel(input);
  const thinkingLevel = resolveAutocodePhaseThinking(input);
  return [modelId, thinkingLevel, getAutocodeThinkingBudget(thinkingLevel)];
}

export function getAutocodeSpecPhaseThinkingBudget(phaseName: string): number {
  const thinkingLevel = AUTOCODE_SPEC_PHASE_THINKING_LEVELS[phaseName] ?? 'medium';
  return getAutocodeThinkingBudget(thinkingLevel);
}

export function resolveAutocodePhaseModelBetas(input: {
  metadata?: AutocodeTaskPhaseMetadataConfig | null;
  phase: Phase;
  cliModel?: string | null;
}): string[] {
  if (input.cliModel) {
    return getAutocodeModelBetas(input.cliModel);
  }

  const metadata = input.metadata ?? null;
  if (metadata) {
    if (metadata.isAutoProfile && metadata.phaseModels) {
      const modelShort = metadata.phaseModels[input.phase] ?? DEFAULT_PHASE_MODELS[input.phase];
      return getAutocodeModelBetas(modelShort);
    }
    if (metadata.model) {
      return getAutocodeModelBetas(metadata.model);
    }
  }

  return getAutocodeModelBetas(DEFAULT_PHASE_MODELS[input.phase]);
}
