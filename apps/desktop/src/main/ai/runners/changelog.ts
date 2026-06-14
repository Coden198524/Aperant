/**
 * Changelog Runner
 * ================
 *
 * AI-powered changelog generation using Vercel AI SDK.
 * Provides the AI generation logic previously handled by the Claude CLI subprocess
 * in apps/desktop/src/main/changelog/generator.ts.
 *
 * Supports multiple source modes: tasks (specs), git history, or branch diffs.
 *
 * Uses `createSimpleClient()` with no tools (single-turn text generation).
 */

import { generateText } from 'ai';

import { createSimpleClient } from '../client/factory';
import type { ModelShorthand, ThinkingLevel } from '@autocode/core';

// =============================================================================
// Types
// =============================================================================

/** A task entry for changelog generation */
export interface ChangelogTask {
  /** Task title */
  title: string;
  /** Task description or spec overview */
  description: string;
  /** Task category (feature, bug_fix, refactoring, etc.) */
  category?: string;
  /** GitHub/GitLab issue number if linked */
  issueNumber?: number;
}

/** Configuration for changelog generation */
export interface ChangelogConfig {
  /** Project name */
  projectName: string;
  /** Version string (e.g., "1.2.0") */
  version: string;
  /** Source mode for changelog content */
  sourceMode: 'tasks' | 'git-history' | 'branch-diff';
  /** Tasks/specs to include (for 'tasks' mode) */
  tasks?: ChangelogTask[];
  /** Git commit messages (for 'git-history' or 'branch-diff' modes) */
  commits?: string;
  /** Previous changelog content for style matching */
  previousChangelog?: string;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'low') */
  thinkingLevel?: ThinkingLevel;
}

/** Result of changelog generation */
export interface ChangelogResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Generated changelog markdown text */
  text: string;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Prompt Building
// =============================================================================

export const CHANGELOG_TASKS_MAX = 60;
export const CHANGELOG_TASK_TITLE_MAX_CHARS = 160;
export const CHANGELOG_TASK_DESCRIPTION_MAX_CHARS = 500;
export const CHANGELOG_COMMITS_MAX_CHARS = 4_000;
export const CHANGELOG_PREVIOUS_CHANGELOG_MAX_CHARS = 1_500;
export const CHANGELOG_PROJECT_NAME_MAX_CHARS = 120;
export const CHANGELOG_VERSION_MAX_CHARS = 80;

const SYSTEM_PROMPT = `Write clear, professional changelogs.

Rules:
1. Use Keep a Changelog format (https://keepachangelog.com/)
2. Group changes by type: Added, Changed, Deprecated, Removed, Fixed, Security
3. Write concise, user-facing descriptions (not implementation details)
4. Use past tense ("Added dark mode" not "Add dark mode")
5. Reference issue numbers where available
6. Keep entries actionable and meaningful to end users

Output only changelog markdown.`;

function normalizePromptText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitPromptText(value: string, maxChars: number): string {
  const normalized = normalizePromptText(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const suffix = `... [truncated, ${normalized.length} chars total]`;
  const budget = Math.max(0, maxChars - suffix.length);
  return `${normalized.slice(0, budget).trimEnd()}${suffix}`;
}

function formatChangelogTask(task: ChangelogTask): string {
  let entry = `- **${limitPromptText(task.title, CHANGELOG_TASK_TITLE_MAX_CHARS)}**`;
  if (task.category) entry += ` [${limitPromptText(task.category, 40)}]`;
  if (task.issueNumber) entry += ` (#${task.issueNumber})`;
  const description = limitPromptText(task.description, CHANGELOG_TASK_DESCRIPTION_MAX_CHARS);
  if (description) {
    entry += `\n  ${description}`;
  }
  return entry;
}

/**
 * Build the user prompt for changelog generation based on source mode.
 */
function buildChangelogPrompt(config: ChangelogConfig): string {
  const parts: string[] = [];
  parts.push(
    `Generate a changelog entry for **${limitPromptText(config.projectName, CHANGELOG_PROJECT_NAME_MAX_CHARS)}** ${limitPromptText(config.version, CHANGELOG_VERSION_MAX_CHARS)}.`,
  );

  if (config.sourceMode === 'tasks' && config.tasks && config.tasks.length > 0) {
    parts.push('\n## Completed Tasks\n');
    for (const task of config.tasks.slice(0, CHANGELOG_TASKS_MAX)) {
      parts.push(formatChangelogTask(task));
    }
    if (config.tasks.length > CHANGELOG_TASKS_MAX) {
      parts.push(`- ... ${config.tasks.length - CHANGELOG_TASKS_MAX} additional completed tasks omitted from the prompt budget.`);
    }
  } else if (config.commits) {
    parts.push(`\n## Git ${config.sourceMode === 'branch-diff' ? 'Branch Diff' : 'History'}\n`);
    parts.push('```');
    parts.push(limitPromptText(config.commits, CHANGELOG_COMMITS_MAX_CHARS));
    parts.push('```');
  }

  if (config.previousChangelog) {
    parts.push('\n## Previous Changelog (for style reference)\n');
    parts.push(limitPromptText(config.previousChangelog, CHANGELOG_PREVIOUS_CHANGELOG_MAX_CHARS));
  }

  parts.push('\nOutput only this version\'s changelog markdown.');
  return parts.join('\n');
}

// =============================================================================
// Changelog Generator
// =============================================================================

/**
 * Generate a changelog entry using AI.
 *
 * @param config - Changelog generation configuration
 * @returns Generated changelog result
 */
export async function generateChangelog(
  config: ChangelogConfig,
): Promise<ChangelogResult> {
  const {
    modelShorthand = 'sonnet',
    thinkingLevel = 'low',
  } = config;

  const prompt = buildChangelogPrompt(config);

  try {
    const client = await createSimpleClient({
      systemPrompt: SYSTEM_PROMPT,
      modelShorthand,
      thinkingLevel,
    });

    const result = await generateText({
      model: client.model,
      system: client.systemPrompt,
      prompt,
    });

    if (result.text.trim()) {
      return { success: true, text: result.text.trim() };
    }

    return { success: false, text: '', error: 'Empty response from AI' };
  } catch (error) {
    return {
      success: false,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
