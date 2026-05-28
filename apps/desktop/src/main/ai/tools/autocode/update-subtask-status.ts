/**
 * update_subtask_status Tool
 * ==========================
 *
 * Updates the status of a subtask in implementation_plan.md.
 * See apps/desktop/src/main/ai/tools/autocode/update-subtask-status.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__update_subtask_status
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';
import {
  AUTOCODE_TASK_ARTIFACTS,
  updateAutocodePlanSubtask,
  type MutableAutocodePlan,
} from '@autocode/core';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import {
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
} from '../../schema/plan-shards';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  subtask_id: z.string().describe('ID of the subtask to update'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'failed'])
    .describe('New status for the subtask'),
  notes: z.string().optional().describe('Optional notes about the completion or failure'),
  completion_summary: z
    .string()
    .optional()
    .describe('Human-reviewable structured completion summary. Use a Markdown review matrix with rows: What changed, Verification, Review notes.'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const updateSubtaskStatusTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__update_subtask_status',
    description:
      'Update the status of a subtask in implementation_plan.md. Use this when completing or starting a subtask.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    const { subtask_id, status, notes, completion_summary } = input;
    const planFile = path.join(context.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);

    if (!fs.existsSync(planFile)) {
      return 'Error: implementation_plan.md not found';
    }

    const plan = await loadImplementationPlanFromFiles(context.specDir) as MutableAutocodePlan | null;
    if (!plan) {
      return 'Error: implementation_plan.md could not be parsed';
    }

    const found = updateAutocodePlanSubtask(plan, subtask_id, {
      status,
      notes,
      completionSummary: completion_summary,
    });
    if (!found) {
      return `Error: Subtask '${subtask_id}' not found in implementation plan`;
    }

    await saveImplementationPlanToFiles(context.specDir, plan);

    return `Successfully updated subtask '${subtask_id}' to status '${status}'`;
  },
});
