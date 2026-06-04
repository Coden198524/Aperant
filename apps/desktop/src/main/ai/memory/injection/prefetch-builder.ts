/**
 * Prefetch Builder
 *
 * Builds the prefetch file plan for coder sessions based on historical access
 * patterns stored as 'prefetch_pattern' memories.
 */

import type { MemoryService } from '../types';

// ============================================================
// TYPES
// ============================================================

export interface PrefetchPlan {
  /** Files accessed in >80% of sessions for these modules */
  alwaysReadFiles: string[];
  /** Files accessed in >50% of sessions for these modules */
  frequentlyReadFiles: string[];
  /** Maximum token budget for prefetched content */
  totalTokenBudget: number;
  /** Maximum number of files to prefetch */
  maxFiles: number;
}

const DEFAULT_PREFETCH_TOKEN_BUDGET = 8192;
const DEFAULT_PREFETCH_MAX_FILES = 6;
const MAX_ALWAYS_READ_FILES = 6;
const MAX_FREQUENTLY_READ_FILES = 4;

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Build a prefetch plan from stored prefetch_pattern memories for the given modules.
 *
 * @param modules - Module names to look up prefetch patterns for
 * @param memoryService - Memory service instance
 * @param projectId - Project identifier
 */
export async function buildPrefetchPlan(
  modules: string[],
  memoryService: MemoryService,
  projectId: string,
): Promise<PrefetchPlan> {
  try {
    const prefetchMemories = await memoryService.search({
      types: ['prefetch_pattern'],
      relatedModules: modules,
      limit: 5,
      projectId,
    });

    const alwaysReadFiles: string[] = [];
    const frequentlyReadFiles: string[] = [];

    for (const m of prefetchMemories) {
      try {
        const data = JSON.parse(m.content) as {
          alwaysReadFiles?: string[];
          frequentlyReadFiles?: string[];
        };
        if (Array.isArray(data.alwaysReadFiles)) {
          alwaysReadFiles.push(...data.alwaysReadFiles);
        }
        if (Array.isArray(data.frequentlyReadFiles)) {
          frequentlyReadFiles.push(...data.frequentlyReadFiles);
        }
      } catch {
        // Skip malformed memory content
      }
    }

    return {
      alwaysReadFiles: [...new Set(alwaysReadFiles)].slice(0, MAX_ALWAYS_READ_FILES),
      frequentlyReadFiles: [...new Set(frequentlyReadFiles)].slice(0, MAX_FREQUENTLY_READ_FILES),
      totalTokenBudget: DEFAULT_PREFETCH_TOKEN_BUDGET,
      maxFiles: DEFAULT_PREFETCH_MAX_FILES,
    };
  } catch {
    // Return empty plan on any failure
    return {
      alwaysReadFiles: [],
      frequentlyReadFiles: [],
      totalTokenBudget: DEFAULT_PREFETCH_TOKEN_BUDGET,
      maxFiles: DEFAULT_PREFETCH_MAX_FILES,
    };
  }
}
