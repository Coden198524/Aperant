import { stepCountIs } from 'ai';
import {
  calculateMemoryAwareMaxSteps,
  getCalibrationFactor,
} from '@autocode/core/memory/injection';

export { calculateMemoryAwareMaxSteps, getCalibrationFactor };

export function buildMemoryAwareStopCondition(
  baseMaxSteps: number,
  calibrationFactor: number | undefined,
) {
  return stepCountIs(calculateMemoryAwareMaxSteps(baseMaxSteps, calibrationFactor));
}
