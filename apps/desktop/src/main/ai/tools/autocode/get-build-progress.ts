/**
 * get_build_progress Tool
 * =======================
 *
 * Reports current build progress from implementation_plan.md.
 * See apps/desktop/src/main/ai/tools/autocode/get-build-progress.ts for the TypeScript implementation.
 *
 * Tool name: mcp__autocode__get_build_progress
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v3';
import { AUTOCODE_TASK_ARTIFACTS } from '@autocode/core';

import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import { loadImplementationPlanFromFilesSync } from '../../schema/plan-shards';

// ---------------------------------------------------------------------------
// Input Schema (no parameters required)
// ---------------------------------------------------------------------------

const inputSchema = z.object({});

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface PlanSubtask {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
}

interface PlanPhase {
  id?: string;
  phase?: number;
  name?: string;
  subtasks?: PlanSubtask[];
}

interface ImplementationPlan {
  phases?: PlanPhase[];
}

type FocusSubtaskStatus = 'in_progress' | 'failed' | 'blocked' | 'pending';

interface FocusSubtask {
  id?: string;
  description?: string;
  phase?: string;
  status: FocusSubtaskStatus;
}

const MAX_PHASE_SUMMARY_LINES = 12;
const MAX_NEXT_SUBTASK_DESCRIPTION_CHARS = 360;
const TEXT_OMISSION_MARKER = ' ... [middle omitted] ... ';

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const getBuildProgressTool = Tool.define({
  metadata: {
    name: 'mcp__autocode__get_build_progress',
    description:
      'Get the current build progress including completed subtasks, pending subtasks, and next subtask to work on.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: (_input, context) => {
    const planFile = path.join(context.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);

    if (!fs.existsSync(planFile)) {
      return 'No implementation plan found. Run the planner first.';
    }

    const plan = loadImplementationPlanFromFilesSync(planFile) as ImplementationPlan | null;
    if (!plan) {
      return 'Error reading build progress: Could not parse implementation_plan.md';
    }

    const stats = { total: 0, completed: 0, in_progress: 0, pending: 0, failed: 0, blocked: 0 };
    const phasesSummary: string[] = [];
    let focusSubtask: FocusSubtask | null = null;

    for (const phase of plan.phases ?? []) {
      const phaseId = phase.id ?? String(phase.phase ?? '');
      const phaseName = phase.name ?? phaseId;
      const subtasks = phase.subtasks ?? [];

      let phaseCompleted = 0;

      for (const subtask of subtasks) {
        stats.total++;
        const status = subtask.status ?? 'pending';

        if (status === 'completed') {
          stats.completed++;
          phaseCompleted++;
        } else if (status === 'in_progress') {
          stats.in_progress++;
          focusSubtask = selectBuildProgressFocusSubtask(focusSubtask, {
            id: subtask.id,
            description: getBuildProgressSubtaskDescription(subtask),
            phase: phaseName,
            status,
          });
        } else if (status === 'failed') {
          stats.failed++;
          focusSubtask = selectBuildProgressFocusSubtask(focusSubtask, {
            id: subtask.id,
            description: getBuildProgressSubtaskDescription(subtask),
            phase: phaseName,
            status,
          });
        } else if (status === 'blocked') {
          stats.blocked++;
          focusSubtask = selectBuildProgressFocusSubtask(focusSubtask, {
            id: subtask.id,
            description: getBuildProgressSubtaskDescription(subtask),
            phase: phaseName,
            status,
          });
        } else {
          stats.pending++;
          focusSubtask = selectBuildProgressFocusSubtask(focusSubtask, {
            id: subtask.id,
            description: getBuildProgressSubtaskDescription(subtask),
            phase: phaseName,
            status: 'pending',
          });
        }
      }

      phasesSummary.push(`  ${phaseName}: ${phaseCompleted}/${subtasks.length}`);
    }

    const progressPct = stats.total > 0
      ? ((stats.completed / stats.total) * 100).toFixed(0)
      : '0';

    let result =
      `Build Progress: ${stats.completed}/${stats.total} subtasks (${progressPct}%)\n\n` +
      `Status breakdown:\n` +
      `  Completed: ${stats.completed}\n` +
      `  In Progress: ${stats.in_progress}\n` +
      `  Pending: ${stats.pending}\n` +
      `  Failed: ${stats.failed}\n` +
      `  Blocked: ${stats.blocked}\n\n` +
      `Phases:\n${formatPhaseSummaryLines(phasesSummary)}`;

    if (focusSubtask) {
      result +=
        `\n\n${getBuildProgressFocusHeading(focusSubtask.status)}:\n` +
        `  ID: ${focusSubtask.id ?? 'unknown'}\n` +
        `  Status: ${focusSubtask.status}\n` +
        `  Phase: ${focusSubtask.phase ?? 'unknown'}\n` +
        `  Description: ${compactBuildProgressText(
          focusSubtask.description ?? 'No description',
          MAX_NEXT_SUBTASK_DESCRIPTION_CHARS,
        )}`;
    } else if (stats.completed === stats.total && stats.total > 0) {
      result += '\n\nAll subtasks completed! Build is ready for QA.';
    }

    return result;
  },
});

function selectBuildProgressFocusSubtask(
  current: FocusSubtask | null,
  candidate: FocusSubtask,
): FocusSubtask {
  if (!current) {
    return candidate;
  }
  return getBuildProgressFocusPriority(candidate.status) < getBuildProgressFocusPriority(current.status)
    ? candidate
    : current;
}

function getBuildProgressFocusPriority(status: FocusSubtaskStatus): number {
  switch (status) {
    case 'in_progress':
      return 0;
    case 'failed':
      return 1;
    case 'blocked':
      return 2;
    case 'pending':
      return 3;
  }
}

function getBuildProgressFocusHeading(status: FocusSubtaskStatus): string {
  switch (status) {
    case 'in_progress':
      return 'Current subtask in progress';
    case 'failed':
      return 'Failed subtask needing attention';
    case 'blocked':
      return 'Blocked subtask needing attention';
    case 'pending':
      return 'Next subtask to work on';
  }
}

function getBuildProgressSubtaskDescription(subtask: PlanSubtask): string | undefined {
  return subtask.description?.trim() || subtask.title?.trim() || undefined;
}

function formatPhaseSummaryLines(lines: string[]): string {
  if (lines.length <= MAX_PHASE_SUMMARY_LINES) {
    return lines.join('\n');
  }

  const budget = MAX_PHASE_SUMMARY_LINES - 1;
  const headCount = Math.ceil(budget * 0.6);
  const tailCount = Math.max(0, budget - headCount);
  return [
    ...lines.slice(0, headCount),
    `  ... ${lines.length - headCount - tailCount} phase(s) omitted ...`,
    ...(tailCount > 0 ? lines.slice(-tailCount) : []),
  ].join('\n');
}

function compactBuildProgressText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= TEXT_OMISSION_MARKER.length + 2) {
    return compact.slice(0, maxChars);
  }

  const budget = maxChars - TEXT_OMISSION_MARKER.length;
  const headChars = Math.ceil(budget * 0.6);
  const tailChars = Math.max(0, budget - headChars);
  return [
    compact.slice(0, headChars).trimEnd(),
    TEXT_OMISSION_MARKER,
    tailChars > 0 ? compact.slice(-tailChars).trimStart() : '',
  ].join('');
}
