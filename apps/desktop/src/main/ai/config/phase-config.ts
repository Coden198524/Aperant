/**
 * Phase Configuration Module
 *
 * Desktop adapter for phase model and thinking-level resolution. File-system
 * metadata loading remains here; pure resolution strategy lives in core.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskWorkflowMode } from '../../../shared/types';

import {
  AUTOCODE_SPEC_PHASE_THINKING_LEVELS,
  getAutocodeModelBetas,
  getAutocodeSpecPhaseThinkingBudget,
  getAutocodeThinkingBudget,
  getAutocodeThinkingKwargsForModel,
  isAutocodeAdaptiveModel,
  resolveAutocodePhaseConfig,
  resolveAutocodePhaseModel,
  resolveAutocodePhaseModelBetas,
  resolveAutocodePhaseModelId,
  resolveAutocodePhaseThinking,
  sanitizeThinkingLevel,
  type AutocodeTaskPhaseMetadataConfig,
  type AutocodeThinkingKwargs,
  type Phase,
  type ThinkingLevel,
} from '@autocode/core';

export const SPEC_PHASE_THINKING_LEVELS: Record<string, ThinkingLevel> =
  AUTOCODE_SPEC_PHASE_THINKING_LEVELS;

export { sanitizeThinkingLevel };

const readAutocodeEnv = (name: string): string | undefined => process.env[name];

export function resolveModelId(model: string): string {
  return resolveAutocodePhaseModelId(model, readAutocodeEnv);
}

export function getModelBetas(modelShort: string): string[] {
  return getAutocodeModelBetas(modelShort);
}

export function getThinkingBudget(thinkingLevel: string): number {
  return getAutocodeThinkingBudget(thinkingLevel);
}

/** Structure of model-related fields in task_metadata.json */
export interface TaskMetadataConfig
  extends Omit<AutocodeTaskPhaseMetadataConfig, 'workflowMode'> {
  workflowMode?: TaskWorkflowMode;
}

/**
 * Load task_metadata.json from the spec directory.
 * Returns null if not found or invalid.
 */
export async function loadTaskMetadata(
  specDir: string,
): Promise<TaskMetadataConfig | null> {
  const metadataPath = join(specDir, 'task_metadata.json');
  try {
    const raw = await readFile(metadataPath, 'utf-8');
    return JSON.parse(raw) as TaskMetadataConfig;
  } catch {
    return null;
  }
}

export async function getPhaseModel(
  specDir: string,
  phase: Phase,
  cliModel?: string | null,
): Promise<string> {
  const metadata = await loadTaskMetadata(specDir);
  return resolveAutocodePhaseModel({
    metadata,
    phase,
    cliModel,
    env: readAutocodeEnv,
  });
}

export async function getPhaseThinking(
  specDir: string,
  phase: Phase,
  cliThinking?: string | null,
): Promise<string> {
  const metadata = await loadTaskMetadata(specDir);
  return resolveAutocodePhaseThinking({
    metadata,
    phase,
    cliThinking,
  });
}

export function isAdaptiveModel(modelId: string): boolean {
  return isAutocodeAdaptiveModel(modelId);
}

/** Thinking kwargs returned for model configuration */
export type ThinkingKwargs = AutocodeThinkingKwargs;

export function getThinkingKwargsForModel(
  modelId: string,
  thinkingLevel: string,
): ThinkingKwargs {
  return getAutocodeThinkingKwargsForModel(modelId, thinkingLevel);
}

export async function getPhaseConfig(
  specDir: string,
  phase: Phase,
  cliModel?: string | null,
  cliThinking?: string | null,
): Promise<[string, string, number]> {
  const metadata = await loadTaskMetadata(specDir);
  return resolveAutocodePhaseConfig({
    metadata,
    phase,
    cliModel,
    cliThinking,
    env: readAutocodeEnv,
  });
}

export async function getPhaseClientThinkingKwargs(
  specDir: string,
  phase: Phase,
  phaseModel: string,
  cliThinking?: string | null,
): Promise<ThinkingKwargs> {
  const thinkingLevel = await getPhaseThinking(specDir, phase, cliThinking);
  return getThinkingKwargsForModel(phaseModel, thinkingLevel);
}

export function getSpecPhaseThinkingBudget(phaseName: string): number {
  return getAutocodeSpecPhaseThinkingBudget(phaseName);
}

export async function getFastMode(specDir: string): Promise<boolean> {
  const metadata = await loadTaskMetadata(specDir);
  return metadata?.fastMode === true;
}

export async function getPhaseModelBetas(
  specDir: string,
  phase: Phase,
  cliModel?: string | null,
): Promise<string[]> {
  const metadata = await loadTaskMetadata(specDir);
  return resolveAutocodePhaseModelBetas({
    metadata,
    phase,
    cliModel,
  });
}
