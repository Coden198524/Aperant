/**
 * Planner Memory Context Builder
 *
 * Builds a compact memory context block for planner agent sessions.
 */

import type { Memory, MemoryService } from '../types.js';

const MAX_PLANNER_MEMORY_ITEM_CHARS = 320;
const MAX_PLANNER_MEMORY_CONTEXT_CHARS = 2400;

export async function buildPlannerMemoryContext(
  taskDescription: string,
  relevantModules: string[],
  memoryService: MemoryService,
  projectId: string,
): Promise<string> {
  try {
    const [calibrations, deadEnds, causalDeps, outcomes, recipes] = await Promise.all([
      memoryService.search({
        types: ['task_calibration'],
        relatedModules: relevantModules,
        limit: 3,
        projectId,
      }),
      memoryService.search({
        types: ['dead_end'],
        relatedModules: relevantModules,
        limit: 3,
        projectId,
      }),
      memoryService.search({
        types: ['causal_dependency'],
        relatedModules: relevantModules,
        limit: 4,
        projectId,
      }),
      memoryService.search({
        types: ['work_unit_outcome'],
        relatedModules: relevantModules,
        limit: 3,
        sort: 'recency',
        projectId,
      }),
      memoryService.searchWorkflowRecipe(taskDescription, { limit: 1 }),
    ]);

    return formatPlannerSections({ calibrations, deadEnds, causalDeps, outcomes, recipes });
  } catch {
    return '';
  }
}

interface PlannerSections {
  calibrations: Memory[];
  deadEnds: Memory[];
  causalDeps: Memory[];
  outcomes: Memory[];
  recipes: Memory[];
}

function formatPlannerSections(sections: PlannerSections): string {
  const parts: string[] = [];

  if (sections.recipes.length > 0) {
    const items = sections.recipes.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`WORKFLOW RECIPES - Proven approaches for similar tasks:\n${items}`);
  }

  if (sections.calibrations.length > 0) {
    const items = sections.calibrations
      .map((m) => {
        try {
          const data = JSON.parse(m.content) as { ratio?: number; module?: string };
          const ratio = data.ratio != null ? ` (step ratio: ${data.ratio.toFixed(2)}x)` : '';
          return `- ${data.module ?? formatMemoryContent(m)}${ratio}`;
        } catch {
          return `- ${formatMemoryContent(m)}`;
        }
      })
      .join('\n');
    parts.push(`TASK CALIBRATIONS - Historical step count data:\n${items}`);
  }

  if (sections.deadEnds.length > 0) {
    const items = sections.deadEnds.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`DEAD ENDS - Approaches that failed before:\n${items}`);
  }

  if (sections.causalDeps.length > 0) {
    const items = sections.causalDeps.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`CAUSAL DEPENDENCIES - Known ordering constraints:\n${items}`);
  }

  if (sections.outcomes.length > 0) {
    const items = sections.outcomes.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`RECENT OUTCOMES - Similar past work:\n${items}`);
  }

  if (parts.length === 0) {
    return '';
  }

  return truncateText(
    `=== MEMORY CONTEXT FOR PLANNER ===\n${parts.join('\n\n')}\n=== END MEMORY CONTEXT ===`,
    MAX_PLANNER_MEMORY_CONTEXT_CHARS,
  );
}

function formatMemoryContent(memory: Memory): string {
  return truncateText(memory.content, MAX_PLANNER_MEMORY_ITEM_CHARS);
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
