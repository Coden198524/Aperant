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
  validateAutocodeCodingSummary,
} from '@autocode/core';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import {
  updateImplementationPlanInFiles,
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
    .describe('Compact human-reviewable structured completion summary. Use a short Markdown review matrix with rows: What changed, Verification, Review notes.'),
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
    const currentSubtaskId = context.currentSubtaskId?.trim();

    if (currentSubtaskId && subtask_id !== currentSubtaskId) {
      return `Error: This coding session is scoped to subtask '${currentSubtaskId}' and cannot update subtask '${subtask_id}'.`;
    }

    if (!fs.existsSync(planFile)) {
      return 'Error: implementation_plan.md not found';
    }

    let found = false;
    let qualityError: string | null = null;
    const plan = await updateImplementationPlanInFiles(context.specDir, (currentPlan) => {
      const targetSubtask = findAutocodePlanSubtask(currentPlan as MutableAutocodePlan, subtask_id);
      if (status === 'completed') {
        if (!targetSubtask) {
          return false;
        }
        const qualityIssues = validateAutocodeCodingSummary(
          {
            description: [
              targetSubtask.title,
              targetSubtask.description,
            ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n'),
            filesToCreate: toStringArray((targetSubtask as Record<string, unknown>).files_to_create),
            filesToModify: toStringArray((targetSubtask as Record<string, unknown>).files_to_modify),
          },
          completion_summary || notes || '',
        );
        if (qualityIssues.length > 0) {
          qualityError = `Error: Cannot mark subtask '${subtask_id}' completed until completion evidence passes quality gates: ${qualityIssues.slice(0, 3).join('; ')}`;
          return false;
        }
      }

      found = updateAutocodePlanSubtask(currentPlan as MutableAutocodePlan, subtask_id, {
        status,
        notes,
        completionSummary: completion_summary,
      });
      return found ? currentPlan : false;
    }) as MutableAutocodePlan | null;
    if (qualityError) {
      return qualityError;
    }
    if (!plan) {
      return 'Error: implementation_plan.md could not be parsed';
    }
    if (!found) {
      return `Error: Subtask '${subtask_id}' not found in implementation plan`;
    }

    return `Successfully updated subtask '${subtask_id}' to status '${status}'`;
  },
});

function findAutocodePlanSubtask(plan: MutableAutocodePlan, subtaskId: string): Record<string, unknown> | null {
  for (const phase of plan.phases ?? []) {
    for (const subtask of phase.subtasks ?? []) {
      const record = subtask as Record<string, unknown>;
      if (record.id === subtaskId || record.subtask_id === subtaskId) {
        return record;
      }
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
