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
  if (isDirectRuntimeMode(metadata)) {
    return {
      mode: 'serial',
      workers: 1,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    };
  }

  const defaultWorkers = getDefaultRuntimeWorkers(metadata);
  const requested = metadata?.runtimeConcurrency;
  const requestedWorkers = requested?.workers === undefined ? undefined : clampWorkers(requested.workers);
  const shouldUseDefaultConcurrency = shouldUseDefaultRuntimeConcurrency(requested, requestedWorkers, defaultWorkers);
  const workers = shouldUseDefaultConcurrency ? defaultWorkers : clampWorkers(requestedWorkers ?? defaultWorkers);
  const mode = shouldUseDefaultConcurrency
    ? (workers > 1 ? 'concurrent' : 'serial')
    : requested?.mode ?? (workers > 1 ? 'concurrent' : 'serial');

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
  if (isDirectRuntimeMode(metadata)) {
    return 1;
  }
  if (
    metadata?.developmentMode === 'spec' ||
    metadata?.sourceType === 'openspec' ||
    metadata?.upstreamSpecSystem === 'openspec'
  ) {
    return 5;
  }
  return 2;
}

function isDirectRuntimeMode(
  metadata: ResolveAutocodeTaskRuntimeConcurrencyInput | null | undefined,
): boolean {
  return metadata?.developmentMode === 'direct' || metadata?.developmentMode === 'fast' || metadata?.workflowMode === 'off';
}

function shouldUseDefaultRuntimeConcurrency(
  requested: AutocodeTaskRuntimeConcurrencyMetadata | undefined,
  requestedWorkers: number | undefined,
  defaultWorkers: number,
): boolean {
  if (!requested || defaultWorkers <= 1) {
    return false;
  }

  const mode = requested.mode;
  const workers = requestedWorkers ?? defaultWorkers;
  return (
    (mode === 'serial' && (requestedWorkers === undefined || requestedWorkers <= 1)) ||
    (mode === undefined && requestedWorkers !== undefined && requestedWorkers <= 1) ||
    (mode === 'concurrent' && workers <= 1)
  );
}

function clampWorkers(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : MIN_WORKERS;
  if (!Number.isFinite(number)) {
    return MIN_WORKERS;
  }
  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.floor(number)));
}
