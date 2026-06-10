/**
 * Memory-Aware Stop Condition
 *
 * Adjusts the agent step limit based on historical calibration data.
 * Prevents premature stopping for tasks that historically require more steps.
 */

import type { MemoryService } from '../types.js';

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
  const factor = Math.min(calibrationFactor ?? 1.0, 2.0); // Cap at 2x
  return Math.min(Math.ceil(baseMaxSteps * factor), MAX_ABSOLUTE_STEPS);
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
    const calibrations = await memoryService.search({
      types: ['task_calibration'],
      relatedModules: modules,
      limit: 5,
      projectId,
      sort: 'recency',
    });

    if (calibrations.length === 0) return undefined;

    const ratios = calibrations.map((m) => {
      try {
        const data = JSON.parse(m.content) as { ratio?: number };
        return typeof data.ratio === 'number' ? data.ratio : 1.0;
      } catch {
        return 1.0;
      }
    });

    return ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  } catch {
    return undefined;
  }
}
