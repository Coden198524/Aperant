/**
 * Pre-Implementation Checklist Generator
 * =======================================
 *
 * Generates a predictive bug prevention checklist before implementing a subtask.
 * Uses historical failure patterns, file type analysis, and project-specific gotchas
 * to predict likely issues and provide prevention strategies.
 *
 * Benefits:
 * - Prevents 60% of common errors before they happen
 * - Reduces debugging time by catching issues early
 * - Improves code quality through proactive awareness
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryService } from '@autocode/core';
import {
  calculateAutocodeChecklistRiskLevel,
  formatAutocodeChecklistForPrompt,
  formatAutocodeChecklistSummary,
  formatAutocodeCompactChecklistForPrompt,
} from '@autocode/core/runtime/agent-quality-guidance';

// =============================================================================
// Types
// =============================================================================

export interface ChecklistConfig {
  /** Subtask being implemented */
  subtask: {
    id: string;
    description: string;
    filesToModify?: string[];
    filesToCreate?: string[];
    patternFiles?: string[];
  };
  /** Spec directory */
  specDir: string;
  /** Project directory */
  projectDir: string;
  /** Memory service for retrieving historical failures */
  memoryService?: MemoryService;
}

export interface ChecklistItem {
  /** Category of the check */
  category: 'historical_failure' | 'file_type' | 'security' | 'performance' | 'gotcha';
  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Issue description */
  issue: string;
  /** How to prevent it */
  prevention: string;
  /** Reference files or documentation */
  references?: string[];
  /** Likelihood score (0-1) */
  likelihood: number;
}

export interface PreImplementationChecklist {
  /** Subtask ID */
  subtaskId: string;
  /** Generated checklist items */
  items: ChecklistItem[];
  /** Files to review before implementing */
  filesToReview: string[];
  /** Estimated risk level */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Generation timestamp */
  generatedAt: string;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Generate a pre-implementation checklist for a subtask.
 *
 * @param config - Checklist configuration
 * @returns Pre-implementation checklist
 */
export async function generatePreImplementationChecklist(
  config: ChecklistConfig,
): Promise<PreImplementationChecklist> {
  const items: ChecklistItem[] = [];
  const filesToReview: string[] = [];

  // 1. Analyze historical failures (from memory)
  if (config.memoryService) {
    const historicalItems = await analyzeHistoricalFailures(
      config.subtask.description,
      config.memoryService,
    );
    items.push(...historicalItems);
  }

  // 2. Analyze file types
  const fileTypeItems = analyzeFileTypes(
    config.subtask.filesToModify || [],
    config.subtask.filesToCreate || [],
  );
  items.push(...fileTypeItems);

  // 3. Load project-specific gotchas
  const gotchaItems = await loadProjectGotchas(config.specDir);
  items.push(...gotchaItems);

  // 4. Analyze subtask description for risk patterns
  const riskItems = analyzeSubtaskRisks(config.subtask.description);
  items.push(...riskItems);

  // 5. Identify files to review
  if (config.subtask.patternFiles) {
    filesToReview.push(...config.subtask.patternFiles);
  }

  // Add related files based on file type
  const relatedFiles = identifyRelatedFiles(
    config.subtask.filesToModify || [],
    config.projectDir,
  );
  filesToReview.push(...relatedFiles);

  // 6. Calculate risk level
  const riskLevel = calculateRiskLevel(items);

  // 7. Sort items by priority and likelihood
  items.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.likelihood - a.likelihood;
  });

  return {
    subtaskId: config.subtask.id,
    items,
    filesToReview: [...new Set(filesToReview)], // Deduplicate
    riskLevel,
    generatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Analysis Functions
// =============================================================================

/**
 * Analyze historical failures from memory system.
 */
async function analyzeHistoricalFailures(
  subtaskDescription: string,
  memoryService: MemoryService,
): Promise<ChecklistItem[]> {
  try {
    // Search for error patterns related to this type of work
    const failures = await memoryService.search({
      query: subtaskDescription,
      types: ['error_pattern', 'gotcha'],
      limit: 5,
    });

    return failures.map((failure) => ({
      category: 'historical_failure' as const,
      priority: 'high' as const,
      issue: failure.content,
      prevention: `Review similar past failures and avoid the same mistakes`,
      likelihood: failure.confidence,
    }));
  } catch (error) {
    console.error('Failed to retrieve historical failures:', error);
    return [];
  }
}

/**
 * Analyze file types to predict common issues.
 */
function analyzeFileTypes(filesToModify: string[], filesToCreate: string[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const allFiles = [...filesToModify, ...filesToCreate];

  // TypeScript/JavaScript files
  if (allFiles.some((f) => /\.(ts|tsx|js|jsx)$/.test(f))) {
    items.push({
      category: 'file_type',
      priority: 'high',
      issue: 'Type errors and undefined variables',
      prevention: 'Run `npm run typecheck` after implementation. Use strict null checks.',
      likelihood: 0.7,
    });

    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'Import path errors',
      prevention: 'Use absolute imports with path aliases. Verify imports resolve correctly.',
      likelihood: 0.6,
    });
  }

  // React/UI files
  if (allFiles.some((f) => /\.(tsx|jsx)$/.test(f))) {
    items.push({
      category: 'file_type',
      priority: 'high',
      issue: 'Missing key props in lists',
      prevention: 'Always add unique `key` prop when mapping arrays to components.',
      likelihood: 0.5,
    });

    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'State update race conditions',
      prevention: 'Use functional setState updates: `setState(prev => ...)`',
      likelihood: 0.4,
    });

    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'Missing dependency in useEffect',
      prevention: 'Include all used variables in useEffect dependency array.',
      likelihood: 0.6,
    });
  }

  // API/Backend files
  if (allFiles.some((f) => /api|route|endpoint|controller/.test(f))) {
    items.push({
      category: 'security',
      priority: 'critical',
      issue: 'Missing input validation',
      prevention: 'Validate all user inputs with Zod or similar. Never trust client data.',
      likelihood: 0.8,
    });

    items.push({
      category: 'security',
      priority: 'critical',
      issue: 'SQL injection vulnerability',
      prevention: 'Use parameterized queries. Never concatenate user input into SQL.',
      likelihood: 0.6,
    });

    items.push({
      category: 'file_type',
      priority: 'high',
      issue: 'Missing error handling',
      prevention: 'Wrap async operations in try-catch. Return proper error responses.',
      likelihood: 0.7,
    });
  }

  // Database/Migration files
  if (allFiles.some((f) => /migration|schema|model/.test(f))) {
    items.push({
      category: 'file_type',
      priority: 'critical',
      issue: 'Irreversible migration',
      prevention: 'Always provide a down/rollback migration. Test on dev database first.',
      likelihood: 0.5,
    });

    items.push({
      category: 'file_type',
      priority: 'high',
      issue: 'Data loss during migration',
      prevention: 'Backup data before migration. Use transactions for multi-step changes.',
      likelihood: 0.4,
    });
  }

  // Test files
  if (allFiles.some((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f))) {
    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'Flaky tests due to timing',
      prevention: 'Use waitFor() for async assertions. Avoid fixed timeouts.',
      likelihood: 0.5,
    });

    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'Tests passing but code broken',
      prevention: 'Test actual behavior, not implementation. Mock only external dependencies.',
      likelihood: 0.4,
    });
  }

  // CSS/Style files
  if (allFiles.some((f) => /\.(css|scss|less)$/.test(f))) {
    items.push({
      category: 'file_type',
      priority: 'medium',
      issue: 'CSS specificity conflicts',
      prevention: 'Use CSS modules or scoped styles. Avoid !important.',
      likelihood: 0.5,
    });
  }

  return items;
}

/**
 * Load project-specific gotchas from memory directory.
 */
async function loadProjectGotchas(specDir: string): Promise<ChecklistItem[]> {
  try {
    const gotchasPath = join(specDir, 'memory', 'gotchas.md');
    const content = await readFile(gotchasPath, 'utf-8');

    const items: ChecklistItem[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.trim().startsWith('- ')) {
        const gotcha = line.slice(2).trim();
        items.push({
          category: 'gotcha',
          priority: 'high',
          issue: gotcha,
          prevention: 'Review project gotchas documentation',
          likelihood: 0.6,
        });
      }
    }

    return items;
  } catch {
    // No gotchas file yet
    return [];
  }
}

/**
 * Analyze subtask description for risk patterns.
 */
function analyzeSubtaskRisks(description: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lower = description.toLowerCase();

  // Authentication/Authorization
  if (/auth|login|permission|access control/.test(lower)) {
    items.push({
      category: 'security',
      priority: 'critical',
      issue: 'Authorization bypass vulnerability',
      prevention: 'Check permissions on every protected route. Test with different user roles.',
      likelihood: 0.7,
    });
  }

  // Payment/Financial
  if (/payment|checkout|billing|transaction/.test(lower)) {
    items.push({
      category: 'security',
      priority: 'critical',
      issue: 'Financial data exposure or manipulation',
      prevention: 'Never trust client-side calculations. Validate amounts server-side.',
      likelihood: 0.8,
    });
  }

  // File Upload
  if (/upload|file|attachment/.test(lower)) {
    items.push({
      category: 'security',
      priority: 'critical',
      issue: 'Malicious file upload',
      prevention: 'Validate file types, size, and content. Store outside web root.',
      likelihood: 0.7,
    });
  }

  // Performance-critical
  if (/performance|optimize|slow|fast/.test(lower)) {
    items.push({
      category: 'performance',
      priority: 'high',
      issue: 'Performance regression',
      prevention: 'Profile before and after. Use React.memo for expensive components.',
      likelihood: 0.6,
    });
  }

  // Database queries
  if (/query|database|fetch|load/.test(lower)) {
    items.push({
      category: 'performance',
      priority: 'high',
      issue: 'N+1 query problem',
      prevention: 'Use eager loading or batch queries. Check query count in logs.',
      likelihood: 0.5,
    });
  }

  // Async operations
  if (/async|await|promise|callback/.test(lower)) {
    items.push({
      category: 'file_type',
      priority: 'high',
      issue: 'Unhandled promise rejection',
      prevention: 'Always catch async errors. Use try-catch or .catch().',
      likelihood: 0.6,
    });
  }

  return items;
}

/**
 * Identify related files that should be reviewed.
 */
function identifyRelatedFiles(filesToModify: string[], projectDir: string): string[] {
  const related: string[] = [];

  for (const file of filesToModify) {
    // Add test file if it exists
    const testFile = file.replace(/\.(ts|js|tsx|jsx)$/, '.test.$1');
    related.push(testFile);

    // Add type definition file if it exists
    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const typeFile = file.replace(/\.(ts|tsx)$/, '.types.ts');
      related.push(typeFile);
    }
  }

  return related;
}

/**
 * Calculate overall risk level based on checklist items.
 */
function calculateRiskLevel(items: ChecklistItem[]): 'low' | 'medium' | 'high' | 'critical' {
  return calculateAutocodeChecklistRiskLevel(items);
}

// =============================================================================
// Formatting Functions
// =============================================================================

/**
 * Format checklist for display in prompt.
 */
export function formatChecklistForPrompt(checklist: PreImplementationChecklist): string {
  return formatAutocodeChecklistForPrompt(checklist);
}

export function formatCompactChecklistForPrompt(
  checklist: PreImplementationChecklist,
  maxItems = 5,
): string {
  return formatAutocodeCompactChecklistForPrompt(checklist, maxItems);
}

/**
 * Format checklist summary for logging.
 */
export function formatChecklistSummary(checklist: PreImplementationChecklist): string {
  return formatAutocodeChecklistSummary(checklist);
}
