/**
 * Conversation Compactor
 * ======================
 *
 * Summarizes phase outputs to maintain continuity between phases while
 * reducing token usage. After each phase completes, key findings are
 * summarized and passed as context to subsequent phases.
 *
 * See apps/desktop/src/main/ai/spec/conversation-compactor.ts for the TypeScript implementation.
 */

import { generateText } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum input chars to send for summarization */
export const MAX_INPUT_CHARS = 10000;

/** Maximum chars per file before truncation */
export const MAX_FILE_CHARS = 6000;

/** Maximum formatted previous-phase context injected into later prompts */
export const MAX_PHASE_SUMMARIES_CONTEXT_CHARS = 8000;

/** Maximum chars kept per previous phase summary */
export const MAX_PHASE_SUMMARY_ITEM_CHARS = 1800;

/** Default target summary length in words */
const DEFAULT_TARGET_WORDS = 300;

/** Maps phases to the output files they produce */
const PHASE_OUTPUT_FILES: Record<string, string[]> = {
  discovery: ['context.md'],
  requirements: ['requirements.md'],
  research: ['research.md'],
  context: ['context.md'],
  quick_spec: ['spec.md'],
  spec_writing: ['spec.md'],
  self_critique: ['spec.md', 'critique_notes.md'],
  planning: ['implementation_plan.md'],
  validation: [],
};

const COMPACTOR_SYSTEM_PROMPT =
  'Summarize phase outputs into concise bullets. Focus on decisions, discoveries, constraints, and actionable insights.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gather output files from a completed phase for summarization.
 * Ported from: `gather_phase_outputs()` in compaction.py
 */
export function gatherPhaseOutputs(specDir: string, phaseName: string): string {
  const outputFiles = PHASE_OUTPUT_FILES[phaseName] ?? [];
  const outputs: string[] = [];

  for (const filename of outputFiles) {
    const filePath = join(specDir, filename);
    if (!existsSync(filePath)) continue;

    try {
      const content = compactPhaseFileContent(readFileSync(filePath, 'utf-8'), MAX_FILE_CHARS);
      outputs.push(`**${filename}**:\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      // Skip unreadable files
    }
  }

  return outputs.join('\n\n');
}

/**
 * Format accumulated phase summaries for injection into agent context.
 * Ported from: `format_phase_summaries()` in compaction.py
 */
export function formatPhaseSummaries(summaries: Record<string, string>): string {
  const entries = Object.entries(summaries);
  if (entries.length === 0) {
    return '';
  }

  const formattedEntries = entries.map(([phaseName, summary]) => {
    const title = phaseName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const compactSummary = compactPhaseSummaryForPrompt(summary, MAX_PHASE_SUMMARY_ITEM_CHARS);
    return {
      phaseName,
      text: `### ${title}\n${compactSummary}\n`,
    };
  });

  const selected: typeof formattedEntries = [];
  const headerLength = '## Context from Previous Phases\n\n'.length;
  const omittedNoticeReserve = 160;
  let remaining = Math.max(0, MAX_PHASE_SUMMARIES_CONTEXT_CHARS - headerLength - omittedNoticeReserve);
  let omitted = 0;

  for (const entry of formattedEntries.slice().reverse()) {
    const cost = entry.text.length + 1;
    if (cost > remaining) {
      omitted += 1;
      continue;
    }
    selected.push(entry);
    remaining -= cost;
  }

  selected.reverse();
  const parts = ['## Context from Previous Phases\n'];
  if (omitted > 0) {
    parts.push(`> ${omitted} older phase summary/summaries omitted to stay within the prompt budget.\n`);
  }
  for (const entry of selected) {
    parts.push(entry.text);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize phase output to a concise summary for subsequent phases.
 * Ported from: `summarize_phase_output()` in compaction.py
 *
 * Uses a lightweight model for cost efficiency (Haiku default).
 *
 * @param phaseName - Name of the completed phase (e.g., 'discovery', 'requirements')
 * @param phaseOutput - Full output content from the phase (file contents, decisions)
 * @param targetWords - Target summary length in words (~500-1000 recommended)
 * @returns Concise summary of key findings, decisions, and insights from the phase
 */
export async function summarizePhaseOutput(
  phaseName: string,
  phaseOutput: string,
  targetWords = DEFAULT_TARGET_WORDS,
): Promise<string> {
  const truncatedOutput = compactPhaseOutputForSummarization(phaseOutput, MAX_INPUT_CHARS);

  const prompt = `Summarize the "${phaseName}" phase in ${targetWords} words or less.

Include only information subsequent phases need:
- Key decisions made and their rationale
- Critical files, components, or patterns identified
- Important constraints or requirements discovered
- Actionable insights for implementation

Use concise bullets. Skip boilerplate and meta-commentary.

## Phase Output:
${truncatedOutput}

## Summary:
`;

  try {
    const client = await createSimpleClient({
      systemPrompt: COMPACTOR_SYSTEM_PROMPT,
      modelShorthand: 'haiku',
      thinkingLevel: 'low',
    });

    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt,
    });

    if (result.text.trim()) {
      return result.text.trim();
    }
  } catch (error: unknown) {
    // Fallback: return truncated raw output on error
    const fallback = compactPhaseOutputForSummarization(phaseOutput, 2000);
    const errMsg = error instanceof Error ? error.message : String(error);
    return `[Summarization failed: ${errMsg}]\n\n${fallback}`;
  }

  // Empty response fallback
  return compactPhaseOutputForSummarization(phaseOutput, 1000);
}

export function compactPhaseFileContent(content: string, maxChars = MAX_FILE_CHARS): string {
  return compactHeadTailText(
    content,
    maxChars,
    (length) => `\n\n[... file middle omitted, ${length} chars total ...]\n\n`,
  );
}

export function compactPhaseOutputForSummarization(content: string, maxChars = MAX_INPUT_CHARS): string {
  return compactHeadTailText(
    content,
    maxChars,
    (length) => `\n\n[... output middle omitted for summarization, ${length} chars total ...]\n\n`,
  );
}

export function compactPhaseSummaryForPrompt(content: string, maxChars = MAX_PHASE_SUMMARY_ITEM_CHARS): string {
  return compactHeadTailText(
    content,
    maxChars,
    (length) => `\n\n[... phase summary middle omitted, ${length} chars total ...]\n\n`,
  );
}

function compactHeadTailText(
  value: string,
  maxChars: number,
  markerFactory: (length: number) => string,
): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const marker = markerFactory(normalized.length);
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }

  const bodyBudget = maxChars - marker.length;
  const headBudget = Math.ceil(bodyBudget * 0.6);
  const tailBudget = Math.max(0, bodyBudget - headBudget);
  return [
    normalized.slice(0, headBudget).trimEnd(),
    marker.trimEnd(),
    normalized.slice(Math.max(0, normalized.length - tailBudget)).trimStart(),
  ].join('\n');
}

/**
 * Compact a completed phase by gathering its outputs and summarizing them.
 *
 * This is the main entry point used by the spec orchestrator after each phase.
 *
 * @param specDir - Path to the spec directory
 * @param phaseName - Name of the completed phase
 * @param targetWords - Target summary length in words
 * @returns Summary string (empty string if phase has no outputs to summarize)
 */
export async function compactPhase(
  specDir: string,
  phaseName: string,
  targetWords = DEFAULT_TARGET_WORDS,
): Promise<string> {
  const phaseOutput = gatherPhaseOutputs(specDir, phaseName);

  if (!phaseOutput) {
    return '';
  }

  return summarizePhaseOutput(phaseName, phaseOutput, targetWords);
}
