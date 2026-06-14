/**
 * Ideation Runner
 * ===============
 *
 * AI-powered idea generation using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/ideation.ts for the TypeScript implementation.
 *
 * Uses `createSimpleClient()` with read-only tools and streaming to generate
 * ideas of different types: code improvements, UI/UX, documentation, security,
 * performance, and code quality.
 */

import { streamText, stepCountIs } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import { getAutocodeSpecsDir, type ModelShorthand, type ThinkingLevel } from '@autocode/core';
import type { SecurityProfile } from '../security/bash-validator';

// =============================================================================
// Constants
// =============================================================================

/** Supported ideation types */
export const IDEATION_TYPES = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const;

export type IdeationType = (typeof IDEATION_TYPES)[number];

export const IDEATION_MAX_STEPS = 18;
export const IDEATION_MIN_IDEAS_PER_TYPE = 1;
export const IDEATION_MAX_IDEAS_PER_TYPE = 10;

/** Human-readable labels for ideation types */
export const IDEATION_TYPE_LABELS: Record<IdeationType, string> = {
  code_improvements: 'Code Improvements',
  ui_ux_improvements: 'UI/UX Improvements',
  documentation_gaps: 'Documentation Gaps',
  security_hardening: 'Security Hardening',
  performance_optimizations: 'Performance Optimizations',
  code_quality: 'Code Quality & Refactoring',
};

const IDEATION_TYPE_LABELS_ZH_CN: Record<IdeationType, string> = {
  code_improvements: '代码改进',
  ui_ux_improvements: 'UI/UX 改进',
  documentation_gaps: '文档完善',
  security_hardening: '安全加固',
  performance_optimizations: '性能优化',
  code_quality: '代码质量与重构',
};

/** Prompt file mapping per ideation type */
const IDEATION_TYPE_PROMPTS: Record<IdeationType, string> = {
  code_improvements: 'ideation_code_improvements.md',
  ui_ux_improvements: 'ideation_ui_ux.md',
  documentation_gaps: 'ideation_documentation.md',
  security_hardening: 'ideation_security.md',
  performance_optimizations: 'ideation_performance.md',
  code_quality: 'ideation_code_quality.md',
};

// =============================================================================
// Types
// =============================================================================

/** Configuration for running ideation */
export interface IdeationConfig {
  /** Project directory path */
  projectDir: string;
  /** Output directory for results */
  outputDir: string;
  /** Project data directory name (defaults to .autocode) */
  dataDirName?: string;
  /** Prompts directory containing ideation prompt files */
  promptsDir: string;
  /** Type of ideation to run */
  ideationType: IdeationType;
  /** Model shorthand (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Maximum ideas per type (defaults to 5) */
  maxIdeasPerType?: number;
  /** User's preferred language for AI-generated content (e.g., 'en', 'zh-CN') */
  language?: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/** Result of an ideation run */
export interface IdeationResult {
  /** Whether the run succeeded */
  success: boolean;
  /** Full response text from the agent */
  text: string;
  /** Error message if failed */
  error?: string;
}

/** Callback for streaming events from the ideation runner */
export type IdeationStreamCallback = (event: IdeationStreamEvent) => void;

/** Events emitted during ideation streaming */
export type IdeationStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string }
  | { type: 'error'; error: string };

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

function shouldUseSimplifiedChinese(language: string | undefined): boolean {
  return language?.trim().toLowerCase().replace(/_/g, '-').startsWith('zh') === true;
}

function getIdeationTypePromptLabel(ideationType: IdeationType, language: string | undefined): string {
  if (shouldUseSimplifiedChinese(language)) {
    return IDEATION_TYPE_LABELS_ZH_CN[ideationType];
  }
  return ideationType.replace(/_/g, ' ');
}

function getIdeationLanguageInstruction(language: string | undefined): string {
  if (!shouldUseSimplifiedChinese(language)) return '';

  return [
    '',
    '',
    '## Language',
    'Current app language: Simplified Chinese (`zh-CN`).',
    'Write every user-facing JSON string value in Simplified Chinese, including idea `title`, `description`, `rationale`, implementation notes, risks, recommendations, user benefits, current states, proposed changes, and acceptance-style text.',
    'Treat the final JSON file as invalid unless every generated user-facing text field is written in Simplified Chinese.',
    'Keep JSON keys, enum values, IDs, file paths, commands, APIs, package names, and code identifiers unchanged.',
    'Do not translate code snippets or quoted source text unless the source text is already Chinese.',
  ].join('\n');
}

function getIdeationEfficiencyInstruction(maxIdeasPerType: number): string {
  return [
    '',
    '',
    '## Cost and Scope Control',
    `Generate at most ${maxIdeasPerType} ideas.`,
    'Read `project-docs/index.md` and `ideation_context.md` first when they exist.',
    'Use targeted reads with limits instead of broad repository scans.',
    'Do not re-read the same files unless a concrete idea needs one more detail.',
    'Stop once every idea has enough source-backed evidence for a title, description, rationale, and affected area.',
  ].join('\n');
}

function resolveMaxIdeasPerType(value: number | undefined): number {
  const normalized = Number.isFinite(value) ? Math.floor(Number(value)) : 5;
  return Math.min(
    IDEATION_MAX_IDEAS_PER_TYPE,
    Math.max(IDEATION_MIN_IDEAS_PER_TYPE, normalized),
  );
}

function buildIdeationUserPrompt(
  projectDir: string,
  maxIdeasPerType: number,
  ideationType: IdeationType,
  language: string | undefined,
): string {
  if (shouldUseSimplifiedChinese(language)) {
    const typeLabel = getIdeationTypePromptLabel(ideationType, language);
    return `分析项目 ${projectDir}，生成最多 ${maxIdeasPerType} 条“${typeLabel}”创意。请使用可用工具探索代码库，然后将结果作为 JSON 文件写入输出目录。所有用户可见内容必须使用简体中文。`;
  }

  return `Analyze the project at ${projectDir} and generate up to ${maxIdeasPerType} ${ideationType.replace(/_/g, ' ')} ideas. Use the available tools to explore the codebase, then write your findings as a JSON file to the output directory.`;
}

// =============================================================================
// Ideation Runner
// =============================================================================

/**
 * Run an ideation agent for a specific ideation type.
 *
 * Loads the appropriate prompt, creates a simple client with read-only tools,
 * and streams the response. Mirrors Python's `IdeationGenerator.run_agent()`.
 *
 * @param config - Ideation configuration
 * @param onStream - Optional callback for streaming events
 * @returns Ideation result
 */
export async function runIdeation(
  config: IdeationConfig,
  onStream?: IdeationStreamCallback,
): Promise<IdeationResult> {
  const {
    projectDir,
    outputDir,
    dataDirName,
    promptsDir,
    ideationType,
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    maxIdeasPerType: requestedMaxIdeasPerType = 5,
    language,
    abortSignal,
  } = config;
  const maxIdeasPerType = resolveMaxIdeasPerType(requestedMaxIdeasPerType);

  // Load prompt file
  const promptFile = IDEATION_TYPE_PROMPTS[ideationType];
  const promptPath = join(promptsDir, promptFile);

  if (!existsSync(promptPath)) {
    return {
      success: false,
      text: '',
      error: `Prompt not found: ${promptPath}`,
    };
  }

  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    return {
      success: false,
      text: '',
      error: `Failed to read prompt: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Add context to prompt (matches Python format)
  prompt += `\n\n---\n\n**Output Directory**: ${outputDir}\n`;
  prompt += `**Project Directory**: ${projectDir}\n`;
  prompt += `**Max Ideas**: ${maxIdeasPerType}\n`;
  prompt += getIdeationEfficiencyInstruction(maxIdeasPerType);
  prompt += getIdeationLanguageInstruction(language);

  // Create tool context for read-only tools
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: getAutocodeSpecsDir({ projectRoot: projectDir, dataDirName }),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  // Bind read-only tools + Write for output
  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('ideation', toolContext);

  // Create simple client
  const client = await createSimpleClient({
    systemPrompt: '',
    modelShorthand,
    thinkingLevel,
    maxSteps: IDEATION_MAX_STEPS,
    tools,
  });

  let responseText = '';

  // Responses models require instructions via providerOptions, not system.
  const modelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isResponsesModel = isResponsesApiModel(modelId);
  const userPrompt = buildIdeationUserPrompt(projectDir, maxIdeasPerType, ideationType, language);

  try {
    const result = streamText({
      model: client.model,
      system: isResponsesModel ? undefined : prompt,
      prompt: userPrompt,
      tools: client.tools,
      stopWhen: stepCountIs(client.maxSteps),
      abortSignal,
      ...(isResponsesModel ? {
        providerOptions: {
          openai: {
            instructions: prompt,
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
          onStream?.({ type: 'tool-use', name: part.toolName });
          break;
        }
        case 'error': {
          const errorMsg =
            part.error instanceof Error ? part.error.message : String(part.error);
          onStream?.({ type: 'error', error: errorMsg });
          break;
        }
      }
    }

    return {
      success: true,
      text: responseText,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    onStream?.({ type: 'error', error: errorMsg });
    return {
      success: false,
      text: responseText,
      error: errorMsg,
    };
  }
}
