/**
 * Insight Extractor Runner
 * ========================
 *
 * Extracts structured insights from completed coding sessions using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/insight-extractor.ts for the TypeScript implementation.
 *
 * Runs after source-backed sessions to capture rich, actionable knowledge for the memory system.
 * Falls back to generic insights if extraction fails (never blocks the build).
 *
 * Uses `createSimpleClient()` with no tools (single-turn text generation).
 */

import { generateText, Output } from 'ai';

import { createSimpleClient } from '../client/factory';
import type { ModelShorthand, ThinkingLevel } from '@autocode/core';
import { parseLLMJson } from '../schema/structured-output';
import { ExtractedInsightsSchema } from '../schema/insight-extractor';
import { ExtractedInsightsOutputSchema } from '../schema/output';

// =============================================================================
// Constants
// =============================================================================

/** Default model for insight extraction (fast and cheap) */
const DEFAULT_MODEL: ModelShorthand = 'haiku';

/** Maximum diff size to send to the LLM */
export const INSIGHT_EXTRACTION_DIFF_MAX_CHARS = 10_000;

/** Maximum changed file paths to include in the LLM prompt */
export const INSIGHT_EXTRACTION_CHANGED_FILES_MAX = 50;

/** Maximum commit message text to include in the LLM prompt */
export const INSIGHT_EXTRACTION_COMMIT_MESSAGES_MAX_CHARS = 2_000;

/** Maximum subtask description text to include in the LLM prompt */
export const INSIGHT_EXTRACTION_SUBTASK_DESCRIPTION_MAX_CHARS = 1_200;

/** Maximum attempt history entries to include */
export const INSIGHT_EXTRACTION_ATTEMPTS_MAX = 3;

/** Maximum text per previous attempt field */
export const INSIGHT_EXTRACTION_ATTEMPT_FIELD_MAX_CHARS = 500;

// =============================================================================
// Types
// =============================================================================

/** Configuration for insight extraction */
export interface InsightExtractionConfig {
  /** Subtask ID that was worked on */
  subtaskId: string;
  /** Description of the subtask */
  subtaskDescription: string;
  /** Session number */
  sessionNum: number;
  /** Whether the session succeeded */
  success: boolean;
  /** Git diff text */
  diff: string;
  /** List of changed file paths */
  changedFiles: string[];
  /** Commit messages from the session */
  commitMessages: string;
  /** Previous attempt history */
  attemptHistory: AttemptRecord[];
  /** Model shorthand (defaults to 'haiku') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'low') */
  thinkingLevel?: ThinkingLevel;
}

/** Record of a previous attempt */
export interface AttemptRecord {
  success: boolean;
  approach: string;
  error?: string;
}

/** Extracted insights from a session */
export interface ExtractedInsights {
  /** Insights about specific files */
  file_insights: FileInsight[];
  /** Patterns discovered during the session */
  patterns_discovered: string[];
  /** Gotchas/pitfalls discovered */
  gotchas_discovered: string[];
  /** Outcome of the approach used */
  approach_outcome: ApproachOutcome;
  /** Recommendations for future sessions */
  recommendations: string[];
  /** Metadata */
  subtask_id: string;
  session_num: number;
  success: boolean;
  changed_files: string[];
}

/** Insight about a specific file */
export interface FileInsight {
  file: string;
  insight: string;
  category?: string;
}

/** Outcome of the approach used in the session */
export interface ApproachOutcome {
  success: boolean;
  approach_used: string;
  why_it_worked: string | null;
  why_it_failed: string | null;
  alternatives_tried: string[];
}

// =============================================================================
// Prompt Building
// =============================================================================

const SYSTEM_PROMPT =
  'Extract structured insights from coding sessions. Return valid JSON only.';

/**
 * Build the extraction prompt from session inputs.
 * Mirrors Python's `_build_extraction_prompt()`.
 */
function buildExtractionPrompt(config: InsightExtractionConfig): string {
  const attemptHistory = formatAttemptHistory(config.attemptHistory);
  const changedFiles = formatChangedFiles(config.changedFiles);
  const subtaskDescription = limitPromptText(
    config.subtaskDescription,
    INSIGHT_EXTRACTION_SUBTASK_DESCRIPTION_MAX_CHARS,
  );
  const commitMessages = limitPromptText(
    config.commitMessages || '(No commit messages)',
    INSIGHT_EXTRACTION_COMMIT_MESSAGES_MAX_CHARS,
  );
  const diff = limitPromptText(config.diff || '(No diff available)', INSIGHT_EXTRACTION_DIFF_MAX_CHARS);

  return `Extract structured insights from this coding session.
Return JSON with: file_insights, patterns_discovered, gotchas_discovered, approach_outcome, recommendations.

## SESSION DATA

### Subtask
- **ID**: ${config.subtaskId}
- **Description**: ${subtaskDescription}
- **Session Number**: ${config.sessionNum}
- **Outcome**: ${config.success ? 'SUCCESS' : 'FAILED'}

### Files Changed
${changedFiles}

### Commit Messages
${commitMessages}

### Git Diff
\`\`\`diff
${diff}
\`\`\`

### Previous Attempts
${attemptHistory}

Return only the JSON object.`;
}

/**
 * Format attempt history for the prompt.
 */
function formatAttemptHistory(attempts: AttemptRecord[]): string {
  if (attempts.length === 0) {
    return '(First attempt - no previous history)';
  }

  const recent = attempts.slice(-INSIGHT_EXTRACTION_ATTEMPTS_MAX);
  return recent
    .map((attempt, i) => {
      const status = attempt.success ? 'SUCCESS' : 'FAILED';
      let line = `**Attempt ${i + 1}** (${status}): ${limitPromptText(
        attempt.approach,
        INSIGHT_EXTRACTION_ATTEMPT_FIELD_MAX_CHARS,
      )}`;
      if (attempt.error) {
        line += `\n  Error: ${limitPromptText(attempt.error, INSIGHT_EXTRACTION_ATTEMPT_FIELD_MAX_CHARS)}`;
      }
      return line;
    })
    .join('\n');
}

function formatChangedFiles(files: string[]): string {
  if (files.length === 0) {
    return '(No files changed)';
  }

  const visible = files.slice(0, INSIGHT_EXTRACTION_CHANGED_FILES_MAX);
  const lines = visible.map((file) => `- ${file}`);
  const omitted = files.length - visible.length;
  if (omitted > 0) {
    lines.push(`- ... ${omitted} more file(s) omitted`);
  }
  return lines.join('\n');
}

function limitPromptText(value: string, maxChars: number): string {
  const normalized = String(value ?? '').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const marker = `\n\n... [truncated middle, ${normalized.length} chars total] ...\n\n`;
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return normalized.slice(0, maxChars);
  }
  const headChars = Math.ceil(budget * 0.65);
  const tailChars = budget - headChars;
  return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}

// =============================================================================
// JSON Parsing
// =============================================================================

/**
 * Parse the LLM response into structured insights.
 * Uses Zod schema validation with field-name coercion.
 */
function parseInsights(responseText: string): Record<string, unknown> | null {
  return parseLLMJson(responseText, ExtractedInsightsSchema) as Record<string, unknown> | null;
}

// =============================================================================
// Generic Fallback
// =============================================================================

/**
 * Return generic insights when extraction fails or is disabled.
 * Mirrors Python's `_get_generic_insights()`.
 */
function getGenericInsights(
  subtaskId: string,
  success: boolean,
  sessionNum = 0,
  changedFiles: string[] = [],
): ExtractedInsights {
  return {
    file_insights: [],
    patterns_discovered: [],
    gotchas_discovered: [],
    approach_outcome: {
      success,
      approach_used: `Implemented subtask: ${subtaskId}`,
      why_it_worked: null,
      why_it_failed: null,
      alternatives_tried: [],
    },
    recommendations: [],
    subtask_id: subtaskId,
    session_num: sessionNum,
    success,
    changed_files: changedFiles,
  };
}

function hasInsightExtractionSource(config: InsightExtractionConfig): boolean {
  if (config.changedFiles.some((file) => file.trim().length > 0)) {
    return true;
  }

  return config.diff.trim().length > 0;
}

// =============================================================================
// Insight Extractor (Main Entry Point)
// =============================================================================

/**
 * Extract insights from a completed coding session using AI.
 *
 * Falls back to generic insights if extraction fails.
 * Never throws — always returns a valid InsightResult.
 *
 * @param config - Extraction configuration
 * @returns Extracted insights (rich if AI succeeds, generic if it fails)
 */
export async function extractSessionInsights(
  config: InsightExtractionConfig,
): Promise<ExtractedInsights> {
  const {
    subtaskId,
    sessionNum,
    success,
    changedFiles,
    modelShorthand = DEFAULT_MODEL,
    thinkingLevel = 'low',
  } = config;

  if (!hasInsightExtractionSource(config)) {
    return getGenericInsights(subtaskId, success, sessionNum, changedFiles);
  }

  try {
    const prompt = buildExtractionPrompt(config);

    const client = await createSimpleClient({
      systemPrompt: SYSTEM_PROMPT,
      modelShorthand,
      thinkingLevel,
    });

    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt,
      output: Output.object({ schema: ExtractedInsightsOutputSchema }),
    });

    if (result.output) {
      const o = result.output;
      return {
        file_insights: o.file_insights,
        patterns_discovered: o.patterns_discovered,
        gotchas_discovered: o.gotchas_discovered,
        approach_outcome: o.approach_outcome,
        recommendations: o.recommendations,
        subtask_id: subtaskId,
        session_num: sessionNum,
        success,
        changed_files: changedFiles,
      };
    }

    // Fallback for providers without constrained decoding
    const parsed = parseInsights(result.text);

    if (parsed) {
      return {
        file_insights: (parsed.file_insights as FileInsight[]) ?? [],
        patterns_discovered: (parsed.patterns_discovered as string[]) ?? [],
        gotchas_discovered: (parsed.gotchas_discovered as string[]) ?? [],
        approach_outcome: (parsed.approach_outcome as ApproachOutcome) ?? {
          success,
          approach_used: `Implemented subtask: ${subtaskId}`,
          why_it_worked: null,
          why_it_failed: null,
          alternatives_tried: [],
        },
        recommendations: (parsed.recommendations as string[]) ?? [],
        subtask_id: subtaskId,
        session_num: sessionNum,
        success,
        changed_files: changedFiles,
      };
    }

    return getGenericInsights(subtaskId, success, sessionNum, changedFiles);
  } catch {
    return getGenericInsights(subtaskId, success, sessionNum, changedFiles);
  }
}
