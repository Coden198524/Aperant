/**
 * QA Session Context Builder
 *
 * Builds a compact memory context block for QA agent sessions.
 */

import type { Memory, MemoryService } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';
import { selectMemoryContextItems } from './context-selection.js';
import { normalizeMemoryModuleFilters } from './module-filters.js';
import { compactMemoryInjectionText } from './text-compaction.js';
import {
  getRenderedVisibleMemories,
  type VisibleMemoryItem,
} from './visible-memory-items.js';
import { stripLowValueMemoryLines } from '../outcome-content.js';

const MAX_QA_MEMORY_ITEM_CHARS = 240;
const MAX_QA_MEMORY_ITEM_TOKENS = 80;
const MAX_QA_MEMORY_CONTEXT_CHARS = 1700;
const MAX_QA_MEMORY_CONTEXT_TOKENS = 425;
const MAX_QA_MEMORY_FILE_REFS = 3;
const MAX_QA_MEMORY_FILE_REF_CHARS = 48;

export async function buildQaSessionContext(
  specDescription: string,
  relevantModules: string[],
  memoryService: MemoryService,
  projectId: string,
): Promise<string> {
  try {
    const modules = normalizeMemoryModuleFilters(relevantModules);
    const task = normalizeTaskDescription(specDescription);
    const emptySearch = Promise.resolve([] as Memory[]);
    const recipeSearch = task
      ? memoryService.searchWorkflowRecipe(task, {
          limit: 1,
          projectId,
          recordAccess: false,
        })
      : Promise.resolve([] as Memory[]);

    const [e2eObservations, errorPatterns, requirements, recipes] =
      await Promise.all([
        modules.length > 0
          ? memoryService.search({
              types: ['e2e_observation'],
              relatedModules: modules,
              limit: 4,
              sort: 'recency',
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        modules.length > 0
          ? memoryService.search({
              types: ['error_pattern'],
              relatedModules: modules,
              limit: 3,
              minConfidence: 0.6,
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        modules.length > 0
          ? memoryService.search({
              types: ['requirement'],
              relatedModules: modules,
              limit: 3,
              projectId,
              promptContextOnly: true,
            })
          : emptySearch,
        recipeSearch,
      ]);

    const selectedSections = selectQaSections({
      e2eObservations,
      errorPatterns,
      requirements,
      recipes,
    });
    const formattedContext = formatQaSections(selectedSections);
    if (formattedContext.context) {
      await recordSelectedMemoryAccess(
        memoryService,
        formattedContext.memories,
      );
    }
    return formattedContext.context;
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

function selectQaSections(sections: QaSections): QaSections {
  const seenFingerprints = new Set<string>();
  const seenContents: string[] = [];
  return {
    requirements: selectMemoryContextItems(sections.requirements, {
      maxItems: 2,
      minConfidence: 0.6,
      seenContents,
      seenFingerprints,
      getContent: formatMemoryContent,
    }),
    errorPatterns: selectMemoryContextItems(sections.errorPatterns, {
      maxItems: 2,
      minConfidence: 0.6,
      seenContents,
      seenFingerprints,
      getContent: formatMemoryContent,
    }),
    e2eObservations: selectMemoryContextItems(sections.e2eObservations, {
      maxItems: 2,
      minConfidence: 0.55,
      seenContents,
      seenFingerprints,
      getContent: formatMemoryContent,
    }),
    recipes: selectMemoryContextItems(sections.recipes, {
      maxItems: 1,
      minConfidence: 0.55,
      seenContents,
      seenFingerprints,
      getContent: formatMemoryContent,
    }),
  };
}

interface FormattedQaContext {
  context: string;
  memories: Memory[];
}

function formatQaSections(sections: QaSections): FormattedQaContext {
  const parts: string[] = [];
  const memoryItems: VisibleMemoryItem[] = [];
  const { requirements, errorPatterns, e2eObservations, recipes } = sections;

  if (requirements.length > 0) {
    const items = requirements.map((memory) => formatMemoryLine(memory));
    parts.push(
      `KNOWN REQUIREMENTS - Constraints to validate:\n${items
        .map((item) => item.renderedLine)
        .join('\n')}`,
    );
    memoryItems.push(...items);
  }

  if (errorPatterns.length > 0) {
    const seenErrorPatternFiles = new Set<string>();
    const items = errorPatterns.map((memory) => {
      return {
        memory,
        renderedLine: `- ${formatMemoryContent(memory)}${formatRelatedFileRefs(
          memory.relatedFiles,
          seenErrorPatternFiles,
        )}`,
      };
    });
    parts.push(
      `ERROR PATTERNS - Known failure modes:\n${items
        .map((item) => item.renderedLine)
        .join('\n')}`,
    );
    memoryItems.push(...items);
  }

  if (e2eObservations.length > 0) {
    const items = e2eObservations.map((memory) => formatMemoryLine(memory));
    parts.push(
      `E2E OBSERVATIONS - Historical test behavior:\n${items
        .map((item) => item.renderedLine)
        .join('\n')}`,
    );
    memoryItems.push(...items);
  }

  if (recipes.length > 0) {
    const items = recipes.map((memory) => formatMemoryLine(memory));
    parts.push(
      `VALIDATION WORKFLOW - Proven QA approach:\n${items
        .map((item) => item.renderedLine)
        .join('\n')}`,
    );
    memoryItems.push(...items);
  }

  if (parts.length === 0) {
    return { context: '', memories: [] };
  }

  const context = truncateText(
    `=== MEMORY CONTEXT FOR QA ===\n${parts.join('\n\n')}\n=== END MEMORY CONTEXT ===`,
    MAX_QA_MEMORY_CONTEXT_CHARS,
    MAX_QA_MEMORY_CONTEXT_TOKENS,
  );
  return {
    context,
    memories: getRenderedVisibleMemories(context, memoryItems),
  };
}

function formatMemoryLine(memory: Memory): VisibleMemoryItem {
  return {
    memory,
    renderedLine: `- ${formatMemoryContent(memory)}`,
  };
}

function formatMemoryContent(memory: Memory): string {
  return truncateText(
    stripLowValueMemoryLines(memory.content),
    MAX_QA_MEMORY_ITEM_CHARS,
    MAX_QA_MEMORY_ITEM_TOKENS,
  );
}

function formatRelatedFileRefs(
  relatedFiles: string[],
  seenFiles: Set<string>,
): string {
  if (relatedFiles.length === 0) {
    return '';
  }

  const uniqueUnseenFiles = uniqueFilePaths(relatedFiles).filter(
    (filePath) => !seenFiles.has(normalizeFilePathForDedupe(filePath)),
  );
  const displayedFiles = uniqueUnseenFiles
    .slice(0, MAX_QA_MEMORY_FILE_REFS)
    .map((filePath) => ({
      filePath,
      fileName: formatRelatedFileName(filePath),
    }))
    .filter((file) => Boolean(file.fileName));

  for (const file of displayedFiles) {
    seenFiles.add(normalizeFilePathForDedupe(file.filePath));
  }

  const fileNames = displayedFiles.map((file) => file.fileName).filter(Boolean);

  if (fileNames.length === 0) {
    return '';
  }

  const omittedSuffix =
    uniqueUnseenFiles.length > displayedFiles.length ? ', ...' : '';
  return ` [${fileNames.join(', ')}${omittedSuffix}]`;
}

function formatRelatedFileName(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? '';
  return compactFileName(fileName, MAX_QA_MEMORY_FILE_REF_CHARS);
}

function compactFileName(fileName: string, maxChars: number): string {
  const compact = fileName.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  const marker = '...';
  const budget = maxChars - marker.length;
  const headChars = Math.ceil(budget * 0.45);
  const tailChars = budget - headChars;
  return `${compact.slice(0, headChars)}${marker}${compact.slice(-tailChars)}`;
}

function normalizeFilePathForDedupe(filePath: string): string {
  return normalizeFilePath(filePath).toLowerCase();
}

function uniqueFilePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeFilePath(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
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
