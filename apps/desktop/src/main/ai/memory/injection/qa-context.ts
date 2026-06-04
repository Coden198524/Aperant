/**
 * QA Session Context Builder
 *
 * Builds a compact memory context block for QA agent sessions.
 */

import type { Memory, MemoryService } from '../types';

const MAX_QA_MEMORY_ITEM_CHARS = 300;
const MAX_QA_MEMORY_CONTEXT_CHARS = 2200;

export async function buildQaSessionContext(
  specDescription: string,
  relevantModules: string[],
  memoryService: MemoryService,
  projectId: string,
): Promise<string> {
  try {
    const [e2eObservations, errorPatterns, requirements, recipes] = await Promise.all([
      memoryService.search({
        types: ['e2e_observation'],
        relatedModules: relevantModules,
        limit: 4,
        sort: 'recency',
        projectId,
      }),
      memoryService.search({
        types: ['error_pattern'],
        relatedModules: relevantModules,
        limit: 3,
        minConfidence: 0.6,
        projectId,
      }),
      memoryService.search({
        types: ['requirement'],
        relatedModules: relevantModules,
        limit: 3,
        projectId,
      }),
      memoryService.searchWorkflowRecipe(specDescription, { limit: 1 }),
    ]);

    return formatQaSections({ e2eObservations, errorPatterns, requirements, recipes });
  } catch {
    return '';
  }
}

interface QaSections {
  e2eObservations: Memory[];
  errorPatterns: Memory[];
  requirements: Memory[];
  recipes: Memory[];
}

function formatQaSections(sections: QaSections): string {
  const parts: string[] = [];

  if (sections.requirements.length > 0) {
    const items = sections.requirements.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`KNOWN REQUIREMENTS - Constraints to validate:\n${items}`);
  }

  if (sections.errorPatterns.length > 0) {
    const items = sections.errorPatterns
      .map((m) => {
        const fileRef =
          m.relatedFiles.length > 0
            ? ` [${m.relatedFiles.map((f) => f.split('/').pop()).join(', ')}]`
            : '';
        return `- ${formatMemoryContent(m)}${fileRef}`;
      })
      .join('\n');
    parts.push(`ERROR PATTERNS - Known failure modes:\n${items}`);
  }

  if (sections.e2eObservations.length > 0) {
    const items = sections.e2eObservations.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`E2E OBSERVATIONS - Historical test behavior:\n${items}`);
  }

  if (sections.recipes.length > 0) {
    const items = sections.recipes.map((m) => `- ${formatMemoryContent(m)}`).join('\n');
    parts.push(`VALIDATION WORKFLOW - Proven QA approach:\n${items}`);
  }

  if (parts.length === 0) {
    return '';
  }

  return truncateText(
    `=== MEMORY CONTEXT FOR QA ===\n${parts.join('\n\n')}\n=== END MEMORY CONTEXT ===`,
    MAX_QA_MEMORY_CONTEXT_CHARS,
  );
}

function formatMemoryContent(memory: Memory): string {
  return truncateText(memory.content, MAX_QA_MEMORY_ITEM_CHARS);
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
