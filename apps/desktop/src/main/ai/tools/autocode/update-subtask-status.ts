/**
 * update_subtask_status Tool
 * ==========================
 *
 * Updates the status of a subtask in implementation_plan.json.
 * See apps/desktop/src/main/ai/tools/autocode/update-subtask-status.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__update_subtask_status
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';

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
    .describe('Human-reviewable structured completion summary. Prefer Markdown table rows for What changed, Verification, and Review notes.'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PlanSubtask {
  id?: string;
  subtask_id?: string;
  status?: string;
  notes?: string;
  completion_summary?: string;
  updated_at?: string;
}

interface PlanPhase {
  subtasks?: PlanSubtask[];
}

interface ImplementationPlan {
  phases?: PlanPhase[];
  last_updated?: string;
  [key: string]: unknown;
}

function updateSubtaskInPlan(
  plan: ImplementationPlan,
  subtaskId: string,
  status: string,
  notes: string | undefined,
  completionSummary: string | undefined,
): boolean {
  for (const phase of plan.phases ?? []) {
    for (const subtask of phase.subtasks ?? []) {
      const id = subtask.id ?? subtask.subtask_id;
      if (id === subtaskId) {
        subtask.status = status;
        if (notes) {
          subtask.notes = notes;
        }
        if (status === 'completed') {
          const summary = completionSummary || notes;
          if (summary) {
            subtask.completion_summary = summary;
            subtask.notes = summary;
          }
        }
        subtask.updated_at = new Date().toISOString();
        plan.last_updated = new Date().toISOString();
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const updateSubtaskStatusTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__update_subtask_status',
    description:
      'Update the status of a subtask in implementation_plan.json. Use this when completing or starting a subtask.',
    permission: ToolPermission.Auto,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    const { subtask_id, status, notes, completion_summary } = input;
    const planFile = path.join(context.specDir, 'implementation_plan.json');

    if (!fs.existsSync(planFile)) {
      return 'Error: implementation_plan.json not found';
    }

    const plan = await loadImplementationPlanFromFiles(context.specDir) as ImplementationPlan | null;
    if (!plan) {
      return 'Error: implementation_plan.json contains unrepairable JSON';
    }

    const found = updateSubtaskInPlan(plan, subtask_id, status, notes, completion_summary);
    if (!found) {
      return `Error: Subtask '${subtask_id}' not found in implementation plan`;
    }

    await saveImplementationPlanToFiles(context.specDir, plan as never);

    return `Successfully updated subtask '${subtask_id}' to status '${status}'`;
  },
});
