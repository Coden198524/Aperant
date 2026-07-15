export type AutocodeTaskDevelopmentModeValue = 'direct' | 'standard';

export interface AutocodeTaskDevelopmentModeMetadataLike {
  developmentMode?: unknown;
  workflowMode?: unknown;
}

export function isAutocodeTaskDevelopmentModeValue(
  value: unknown,
): value is AutocodeTaskDevelopmentModeValue {
  return value === 'direct' || value === 'standard';
}

export function normalizeAutocodeTaskDevelopmentModeValue(
  value: unknown,
): AutocodeTaskDevelopmentModeValue | null {
  return isAutocodeTaskDevelopmentModeValue(value) ? value : null;
}

export function resolveAutocodeTaskDevelopmentModeValue(
  metadata: AutocodeTaskDevelopmentModeMetadataLike | null | undefined,
  defaultMode: AutocodeTaskDevelopmentModeValue = 'standard',
): AutocodeTaskDevelopmentModeValue {
  const explicitMode = normalizeAutocodeTaskDevelopmentModeValue(metadata?.developmentMode);
  if (explicitMode) {
    return explicitMode;
  }
  if (metadata?.workflowMode === 'off') {
    return 'direct';
  }
  return defaultMode;
}
