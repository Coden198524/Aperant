import {
  ALL_AVAILABLE_MODELS,
  AVAILABLE_MODELS,
  resolveModelEquivalent,
  type ModelCatalogProvider,
} from '../config/model-catalog.js';

export function getAutocodeProviderModelLabel(
  modelShorthand: string,
  provider: ModelCatalogProvider,
  userOverrides?: Record<string, Partial<Record<ModelCatalogProvider, unknown>>>
): string {
  const spec = resolveModelEquivalent(modelShorthand, provider, userOverrides as Parameters<typeof resolveModelEquivalent>[2]);
  if (spec) {
    const byModelId = ALL_AVAILABLE_MODELS.find(
      (model) => model.provider === provider && (model.value === spec.modelId || model.value === modelShorthand)
    );
    if (byModelId) {
      return byModelId.label;
    }

    const byValue = ALL_AVAILABLE_MODELS.find((model) => model.value === spec.modelId);
    if (byValue) {
      return byValue.label;
    }
  }

  const direct = ALL_AVAILABLE_MODELS.find((model) => model.value === modelShorthand && model.provider === provider);
  if (direct) {
    return direct.label;
  }

  const defaultLabel = AVAILABLE_MODELS.find((model) => model.value === modelShorthand);
  if (defaultLabel) {
    return defaultLabel.label;
  }

  return modelShorthand;
}
