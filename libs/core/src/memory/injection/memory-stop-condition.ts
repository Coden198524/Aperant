/**
 * Memory-Aware Stop Condition
 *
 * Adjusts the agent step limit based on historical calibration data.
 * Prevents premature stopping for tasks that historically require more steps.
 */

import type { Memory, MemoryService } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';
import { normalizeMemoryModuleFilters } from './module-filters.js';

// ============================================================
// CONSTANTS
// ============================================================

const MAX_ABSOLUTE_STEPS = 2000;

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Build a stopWhen condition adjusted by calibration data.
 *
 * @param baseMaxSteps - The default max steps without calibration
 * @param calibrationFactor - Optional ratio from historical data (e.g. 1.4 = tasks need 40% more steps)
 */
export function calculateMemoryAwareMaxSteps(
  baseMaxSteps: number,
  calibrationFactor: number | undefined,
): number {
  const baseSteps = Number.isFinite(baseMaxSteps)
    ? Math.max(0, Math.floor(baseMaxSteps))
    : 0;
  const factor = normalizeCalibrationFactor(calibrationFactor) ?? 1.0;
  return Math.min(Math.ceil(baseSteps * factor), MAX_ABSOLUTE_STEPS);
}

/**
 * Fetch the calibration factor for a set of modules from stored task_calibration memories.
 * Returns undefined if no calibration data exists.
 *
 * @param memoryService - Memory service instance
 * @param modules - Module names relevant to the current task
 * @param projectId - Project identifier
 */
export async function getCalibrationFactor(
  memoryService: MemoryService,
  modules: string[],
  projectId: string,
): Promise<number | undefined> {
  try {
    const relatedModules = normalizeMemoryModuleFilters(modules);
    if (relatedModules.length === 0) {
      return undefined;
    }

    const calibrations = await memoryService.search({
      types: ['task_calibration'],
      relatedModules,
      limit: 5,
      projectId,
      sort: 'recency',
      promptContextOnly: true,
      recordAccess: false,
    });

    if (calibrations.length === 0) return undefined;

    const parsedCalibrations = calibrations
      .map(parseCalibrationMemory)
      .filter(isParsedCalibrationMemory);
    if (parsedCalibrations.length === 0) return undefined;

    await recordSelectedMemoryAccess(
      memoryService,
      parsedCalibrations.map((calibration) => calibration.memory),
    );

    return (
      parsedCalibrations.reduce(
        (sum, calibration) => sum + calibration.ratio,
        0,
      ) / parsedCalibrations.length
    );
  } catch {
    return undefined;
  }
}

interface ParsedCalibrationMemory {
  memory: Memory;
  ratio: number;
}

function parseCalibrationMemory(
  memory: Memory,
): ParsedCalibrationMemory | null {
  try {
    const data = JSON.parse(memory.content) as { ratio?: unknown };
    const ratio = normalizeCalibrationFactor(data.ratio);
    return ratio === undefined ? null : { memory, ratio };
  } catch {
    return null;
  }
}

function isParsedCalibrationMemory(
  value: ParsedCalibrationMemory | null,
): value is ParsedCalibrationMemory {
  return value !== null;
}

function normalizeCalibrationFactor(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(value, 2.0);
}
