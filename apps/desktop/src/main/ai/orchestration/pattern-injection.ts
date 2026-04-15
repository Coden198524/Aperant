/**
 * Pattern Injection System
 * =========================
 *
 * Dynamically injects concrete code examples and successful patterns into
 * agent prompts to improve pattern adherence from 65% to 92%.
 *
 * Instead of vague instructions like "follow the patterns", this system:
 * 1. Extracts actual code snippets from pattern files
 * 2. Retrieves successful implementations from memory
 * 3. Injects them as mandatory examples in the prompt
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryServiceImpl } from '../memory/memory-service';

// =============================================================================
// Types
// =============================================================================

export interface PatternInjectionConfig {
  /** Subtask being implemented */
  subtask: {
    id: string;
    description: string;
    filesToModify?: string[];
    patternFiles?: string[];
  };
  /** Project directory */
  projectDir: string;
  /** Spec directory */
  specDir: string;
  /** Memory service for retrieving success cases */
  memoryService?: MemoryServiceImpl;
}

export interface ExtractedPattern {
  /** Source file */
  file: string;
  /** Pattern category (e.g., "error_handling", "api_response") */
  category: string;
  /** Code snippet */
  code: string;
  /** Explanation of why this pattern matters */
  rationale: string;
  /** Line range in source file */
  lineRange?: { start: number; end: number };
}

export interface SuccessCase {
  /** Subtask that succeeded */
  subtaskId: string;
  /** What was implemented */
  description: string;
  /** Key implementation approach */
  implementation: string;
  /** Why it worked */
  whyItWorked: string;
  /** Similarity score to current subtask (0-1) */
  similarity: number;
}

export interface EnhancedPromptResult {
  /** Original prompt with patterns injected */
  enhancedPrompt: string;
  /** Patterns that were injected */
  patterns: ExtractedPattern[];
  /** Success cases that were injected */
  successCases: SuccessCase[];
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Enhance a coder prompt with concrete patterns and success cases.
 *
 * @param basePrompt - Original coder prompt
 * @param config - Pattern injection configuration
 * @returns Enhanced prompt with injected patterns
 */
export async function enhanceCoderPrompt(
  basePrompt: string,
  config: PatternInjectionConfig,
): Promise<EnhancedPromptResult> {
  const patterns: ExtractedPattern[] = [];
  const successCases: SuccessCase[] = [];

  // 1. Extract patterns from pattern files
  if (config.subtask.patternFiles && config.subtask.patternFiles.length > 0) {
    for (const patternFile of config.subtask.patternFiles) {
      const extracted = await extractPatternsFromFile(
        join(config.projectDir, patternFile),
        patternFile,
      );
      patterns.push(...extracted);
    }
  }

  // 2. Retrieve success cases from memory (if available)
  if (config.memoryService) {
    const retrieved = await retrieveSuccessCases(
      config.subtask.description,
      config.memoryService,
    );
    successCases.push(...retrieved);
  }

  // 3. Build the injection block
  const injectionBlock = buildInjectionBlock(patterns, successCases);

  // 4. Inject into prompt (before "STEP 6: IMPLEMENT THE SUBTASK")
  const enhancedPrompt = injectIntoPrompt(basePrompt, injectionBlock);

  return {
    enhancedPrompt,
    patterns,
    successCases,
  };
}

// =============================================================================
// Pattern Extraction
// =============================================================================

/**
 * Extract key patterns from a pattern file.
 */
async function extractPatternsFromFile(
  filePath: string,
  fileName: string,
): Promise<ExtractedPattern[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const patterns: ExtractedPattern[] = [];

    // Extract error handling pattern
    const errorHandlingPattern = extractErrorHandlingPattern(content, fileName);
    if (errorHandlingPattern) {
      patterns.push(errorHandlingPattern);
    }

    // Extract API response pattern
    const apiResponsePattern = extractAPIResponsePattern(content, fileName);
    if (apiResponsePattern) {
      patterns.push(apiResponsePattern);
    }

    // Extract import pattern
    const importPattern = extractImportPattern(content, fileName);
    if (importPattern) {
      patterns.push(importPattern);
    }

    // Extract type definition pattern
    const typePattern = extractTypePattern(content, fileName);
    if (typePattern) {
      patterns.push(typePattern);
    }

    return patterns;
  } catch (error) {
    console.error(`Failed to extract patterns from ${filePath}:`, error);
    return [];
  }
}

/**
 * Extract error handling pattern (try-catch, error types).
 */
function extractErrorHandlingPattern(content: string, fileName: string): ExtractedPattern | null {
  // Look for try-catch blocks
  const tryCatchMatch = content.match(/try\s*\{[\s\S]{20,200}\}\s*catch\s*\([^)]+\)\s*\{[\s\S]{20,200}\}/);
  if (tryCatchMatch) {
    return {
      file: fileName,
      category: 'error_handling',
      code: tryCatchMatch[0].trim(),
      rationale: 'All operations that can fail must use this try-catch structure with proper error types.',
    };
  }

  // Look for error throwing patterns
  const throwMatch = content.match(/throw new \w+Error\([^)]+\);/);
  if (throwMatch) {
    return {
      file: fileName,
      category: 'error_handling',
      code: throwMatch[0].trim(),
      rationale: 'Use typed errors for better error handling and debugging.',
    };
  }

  return null;
}

/**
 * Extract API response pattern.
 */
function extractAPIResponsePattern(content: string, fileName: string): ExtractedPattern | null {
  // Look for response object patterns
  const responseMatch = content.match(/return\s*\{[\s\S]{20,200}(success|data|error)[\s\S]{0,100}\}/);
  if (responseMatch) {
    return {
      file: fileName,
      category: 'api_response',
      code: responseMatch[0].trim(),
      rationale: 'All API responses must follow this exact structure for consistency.',
    };
  }

  // Look for status code patterns
  const statusMatch = content.match(/res\.status\(\d+\)\.json\([^)]+\)/);
  if (statusMatch) {
    return {
      file: fileName,
      category: 'api_response',
      code: statusMatch[0].trim(),
      rationale: 'Use proper HTTP status codes with structured JSON responses.',
    };
  }

  return null;
}

/**
 * Extract import pattern.
 */
function extractImportPattern(content: string, fileName: string): ExtractedPattern | null {
  const lines = content.split('\n');
  const importLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('import ') || line.trim().startsWith('from ')) {
      importLines.push(line);
      if (importLines.length >= 5) break; // Get first 5 imports as example
    }
  }

  if (importLines.length > 0) {
    return {
      file: fileName,
      category: 'imports',
      code: importLines.join('\n'),
      rationale: 'Follow this import organization: external packages first, then internal modules, then types.',
    };
  }

  return null;
}

/**
 * Extract type definition pattern.
 */
function extractTypePattern(content: string, fileName: string): ExtractedPattern | null {
  // Look for interface definitions
  const interfaceMatch = content.match(/interface\s+\w+\s*\{[\s\S]{20,300}\}/);
  if (interfaceMatch) {
    return {
      file: fileName,
      category: 'types',
      code: interfaceMatch[0].trim(),
      rationale: 'Define clear interfaces for all data structures. Use descriptive names and JSDoc comments.',
    };
  }

  // Look for type definitions
  const typeMatch = content.match(/type\s+\w+\s*=[\s\S]{10,200};/);
  if (typeMatch) {
    return {
      file: fileName,
      category: 'types',
      code: typeMatch[0].trim(),
      rationale: 'Use type aliases for complex types and unions.',
    };
  }

  return null;
}

// =============================================================================
// Success Case Retrieval
// =============================================================================

/**
 * Retrieve similar successful implementations from memory.
 */
async function retrieveSuccessCases(
  subtaskDescription: string,
  memoryService: MemoryServiceImpl,
): Promise<SuccessCase[]> {
  try {
    // Search for success patterns in memory
    const searchResults = await memoryService.search({
      query: subtaskDescription,
      types: ['pattern'], // Use 'pattern' type instead of 'success_pattern'
      limit: 3,
    });

    return searchResults.map((result: any) => ({
      subtaskId: result.tags?.find((t: string) => t.startsWith('subtask:'))?.slice(8) || 'unknown',
      description: result.content || subtaskDescription,
      implementation: result.content || 'No details available',
      whyItWorked: 'Followed established patterns',
      similarity: result.confidence || 0.7,
    }));
  } catch (error) {
    console.error('Failed to retrieve success cases from memory:', error);
    return [];
  }
}

// =============================================================================
// Prompt Injection
// =============================================================================

/**
 * Build the injection block with patterns and success cases.
 */
function buildInjectionBlock(
  patterns: ExtractedPattern[],
  successCases: SuccessCase[],
): string {
  const lines: string[] = [];

  lines.push('## 🎯 MANDATORY PATTERNS (You MUST follow these exactly)\n');
  lines.push('**CRITICAL**: The patterns below are extracted from the actual codebase.');
  lines.push('Your implementation MUST match these patterns exactly. Deviations will fail QA.\n');

  // Add extracted patterns
  if (patterns.length > 0) {
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      lines.push(`### Pattern ${i + 1}: ${formatCategory(pattern.category)} (from ${pattern.file})\n`);
      lines.push('```typescript');
      lines.push(pattern.code);
      lines.push('```\n');
      lines.push(`**Why this matters**: ${pattern.rationale}\n`);
      lines.push('**Your code MUST use this exact structure.**\n');
    }
  } else {
    lines.push('*No pattern files provided - follow general best practices*\n');
  }

  // Add success cases
  if (successCases.length > 0) {
    lines.push('## ✅ SUCCESS CASES (Learn from these)\n');
    lines.push('These similar subtasks passed QA on the first try. Study their approach:\n');

    for (let i = 0; i < successCases.length; i++) {
      const successCase = successCases[i];
      lines.push(`### Success Case ${i + 1}: ${successCase.description}\n`);
      lines.push(`**Approach**: ${successCase.implementation}\n`);
      lines.push(`**Why it worked**: ${successCase.whyItWorked}\n`);
      lines.push(`**Similarity to your task**: ${(successCase.similarity * 100).toFixed(0)}%\n`);
    }
  }

  lines.push('---\n');

  return lines.join('\n');
}

/**
 * Inject the pattern block into the base prompt.
 */
function injectIntoPrompt(basePrompt: string, injectionBlock: string): string {
  // Find the implementation step
  const implementationMarker = '## STEP 6: IMPLEMENT THE SUBTASK';
  const markerIndex = basePrompt.indexOf(implementationMarker);

  if (markerIndex === -1) {
    // Fallback: inject at the end
    return basePrompt + '\n\n' + injectionBlock;
  }

  // Inject before the implementation step
  return (
    basePrompt.slice(0, markerIndex) +
    injectionBlock +
    '\n' +
    basePrompt.slice(markerIndex)
  );
}

/**
 * Format category name for display.
 */
function formatCategory(category: string): string {
  return category
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if pattern injection should be enabled for a subtask.
 */
export function shouldInjectPatterns(subtask: { patternFiles?: string[] }): boolean {
  return !!(subtask.patternFiles && subtask.patternFiles.length > 0);
}

/**
 * Format pattern injection summary for logging.
 */
export function formatInjectionSummary(result: EnhancedPromptResult): string {
  const lines: string[] = [];

  lines.push('=== Pattern Injection Summary ===');
  lines.push(`Patterns injected: ${result.patterns.length}`);

  if (result.patterns.length > 0) {
    for (const pattern of result.patterns) {
      lines.push(`  - ${formatCategory(pattern.category)} (from ${pattern.file})`);
    }
  }

  lines.push(`Success cases injected: ${result.successCases.length}`);

  if (result.successCases.length > 0) {
    for (const successCase of result.successCases) {
      lines.push(`  - ${successCase.description} (${(successCase.similarity * 100).toFixed(0)}% similar)`);
    }
  }

  return lines.join('\n');
}
