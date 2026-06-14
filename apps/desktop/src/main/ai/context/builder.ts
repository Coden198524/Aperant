/**
 * Context Builder
 *
 * Orchestrates all context-building steps: keyword extraction → file search →
 * service matching → categorization → pattern discovery → memory hints.
 *
 * See apps/desktop/src/main/ai/context/builder.ts for the TypeScript implementation.
 * Entry point: buildContext()
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAutocodeProjectIndexPath } from '@autocode/core';

import { categorizeMatches } from './categorizer.js';
import { fetchGraphHints, isMemoryEnabled } from './graphiti-integration.js';
import { extractKeywords } from './keyword-extractor.js';
import { discoverPatterns } from './pattern-discovery.js';
import { searchService } from './search.js';
import { suggestServices } from './service-matcher.js';
import type {
  CodePattern,
  ContextFile,
  FileMatch,
  ProjectIndex,
  ServiceInfo,
  ServiceMatch,
  SubtaskContext,
  TaskContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const SERVICE_CONTEXT_MAX_CHARS = 1_600;
const SERVICE_CONTEXT_COMPACTION_HEAD_RATIO = 0.65;

function loadProjectIndex(projectDir: string, dataDirName?: string): ProjectIndex {
  try {
    const indexPath = getAutocodeProjectIndexPath(projectDir, dataDirName);
    if (fs.existsSync(indexPath)) {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const loaded = normalizeProjectIndex(parsed);
      if (loaded) {
        return loaded;
      }
    }
  } catch {
    // Fall through to a single-service fallback.
  }
  return createFallbackProjectIndex(projectDir);
}

function createFallbackProjectIndex(projectDir: string): ProjectIndex {
  return {
    services: {
      main: {
        type: 'api',
        path: projectDir,
      },
    },
  };
}

function normalizeProjectIndex(value: unknown): ProjectIndex | null {
  if (!isRecord(value) || !isRecord(value.services)) {
    return null;
  }

  const services = Object.fromEntries(
    Object.entries(value.services)
      .filter((entry): entry is [string, ServiceInfo] => (
        typeof entry[0] === 'string' && isRecord(entry[1])
      )),
  );
  if (Object.keys(services).length === 0) {
    return null;
  }

  return {
    ...value,
    services,
  } as ProjectIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getServiceContext(
  serviceDir: string,
  serviceInfo: ServiceInfo,
): Record<string, unknown> {
  const contextFile = path.join(serviceDir, 'SERVICE_CONTEXT.md');
  if (fs.existsSync(contextFile)) {
    try {
      const content = compactServiceContextText(fs.readFileSync(contextFile, 'utf8'));
      return { source: 'SERVICE_CONTEXT.md', content };
    } catch {
      // Fall through
    }
  }
  return {
    source: 'generated',
    language: serviceInfo.language,
    framework: serviceInfo.framework,
    type: serviceInfo.type,
    entry_point: serviceInfo.entry_point,
    key_directories: serviceInfo.key_directories ?? {},
  };
}

function compactServiceContextText(value: string): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= SERVICE_CONTEXT_MAX_CHARS) {
    return normalized;
  }

  const marker = `\n\n[... service context middle omitted, ${normalized.length} chars total ...]\n\n`;
  const budget = SERVICE_CONTEXT_MAX_CHARS - marker.length;
  if (budget <= 0) {
    return normalized.slice(0, SERVICE_CONTEXT_MAX_CHARS);
  }

  const headChars = Math.ceil(budget * SERVICE_CONTEXT_COMPACTION_HEAD_RATIO);
  const tailChars = Math.max(0, budget - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}

function resolveServiceDir(
  projectDir: string,
  serviceName: string,
  serviceInfo: ServiceInfo,
): string | null {
  const rawPath = typeof serviceInfo.path === 'string' && serviceInfo.path.trim()
    ? serviceInfo.path.trim()
    : serviceName;
  const projectRoot = path.resolve(projectDir);
  const serviceDir = path.resolve(path.isAbsolute(rawPath)
    ? rawPath
    : path.join(projectRoot, rawPath));
  const relative = path.relative(projectRoot, serviceDir);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return serviceDir;
  }
  return null;
}

/** Convert internal FileMatch to the public ContextFile interface. */
function toContextFile(match: FileMatch, role: 'modify' | 'reference'): ContextFile {
  return {
    path: match.path,
    role,
    relevance: match.relevanceScore,
    snippet: match.matchingLines.length > 0
      ? match.matchingLines.map(([, line]) => line).join('\n')
      : undefined,
  };
}

/** Convert pattern map entries to CodePattern objects. */
function toCodePatterns(patterns: Record<string, string>): CodePattern[] {
  return Object.entries(patterns).map(([name, example]) => ({
    name,
    description: `Pattern discovered from codebase for: ${name.replace('_pattern', '')}`,
    example,
    files: [],
  }));
}

/** Derive ServiceMatch objects from matched files. */
function toServiceMatches(
  filesByService: Map<string, FileMatch[]>,
  projectIndex: ProjectIndex,
): ServiceMatch[] {
  const result: ServiceMatch[] = [];
  for (const [serviceName, files] of filesByService) {
    const info = projectIndex.services?.[serviceName];
    const rawType = info?.type ?? 'api';
    const type = (['api', 'database', 'queue', 'cache', 'storage'] as const).includes(
      rawType as 'api' | 'database' | 'queue' | 'cache' | 'storage',
    )
      ? (rawType as ServiceMatch['type'])
      : 'api';
    result.push({
      name: serviceName,
      type,
      relatedFiles: files.map(f => f.path),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildContextConfig {
  /** Human-readable task description used for keyword extraction and search. */
  taskDescription: string;
  /** Absolute path to the project root. */
  projectDir: string;
  /** Project data directory name, relative to the project root. */
  dataDirName?: string;
  /** Absolute path to the spec directory (unused currently, reserved for future use). */
  specDir?: string;
  /** Optional subtask identifier for targeted searches. */
  subtaskId?: string;
  /** Override auto-detected services. */
  services?: string[];
  /** Override auto-extracted keywords. */
  keywords?: string[];
  /** Whether to include memory graph hints (default true). */
  includeGraphHints?: boolean;
}

/**
 * Build context for a subtask.
 *
 * Steps:
 * 1. Auto-detect services from project index (or use provided list).
 * 2. Extract keywords from task description.
 * 3. Search each service directory for matching files.
 * 4. Categorize files (modify vs reference).
 * 5. Discover code patterns in reference files.
 * 6. Optionally fetch Graphiti graph hints.
 *
 * @returns SubtaskContext suitable for injecting into agent prompts.
 */
export async function buildContext(config: BuildContextConfig): Promise<SubtaskContext> {
  const {
    taskDescription,
    projectDir,
    dataDirName,
    services: providedServices,
    keywords: providedKeywords,
    includeGraphHints = true,
  } = config;

  const projectIndex = loadProjectIndex(projectDir, dataDirName);

  // Step 1: Determine which services to search
  const services = providedServices ?? suggestServices(taskDescription, projectIndex);

  // Step 2: Extract keywords
  const keywords = providedKeywords ?? extractKeywords(taskDescription);

  // Step 3: Search each service
  const allMatches: FileMatch[] = [];
  const filesByService = new Map<string, FileMatch[]>();
  const serviceContexts: Record<string, Record<string, unknown>> = {};

  for (const serviceName of services) {
    const serviceInfo = projectIndex.services?.[serviceName];
    if (!serviceInfo) continue;

    const serviceDir = resolveServiceDir(projectDir, serviceName, serviceInfo);
    if (!serviceDir) continue;

    const matches = searchService(serviceDir, serviceName, keywords, projectDir);
    allMatches.push(...matches);
    filesByService.set(serviceName, matches);
    serviceContexts[serviceName] = getServiceContext(serviceDir, serviceInfo);
  }

  // Step 4: Categorize
  const { toModify, toReference } = categorizeMatches(allMatches, taskDescription);

  // Step 5: Discover patterns
  const rawPatterns = discoverPatterns(projectDir, toReference, keywords);
  const patterns = toCodePatterns(rawPatterns);

  // Step 6: Graph hints (optional)
  const graphHints = includeGraphHints && isMemoryEnabled()
    ? await fetchGraphHints(taskDescription, projectDir)
    : [];

  // Compose final context
  const files: ContextFile[] = [
    ...toModify.map(m => toContextFile(m, 'modify')),
    ...toReference.map(m => toContextFile(m, 'reference')),
  ];

  const serviceMatches = toServiceMatches(filesByService, projectIndex);

  return {
    files,
    services: serviceMatches,
    patterns,
    keywords,
  };
}

/**
 * Lower-level builder that returns the full internal TaskContext representation.
 * Used when callers need access to the raw file-match data (e.g., for prompts
 * that reference files_to_modify / files_to_reference directly).
 */
export async function buildTaskContext(config: BuildContextConfig): Promise<TaskContext> {
  const {
    taskDescription,
    projectDir,
    dataDirName,
    services: providedServices,
    keywords: providedKeywords,
    includeGraphHints = true,
  } = config;

  const projectIndex = loadProjectIndex(projectDir, dataDirName);
  const services = providedServices ?? suggestServices(taskDescription, projectIndex);
  const keywords = providedKeywords ?? extractKeywords(taskDescription);

  const allMatches: FileMatch[] = [];
  const serviceContexts: Record<string, Record<string, unknown>> = {};
  const scopedServices: string[] = [];

  for (const serviceName of services) {
    const serviceInfo = projectIndex.services?.[serviceName];
    if (!serviceInfo) continue;

    const serviceDir = resolveServiceDir(projectDir, serviceName, serviceInfo);
    if (!serviceDir) continue;

    const matches = searchService(serviceDir, serviceName, keywords, projectDir);
    allMatches.push(...matches);
    scopedServices.push(serviceName);
    serviceContexts[serviceName] = getServiceContext(serviceDir, serviceInfo);
  }

  const { toModify, toReference } = categorizeMatches(allMatches, taskDescription);
  const patternsDiscovered = discoverPatterns(projectDir, toReference, keywords);

  const graphHints = includeGraphHints && isMemoryEnabled()
    ? await fetchGraphHints(taskDescription, projectDir)
    : [];

  return {
    taskDescription,
    scopedServices,
    filesToModify: toModify,
    filesToReference: toReference,
    patternsDiscovered,
    serviceContexts,
    graphHints,
  };
}
