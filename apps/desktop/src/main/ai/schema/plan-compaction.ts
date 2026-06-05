import { readFile } from 'node:fs/promises';

import {
  compactImplementationPlan,
  PLAN_COMPACTION_LIMITS,
  type PlanCompactionOptions,
  type PlanCompactionResult,
} from '@autocode/core/schema/plan-compaction';

import { writeFileAtomic } from '../../utils/atomic-file';
import { safeParseJson } from '../../utils/json-repair';

export {
  compactImplementationPlan,
  PLAN_COMPACTION_LIMITS,
  type PlanCompactionOptions,
  type PlanCompactionResult,
} from '@autocode/core/schema/plan-compaction';

export interface PlanFileCompactionResult extends PlanCompactionResult {
  valid: true;
}

export interface PlanFileCompactionSkipped {
  valid: false;
  reason: string;
}

export async function compactImplementationPlanFile(
  filePath: string,
  options?: PlanCompactionOptions,
): Promise<PlanFileCompactionResult | PlanFileCompactionSkipped> {
  let rawContent: string;
  try {
    rawContent = await readFile(filePath, 'utf-8');
  } catch {
    return { valid: false, reason: `File not found: ${filePath}` };
  }

  const parsed = safeParseJson<unknown>(rawContent);
  if (parsed === null) {
    return { valid: false, reason: 'Invalid JSON syntax that could not be compacted' };
  }

  const result = compactImplementationPlan(parsed, options);
  if (!result) {
    return { valid: false, reason: 'Plan does not match the implementation plan schema' };
  }

  if (result.changed) {
    await writeFileAtomic(filePath, JSON.stringify(result.plan, null, 2), {
      encoding: 'utf-8',
    });
  }

  return {
    valid: true,
    ...result,
  };
}
