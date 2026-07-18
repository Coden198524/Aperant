/**
 * Triage Engine
 * =============
 *
 * Issue triage logic for detecting duplicates, spam, and feature creep.
 * See apps/desktop/src/main/ai/runners/github/triage-engine.ts for the TypeScript implementation.
 *
 * Uses `createSimpleClient()` with `generateText()` for single-turn triage.
 */

import { generateText, Output } from 'ai';

import { createSimpleClient } from '../../client/factory';
import type { ModelShorthand, ThinkingLevel } from '@autocode/core';
import {
  TRIAGE_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  TriageCategory,
  buildTriageContext,
  type GitHubTriageIssue as GitHubIssue,
  type TriageProgressCallback,
  type TriageResult,
} from '@autocode/core/integrations/github';
import { parseLLMJson } from '../../schema/structured-output';
import { TriageResultSchema } from '../../schema/triage';
import { TriageResultOutputSchema } from '../../schema/output';

export {
  TriageCategory,
  buildTriageContext,
} from '@autocode/core/integrations/github';

export type {
  GitHubTriageIssue as GitHubIssue,
  TriageProgressCallback,
  TriageProgressUpdate,
  TriageResult,
} from '@autocode/core/integrations/github';

/** Configuration for triage engine. */
export interface TriageEngineConfig {
  repo: string;
  model?: ModelShorthand;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
}

// =============================================================================
// Response Parsing
// =============================================================================

function parseTriageResult(
  issue: GitHubIssue,
  text: string,
  repo: string,
): TriageResult {
  const defaults: TriageResult = {
    issueNumber: issue.number,
    repo,
    category: TriageCategory.FEATURE,
    confidence: 0.0,
    labelsToAdd: [],
    labelsToRemove: [],
    isDuplicate: false,
    duplicateOf: null,
    isSpam: false,
    isFeatureCreep: false,
    suggestedBreakdown: [],
    priority: 'medium',
    comment: null,
  };

  const validated = parseLLMJson(text, TriageResultSchema);
  if (!validated) {
    return defaults;
  }

  return {
    issueNumber: issue.number,
    repo,
    category: validated.category as TriageCategory,
    confidence: validated.confidence,
    labelsToAdd: validated.labelsToAdd,
    labelsToRemove: validated.labelsToRemove,
    isDuplicate: validated.isDuplicate,
    duplicateOf: validated.duplicateOf,
    isSpam: validated.isSpam,
    isFeatureCreep: validated.isFeatureCreep,
    suggestedBreakdown: validated.suggestedBreakdown,
    priority: validated.priority,
    comment: validated.comment,
  };
}

// =============================================================================
// Triage Engine
// =============================================================================

/**
 * Triage a single issue using AI.
 */
export async function triageSingleIssue(
  issue: GitHubIssue,
  allIssues: GitHubIssue[],
  config: TriageEngineConfig,
): Promise<TriageResult> {
  const context = buildTriageContext(issue, allIssues);
  const fullPrompt = `${TRIAGE_PROMPT}\n\n---\n\n${context}`;

  const client = await createSimpleClient({
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    modelShorthand: config.model ?? 'sonnet',
    thinkingLevel: config.thinkingLevel ?? 'low',
  });

  try {
    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt: fullPrompt,
      output: Output.object({ schema: TriageResultOutputSchema }),
    });

    if (result.output) {
      const o = result.output;
      return {
        issueNumber: issue.number,
        repo: config.repo,
        category: o.category as TriageCategory,
        confidence: o.confidence,
        labelsToAdd: o.labels_to_add,
        labelsToRemove: o.labels_to_remove,
        isDuplicate: o.is_duplicate,
        duplicateOf: o.duplicate_of,
        isSpam: o.is_spam,
        isFeatureCreep: o.is_feature_creep,
        suggestedBreakdown: o.suggested_breakdown,
        priority: o.priority,
        comment: o.comment,
      };
    }

    // Fallback for providers without constrained decoding
    return parseTriageResult(issue, result.text, config.repo);
  } catch {
    return {
      issueNumber: issue.number,
      repo: config.repo,
      category: TriageCategory.FEATURE,
      confidence: 0.0,
      labelsToAdd: [],
      labelsToRemove: [],
      isDuplicate: false,
      duplicateOf: null,
      isSpam: false,
      isFeatureCreep: false,
      suggestedBreakdown: [],
      priority: 'medium',
      comment: null,
    };
  }
}

/**
 * Triage multiple issues in batch.
 */
export async function triageBatchIssues(
  issues: GitHubIssue[],
  config: TriageEngineConfig,
  progressCallback?: TriageProgressCallback,
): Promise<TriageResult[]> {
  const results: TriageResult[] = [];

  for (let i = 0; i < issues.length; i++) {
    progressCallback?.({
      phase: 'triaging',
      progress: Math.round(((i + 1) / issues.length) * 100),
      message: `Triaging issue #${issues[i].number} (${i + 1}/${issues.length})...`,
    });

    const result = await triageSingleIssue(issues[i], issues, config);
    results.push(result);
  }

  return results;
}
