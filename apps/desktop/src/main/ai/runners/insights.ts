/**
 * Insights Runner
 * ===============
 *
 * AI chat for codebase insights using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/insights.ts for the TypeScript implementation.
 *
 * Provides an AI-powered chat interface for asking questions about a codebase.
 * Can also suggest tasks based on the conversation.
 *
 * Uses `createSimpleClient()` with read-only tools (Read, Glob, Grep) and streaming.
 */

import { streamText, stepCountIs } from 'ai';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { createSimpleClient } from '../client/factory';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import {
  buildAutocodeProjectDocsReferencePrompt,
  getAutocodeRoadmapFilePath,
  getAutocodeSpecsDir,
  type ModelShorthand,
  type ThinkingLevel,
} from '@autocode/core';
import type { SecurityProfile } from '../security/bash-validator';
import { safeParseJson } from '../../utils/json-repair';
import { parseLLMJson } from '../schema/structured-output';
import { TaskSuggestionSchema } from '../schema/insight-extractor';

// =============================================================================
// Types
// =============================================================================

/** A message in the insights conversation history */
export interface InsightsMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Configuration for running an insights query */
export interface InsightsConfig {
  /** Project directory path */
  projectDir: string;
  /** User message to process */
  message: string;
  /** Previous conversation history */
  history?: InsightsMessage[];
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Project data directory name (defaults to .autocode) */
  dataDirName?: string;
}

/** Result of an insights query */
export interface InsightsResult {
  /** Full response text */
  text: string;
  /** Task suggestion if detected, or null */
  taskSuggestion: TaskSuggestion | null;
  /** Tool calls made during the session */
  toolCalls: ToolCallInfo[];
}

/** A task suggestion extracted from the response */
export interface TaskSuggestion {
  title: string;
  description: string;
  metadata: {
    category: string;
    complexity: string;
    impact: string;
  };
}

/** Info about a tool call made during the session */
export interface ToolCallInfo {
  name: string;
  input: string;
}

/** Callback for streaming events from the insights runner */
export type InsightsStreamCallback = (event: InsightsStreamEvent) => void;

/** Events emitted during insights streaming */
export type InsightsStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; input: string }
  | { type: 'tool-end'; name: string }
  | { type: 'error'; error: string };

export const INSIGHTS_PROJECT_DOCS_REFERENCE_MAX_BYTES = 6_000;
export const INSIGHTS_HISTORY_MAX_MESSAGES = 8;
export const INSIGHTS_HISTORY_MAX_CHARS = 4_000;
export const INSIGHTS_HISTORY_MESSAGE_MAX_CHARS = 700;
export const INSIGHTS_CURRENT_MESSAGE_MAX_CHARS = 6_000;

function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

// =============================================================================
// Project Context Loading
// =============================================================================

/**
 * Load project context for the AI.
 * Mirrors Python's `load_project_context()`.
 */
function loadProjectContext(projectDir: string, dataDirName?: string): string {
  const contextParts: string[] = [];

  // Load generated project documentation if available.
  const projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
    projectRoot: projectDir,
    dataDirName,
    maxBytes: INSIGHTS_PROJECT_DOCS_REFERENCE_MAX_BYTES,
  });
  if (projectDocsReference) {
    contextParts.push(projectDocsReference);
  }

  // Load roadmap if available
  const roadmapPath = getAutocodeRoadmapFilePath(projectDir, dataDirName);
  if (existsSync(roadmapPath)) {
    const roadmap = safeParseJson<Record<string, unknown>>(readFileSync(roadmapPath, 'utf-8'));
    if (roadmap) {
      const features = ((roadmap.features as Record<string, unknown>[]) ?? []).slice(0, 10);
      const featureSummary = features.map((f: Record<string, unknown>) => ({
        title: f.title ?? '',
        status: f.status ?? '',
      }));
      contextParts.push(
        `## Roadmap Features\n\`\`\`json\n${JSON.stringify(featureSummary, null, 2)}\n\`\`\``,
      );
    }
  }

  // Load existing tasks
  const tasksPath = getAutocodeSpecsDir({ projectRoot: projectDir, dataDirName });
  if (existsSync(tasksPath)) {
    try {
      const taskDirs = readdirSync(tasksPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 10);
      if (taskDirs.length > 0) {
        contextParts.push(`## Existing Tasks/Specs\n- ${taskDirs.join('\n- ')}`);
      }
    } catch {
      // Ignore read errors
    }
  }

  return contextParts.length > 0
    ? contextParts.join('\n\n')
    : 'No project context available yet.';
}

/**
 * Build the system prompt for the insights agent.
 * Mirrors Python's `build_system_prompt()`.
 */
function buildSystemPrompt(projectDir: string, dataDirName?: string): string {
  const context = loadProjectContext(projectDir, dataDirName);

  return `Help developers understand and work with this codebase.

Project context:
${context}

Use this context to answer architecture, pattern, planning, improvement, and code explanation questions.

When creating a task would help, include this single-line suggestion:
__TASK_SUGGESTION__:{"title": "Task title here", "description": "Detailed description of what the task involves", "metadata": {"category": "feature", "complexity": "medium", "impact": "medium"}}

Valid categories: feature, bug_fix, refactoring, documentation, security, performance, ui_ux, infrastructure, testing
Valid complexity: trivial, small, medium, large, complex
Valid impact: low, medium, high, critical

Be concise, actionable, and clear.`;
}

// =============================================================================
// Task Suggestion Extraction
// =============================================================================

const TASK_SUGGESTION_PREFIX = '__TASK_SUGGESTION__:';

/**
 * Extract a task suggestion from the response text if present.
 */
function extractTaskSuggestion(text: string): TaskSuggestion | null {
  const idx = text.indexOf(TASK_SUGGESTION_PREFIX);
  if (idx === -1) return null;

  // Find the JSON on the same line
  const afterPrefix = text.substring(idx + TASK_SUGGESTION_PREFIX.length);
  const lineEnd = afterPrefix.indexOf('\n');
  const jsonStr = lineEnd === -1 ? afterPrefix.trim() : afterPrefix.substring(0, lineEnd).trim();

  const validated = parseLLMJson(jsonStr, TaskSuggestionSchema);
  if (validated && validated.title && validated.description) {
    return validated as TaskSuggestion;
  }

  return null;
}

// =============================================================================
// Insights Runner
// =============================================================================

/**
 * Run an insights chat query with streaming.
 *
 * @param config - Insights query configuration
 * @param onStream - Optional callback for streaming events
 * @returns Insights result with text, task suggestion, and tool call info
 */
export async function runInsightsQuery(
  config: InsightsConfig,
  onStream?: InsightsStreamCallback,
): Promise<InsightsResult> {
  const {
    projectDir,
    message,
    history = [],
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    abortSignal,
    dataDirName,
  } = config;

  const systemPrompt = buildSystemPrompt(projectDir, dataDirName);

  const fullPrompt = buildInsightsPrompt(message, history);

  // Create tool context for read-only tools
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: getAutocodeSpecsDir({ projectRoot: projectDir, dataDirName }),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  // Bind tools via registry (insights agent gets Read, Glob, Grep)
  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('insights', toolContext);

  // Create simple client with tools
  const client = await createSimpleClient({
    systemPrompt,
    modelShorthand,
    thinkingLevel,
    maxSteps: 30, // Allow sufficient turns for codebase exploration
    tools,
  });

  const toolCalls: ToolCallInfo[] = [];
  let responseText = '';

  // Responses models require instructions via providerOptions, not system.
  const insightsModelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isResponsesInsights = isResponsesApiModel(insightsModelId);

  try {
    const result = streamText({
      model: client.model,
      system: isResponsesInsights ? undefined : client.systemPrompt,
      prompt: fullPrompt,
      tools: client.tools,
      stopWhen: stepCountIs(client.maxSteps),
      abortSignal,
      ...(isResponsesInsights ? {
        providerOptions: {
          openai: {
            ...(client.systemPrompt ? { instructions: client.systemPrompt } : {}),
            store: false,
          },
        },
      } : {}),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          responseText += part.text;
          onStream?.({ type: 'text-delta', text: part.text });
          break;
        }
        case 'tool-call': {
          const args = 'input' in part ? (part.input as Record<string, unknown>) : {};
          const input = extractToolInput(args);
          toolCalls.push({ name: part.toolName, input });
          onStream?.({ type: 'tool-start', name: part.toolName, input });
          break;
        }
        case 'tool-result': {
          onStream?.({ type: 'tool-end', name: part.toolName });
          break;
        }
        case 'error': {
          const errorMsg = part.error instanceof Error ? part.error.message : String(part.error);
          onStream?.({ type: 'error', error: errorMsg });
          break;
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    onStream?.({ type: 'error', error: errorMsg });
    throw error;
  }

  const taskSuggestion = extractTaskSuggestion(responseText);

  return {
    text: responseText,
    taskSuggestion,
    toolCalls,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function buildInsightsPrompt(message: string, history: InsightsMessage[]): string {
  const currentMessage = compactCurrentMessage(message);
  if (history.length === 0) {
    return currentMessage;
  }

  const recentHistory = history.slice(-INSIGHTS_HISTORY_MAX_MESSAGES);
  const conversationContext = buildCompactConversationContext(recentHistory);
  const historyLabel = history.length > recentHistory.length
    ? `up to ${recentHistory.length} most recent of ${history.length} messages`
    : 'recent messages';

  return `Previous conversation (${historyLabel}, compacted):\n${conversationContext}\n\nCurrent question: ${currentMessage}`;
}

function buildCompactConversationContext(history: InsightsMessage[]): string {
  const formatted = history.map((msg) => (
    `${msg.role === 'user' ? 'User' : 'Assistant'}: ${compactHistoryMessage(msg.content)}`
  ));
  const kept: string[] = [];
  let omitted = 0;

  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    const next = [formatted[index], ...kept].join('\n\n');
    if (next.length <= INSIGHTS_HISTORY_MAX_CHARS || kept.length === 0) {
      kept.unshift(formatted[index]);
      continue;
    }
    omitted = index + 1;
    break;
  }

  const body = kept.join('\n\n');
  return omitted > 0
    ? `...[${omitted} older or verbose message(s) omitted]\n\n${body}`
    : body;
}

function compactHistoryMessage(content: string): string {
  const normalized = normalizePromptText(content);
  return limitPromptText(
    normalized,
    INSIGHTS_HISTORY_MESSAGE_MAX_CHARS,
    ' ... [history middle omitted] ... ',
  );
}

function compactCurrentMessage(content: string): string {
  const normalized = normalizePromptText(content);
  if (normalized.length <= INSIGHTS_CURRENT_MESSAGE_MAX_CHARS) {
    return normalized;
  }

  const marker = `\n\n...[current question truncated, ${normalized.length} chars total]...\n\n`;
  const budget = Math.max(0, INSIGHTS_CURRENT_MESSAGE_MAX_CHARS - marker.length);
  const headBudget = Math.ceil(budget * 0.45);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${normalized.slice(0, headBudget).trimEnd()}${marker}${normalized.slice(-tailBudget).trimStart()}`;
}

function normalizePromptText(value: string): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitPromptText(value: string, maxChars: number, suffix: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  const budget = maxChars - suffix.length;
  if (budget <= 0) {
    return value.slice(0, maxChars);
  }
  const headChars = Math.ceil(budget * 0.62);
  const tailChars = budget - headChars;
  return `${value.slice(0, headChars).trimEnd()}${suffix}${value.slice(-tailChars).trimStart()}`;
}

/**
 * Extract a brief description from tool call args for UI display.
 */
function extractToolInput(args: Record<string, unknown>): string {
  if (args.pattern) return `pattern: ${args.pattern}`;
  if (args.file_path) {
    const fp = String(args.file_path);
    return fp.length > 50 ? `...${fp.slice(-47)}` : fp;
  }
  if (args.path) return String(args.path);
  return '';
}
