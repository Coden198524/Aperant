/**
 * Prefetch Builder
 *
 * Builds the prefetch file plan for coder sessions based on historical access
 * patterns stored as 'prefetch_pattern' memories.
 */

import { isMemoryEligibleForPromptContext } from '../retrieval/context-packer.js';
import type { Memory, MemoryService } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';
import { normalizeMemoryModuleFilters } from './module-filters.js';

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

interface ParsedPrefetchMemory {
  memory: Memory;
  alwaysReadFiles: string[];
  frequentlyReadFiles: string[];
}

interface PrefetchCandidateSources {
  alwaysReadFiles: string[];
  frequentlyReadFiles: string[];
  alwaysSourceByFileKey: Map<string, Memory>;
  frequentSourceByFileKey: Map<string, Memory>;
}

const DEFAULT_PREFETCH_TOKEN_BUDGET = 8192;
const DEFAULT_PREFETCH_MAX_FILES = 6;
const MAX_ALWAYS_READ_FILES = 6;
const MAX_FREQUENTLY_READ_FILES = 4;
const MAX_PREFETCH_PATH_CHARS = 180;
const PREFETCH_SELECTION_HEAD_RATIO = 0.65;
const IGNORED_PREFETCH_FILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const IGNORED_PREFETCH_FILE_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bmp',
  '.br',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.icns',
  '.ico',
  '.jpeg',
  '.jpg',
  '.lock',
  '.map',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);
const IGNORED_PREFETCH_PATH_SEGMENTS = new Set([
  '.autocode',
  '.auto-claude',
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
]);

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
    const relatedModules = normalizeMemoryModuleFilters(modules);
    if (relatedModules.length === 0) {
      return createEmptyPrefetchPlan();
    }

    const prefetchMemories = (
      await memoryService.search({
        types: ['prefetch_pattern'],
        relatedModules,
        limit: 5,
        projectId,
        promptContextOnly: true,
        recordAccess: false,
      })
    ).filter(isMemoryEligibleForPromptContext);

    const parsedMemories = prefetchMemories
      .map(parsePrefetchMemory)
      .filter(isParsedPrefetchMemory);
    const candidates = collectPrefetchCandidateSources(parsedMemories);

    const always = selectPrefetchFiles(
      candidates.alwaysReadFiles,
      Math.min(MAX_ALWAYS_READ_FILES, DEFAULT_PREFETCH_MAX_FILES),
    );
    const remainingFileBudget = Math.max(
      0,
      DEFAULT_PREFETCH_MAX_FILES - always.length,
    );
    const alwaysSet = new Set(always.map(normalizePrefetchFileKey));
    const frequent = selectPrefetchFiles(
      candidates.frequentlyReadFiles.filter(
        (file) => !alwaysSet.has(normalizePrefetchFileKey(file)),
      ),
      Math.min(MAX_FREQUENTLY_READ_FILES, remainingFileBudget),
    );

    const accessedMemories = getSelectedPrefetchSourceMemories(
      always,
      frequent,
      candidates,
    );
    if (accessedMemories.length > 0) {
      await recordSelectedMemoryAccess(memoryService, accessedMemories);
    }

    return {
      alwaysReadFiles: always,
      frequentlyReadFiles: frequent,
      totalTokenBudget: DEFAULT_PREFETCH_TOKEN_BUDGET,
      maxFiles: DEFAULT_PREFETCH_MAX_FILES,
    };
  } catch {
    // Return empty plan on any failure
    return createEmptyPrefetchPlan();
  }
}

function parsePrefetchMemory(memory: Memory): ParsedPrefetchMemory | null {
  try {
    const data = JSON.parse(memory.content) as {
      alwaysReadFiles?: string[];
      frequentlyReadFiles?: string[];
    };
    const alwaysReadFiles = Array.isArray(data.alwaysReadFiles)
      ? data.alwaysReadFiles.map(normalizePrefetchFilePath).filter(isString)
      : [];
    const frequentlyReadFiles = Array.isArray(data.frequentlyReadFiles)
      ? data.frequentlyReadFiles.map(normalizePrefetchFilePath).filter(isString)
      : [];
    return alwaysReadFiles.length > 0 || frequentlyReadFiles.length > 0
      ? { memory, alwaysReadFiles, frequentlyReadFiles }
      : null;
  } catch {
    return null;
  }
}

function collectPrefetchCandidateSources(
  memories: readonly ParsedPrefetchMemory[],
): PrefetchCandidateSources {
  const alwaysReadFiles: string[] = [];
  const frequentlyReadFiles: string[] = [];
  const alwaysSourceByFileKey = new Map<string, Memory>();
  const frequentSourceByFileKey = new Map<string, Memory>();

  for (const entry of memories) {
    recordFirstPrefetchSource(
      entry.alwaysReadFiles,
      entry.memory,
      alwaysReadFiles,
      alwaysSourceByFileKey,
    );
    recordFirstPrefetchSource(
      entry.frequentlyReadFiles,
      entry.memory,
      frequentlyReadFiles,
      frequentSourceByFileKey,
    );
  }

  return {
    alwaysReadFiles,
    frequentlyReadFiles,
    alwaysSourceByFileKey,
    frequentSourceByFileKey,
  };
}

function recordFirstPrefetchSource(
  files: readonly string[],
  memory: Memory,
  selectedFiles: string[],
  sourceByFileKey: Map<string, Memory>,
): void {
  for (const file of files) {
    const key = normalizePrefetchFileKey(file);
    if (!sourceByFileKey.has(key)) {
      sourceByFileKey.set(key, memory);
      selectedFiles.push(file);
    }
  }
}

function getSelectedPrefetchSourceMemories(
  alwaysReadFiles: readonly string[],
  frequentlyReadFiles: readonly string[],
  candidates: PrefetchCandidateSources,
): Memory[] {
  const memories: Memory[] = [];
  for (const file of alwaysReadFiles) {
    const memory = candidates.alwaysSourceByFileKey.get(
      normalizePrefetchFileKey(file),
    );
    if (memory) {
      memories.push(memory);
    }
  }
  for (const file of frequentlyReadFiles) {
    const memory = candidates.frequentSourceByFileKey.get(
      normalizePrefetchFileKey(file),
    );
    if (memory) {
      memories.push(memory);
    }
  }
  return memories;
}

function isParsedPrefetchMemory(
  value: ParsedPrefetchMemory | null,
): value is ParsedPrefetchMemory {
  return value !== null;
}

function createEmptyPrefetchPlan(): PrefetchPlan {
  return {
    alwaysReadFiles: [],
    frequentlyReadFiles: [],
    totalTokenBudget: DEFAULT_PREFETCH_TOKEN_BUDGET,
    maxFiles: DEFAULT_PREFETCH_MAX_FILES,
  };
}

function normalizePrefetchFilePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  let normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (
    !normalized ||
    normalized.length > MAX_PREFETCH_PATH_CHARS ||
    normalized.endsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    /^[a-z][a-z0-9+.-]*:\//i.test(normalized) ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }

  if (
    segments.some((segment) =>
      IGNORED_PREFETCH_PATH_SEGMENTS.has(segment.toLowerCase()),
    )
  ) {
    return null;
  }

  const fileName = (segments[segments.length - 1] ?? '').toLowerCase();
  if (
    isIgnoredPrefetchFileName(fileName) ||
    isIgnoredPrefetchFileExtension(fileName)
  ) {
    return null;
  }

  return segments.join('/');
}

function normalizePrefetchFileKey(filePath: string): string {
  return filePath.toLowerCase();
}

function isIgnoredPrefetchFileName(fileName: string): boolean {
  return IGNORED_PREFETCH_FILE_NAMES.has(fileName);
}

function isIgnoredPrefetchFileExtension(fileName: string): boolean {
  return [...IGNORED_PREFETCH_FILE_EXTENSIONS].some((extension) =>
    fileName.endsWith(extension),
  );
}

function selectPrefetchFiles(
  files: readonly string[],
  limit: number,
): string[] {
  if (limit <= 0) {
    return [];
  }
  if (files.length <= limit) {
    return [...files];
  }
  if (limit === 1) {
    return [files[0]];
  }

  const headCount = Math.ceil(limit * PREFETCH_SELECTION_HEAD_RATIO);
  const tailCount = Math.max(0, limit - headCount);
  return [
    ...files.slice(0, headCount),
    ...files.slice(files.length - tailCount),
  ];
}

function isString(value: string | null): value is string {
  return typeof value === 'string';
}
