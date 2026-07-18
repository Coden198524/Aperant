/**
 * Roadmap Runner
 * ==============
 *
 * AI-powered roadmap generation using Vercel AI SDK.
 * See apps/desktop/src/main/ai/runners/roadmap.ts for the TypeScript implementation.
 *
 * Multi-step process: project discovery → feature generation → roadmap synthesis.
 * Uses `createSimpleClient()` with read-only tools and streaming.
 */

import { streamText, stepCountIs } from 'ai';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createSimpleClient } from '../client/factory';
import type { SimpleClientResult } from '../client/types';
import { buildToolRegistry } from '../tools/build-registry';
import type { ToolContext } from '../tools/types';
import {
  AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME,
  AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME,
  AUTOCODE_ROADMAP_FILE_NAME,
  getAutocodeProjectDocsPath,
  getAutocodeRoadmapDir,
  getAutocodeRoadmapFilePath,
  getAutocodeSpecsDir,
  type ModelShorthand,
  type ThinkingLevel,
} from '@autocode/core';
import type { SecurityProfile } from '../security/bash-validator';
import { safeParseJson } from '../../utils/json-repair';
import { tryLoadPrompt } from '../prompts/prompt-loader';

// =============================================================================
// Constants
// =============================================================================

const MAX_RETRIES = 3;

/** Maximum agentic steps per phase */
export const ROADMAP_MAX_STEPS_PER_PHASE = 24;
export const ROADMAP_PRESERVED_FEATURES_PROMPT_MAX = 40;
export const ROADMAP_PRESERVED_FEATURE_TITLE_MAX_CHARS = 120;
export const ROADMAP_PRESERVED_FEATURE_ID_MAX_CHARS = 80;
const ROADMAP_PRESERVED_FEATURES_HEAD_RATIO = 0.65;

const DISCOVERY_REQUIRED_FIELDS = ['project_name', 'target_audience', 'product_vision'] as const;

function shouldUseSimplifiedChinese(language: string | undefined): boolean {
  return language?.trim().toLowerCase().replace('_', '-').startsWith('zh') === true;
}

function getDiscoveryLanguageInstruction(language: string): string {
  if (!shouldUseSimplifiedChinese(language)) return '';
  return [
    '',
    '',
    '## Language',
    'Write all user-facing JSON string values in Simplified Chinese.',
    'Keep JSON keys, IDs, file paths, commands, APIs, package names, and code identifiers unchanged.',
  ].join('\n');
}

function getRoadmapLanguageInstruction(language: string): string {
  if (!shouldUseSimplifiedChinese(language)) return '';
  return [
    '',
    '',
    '## Language',
    'Write all roadmap user-facing JSON string values in Simplified Chinese.',
    'This includes project vision, target audience text, phase names/descriptions, milestone titles/descriptions, feature titles/descriptions, rationales, acceptance criteria, and user stories.',
    'Keep JSON keys, IDs, file paths, commands, APIs, package names, and code identifiers unchanged.',
  ].join('\n');
}

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

function extractJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = safeParseJson<Record<string, unknown>>(trimmed);
  if (direct) return direct;

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let codeBlockMatch: RegExpExecArray | null = codeBlockRegex.exec(text);
  while (codeBlockMatch) {
    const parsed = safeParseJson<Record<string, unknown>>(codeBlockMatch[1].trim());
    if (parsed) return parsed;
    codeBlockMatch = codeBlockRegex.exec(text);
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return safeParseJson<Record<string, unknown>>(text.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function limitPromptText(value: unknown, maxChars: number, fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (text.length <= maxChars) {
    return text;
  }

  const marker = ' ... [middle omitted] ... ';
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const headChars = Math.ceil(budget * ROADMAP_PRESERVED_FEATURES_HEAD_RATIO);
  const tailChars = Math.max(0, budget - headChars);
  return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}`;
}

function selectPreservedFeaturesForPrompt(
  preservedFeatures: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (preservedFeatures.length <= ROADMAP_PRESERVED_FEATURES_PROMPT_MAX) {
    return preservedFeatures;
  }

  const headCount = Math.ceil(ROADMAP_PRESERVED_FEATURES_PROMPT_MAX * ROADMAP_PRESERVED_FEATURES_HEAD_RATIO);
  const tailCount = Math.max(0, ROADMAP_PRESERVED_FEATURES_PROMPT_MAX - headCount);
  return [
    ...preservedFeatures.slice(0, headCount),
    ...preservedFeatures.slice(preservedFeatures.length - tailCount),
  ];
}

function buildPreservedFeaturesPromptSection(preservedFeatures: Record<string, unknown>[]): string {
  if (preservedFeatures.length === 0) {
    return '';
  }

  const visibleFeatures = selectPreservedFeaturesForPrompt(preservedFeatures);
  const preservedInfo = visibleFeatures
    .map((feature) => {
      const id = limitPromptText(feature.id, ROADMAP_PRESERVED_FEATURE_ID_MAX_CHARS, 'unknown');
      const title = limitPromptText(feature.title, ROADMAP_PRESERVED_FEATURE_TITLE_MAX_CHARS, 'Untitled');
      const status = typeof feature.status === 'string' && feature.status.trim()
        ? ` [${limitPromptText(feature.status, 32, 'status')}]`
        : '';
      return `  - ${id}: ${title}${status}`;
    })
    .join('\n');
  const omitted = preservedFeatures.length > visibleFeatures.length
    ? `\n  - ... ${preservedFeatures.length - visibleFeatures.length} middle existing feature(s) omitted from the prompt budget.`
    : '';

  return `\n**EXISTING FEATURES TO PRESERVE**:
The following ${preservedFeatures.length} features already exist and will be preserved.
Only ${visibleFeatures.length} sampled from the start and end are summarized here to control prompt size.
Generate new complementary features without duplicating these:
${preservedInfo}${omitted}
`;
}

function buildFallbackDiscovery(
  projectDir: string,
  projectDocsIndexFile: string,
  language = 'en',
): Record<string, unknown> | null {
  const projectName = basename(projectDir) || 'Project';
  const useChinese = shouldUseSimplifiedChinese(language);
  if (!existsSync(projectDocsIndexFile)) {
    return null;
  }
  const projectDocsContent = readFileSync(projectDocsIndexFile, 'utf-8');
  const firstHeading = projectDocsContent
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0);
  const documentTitle = firstHeading && !/documentation|文档|索引/i.test(firstHeading)
    ? firstHeading
    : projectName;
  const projectType = 'documented-project';
  const primaryLanguage = 'Unknown';
  const frameworks: string[] = [];
  const keyDependencies: string[] = [];

  return {
    project_name: documentTitle,
    project_type: projectType,
    tech_stack: {
      primary_language: primaryLanguage,
      frameworks: Array.from(frameworks).slice(0, 8),
      key_dependencies: Array.from(keyDependencies).slice(0, 15),
    },
    target_audience: {
      primary_persona: useChinese ? '维护和扩展该项目的开发者' : 'Developers maintaining and extending this project',
      secondary_personas: useChinese ? ['评估进度的技术相关方'] : ['Technical stakeholders reviewing progress'],
      pain_points: useChinese ? ['手动流程较多', '缺少清晰的实现优先级'] : ['Manual workflows', 'Lack of clear implementation priorities'],
      goals: useChinese ? ['更快交付功能', '提升可靠性和可维护性'] : ['Ship features faster', 'Improve reliability and maintainability'],
      usage_context: useChinese ? '用于活跃的软件开发和交付流程' : 'Used during active software development and delivery workflows',
    },
    product_vision: {
      one_liner: useChinese
        ? `${projectName} 帮助用户以更高效率和质量完成核心工作流。`
        : `${projectName} helps users complete core workflows with higher efficiency and quality.`,
      problem_statement: useChinese
        ? '当前工作流缺少与用户结果绑定的清晰优先级路线图。'
        : 'The current workflow lacks a clear, prioritized roadmap tied to user outcomes.',
      value_proposition: useChinese
        ? '基于现有代码库提供聚焦的增量交付计划。'
        : 'Provides a focused plan for incremental delivery based on the existing codebase.',
      success_metrics: useChinese ? ['功能交付效率', '缺陷减少', '用户满意度'] : ['Feature throughput', 'Defect reduction', 'User satisfaction'],
    },
    current_state: {
      maturity: 'prototype',
      existing_features: [],
      known_gaps: useChinese
        ? ['由于 AI 生成失败，路线图发现信息根据本地项目文档和源码路径推断。']
        : ['Roadmap discovery details were inferred from local project documentation and source paths due AI generation failure'],
      technical_debt: [],
    },
    competitive_context: {
      alternatives: [],
      differentiators: [],
      market_position: useChinese
        ? '细分或发展中的产品领域；精确定位需要进一步分析。'
        : 'Niche or evolving product area; precise positioning requires deeper analysis',
      competitor_pain_points: [],
      competitor_analysis_available: false,
    },
    constraints: {
      technical: [],
      resources: [],
      dependencies: [],
    },
    created_at: new Date().toISOString(),
  };
}

// =============================================================================
// Types
// =============================================================================

/** Configuration for roadmap generation */
export interface RoadmapConfig {
  /** Project directory path */
  projectDir: string;
  /** Output directory for roadmap files (defaults to .autocode/roadmap/) */
  outputDir?: string;
  /** Project data directory name (defaults to .autocode) */
  dataDirName?: string;
  /** Model shorthand or full model ID (defaults to 'sonnet') */
  modelShorthand?: ModelShorthand | string;
  /** Thinking level (defaults to 'medium') */
  thinkingLevel?: ThinkingLevel;
  /** Whether to refresh existing data */
  refresh?: boolean;
  /** Whether to enable competitor analysis */
  enableCompetitorAnalysis?: boolean;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** User's preferred language for AI-generated content (e.g., 'en', 'zh') */
  language?: string;
}

/** Result of a roadmap phase */
export interface RoadmapPhaseResult {
  /** Phase name */
  phase: string;
  /** Whether the phase succeeded */
  success: boolean;
  /** Output files created */
  outputs: string[];
  /** Errors encountered */
  errors: string[];
}

/** Result of the full roadmap generation */
export interface RoadmapResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Phase results */
  phases: RoadmapPhaseResult[];
  /** Path to the generated roadmap file */
  roadmapPath?: string;
  /** Error message if failed */
  error?: string;
}

/** Callback for streaming events from the roadmap runner */
export type RoadmapStreamCallback = (event: RoadmapStreamEvent) => void;

/** Events emitted during roadmap generation */
export type RoadmapStreamEvent =
  | { type: 'phase-start'; phase: string }
  | { type: 'phase-complete'; phase: string; success: boolean }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string }
  | { type: 'error'; error: string };

// =============================================================================
// Discovery Phase
// =============================================================================

/**
 * Run the discovery phase — analyze project and determine audience/vision.
 * Mirrors Python's `DiscoveryPhase.execute()`.
 */
async function runDiscoveryPhase(
  projectDir: string,
  outputDir: string,
  projectDocsIndexFile: string,
  refresh: boolean,
  client: SimpleClientResult,
  language: string,
  abortSignal?: AbortSignal,
  onStream?: RoadmapStreamCallback,
): Promise<RoadmapPhaseResult> {
  const discoveryFile = join(outputDir, AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME);

  if (existsSync(discoveryFile) && !refresh) {
    return { phase: 'discovery', success: true, outputs: [discoveryFile], errors: [] };
  }

  const errors: string[] = [];

  // Responses models require instructions via providerOptions, not system.
  const discoveryModelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isResponsesDiscovery = isResponsesApiModel(discoveryModelId);

  // Load the full prompt file with JSON schema; fall back to inline prompt
  const loadedDiscoveryPrompt = tryLoadPrompt('roadmap_discovery');
  let retryContext: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const languageInstruction = getDiscoveryLanguageInstruction(language);
    const contextBlock = `\n\n---\n\n## CONTEXT (injected by runner)\n\n**Project Directory**: ${projectDir}\n**Project Documentation Index**: ${projectDocsIndexFile}\n**Output Directory**: ${outputDir}\n**Output File**: ${discoveryFile}\n${languageInstruction}\n\nUse the project documentation index when it exists. If it is missing or incomplete, inspect source files directly. Use the paths above when reading input files and writing output.`;

    const basePrompt = loadedDiscoveryPrompt
      ? loadedDiscoveryPrompt + contextBlock
      : `Analyze the project and create a discovery document.

**Project Documentation Index**: ${projectDocsIndexFile}
**Output Directory**: ${outputDir}
**Output File**: ${discoveryFile}
${languageInstruction}

This runs non-interactively. Infer sensible defaults; do not ask questions.

Your task:
1. Analyze the project (read the project documentation index when available, then README, code structure, and key files)
2. Infer target audience, vision, and constraints from your analysis
3. Create ${discoveryFile} with valid JSON

The JSON must contain at minimum: project_name, target_audience, product_vision, key_features, technical_stack, and constraints.
`;
    const prompt = retryContext
      ? `${basePrompt}\n\n---\n\n## RETRY FEEDBACK (HIGHEST PRIORITY)\n\n${retryContext}`
      : basePrompt;

    const discoveryUserPrompt = 'Analyze the project and create the discovery document. Use the available tools to explore the codebase, then write your findings as JSON to the output file specified in the context above.';
    let streamedText = '';
    let toolCallCount = 0;
    let streamError: string | undefined;

    try {
      const result = streamText({
        model: client.model,
        system: isResponsesDiscovery ? undefined : prompt,
        prompt: discoveryUserPrompt,
        tools: client.tools,
        stopWhen: stepCountIs(client.maxSteps),
        abortSignal,
        ...(isResponsesDiscovery ? {
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
          case 'text-delta':
            streamedText += part.text;
            onStream?.({ type: 'text-delta', text: part.text });
            break;
          case 'tool-call':
            toolCallCount += 1;
            onStream?.({ type: 'tool-use', name: part.toolName });
            break;
          case 'error': {
            const errorMsg = part.error instanceof Error ? part.error.message : String(part.error);
            onStream?.({ type: 'error', error: errorMsg });
            break;
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error);
    }

    if (!existsSync(discoveryFile) && streamedText.trim().length > 0) {
      const extracted = extractJsonObjectFromText(streamedText);
      if (extracted) {
        writeFileSync(discoveryFile, JSON.stringify(extracted, null, 2), 'utf-8');
      }
    }

    if (existsSync(discoveryFile)) {
      const data = safeParseJson<Record<string, unknown>>(readFileSync(discoveryFile, 'utf-8'));
      if (data) {
        const missing = DISCOVERY_REQUIRED_FIELDS.filter((k) => !(k in data));
        if (missing.length === 0) {
          return { phase: 'discovery', success: true, outputs: [discoveryFile], errors: [] };
        }
        const detail = `Missing fields: ${missing.join(', ')}`;
        errors.push(`Attempt ${attempt + 1}: ${streamError ? `${streamError}; ` : ''}${detail}`);
      } else {
        const detail = 'Invalid JSON in discovery file';
        errors.push(`Attempt ${attempt + 1}: ${streamError ? `${streamError}; ` : ''}${detail}`);
      }
    } else {
      const noToolCalls = toolCallCount === 0;
      const detail = noToolCalls
        ? 'Discovery file not created and no tool calls were made'
        : 'Discovery file not created';
      errors.push(`Attempt ${attempt + 1}: ${streamError ? `${streamError}; ` : ''}${detail}`);
      retryContext = [
        'WRITE TOOL REQUIRED',
        '',
        noToolCalls
          ? 'The previous attempt made no tool calls.'
          : 'The required output file was not created.',
        `Use Write to create: ${discoveryFile}`,
        'Return analysis only after the file exists.',
        'After writing the file, continue without additional tool calls unless strictly necessary.',
      ].join('\n');
    }
  }

  try {
    const fallback = buildFallbackDiscovery(projectDir, projectDocsIndexFile, language);
    if (!fallback) {
      return { phase: 'discovery', success: false, outputs: [], errors };
    }
    writeFileSync(discoveryFile, JSON.stringify(fallback, null, 2), 'utf-8');
    onStream?.({
      type: 'error',
      error: 'Discovery fallback used: generated roadmap_discovery.json from local project documentation',
    });
    return { phase: 'discovery', success: true, outputs: [discoveryFile], errors };
  } catch (error) {
    errors.push(`Fallback failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { phase: 'discovery', success: false, outputs: [], errors };
}

// =============================================================================
// Features Phase
// =============================================================================

/**
 * Run the features phase — generate and prioritize roadmap features.
 * Mirrors Python's `FeaturesPhase.execute()`.
 */
async function runFeaturesPhase(
  _projectDir: string,
  outputDir: string,
  projectDocsIndexFile: string,
  refresh: boolean,
  client: SimpleClientResult,
  language: string,
  abortSignal?: AbortSignal,
  onStream?: RoadmapStreamCallback,
): Promise<RoadmapPhaseResult> {
  const roadmapFile = join(outputDir, AUTOCODE_ROADMAP_FILE_NAME);
  const discoveryFile = join(outputDir, AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME);

  if (!existsSync(discoveryFile)) {
    return { phase: 'features', success: false, outputs: [], errors: ['Discovery file not found'] };
  }

  if (existsSync(roadmapFile) && !refresh) {
    return { phase: 'features', success: true, outputs: [roadmapFile], errors: [] };
  }

  // Load preserved features before agent potentially overwrites
  const preservedFeatures = loadPreservedFeatures(roadmapFile);

  const errors: string[] = [];

  // Responses models require instructions via providerOptions, not system.
  const featuresModelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isResponsesFeatures = isResponsesApiModel(featuresModelId);

  // Load the full prompt file with JSON schema; fall back to inline prompt
  const loadedFeaturesPrompt = tryLoadPrompt('roadmap_features');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const preservedSection = buildPreservedFeaturesPromptSection(preservedFeatures);
    const languageInstruction = getRoadmapLanguageInstruction(language);
    const featuresContextBlock = `\n\n---\n\n## CONTEXT (injected by runner)\n\n**Discovery File**: ${discoveryFile}\n**Project Documentation Index**: ${projectDocsIndexFile}\n**Output File**: ${roadmapFile}\n${preservedSection}${languageInstruction}\n\nUse the project documentation index when it exists. If it is missing or incomplete, inspect source files directly. Use the paths above when reading input files and writing output. Write the complete roadmap JSON to the Output File path.`;

    const prompt = loadedFeaturesPrompt
      ? loadedFeaturesPrompt + featuresContextBlock
      : `Generate a roadmap with prioritized features.

**Discovery File**: ${discoveryFile}
**Project Documentation Index**: ${projectDocsIndexFile}
**Output File**: ${roadmapFile}
${preservedSection}
${languageInstruction}
Based on the discovery data:
1. Read the discovery file to understand the project
2. Generate features that address user pain points
3. Prioritize using MoSCoW framework
4. Organize into phases
5. Create milestones
6. Map dependencies

Output the complete roadmap as valid JSON to ${roadmapFile}.
The JSON must contain: vision, target_audience (object with "primary" key), phases (array), and features (array with at least 3 items each with id, title, description, priority, complexity, impact, phase_id, status, acceptance_criteria, and user_stories).`;

    const featuresUserPrompt = 'Read the discovery data and generate a complete roadmap with prioritized features. Write the roadmap JSON to the output file specified in the context above.';

    try {
      const result = streamText({
        model: client.model,
        system: isResponsesFeatures ? undefined : prompt,
        prompt: featuresUserPrompt,
        tools: client.tools,
        stopWhen: stepCountIs(client.maxSteps),
        abortSignal,
        ...(isResponsesFeatures ? {
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
          case 'text-delta':
            onStream?.({ type: 'text-delta', text: part.text });
            break;
          case 'tool-call':
            onStream?.({ type: 'tool-use', name: part.toolName });
            break;
          case 'error': {
            const errorMsg = part.error instanceof Error ? part.error.message : String(part.error);
            onStream?.({ type: 'error', error: errorMsg });
            break;
          }
        }
      }

      // Validate and merge — read/write through fd to avoid TOCTOU
      let roadmapRaw: string | null = null;
      try {
        roadmapRaw = readFileSync(roadmapFile, 'utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (roadmapRaw !== null) {
        const data = safeParseJson<Record<string, unknown>>(roadmapRaw);
        if (data) {
          const required = ['phases', 'features', 'vision', 'target_audience'];
          const missing = required.filter((k) => !(k in data));
          const featureCount = ((data.features as unknown[]) ?? []).length;

          const targetAudience = data.target_audience;
          if (typeof targetAudience !== 'object' || targetAudience === null || !(targetAudience as Record<string, unknown>).primary) {
            missing.push('target_audience.primary');
          }

          if (missing.length === 0 && featureCount >= 3) {
            // Merge preserved features — atomic write via temp file + rename
            if (preservedFeatures.length > 0) {
              data.features = mergeFeatures(data.features as Record<string, unknown>[], preservedFeatures);
              const merged = JSON.stringify(data, null, 2);
              const tmpFile = `${roadmapFile}.tmp.${process.pid}`;
              writeFileSync(tmpFile, merged, 'utf-8');
              renameSync(tmpFile, roadmapFile);
            }
            return { phase: 'features', success: true, outputs: [roadmapFile], errors: [] };
          }
          errors.push(`Attempt ${attempt + 1}: Missing fields or too few features (${featureCount})`);
        } else {
          errors.push(`Attempt ${attempt + 1}: Invalid JSON in roadmap file`);
        }
      } else {
        errors.push(`Attempt ${attempt + 1}: Roadmap file not created`);
      }
    } catch (error) {
      errors.push(`Attempt ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { phase: 'features', success: false, outputs: [], errors };
}

// =============================================================================
// Feature Preservation Helpers
// =============================================================================

/**
 * Load features from existing roadmap that should be preserved.
 * Preserves features with status planned/in_progress/done, linked specs, or internal source.
 */
function loadPreservedFeatures(roadmapFile: string): Record<string, unknown>[] {
  if (!existsSync(roadmapFile)) return [];

  const data = safeParseJson<Record<string, unknown>>(readFileSync(roadmapFile, 'utf-8'));
  if (!data) return [];

  const features: Record<string, unknown>[] = (data.features as Record<string, unknown>[]) ?? [];

  return features.filter((feature) => {
    const status = feature.status as string | undefined;
    const hasLinkedSpec = Boolean(feature.linked_spec_id);
    const source = feature.source as Record<string, unknown> | undefined;
    const isInternal = typeof source === 'object' && source !== null && source.provider === 'internal';

    return (
      status === 'planned' || status === 'in_progress' || status === 'done' ||
      hasLinkedSpec || isInternal
    );
  });
}

/**
 * Merge new AI-generated features with preserved features.
 * Preserved features take priority; deduplicates by ID and title.
 */
function mergeFeatures(
  newFeatures: Record<string, unknown>[],
  preserved: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (preserved.length === 0) return newFeatures;

  const preservedIds = new Set(
    preserved.filter((f) => f.id).map((f) => f.id as string),
  );
  const preservedTitles = new Set(
    preserved
      .filter((f) => f.title)
      .map((f) => (f.title as string).trim().toLowerCase()),
  );

  const merged = [...preserved];
  for (const feature of newFeatures) {
    const id = feature.id as string | undefined;
    const title = ((feature.title as string) ?? '').trim().toLowerCase();

    if (id && preservedIds.has(id)) continue;
    if (title && preservedTitles.has(title)) continue;
    merged.push(feature);
  }

  return merged;
}

// =============================================================================
// Roadmap Runner (Main Entry Point)
// =============================================================================

/**
 * Run the complete roadmap generation process.
 *
 * Multi-phase pipeline:
 * 1. Discovery — analyze project, infer audience and vision
 * 2. Features — generate and prioritize roadmap features
 *
 * @param config - Roadmap generation configuration
 * @param onStream - Optional callback for streaming events
 * @returns Roadmap generation result
 */
export async function runRoadmapGeneration(
  config: RoadmapConfig,
  onStream?: RoadmapStreamCallback,
): Promise<RoadmapResult> {
  const {
    projectDir,
    modelShorthand = 'sonnet',
    thinkingLevel = 'medium',
    refresh = false,
    abortSignal,
    language = 'en',
    dataDirName,
  } = config;

  const outputDir = config.outputDir ?? getAutocodeRoadmapDir(projectDir, dataDirName);
  const projectDocsIndexFile = getAutocodeProjectDocsPath(
    projectDir,
    AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME,
    dataDirName,
  );

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create tool context for read-only tools + Write
  const toolContext: ToolContext = {
    cwd: projectDir,
    projectDir,
    specDir: getAutocodeSpecsDir({ projectRoot: projectDir, dataDirName }),
    securityProfile: null as unknown as SecurityProfile,
    abortSignal,
  };

  const registry = buildToolRegistry();
  const tools = registry.getToolsForAgent('roadmap_discovery', toolContext);

  const client = await createSimpleClient({
    systemPrompt: '',
    modelShorthand,
    thinkingLevel,
    maxSteps: ROADMAP_MAX_STEPS_PER_PHASE,
    tools,
  });

  const phases: RoadmapPhaseResult[] = [];

  // Phase 1: Discovery
  onStream?.({ type: 'phase-start', phase: 'discovery' });
  const discoveryResult = await runDiscoveryPhase(
    projectDir, outputDir, projectDocsIndexFile, refresh, client, language, abortSignal, onStream,
  );
  phases.push(discoveryResult);
  onStream?.({ type: 'phase-complete', phase: 'discovery', success: discoveryResult.success });

  if (!discoveryResult.success) {
    return {
      success: false,
      phases,
      error: `Discovery failed: ${discoveryResult.errors.join('; ')}`,
    };
  }

  // Phase 2: Feature Generation
  onStream?.({ type: 'phase-start', phase: 'features' });
  const featuresResult = await runFeaturesPhase(
    projectDir, outputDir, projectDocsIndexFile, refresh, client, language, abortSignal, onStream,
  );
  phases.push(featuresResult);
  onStream?.({ type: 'phase-complete', phase: 'features', success: featuresResult.success });

  if (!featuresResult.success) {
    return {
      success: false,
      phases,
      error: `Feature generation failed: ${featuresResult.errors.join('; ')}`,
    };
  }

  const roadmapPath = config.outputDir
    ? join(outputDir, AUTOCODE_ROADMAP_FILE_NAME)
    : getAutocodeRoadmapFilePath(projectDir, dataDirName);
  return {
    success: true,
    phases,
    roadmapPath,
  };
}
