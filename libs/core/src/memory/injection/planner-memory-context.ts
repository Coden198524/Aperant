/**
 * Planner Memory Context Builder
 *
 * Builds a compact memory context block for planner agent sessions.
 */

import type { Memory, MemoryService } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';
import { selectMemoryContextItems } from './context-selection.js';
import { normalizeMemoryModuleFilters } from './module-filters.js';
import { compactMemoryInjectionText } from './text-compaction.js';

const MAX_PLANNER_MEMORY_ITEM_CHARS = 240;
const MAX_PLANNER_MEMORY_ITEM_TOKENS = 80;
const MAX_PLANNER_MEMORY_CONTEXT_CHARS = 1800;
const MAX_PLANNER_MEMORY_CONTEXT_TOKENS = 450;
const LOW_VALUE_SESSION_METRIC_LINE_PATTERNS = [
  /^(?:Summary:\s*)?Efficient token usage\b/i,
  /^(?:Summary:\s*)?High token usage per step\b/i,
  /^(?:Summary:\s*)?Completed quickly with few steps\b/i,
  /^(?:Summary:\s*)?Many steps required\b/i,
  /^(?:Summary:\s*)?Used diverse set of tools\b/i,
] as const;

export async function buildPlannerMemoryContext(
  taskDescription: string,
  relevantModules: string[],
  memoryService: MemoryService,
  projectId: string,
): Promise<string> {
  try {
    const modules = normalizeMemoryModuleFilters(relevantModules);
    const task = normalizeTaskDescription(taskDescription);
    const emptySearch = Promise.resolve([] as Memory[]);
    const recipeSearch = task
      ? memoryService.searchWorkflowRecipe(task, {
          limit: 1,
          projectId,
          recordAccess: false,
        })
      : Promise.resolve([] as Memory[]);

    const [calibrations, deadEnds, causalDeps, outcomes, recipes] =
      await Promise.all([
        modules.length > 0
          ? memoryService.search({
              types: ['task_calibration'],
              relatedModules: modules,
              limit: 3,
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        modules.length > 0
          ? memoryService.search({
              types: ['dead_end'],
              relatedModules: modules,
              limit: 3,
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        modules.length > 0
          ? memoryService.search({
              types: ['causal_dependency'],
              relatedModules: modules,
              limit: 4,
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        modules.length > 0
          ? memoryService.search({
              types: ['work_unit_outcome'],
              relatedModules: modules,
              limit: 3,
              sort: 'recency',
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        recipeSearch,
      ]);

    const selectedSections = selectPlannerSections({
      calibrations,
      deadEnds,
      causalDeps,
      outcomes,
      recipes,
    });
    const context = formatPlannerSections(selectedSections);
    if (context) {
      await recordSelectedMemoryAccess(
        memoryService,
        flattenPlannerSections(selectedSections),
      );
    }
    return context;
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

function selectPlannerSections(sections: PlannerSections): PlannerSections {
  const seenFingerprints = new Set<string>();
  const seenContents: string[] = [];
  return {
    recipes: selectMemoryContextItems(sections.recipes, {
      maxItems: 1,
      minConfidence: 0.55,
      seenContents,
      seenFingerprints,
    }),
    calibrations: selectMemoryContextItems(sections.calibrations, {
      maxItems: 2,
      minConfidence: 0.55,
      seenContents,
      seenFingerprints,
    }),
    deadEnds: selectMemoryContextItems(sections.deadEnds, {
      maxItems: 2,
      minConfidence: 0.6,
      seenContents,
      seenFingerprints,
    }),
    causalDeps: selectMemoryContextItems(sections.causalDeps, {
      maxItems: 2,
      minConfidence: 0.6,
      seenContents,
      seenFingerprints,
    }),
    outcomes: selectMemoryContextItems(sections.outcomes, {
      maxItems: 2,
      minConfidence: 0.55,
      seenContents,
      seenFingerprints,
    }),
  };
}

function flattenPlannerSections(sections: PlannerSections): Memory[] {
  return [
    ...sections.recipes,
    ...sections.calibrations,
    ...sections.deadEnds,
    ...sections.causalDeps,
    ...sections.outcomes,
  ];
}

function formatPlannerSections(sections: PlannerSections): string {
  const parts: string[] = [];
  const { recipes, calibrations, deadEnds, causalDeps, outcomes } = sections;

  if (recipes.length > 0) {
    const items = recipes.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(
      `WORKFLOW RECIPES - Proven approaches for similar tasks:\n${items}`,
    );
  }

  if (calibrations.length > 0) {
    const items = calibrations
      .map((m) => {
        try {
          const data = JSON.parse(m.content) as {
            ratio?: number;
            module?: string;
          };
          const ratio =
            data.ratio != null
              ? ` (step ratio: ${data.ratio.toFixed(2)}x)`
              : '';
          return `- ${data.module ?? formatMemoryContent(m)}${ratio}`;
        } catch {
          return `- ${formatMemoryContent(m)}`;
        }
      })
      .join('\n');
    parts.push(`TASK CALIBRATIONS - Historical step count data:\n${items}`);
  }

  if (deadEnds.length > 0) {
    const items = deadEnds.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`DEAD ENDS - Approaches that failed before:\n${items}`);
  }

  if (causalDeps.length > 0) {
    const items = causalDeps
      .map((m) => `- ${formatMemoryContent(m)}`)
      .join('\n');
    parts.push(`CAUSAL DEPENDENCIES - Known ordering constraints:\n${items}`);
  }

  if (outcomes.length > 0) {
    const items = outcomes
      .map(formatOutcomeMemoryContent)
      .filter(Boolean)
      .map((content) => `- ${content}`)
      .join('\n');
    if (items) {
      parts.push(`RECENT OUTCOMES - Similar past work:\n${items}`);
    }
  }

  if (parts.length === 0) {
    return '';
  }

  return truncateText(
    `=== MEMORY CONTEXT FOR PLANNER ===\n${parts.join('\n\n')}\n=== END MEMORY CONTEXT ===`,
    MAX_PLANNER_MEMORY_CONTEXT_CHARS,
    MAX_PLANNER_MEMORY_CONTEXT_TOKENS,
  );
}

function formatMemoryContent(memory: Memory): string {
  return truncateText(
    memory.content,
    MAX_PLANNER_MEMORY_ITEM_CHARS,
    MAX_PLANNER_MEMORY_ITEM_TOKENS,
  );
}

function formatOutcomeMemoryContent(memory: Memory): string {
  return truncateText(
    stripLowValueSessionMetricLines(memory.content),
    MAX_PLANNER_MEMORY_ITEM_CHARS,
    MAX_PLANNER_MEMORY_ITEM_TOKENS,
  );
}

function stripLowValueSessionMetricLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(
      (line) =>
        !LOW_VALUE_SESSION_METRIC_LINE_PATTERNS.some((pattern) =>
          pattern.test(line.trim()),
        ),
    )
    .join('\n')
    .trim();
}

function truncateText(
  text: string,
  maxChars: number,
  maxTokens: number,
): string {
  return compactMemoryInjectionText(text, maxChars, maxTokens);
}

function normalizeTaskDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
