/**
 * update_qa_status Tool
 * =====================
 *
 * Updates the QA sign-off status in implementation_plan.md.
 * See apps/desktop/src/main/ai/tools/autocode/update-qa-status.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__update_qa_status
 *
 * IMPORTANT: Do NOT write plan["status"] or plan["planStatus"] here.
 * The frontend XState task state machine owns status transitions.
 * Writing status here races with XState and can clobber reviewReason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';
import {
  AUTOCODE_TASK_ARTIFACTS,
  applyAutocodePlanQaSignoff,
} from '@autocode/core';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import { safeParseJson } from '../../../utils/json-repair';
import {
  updateImplementationPlanInFiles,
} from '../../schema/plan-shards';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  status: z
    .enum(['pending', 'in_review', 'approved', 'rejected', 'fixes_applied'])
    .describe('QA status to set'),
  issues: z
    .string()
    .optional()
    .describe('JSON array of issues found, or plain text description. Use [] for no issues.'),
  tests_passed: z
    .string()
    .optional()
    .describe('JSON object of test results (e.g., {"unit": "pass", "e2e": "pass"})'),
});

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface QAIssue {
  description?: string;
  [key: string]: unknown;
}

interface ImplementationPlan {
  last_updated?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const updateQaStatusTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__update_qa_status',
    description:
      'Update the QA sign-off status in implementation_plan.md. Use this after completing a QA review to record the outcome.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
    writePathInputKeys: [],
  },
  inputSchema,
  execute: async (input, context) => {
    const { status, issues: issuesStr, tests_passed: testsStr } = input;
    const planFile = path.join(context.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);

    if (!fs.existsSync(planFile)) {
      return 'Error: implementation_plan.md not found';
    }

    // Parse issues
    let issues: QAIssue[] = [];
    if (issuesStr) {
      const parsed = safeParseJson<QAIssue[]>(issuesStr);
      if (parsed !== null && Array.isArray(parsed)) {
        issues = parsed;
      } else {
        issues = [{ description: issuesStr }];
      }
    }

    // Parse tests_passed
    let testsPassed: Record<string, unknown> = {};
    if (testsStr) {
      const parsed = safeParseJson<Record<string, unknown>>(testsStr);
      if (parsed !== null) {
        testsPassed = parsed;
      }
    }

    let qaSession = 0;
    const plan = await updateImplementationPlanInFiles(context.specDir, (currentPlan) => {
      qaSession = applyAutocodePlanQaSignoff(currentPlan as ImplementationPlan, {
        status,
        issues,
        testsPassed,
      });
      return currentPlan;
    }) as ImplementationPlan | null;
    if (!plan) {
      return 'Error: implementation_plan.md could not be parsed';
    }

    return `Updated QA status to '${status}' (session ${qaSession})`;
  },
});
