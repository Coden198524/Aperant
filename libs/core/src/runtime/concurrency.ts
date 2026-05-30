import type { AutocodeTaskDevelopmentMode, AutocodeTaskWorkflowMode } from '../tasks/spec-store.js';

export type AutocodeTaskRuntimeConcurrencyMode = 'serial' | 'concurrent';
export type AutocodeTaskRuntimeConcurrencyUnit = 'work_item';
export type AutocodeTaskRuntimeConflictPolicy = 'lock-and-queue';

export interface AutocodeTaskRuntimeConcurrencyMetadata {
  mode?: AutocodeTaskRuntimeConcurrencyMode;
  workers?: number;
  unit?: AutocodeTaskRuntimeConcurrencyUnit;
  conflictPolicy?: AutocodeTaskRuntimeConflictPolicy;
}

export interface AutocodeTaskRuntimeConcurrencyResolved {
  mode: AutocodeTaskRuntimeConcurrencyMode;
  workers: number;
  unit: AutocodeTaskRuntimeConcurrencyUnit;
  conflictPolicy: AutocodeTaskRuntimeConflictPolicy;
}

export interface ResolveAutocodeTaskRuntimeConcurrencyInput {
  developmentMode?: AutocodeTaskDevelopmentMode | string;
  workflowMode?: AutocodeTaskWorkflowMode | string;
  sourceType?: string;
  upstreamSpecSystem?: string;
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyMetadata;
}

const MIN_WORKERS = 1;
const MAX_WORKERS = 8;

export function resolveAutocodeTaskRuntimeConcurrency(
  metadata: ResolveAutocodeTaskRuntimeConcurrencyInput | null | undefined,
): AutocodeTaskRuntimeConcurrencyResolved {
  const defaultWorkers = getDefaultRuntimeWorkers(metadata);
  const requested = metadata?.runtimeConcurrency;
  const workers = clampWorkers(requested?.workers ?? defaultWorkers);
  const mode = requested?.mode ?? (workers > 1 ? 'concurrent' : 'serial');

  return {
    mode: mode === 'concurrent' && workers > 1 ? 'concurrent' : 'serial',
    workers: mode === 'concurrent' ? workers : 1,
    unit: 'work_item',
    conflictPolicy: 'lock-and-queue',
  };
}

export function buildAutocodeTaskRuntimeConcurrencyMetadata(
  metadata: ResolveAutocodeTaskRuntimeConcurrencyInput | null | undefined,
): AutocodeTaskRuntimeConcurrencyResolved {
  return resolveAutocodeTaskRuntimeConcurrency(metadata);
}

function getDefaultRuntimeWorkers(
  metadata: ResolveAutocodeTaskRuntimeConcurrencyInput | null | undefined,
): number {
  if (metadata?.developmentMode === 'fast' || metadata?.workflowMode === 'off') {
    return 1;
  }
  if (
    metadata?.developmentMode === 'spec' ||
    metadata?.sourceType === 'openspec' ||
    metadata?.upstreamSpecSystem === 'openspec'
  ) {
    return 3;
  }
  return 2;
}

function clampWorkers(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : MIN_WORKERS;
  if (!Number.isFinite(number)) {
    return MIN_WORKERS;
  }
  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.floor(number)));
}
