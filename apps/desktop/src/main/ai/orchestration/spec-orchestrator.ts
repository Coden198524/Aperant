/**
 * Spec Orchestrator
 * =================
 *
 * Drives the spec creation pipeline through complexity-first phase selection:
 *   complexity_assessment → [phases based on tier]
 *
 * Complexity assessment runs FIRST to gate the workflow:
 *   - SIMPLE: quick_spec → validation (2 phases — no discovery/requirements)
 *   - STANDARD: discovery → requirements → spec_writing → planning → validation
 *   - COMPLEX: Full pipeline including research and self-critique
 *
 * Context accumulation: after each phase, output files are captured and injected
 * into the next phase's kickoff message, eliminating redundant file re-reads.
 */

import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import type { SupportedLanguage } from '../../../shared/constants/i18n';
import {
  validateJsonFile,
  validateAndNormalizeJsonFile,
  ComplexityAssessmentSchema,
  ImplementationPlanSchema,
  validateImplementationPlanLanguage,
  ComplexityAssessmentOutputSchema,
  buildValidationRetryPrompt,
  IMPLEMENTATION_PLAN_SCHEMA_HINT,
  rewriteImplementationPlanFiles,
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
  SpecContextOutputSchema,
  RequirementsOutputSchema,
  type RequirementsOutput,
  ResearchOutputSchema,
} from '../schema';
import type { ZodSchema } from 'zod';
import type { SessionResult } from '../session/types';
import type { WorkflowConfig } from './workflow-config';
import { getRetryLimits, DEFAULT_WORKFLOW_CONFIG } from './workflow-config';

// =============================================================================
// Constants
// =============================================================================

/** Maximum retries for a single phase (configurable via WorkflowConfig) */
const MAX_PHASE_RETRIES = 2;

/** Maximum characters of a single phase output to carry forward */
const MAX_PHASE_OUTPUT_SIZE = 12_000;

// =============================================================================
// Types
// =============================================================================

/** Complexity tiers */
export type ComplexityTier = 'simple' | 'standard' | 'complex';

/** Spec creation phases (ordered) */
export type SpecPhase =
  | 'discovery'
  | 'requirements'
  | 'complexity_assessment'
  | 'historical_context'
  | 'research'
  | 'context'
  | 'spec_writing'
  | 'self_critique'
  | 'planning'
  | 'validation'
  | 'quick_spec';

/** Maps spec phases to their agent types */
const PHASE_AGENT_MAP: Record<SpecPhase, AgentType> = {
  discovery: 'spec_discovery',
  requirements: 'spec_gatherer',
  complexity_assessment: 'spec_gatherer',
  historical_context: 'spec_context',
  research: 'spec_researcher',
  context: 'spec_context',
  spec_writing: 'spec_writer',
  self_critique: 'spec_critic',
  planning: 'planner',
  validation: 'spec_validation',
  quick_spec: 'spec_writer',
} as const;

/**
 * Phases to run for each complexity tier.
 * Complexity assessment runs BEFORE these phases as the gating step.
 *
 * - SIMPLE: skip discovery & requirements entirely — quick_spec handles everything.
 * - STANDARD: discovery builds context.json, requirements gathers formal reqs,
 *   then spec_writing + planning. 'context' phase removed (redundant with discovery).
 * - COMPLEX: full pipeline including research and self-critique.
 */
const COMPLEXITY_PHASES: Record<ComplexityTier, SpecPhase[]> = {
  simple: ['quick_spec', 'validation'],
  standard: ['discovery', 'requirements', 'spec_writing', 'planning', 'validation'],
  complex: [
    'discovery',
    'requirements',
    'research',
    'context',
    'spec_writing',
    'self_critique',
    'planning',
    'validation',
  ],
} as const;

const AGGRESSIVE_SIMPLE_PHASES: SpecPhase[] = ['quick_spec'];

/** Maps each phase to the output files it typically produces */
const PHASE_OUTPUTS: Partial<Record<SpecPhase, string[]>> = {
  discovery: ['context.json'],
  requirements: ['requirements.json'],
  complexity_assessment: ['complexity_assessment.json'],
  research: ['research.json'],
  context: ['context.json'],
  spec_writing: ['spec.md'],
  self_critique: ['spec.md'],
  planning: ['implementation_plan.json'],
  quick_spec: ['spec.md', 'implementation_plan.json'],
};

const STRUCTURED_JSON_PHASE_OUTPUTS: Partial<Record<SpecPhase, string>> = {
  discovery: 'context.json',
  requirements: 'requirements.json',
  research: 'research.json',
  context: 'context.json',
};

/** State file name for tracking spec creation progress */
const SPEC_STATE_FILE = 'spec_state.json';

/** Spec creation state for resume support */
interface SpecState {
  complexity?: ComplexityTier;
  completedPhases: SpecPhase[];
  lastUpdated: string;
}

/** Configuration for the spec orchestrator */
export interface SpecOrchestratorConfig {
  /** Spec directory path */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** Task description (what to build) */
  taskDescription?: string;
  /** Complexity override (skip AI assessment) */
  complexityOverride?: ComplexityTier;
  /** Whether to use AI for complexity assessment (default: true) */
  useAiAssessment?: boolean;
  /** Pre-generated project index JSON content (injected into all phases) */
  projectIndex?: string;
  /** CLI model override */
  cliModel?: string;
  /** CLI thinking level override */
  cliThinking?: string;
  /** App UI language */
  language?: SupportedLanguage;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Workflow optimization configuration */
  workflowConfig?: WorkflowConfig;
  /** Callback to generate the system prompt for a given agent type and phase */
  generatePrompt: (agentType: AgentType, phase: SpecPhase, context: SpecPromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: SpecSessionRunConfig) => Promise<SessionResult>;
}

interface QuickSpecPlan {
  specMarkdown: string;
  implementationPlan: {
    feature: string;
    workflow_type: string;
    phases: Array<{
      id: string;
      phase: number;
      name: string;
      depends_on: string[];
      subtasks: Array<{
        id: string;
        title: string;
        description: string;
        status: 'pending';
        files_to_create?: string[];
        files_to_modify?: string[];
        pattern_files?: string[];
        verification: {
          type: string;
          run: string;
          scenario?: string;
        };
      }>;
    }>;
    split_plan: false;
  };
}

/** Context passed to prompt generation */
export interface SpecPromptContext {
  /** Current phase number (1-indexed) */
  phaseNumber: number;
  /** Total phases to run */
  totalPhases: number;
  /** Current phase name */
  phaseName: SpecPhase;
  /** Task description */
  taskDescription?: string;
  /** Complexity tier (after assessment) */
  complexity?: ComplexityTier;
  /** Pre-generated project index (JSON string) */
  projectIndex?: string;
  /** Accumulated outputs from prior phases (filename → content) */
  priorPhaseOutputs?: Record<string, string>;
  /** Retry attempt number (0 = first try) */
  attemptCount: number;
  /** Schema validation error feedback for retry (built by buildValidationRetryPrompt) */
  schemaRetryContext?: string;
}

/** Configuration passed to runSession callback */
export interface SpecSessionRunConfig {
  agentType: AgentType;
  phase: Phase;
  /** Spec pipeline phase name (e.g., 'complexity_assessment', 'discovery', 'requirements') */
  specPhase: SpecPhase;
  systemPrompt: string;
  specDir: string;
  projectDir: string;
  sessionNumber: number;
  abortSignal?: AbortSignal;
  cliModel?: string;
  cliThinking?: string;
  /** Accumulated outputs from prior phases (filename → content) for kickoff enrichment */
  priorPhaseOutputs?: Record<string, string>;
  /** Pre-generated project index (JSON string) */
  projectIndex?: string;
  /** Optional Zod schema for structured output (uses AI SDK Output.object()) */
  outputSchema?: ZodSchema;
}

/** Result of a single phase execution */
export interface SpecPhaseResult {
  phase: SpecPhase;
  success: boolean;
  errors: string[];
  retries: number;
}

/** Events emitted by the spec orchestrator */
export interface SpecOrchestratorEvents {
  /** Phase started */
  'phase-start': (phase: SpecPhase, phaseNumber: number, totalPhases: number) => void;
  /** Phase completed */
  'phase-complete': (phase: SpecPhase, result: SpecPhaseResult) => void;
  /** Session completed within a phase */
  'session-complete': (result: SessionResult, phase: SpecPhase) => void;
  /** Spec creation finished */
  'spec-complete': (outcome: SpecOutcome) => void;
  /** Log message */
  'log': (message: string) => void;
  /** Error occurred */
  'error': (error: Error, phase: SpecPhase) => void;
}

/** Final spec creation outcome */
export interface SpecOutcome {
  success: boolean;
  complexity?: ComplexityTier;
  phasesExecuted: SpecPhase[];
  durationMs: number;
  error?: string;
}

/** Complexity assessment result (matches Python spec/complexity.py) */
interface ComplexityAssessment {
  complexity: ComplexityTier;
  confidence: number;
  reasoning: string;
  needs_research?: boolean;
  needs_self_critique?: boolean;
}

interface MinimalImplementationPlan {
  phases?: Array<{
    subtasks?: unknown[];
  }>;
}

interface MinimalPlanSubtask {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  verification?: {
    type?: string;
    run?: string;
    scenario?: string;
  };
  [key: string]: unknown;
}

interface MinimalPlanPhase {
  id?: string | number;
  phase?: number;
  name?: string;
  subtasks?: MinimalPlanSubtask[];
  [key: string]: unknown;
}

interface MutableImplementationPlan extends Record<string, unknown> {
  phases?: MinimalPlanPhase[];
  split_plan?: boolean;
  plan_files?: unknown;
}

function hasExecutableSubtasks(plan: MinimalImplementationPlan | null): boolean {
  return plan?.phases?.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0) ?? false;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))));
}

function normalizeTaskDescription(taskDescription: string | undefined): string {
  const trimmed = taskDescription?.trim().replace(/\r\n/g, '\n');
  if (!trimmed) {
    return 'Complete the requested task';
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const taskLine = lines.find((line) => /^Task\s*:/i.test(line));
  const taskOnly = taskLine
    ? taskLine.replace(/^Task\s*:\s*/i, '').trim()
    : lines
      .filter((line) => !/^(Project directory|Spec directory|Base branch|Auto-approve)\s*:/i.test(line))
      .join(' ')
      .trim();
  const normalized = taskOnly || trimmed;

  return normalized.length > 1200 ? `${normalized.slice(0, 1200)}...` : normalized;
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

const COMMON_LOW_VALUE_ROOT_FILES = new Set([
  'task_logs.json',
  'task_metadata.json',
  'requirements.json',
  'implementation_plan.json',
  'spec.md',
]);

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cpp',
  '.cc',
  '.cxx',
  '.c',
  '.h',
  '.hpp',
  '.html',
  '.css',
  '.scss',
  '.py',
  '.java',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.swift',
  '.kt',
]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

const EXPLICIT_FILE_PATTERN = /(?:^|[\s`"'([{,:;])([A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"'\])},:;.!?])/g;

const CREATE_TARGET_RULES: Array<{
  pattern: RegExp;
  files: string[];
}> = [
  { pattern: /(readme|docs?|documentation|\u6587\u6863|\u8bf4\u660e)/i, files: ['README.md'] },
  { pattern: /(html|web|\u7f51\u9875|\u9875\u9762|\u6d4f\u89c8\u5668)/i, files: ['index.html'] },
  { pattern: /(react|vite)/i, files: ['package.json', 'src/App.tsx'] },
  { pattern: /(node|express|javascript|js\b)/i, files: ['package.json', 'src/index.js'] },
  { pattern: /(typescript|ts\b)/i, files: ['package.json', 'src/index.ts'] },
  { pattern: /(python|py\b)/i, files: ['main.py'] },
  { pattern: /(go\b|golang)/i, files: ['go.mod', 'main.go'] },
  { pattern: /(rust|cargo)/i, files: ['Cargo.toml', 'src/main.rs'] },
  { pattern: /(java\b|maven|gradle)/i, files: ['src/main/java/Main.java'] },
  { pattern: /(c#|csharp|\.net)/i, files: ['Program.cs'] },
  { pattern: /(c\+\+|cpp|cxx|\u63a7\u5236\u53f0|console)/i, files: ['CMakeLists.txt', 'src/main.cpp'] },
  { pattern: /(\bc\b|clang|gcc)/i, files: ['CMakeLists.txt', 'src/main.c'] },
  { pattern: /(shell|bash|sh\b)/i, files: ['script.sh'] },
  { pattern: /(powershell|pwsh|ps1)/i, files: ['script.ps1'] },
];

function extractExplicitTaskFiles(taskDescription: string): string[] {
  const files: string[] = [];
  const normalized = taskDescription.replace(/\\/g, '/');
  for (const match of normalized.matchAll(EXPLICIT_FILE_PATTERN)) {
    const file = match[1]?.replace(/^\.?\//, '').trim();
    if (!file || file.startsWith('.autocode/')) {
      continue;
    }
    const lower = file.toLowerCase();
    if (COMMON_LOW_VALUE_ROOT_FILES.has(lower)) {
      continue;
    }
    files.push(file);
  }
  return uniqueStrings(files);
}

function inferAggressiveCreateFiles(taskDescription: string, patternFiles: string[]): string[] {
  if (patternFiles.length > 0) {
    return [];
  }

  const task = normalizeTaskDescription(taskDescription);
  const explicitFiles = extractExplicitTaskFiles(task);
  if (explicitFiles.length > 0) {
    return explicitFiles.slice(0, 4);
  }

  const matched = CREATE_TARGET_RULES.find((rule) => rule.pattern.test(task));
  return matched ? matched.files : [];
}

function _scoreAggressiveRootCandidate(fileName: string, task: string): number {
  const lower = fileName.toLowerCase();
  const ext = extensionOf(lower);
  let score = 0;

  if (COMMON_LOW_VALUE_ROOT_FILES.has(lower)) {
    score -= 10;
  }
  if (SOURCE_FILE_EXTENSIONS.has(ext)) {
    score += 8;
  }
  if (lower === 'package.json') {
    score += 6;
  }
  if (lower === 'index.html' || lower.startsWith('main.') || lower.startsWith('app.')) {
    score += 5;
  }
  if (lower.startsWith('readme.')) {
    score += 1;
  }

  if (/\b(c\+\+|cpp|cxx|控制台|console)\b/i.test(task)) {
    if (['.cpp', '.cc', '.cxx', '.h', '.hpp', '.c'].includes(ext)) score += 12;
    if (lower.startsWith('main.')) score += 4;
  }
  if (/\b(html|web|网页|页面|浏览器)\b/i.test(task)) {
    if (['.html', '.css', '.js', '.ts'].includes(ext)) score += 10;
    if (lower === 'index.html') score += 5;
  }
  if (/\b(readme|文档|说明)\b/i.test(task) && lower.startsWith('readme.')) {
    score += 12;
  }

  return score;
}

function scoreLocalizedAggressiveRootCandidate(fileName: string, task: string): number {
  const lower = fileName.toLowerCase();
  const ext = extensionOf(lower);
  let score = 0;

  if (COMMON_LOW_VALUE_ROOT_FILES.has(lower)) {
    score -= 10;
  }
  if (SOURCE_FILE_EXTENSIONS.has(ext)) {
    score += 8;
  }
  if (lower === 'package.json') {
    score += 6;
  }
  if (lower === 'index.html' || lower.startsWith('main.') || lower.startsWith('app.')) {
    score += 5;
  }
  if (lower.startsWith('readme.')) {
    score += 1;
  }

  if (/(c\+\+|cpp|cxx|console|\u63a7\u5236\u53f0)/i.test(task)) {
    if (['.cpp', '.cc', '.cxx', '.h', '.hpp', '.c'].includes(ext)) score += 12;
    if (lower.startsWith('main.')) score += 4;
  }
  if (/(html|web|\u7f51\u9875|\u9875\u9762|\u6d4f\u89c8\u5668)/i.test(task)) {
    if (['.html', '.css', '.js', '.ts'].includes(ext)) score += 10;
    if (lower === 'index.html') score += 5;
  }
  if (/(readme|\u6587\u6863|\u8bf4\u660e)/i.test(task) && lower.startsWith('readme.')) {
    score += 12;
  }

  return score;
}

async function inferAggressivePatternFiles(projectDir: string, taskDescription: string): Promise<string[]> {
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        score: scoreLocalizedAggressiveRootCandidate(entry.name, normalizeTaskDescription(taskDescription)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 4)
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function _buildAggressiveQuickSpecPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
): QuickSpecPlan {
  const task = normalizeTaskDescription(taskDescription);
  const feature = oneLine(task, 120);
  const title = language === 'zh-CN' ? '实现完整任务' : 'Implement complete task';
  const phaseName = language === 'zh-CN' ? '实现' : 'Implementation';
  const verificationRun = language === 'zh-CN'
    ? '根据项目类型运行最小可用验证；若没有自动化验证，说明已完成的人工检查。'
    : 'Run the smallest available project-specific verification; if none exists, describe the manual check completed.';
  const specMarkdown = [
    `# Quick Spec: ${feature}`,
    '',
    '## Overview',
    task,
    '',
    '## Workflow Type',
    '**Type**: simple',
    '',
    '## Scope',
    `- ${escapeMarkdownTableCell(task)}`,
    '',
    '## Implementation Notes',
    '- Aggressive mode uses one focused coder session.',
    '- The coder should inspect only files directly needed for the task.',
    '- No new design pattern is required unless the existing code clearly demands it.',
    '',
    '## Success Criteria',
    '- Requested behavior is implemented.',
    '- A targeted verification or clear manual check is recorded.',
    '',
  ].join('\n');

  return {
    specMarkdown,
    implementationPlan: {
      feature,
      workflow_type: 'simple',
      phases: [
        {
          id: '1',
          phase: 1,
          name: phaseName,
          depends_on: [],
          subtasks: [
            {
              id: '1-1',
              title,
              description: [
                task,
                '',
                'Implement the complete requested change in one focused coding session. Read only directly relevant files before editing.',
              ].join('\n'),
              status: 'pending',
              files_to_create: [],
              files_to_modify: [],
              ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
              verification: {
                type: 'manual',
                run: verificationRun,
              },
            },
          ],
        },
      ],
      split_plan: false,
    },
  };
}

function buildLocalizedAggressiveQuickSpecPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
): QuickSpecPlan {
  const task = normalizeTaskDescription(taskDescription);
  const filesToCreate = inferAggressiveCreateFiles(task, patternFiles);
  const feature = oneLine(task, 120);
  const isChinese = language === 'zh-CN';
  const title = isChinese ? '\u5b9e\u73b0\u5b8c\u6574\u4efb\u52a1' : 'Implement complete task';
  const phaseName = isChinese ? '\u5b9e\u73b0' : 'Implementation';
  const verificationRun = isChinese
    ? '\u6839\u636e\u9879\u76ee\u7c7b\u578b\u8fd0\u884c\u6700\u5c0f\u53ef\u7528\u9a8c\u8bc1\uff1b\u82e5\u6ca1\u6709\u81ea\u52a8\u5316\u9a8c\u8bc1\uff0c\u8bf4\u660e\u5df2\u5b8c\u6210\u7684\u4eba\u5de5\u68c0\u67e5\u3002'
    : 'Run the smallest available project-specific verification; if none exists, describe the manual check completed.';
  const implementationInstruction = isChinese
    ? '\u7528\u4e00\u6b21\u805a\u7126\u7684\u7f16\u7801\u4f1a\u8bdd\u5b8c\u6210\u6574\u4e2a\u8bf7\u6c42\u3002\u7f16\u8f91\u524d\u53ea\u9605\u8bfb\u4e0e\u4efb\u52a1\u76f4\u63a5\u76f8\u5173\u7684\u6587\u4ef6\u3002'
    : 'Implement the complete requested change in one focused coding session. Read only directly relevant files before editing.';
  const specMarkdown = isChinese
    ? [
        `# \u5feb\u901f\u89c4\u683c\uff1a${feature}`,
        '',
        '## \u6982\u8ff0',
        task,
        '',
        '## \u5de5\u4f5c\u6d41\u7c7b\u578b',
        '**\u7c7b\u578b**\uff1a\u7b80\u5355',
        '',
        '## \u8303\u56f4',
        `- ${escapeMarkdownTableCell(task)}`,
        '',
        '## \u5b9e\u73b0\u8981\u70b9',
        '- \u6fc0\u8fdb\u6a21\u5f0f\u4f7f\u7528\u4e00\u6b21\u805a\u7126\u7684\u7f16\u7801\u4f1a\u8bdd\u3002',
        '- \u7f16\u7801\u667a\u80fd\u4f53\u53ea\u5e94\u68c0\u67e5\u4e0e\u4efb\u52a1\u76f4\u63a5\u76f8\u5173\u7684\u6587\u4ef6\u3002',
        '- \u9664\u975e\u73b0\u6709\u4ee3\u7801\u660e\u786e\u9700\u8981\uff0c\u5426\u5219\u4e0d\u5f15\u5165\u65b0\u8bbe\u8ba1\u6a21\u5f0f\u3002',
        '',
        '## \u6210\u529f\u6807\u51c6',
        '- \u5df2\u5b9e\u73b0\u7528\u6237\u8bf7\u6c42\u7684\u884c\u4e3a\u3002',
        '- \u5df2\u8bb0\u5f55\u6709\u9488\u5bf9\u6027\u7684\u9a8c\u8bc1\u6216\u4eba\u5de5\u68c0\u67e5\u7ed3\u679c\u3002',
        '',
      ].join('\n')
    : [
        `# Quick Spec: ${feature}`,
        '',
        '## Overview',
        task,
        '',
        '## Workflow Type',
        '**Type**: simple',
        '',
        '## Scope',
        `- ${escapeMarkdownTableCell(task)}`,
        '',
        '## Implementation Notes',
        '- Aggressive mode uses one focused coder session.',
        '- The coder should inspect only files directly needed for the task.',
        '- No new design pattern is required unless the existing code clearly demands it.',
        '',
        '## Success Criteria',
        '- Requested behavior is implemented.',
        '- A targeted verification or clear manual check is recorded.',
        '',
      ].join('\n');

  return {
    specMarkdown,
    implementationPlan: {
      feature,
      workflow_type: 'simple',
      phases: [
        {
          id: '1',
          phase: 1,
          name: phaseName,
          depends_on: [],
          subtasks: [
            {
              id: '1-1',
              title,
              description: [task, '', implementationInstruction].join('\n'),
              status: 'pending',
              files_to_create: filesToCreate,
              files_to_modify: [],
              ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
              verification: {
                type: 'manual',
                run: verificationRun,
              },
            },
          ],
        },
      ],
      split_plan: false,
    },
  };
}

export function isWriteToolJsonFailure(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsWriteTool = lower.includes("tool 'write'") ||
    lower.includes('tool write') ||
    lower.includes('invalid input for tool write');
  const mentionsJsonOrInputFailure = lower.includes('json parsing failed') ||
    lower.includes('received invalid input type') ||
    lower.includes('invalid input');

  return mentionsWriteTool && mentionsJsonOrInputFailure;
}

export function buildWriteToolJsonRetryPrompt(phase: SpecPhase, specDir: string): string {
  const normalizedSpecDir = specDir.replace(/\\/g, '/');
  if (phase === 'planning') {
    return [
      'CRITICAL - RETRY IMPLEMENTATION PLAN WITH WRITE TOOL',
      '',
      'Your previous Write tool call was rejected before execution.',
      'Retry by writing smaller implementation plan files instead of returning one giant JSON response.',
      '',
      'Rules for the retry:',
      `- Use the Write tool to create ${normalizedSpecDir}/implementation_plan.json.`,
      '- Pass a JSON object, not a string containing JSON.',
      '- Include BOTH required keys in the same object: file_path and content.',
      '- Use forward slashes in file_path, including Windows paths.',
      '- Keep each Write content short enough that the JSON closes correctly.',
      '- If the plan is large, write implementation_plan.phase-1.json, implementation_plan.phase-2.json, etc. first.',
      '- Then write a compact implementation_plan.json index with split_plan, plan_files, and phases that reference subtasks_file.',
      '- Keep descriptions concise and preserve necessary subtasks by splitting into files, not by dropping work.',
      '- Do not embed source code, long analysis, or copied documentation in JSON fields.',
      '',
      'Required Write tool input shape:',
      `{"file_path":"${normalizedSpecDir}/implementation_plan.json","content":"..."}`,
    ].join('\n');
  }

  if (phase === 'quick_spec') {
    return [
      'CRITICAL - RETRY QUICK SPEC FILE WRITES',
      '',
      'Your previous Write tool call was rejected before execution.',
      '',
      'Rules for the retry:',
      `- Use the Write tool to create ${normalizedSpecDir}/spec.md.`,
      `- Use the Write tool to create ${normalizedSpecDir}/implementation_plan.json.`,
      '- Pass a JSON object, not a string containing JSON.',
      '- Include BOTH required keys in each Write object: file_path and content.',
      '- For spec.md, write a compact 20-60 line version first.',
      '- Keep implementation_plan.json concise and schema-compatible.',
      '- Do not paste the implementation plan into the final response.',
    ].join('\n');
  }

  const structuredJsonFile = STRUCTURED_JSON_PHASE_OUTPUTS[phase];
  if (structuredJsonFile) {
    return buildStructuredJsonOutputRetryPrompt(phase, normalizedSpecDir, structuredJsonFile);
  }

  const targetFiles = (PHASE_OUTPUTS[phase] ?? ['output file'])
    .map((file) => `${normalizedSpecDir}/${file}`)
    .join(', ');

  const phaseSpecificGuidance = phase === 'spec_writing' || phase === 'self_critique'
    ? [
        'For spec.md, write a compact 20-60 line version first.',
        'Do not copy large context blocks, full source files, long code blocks, or large tables into spec.md.',
      ]
    : [
        'Keep JSON or markdown content concise and include only information needed by the next phase.',
      ];

  return [
    'CRITICAL - RETRY WRITE TOOL WITH VALID JSON',
    '',
    'Your previous Write tool call was rejected before execution because the tool input JSON was incomplete, malformed, or passed as the wrong type.',
    'Do not repeat the same tool call.',
    '',
    'Required Write tool input shape:',
    `{"file_path":"${targetFiles.split(', ')[0]}","content":"..."}`,
    '',
    'Rules for the retry:',
    `- Use the Write tool to create: ${targetFiles}`,
    '- Pass a JSON object, not a string containing JSON.',
    '- Include BOTH required keys in the same object: file_path and content.',
    '- For multiple required files, call Write once per file with a separate valid object.',
    '- Use forward slashes in file_path, including Windows paths.',
    '- Keep each Write content short enough that the JSON closes correctly.',
    '- If the previous error text ended after "file_path", that means the content key was omitted or the tool JSON was truncated.',
    ...phaseSpecificGuidance.map((line) => `- ${line}`),
  ].join('\n');
}

function buildStructuredJsonOutputRetryPrompt(
  phase: SpecPhase,
  normalizedSpecDir: string,
  fileName: string,
): string {
  const phaseGuidance: Partial<Record<SpecPhase, string[]>> = {
    discovery: [
      'Summarize only the files and patterns directly relevant to the task.',
      'Include files_to_modify, files_to_reference, scoped_services, design_patterns, implementation_notes, risks, and verification_suggestions.',
    ],
    context: [
      'Focus on task-specific architecture, files, patterns, risks, and verification suggestions.',
      'Do not copy source code or broad repository inventories.',
    ],
    requirements: [
      'Include task_description, workflow_type, services_involved, user_requirements, acceptance_criteria, constraints, and created_at.',
      'Keep each requirement and criterion short and actionable.',
    ],
    research: [
      'Include concise verified findings only; link to sources instead of copying documentation.',
      'Keep code snippets out of JSON unless they are one-line API examples.',
    ],
  };

  return [
    `CRITICAL - RETURN ${fileName} AS FINAL JSON`,
    '',
    'Your previous Write tool call was rejected before execution because the tool input JSON was incomplete, malformed, or passed as the wrong type.',
    'Do NOT call the Write tool again for this JSON file.',
    '',
    `Return the complete ${fileName} content as the final response JSON object.`,
    'The orchestrator will validate that final JSON and write it to disk.',
    '',
    'Rules for the retry:',
    `- Do NOT call Write for ${normalizedSpecDir}/${fileName}.`,
    '- Do NOT wrap the JSON in a markdown fence.',
    '- Do NOT add prose before or after the JSON.',
    '- Use forward slashes in any file paths.',
    '- Keep the JSON compact so it can be parsed reliably.',
    '- Prefer summaries and exact file paths over copied source code, large tables, or long analysis.',
    ...(phaseGuidance[phase] ?? []).map((line) => `- ${line}`),
  ].join('\n');
}

function getStructuredJsonOutputSchema(phase: SpecPhase): ZodSchema | undefined {
  switch (phase) {
    case 'discovery':
    case 'context':
      return SpecContextOutputSchema;
    case 'requirements':
      return RequirementsOutputSchema;
    case 'research':
      return ResearchOutputSchema;
    default:
      return undefined;
  }
}

async function writeStructuredJsonOutput(
  specDir: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  await writeFile(join(specDir, fileName), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

type RequirementsWorkflowType = RequirementsOutput['workflow_type'];

function inferRequirementsWorkflowType(
  taskDescription?: string,
  complexity?: ComplexityTier,
): RequirementsWorkflowType {
  const text = (taskDescription ?? '').toLowerCase();
  if (/\b(migrate|migration|port)\b|迁移|移植|切换/.test(text)) {
    return 'migration';
  }
  if (/\b(refactor|rewrite|rework|redesign|restructure)\b|重构|重写|改造|重新设计|结构调整/.test(text)) {
    return 'refactor';
  }
  if (/\b(fix|bug|debug|error|crash|fail|failed|failure)\b|修复|报错|错误|崩溃|失败|异常|无法/.test(text)) {
    return 'bugfix';
  }
  return complexity === 'simple' ? 'simple' : 'feature';
}

function buildFallbackRequirementsOutput(
  taskDescription?: string,
  complexity?: ComplexityTier,
): RequirementsOutput {
  const description = taskDescription?.trim() || 'Create the requested software change.';
  return {
    task_description: description,
    workflow_type: inferRequirementsWorkflowType(description, complexity),
    services_involved: [],
    user_requirements: [description],
    acceptance_criteria: [
      'The requested change is implemented according to the task description.',
      'Relevant project checks pass or any remaining verification gaps are documented.',
    ],
    constraints: [
      'Follow existing project architecture, coding conventions, and design patterns.',
    ],
    created_at: new Date().toISOString(),
  };
}

function buildPlanStructuredOutputValidationRetryPrompt(
  phase: SpecPhase,
  errors: string[],
  schemaHint?: string,
): string {
  const lines = [
    '## IMPLEMENTATION PLAN FILE VALIDATION ERRORS',
    '',
    'The implementation plan file written by your previous attempt was missing or invalid.',
    '',
    '### Errors found:',
    ...errors.map((error) => `- ${error}`),
    '',
  ];

  if (schemaHint) {
    lines.push('### Required schema:', schemaHint, '');
  }

  lines.push(
    '### How to fix:',
    '1. Use the Write tool to rewrite the implementation plan files.',
    '2. Use phases[].subtasks[] with concise pending subtasks for small plans.',
    '3. For large plans, write implementation_plan.phase-1.json, implementation_plan.phase-2.json, etc. first.',
    '4. Then write a compact implementation_plan.json index with split_plan, plan_files, and phases that reference subtasks_file.',
    '5. Keep each Write payload small enough that the tool-call JSON closes correctly.',
    '6. Do not paste the full plan into the final response.',
    '7. Do not include top-level summary, verification_strategy, qa_acceptance, research notes, copied source, or long analysis.',
  );

  if (phase === 'quick_spec') {
    lines.push('8. If spec.md is missing, use Write to recreate a compact spec.md as well.');
  }

  return lines.join('\n');
}

// =============================================================================
// SpecOrchestrator
// =============================================================================

/**
 * Orchestrates the spec creation pipeline with dynamic complexity adaptation.
 *
 * Replaces the Python `SpecOrchestrator` class from `spec/pipeline/orchestrator.py`.
 * Manages spec creation through a series of AI-driven phases that adapt based on
 * task complexity assessment.
 */
export class SpecOrchestrator extends EventEmitter {
  private config: SpecOrchestratorConfig;
  private sessionNumber = 0;
  private aborted = false;
  private assessment: ComplexityAssessment | null = null;
  private phaseSummaries: Record<string, string> = {};
  private completedPhases: SpecPhase[] = [];

  constructor(config: SpecOrchestratorConfig) {
    super();
    this.config = config;

    // Apply workflow configuration defaults
    if (!this.config.workflowConfig) {
      this.config.workflowConfig = DEFAULT_WORKFLOW_CONFIG;
    }

    config.abortSignal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  /**
   * Save current spec creation state to disk for resume support.
   */
  private async saveState(): Promise<void> {
    try {
      const state: SpecState = {
        complexity: this.assessment?.complexity,
        completedPhases: this.completedPhases,
        lastUpdated: new Date().toISOString(),
      };
      const statePath = join(this.config.specDir, SPEC_STATE_FILE);
      await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      // Non-fatal: state save failure shouldn't block execution
      console.warn('[SpecOrchestrator] Failed to save state:', error);
    }
  }

  /**
   * Load spec creation state from disk to resume from last checkpoint.
   * Returns null if no state file exists or if it's invalid.
   */
  private async loadState(): Promise<SpecState | null> {
    try {
      const statePath = join(this.config.specDir, SPEC_STATE_FILE);
      await access(statePath);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content) as SpecState;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Run the full spec creation pipeline.
   *
   * Phase progression:
   * 1. Complexity assessment — gate the workflow (uses task description + project index)
   * 2. Phases based on complexity tier (SIMPLE skips discovery/requirements entirely)
   *
   * After each phase, output files are captured and injected into subsequent phases
   * to eliminate redundant file re-reads between agents.
   */
  async run(): Promise<SpecOutcome> {
    const startTime = Date.now();
    const phasesExecuted: SpecPhase[] = [];

    try {
      // ===================================================================
      // Step 0: Try to restore state from previous run (resume support)
      // ===================================================================
      const savedState = await this.loadState();
      if (savedState) {
        this.emitTyped('log', `Resuming from saved state: ${savedState.completedPhases.length} phases completed`);
        this.completedPhases = savedState.completedPhases;
        phasesExecuted.push(...savedState.completedPhases);

        if (savedState.complexity) {
          this.assessment = {
            complexity: savedState.complexity,
            confidence: 0.9,
            reasoning: 'Restored from saved state',
          };
        }
      }

      // ===================================================================
      // Step 1: Determine complexity (runs FIRST to gate the workflow)
      // ===================================================================
      let complexity: ComplexityTier = 'standard';

      // Skip complexity assessment if already completed
      if (this.completedPhases.includes('complexity_assessment')) {
        complexity = this.assessment?.complexity ?? 'standard';
        this.emitTyped('log', `Skipping complexity assessment (already completed): ${complexity}`);
      } else {
        // Fast-path heuristic: catch obviously simple tasks before expensive AI assessment
        const heuristicResult = this.assessComplexityHeuristic(this.config.taskDescription ?? '');
        if (heuristicResult) {
          complexity = heuristicResult;
          this.assessment = {
            complexity: heuristicResult,
            confidence: 0.9,
            reasoning: `Heuristic: task description matches ${heuristicResult} pattern`,
          };
          this.emitTyped('log', `Complexity heuristic: ${heuristicResult} (skipping AI assessment)`);
          phasesExecuted.push('complexity_assessment');
          this.completedPhases.push('complexity_assessment');
          await this.saveState();
        } else if (this.config.complexityOverride) {
          complexity = this.config.complexityOverride;
          this.emitTyped('log', `Complexity override: ${complexity}`);
        } else if (this.config.useAiAssessment !== false) {
          // Try to restore complexity assessment from file first (resume support)
          const assessmentPath = join(this.config.specDir, 'complexity_assessment.json');
          let restoredFromFile = false;

          try {
            await access(assessmentPath);
            const fileResult = await validateJsonFile(assessmentPath, ComplexityAssessmentSchema);

            if (fileResult.valid && fileResult.data) {
              this.assessment = fileResult.data as ComplexityAssessment;
              complexity = this.assessment.complexity;
              this.emitTyped('log', `Restored complexity from file: ${complexity} (confidence: ${(this.assessment.confidence * 100).toFixed(0)}%)`);
              phasesExecuted.push('complexity_assessment');
              this.completedPhases.push('complexity_assessment');
              await this.capturePhaseOutput('complexity_assessment');
              await this.saveState();
              restoredFromFile = true;
            }
          } catch {
            // File doesn't exist or is invalid - will run AI assessment below
          }

          // Run AI complexity assessment if not restored from file
          if (!restoredFromFile) {
            if (this.aborted) {
              return this.outcome(false, phasesExecuted, Date.now() - startTime, 'Cancelled');
            }

            const assessResult = await this.runComplexityAssessment(1);
            phasesExecuted.push('complexity_assessment');
            this.completedPhases.push('complexity_assessment');
            await this.capturePhaseOutput('complexity_assessment');
            await this.saveState();

            if (!assessResult.success) {
              // Fall back to standard on assessment failure
              this.assessment = {
                complexity: 'standard',
                confidence: 0.5,
                reasoning: 'Fallback: AI assessment failed',
              };
            }

            complexity = this.assessment?.complexity ?? 'standard';
          }
        } else {
          // Heuristic fallback
          complexity = 'standard';
          this.assessment = {
            complexity: 'standard',
            confidence: 0.5,
            reasoning: 'Heuristic assessment (AI disabled)',
          };
          phasesExecuted.push('complexity_assessment');
          this.completedPhases.push('complexity_assessment');
          await this.saveState();
        }
      }

      // ===================================================================
      // Step 2: Determine and run phases based on assessed complexity
      // ===================================================================
      const phasesToRun = this.config.workflowConfig?.optimizationLevel === 'aggressive' && complexity === 'simple'
        ? [...AGGRESSIVE_SIMPLE_PHASES]
        : [...COMPLEXITY_PHASES[complexity]];

      // Inject research/self-critique if flagged but not already in the tier
      if (this.assessment?.needs_research && !phasesToRun.includes('research')) {
        // Insert research before context (or before spec_writing if no context phase)
        const insertBefore = phasesToRun.indexOf('context') !== -1
          ? phasesToRun.indexOf('context')
          : phasesToRun.indexOf('spec_writing');
        if (insertBefore !== -1) {
          phasesToRun.splice(insertBefore, 0, 'research');
        }
      }

      if (this.assessment?.needs_self_critique && !phasesToRun.includes('self_critique')) {
        const planningIdx = phasesToRun.indexOf('planning');
        if (planningIdx !== -1) {
          phasesToRun.splice(planningIdx, 0, 'self_critique');
        }
      }

      this.emitTyped('log', `Running ${complexity} workflow: ${phasesToRun.join(' → ')}`);

      for (const phase of phasesToRun) {
        if (
          phase === 'quick_spec' &&
          this.config.workflowConfig?.optimizationLevel === 'aggressive' &&
          complexity === 'simple'
        ) {
          const phaseNumber = phasesExecuted.length + 1;
          const totalPhases = phasesToRun.length + (phasesExecuted.includes('complexity_assessment') ? 1 : 0);
          const result = await this.writeAggressiveQuickSpec(phaseNumber, totalPhases);
          phasesExecuted.push(phase);
          this.completedPhases.push(phase);
          await this.capturePhaseOutput(phase);
          await this.saveState();
          if (!result.success) {
            return this.outcome(false, phasesExecuted, Date.now() - startTime, result.errors.join('; '));
          }
          continue;
        }

        // Skip phases that were already completed
        if (this.completedPhases.includes(phase)) {
          this.emitTyped('log', `Skipping ${phase} (already completed)`);
          continue;
        }

        if (this.aborted) {
          return this.outcome(false, phasesExecuted, Date.now() - startTime, 'Cancelled');
        }

        const result = await this.runPhase(phase, phasesExecuted.length + 1, phasesToRun.length + (phasesExecuted.includes('complexity_assessment') ? 1 : 0));
        phasesExecuted.push(phase);
        this.completedPhases.push(phase);

        if (!result.success) {
          await this.saveState(); // Save state even on failure for resume
          return this.outcome(false, phasesExecuted, Date.now() - startTime, result.errors.join('; '));
        }

        // Capture phase outputs for injection into subsequent phases
        await this.capturePhaseOutput(phase);

        // Save state after each successful phase
        await this.saveState();
      }

      return this.outcome(true, phasesExecuted, Date.now() - startTime);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.outcome(false, phasesExecuted, Date.now() - startTime, message);
    }
  }

  // ===========================================================================
  // Complexity Heuristic
  // ===========================================================================

  /**
   * Fast-path heuristic for obviously simple tasks.
   * Returns 'simple' if the description matches simple patterns, null otherwise.
   * This avoids an expensive AI assessment call for trivial tasks.
   */
  private assessComplexityHeuristic(taskDescription: string): ComplexityTier | null {
    const desc = taskDescription.toLowerCase().trim();
    const wordCount = desc.split(/\s+/).length;

    // Very short descriptions (under 30 words) with simple signal words → SIMPLE
    if (wordCount <= 30) {
      const simplePatterns = [
        /\b(change|rename|update|replace|swap|switch)\b.*\b(color|colour|name|text|label|title|string|value|icon|logo)\b/,
        /\b(fix|correct)\b.*\b(typo|spelling|grammar)\b/,
        /\b(bump|update)\b.*\b(version|dependency)\b/,
        /\b(remove|delete)\b.*\b(unused|dead|deprecated)\b/,
      ];
      if (simplePatterns.some(p => p.test(desc))) {
        return 'simple';
      }
    }

    // Long descriptions or complex signal words → let AI decide
    return null;
  }

  // ===========================================================================
  // Phase Execution
  // ===========================================================================

  /**
   * Run a single spec phase with retries.
   */
  private async runPhase(
    phase: SpecPhase,
    phaseNumber: number,
    totalPhases: number,
  ): Promise<SpecPhaseResult> {
    const agentType = PHASE_AGENT_MAP[phase];
    const errors: string[] = [];
    let schemaRetryContext: string | undefined;
    /** Set when a retry is needed because the model didn't call any tools */
    let toolUseRetryContext: string | undefined;

    // Get retry limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig!);
    const maxPhaseRetries = retryLimits.specPhase;

    this.emitTyped('phase-start', phase, phaseNumber, totalPhases);

    for (let attempt = 0; attempt <= maxPhaseRetries; attempt++) {
      if (this.aborted) {
        return { phase, success: false, errors: ['Cancelled'], retries: attempt };
      }

      this.sessionNumber++;

      const phaseOutputs = Object.keys(this.phaseSummaries).length > 0 ? { ...this.phaseSummaries } : undefined;

      const prompt = await this.config.generatePrompt(agentType, phase, {
        phaseNumber,
        totalPhases,
        phaseName: phase,
        taskDescription: this.config.taskDescription,
        complexity: this.assessment?.complexity,
        projectIndex: this.config.projectIndex,
        priorPhaseOutputs: phaseOutputs,
        attemptCount: attempt,
        // Carry both schema and tool-use retry context (at most one is set at a time)
        schemaRetryContext: schemaRetryContext ?? toolUseRetryContext,
      });
      // Clear single-use retry context
      toolUseRetryContext = undefined;

      // Discovery/context-style JSON files are compact enough for structured
      // output. Implementation plans can be very large, so planner phases write
      // plan files directly with the Write tool and validate them from disk.
      const isPlanningPhase = phase === 'planning' || phase === 'quick_spec';
      const structuredJsonFile = STRUCTURED_JSON_PHASE_OUTPUTS[phase];
      const outputSchema = getStructuredJsonOutputSchema(phase);

      const result = await this.config.runSession({
        agentType,
        phase: 'spec',
        specPhase: phase,
        systemPrompt: prompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.sessionNumber,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
        priorPhaseOutputs: phaseOutputs,
        projectIndex: this.config.projectIndex,
        ...(outputSchema ? { outputSchema } : {}),
      });

      this.emitTyped('session-complete', result, phase);

      if (result.outcome === 'cancelled') {
        return { phase, success: false, errors: ['Cancelled'], retries: attempt };
      }

      if (result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window') {
        // Compact structured JSON phases are persisted here; plan files are written by the planner.
        if (structuredJsonFile && result.structuredOutput) {
          try {
            await writeStructuredJsonOutput(this.config.specDir, structuredJsonFile, result.structuredOutput);
            this.emitTyped('log', `Wrote ${structuredJsonFile} from structured output`);
          } catch (writeErr) {
            this.emitTyped('log', `Failed to write structured ${structuredJsonFile}: ${writeErr}`);
          }
        }
        // Validate that expected output files were actually created.
        // Some models (e.g., GLM-5, Codex) may complete a session without calling
        // any tools, producing no output files despite a successful stream.
        const missingFiles = await this.validatePhaseOutputs(phase);
        if (missingFiles.length > 0) {
          const noToolCalls = result.toolCallCount === 0;
          const detail = noToolCalls
            ? `Model completed session without making any tool calls — expected files not created: ${missingFiles.join(', ')}`
            : `Phase completed but expected output files missing: ${missingFiles.join(', ')}`;
          errors.push(detail);
          this.emitTyped('log', `Phase ${phase} output validation failed (attempt ${attempt + 1}): ${detail}`);

          if (phase === 'requirements' && missingFiles.includes('requirements.json') && attempt >= maxPhaseRetries) {
            try {
              await writeStructuredJsonOutput(
                this.config.specDir,
                'requirements.json',
                buildFallbackRequirementsOutput(this.config.taskDescription, this.assessment?.complexity),
              );
              const remainingMissing = await this.validatePhaseOutputs(phase);
              if (remainingMissing.length === 0) {
                this.emitTyped('log', 'Wrote fallback requirements.json from task description');
                errors.pop();
                const phaseResult: SpecPhaseResult = { phase, success: true, errors: [], retries: attempt };
                this.emitTyped('phase-complete', phase, phaseResult);
                return phaseResult;
              }
            } catch (fallbackErr) {
              this.emitTyped('log', `Failed to write fallback requirements.json: ${fallbackErr}`);
            }
          }

          if (attempt < maxPhaseRetries) {
            if (structuredJsonFile && missingFiles.includes(structuredJsonFile)) {
              toolUseRetryContext = buildStructuredJsonOutputRetryPrompt(
                phase,
                this.config.specDir.replace(/\\/g, '/'),
                structuredJsonFile,
              );
              continue;
            }

            if (isPlanningPhase && missingFiles.includes('implementation_plan.json')) {
              toolUseRetryContext = buildWriteToolJsonRetryPrompt(phase, this.config.specDir);
              continue;
            }

            // Build a directive retry prompt when the model hallucinated tool usage.
            // This is common with Codex models that generate text claiming to have
            // written files without actually invoking the Write tool.
            if (noToolCalls) {
              const fileList = missingFiles.map(f => `${this.config.specDir}/${f}`).join(', ');
              toolUseRetryContext = [
                'CRITICAL — TOOL USE REQUIRED',
                '',
                'Your previous attempt failed because you did NOT call any tools.',
                'You MUST use the Write tool to create the required output file(s).',
                'Do NOT describe file contents in your text response — you must invoke the Write tool.',
                '',
                `Missing file(s) that MUST be created using the Write tool: ${fileList}`,
                '',
                'Steps:',
                `1. Use the Write tool to create each missing file listed above`,
                '2. Include the full file content in the Write tool call',
                '3. Do NOT skip tool calls or assume files were already created',
              ].join('\n');
            }
            continue; // Retry the phase
          }
          // All retries exhausted — fall through to failure
          break;
        }

        // Schema validation for phases with structured output requirements
        // (e.g., planning phase must produce valid implementation_plan.json)
        const schemaValidation = await this.validatePhaseSchema(phase);
        if (schemaValidation && !schemaValidation.valid) {
          errors.push(`Schema validation failed: ${schemaValidation.errors.join(', ')}`);
          this.emitTyped('log', `Phase ${phase} schema validation failed (attempt ${attempt + 1}): ${schemaValidation.errors.join(', ')}`);
          if (attempt < maxPhaseRetries) {
            // Build LLM-friendly error feedback so the agent knows what to fix
            const schemaHint = (phase === 'planning' || phase === 'quick_spec')
              ? IMPLEMENTATION_PLAN_SCHEMA_HINT
              : undefined;
            schemaRetryContext = isPlanningPhase
              ? buildPlanStructuredOutputValidationRetryPrompt(phase, schemaValidation.errors, schemaHint)
              : buildValidationRetryPrompt(
                  PHASE_OUTPUTS[phase]?.[0] ?? 'output file',
                  schemaValidation.errors,
                  schemaHint,
                );
            continue; // Retry with error feedback
          }
          break;
        }

        const phaseResult: SpecPhaseResult = { phase, success: true, errors: [], retries: attempt };
        this.emitTyped('phase-complete', phase, phaseResult);
        return phaseResult;
      }

      // Error — collect and maybe retry
      const errorMsg = result.error?.message ?? `Phase ${phase} failed with outcome: ${result.outcome}`;
      errors.push(errorMsg);

      // Non-retryable errors
      if (result.outcome === 'auth_failure') {
        return { phase, success: false, errors, retries: attempt };
      }

      if (attempt < maxPhaseRetries) {
        if (isWriteToolJsonFailure(errorMsg)) {
          schemaRetryContext = undefined;
          toolUseRetryContext = buildWriteToolJsonRetryPrompt(phase, this.config.specDir);
          this.emitTyped('log', `Phase ${phase} Write tool JSON failed (attempt ${attempt + 1}), retrying with compact Write guidance...`);
        } else {
          this.emitTyped('log', `Phase ${phase} failed (attempt ${attempt + 1}), retrying...`);
        }
      }
    }

    const failResult: SpecPhaseResult = { phase, success: false, errors, retries: maxPhaseRetries };
    this.emitTyped('phase-complete', phase, failResult);
    return failResult;
  }

  /**
   * Run AI complexity assessment by invoking the complexity assessor agent.
   */
  private async runComplexityAssessment(
    phaseNumber: number,
  ): Promise<SpecPhaseResult> {
    // totalPhases=1 for the assessment itself; actual phase count is determined after assessment
    this.emitTyped('phase-start', 'complexity_assessment', phaseNumber, 1);
    this.sessionNumber++;

    const prompt = await this.config.generatePrompt('spec_gatherer', 'complexity_assessment', {
      phaseNumber,
      totalPhases: 1,
      phaseName: 'complexity_assessment',
      taskDescription: this.config.taskDescription,
      projectIndex: this.config.projectIndex,
      attemptCount: 0,
    });

    // Pass clean output schema for constrained decoding (all fields required,
    // no preprocess/passthrough). Providers with native structured output
    // (Anthropic, OpenAI) enforce this at the token level.
    const sessionResult = await this.config.runSession({
      agentType: 'spec_gatherer',
      phase: 'spec',
      specPhase: 'complexity_assessment',
      systemPrompt: prompt,
      specDir: this.config.specDir,
      projectDir: this.config.projectDir,
      sessionNumber: this.sessionNumber,
      abortSignal: this.config.abortSignal,
      cliModel: this.config.cliModel,
      cliThinking: this.config.cliThinking,
      projectIndex: this.config.projectIndex,
      outputSchema: ComplexityAssessmentOutputSchema,
    });

    this.emitTyped('session-complete', sessionResult, 'complexity_assessment');

    if (sessionResult.outcome === 'cancelled') {
      return { phase: 'complexity_assessment', success: false, errors: ['Cancelled'], retries: 0 };
    }

    // Prefer structured output from constrained decoding (no file I/O needed)
    if (sessionResult.structuredOutput) {
      this.assessment = sessionResult.structuredOutput as unknown as ComplexityAssessment;
      this.emitTyped('log', `Complexity assessed (structured output): ${this.assessment.complexity} (confidence: ${(this.assessment.confidence * 100).toFixed(0)}%)`);
      return { phase: 'complexity_assessment', success: true, errors: [], retries: 0 };
    }

    // Fallback: read assessment from file (agent wrote it via tool)
    try {
      const assessmentPath = join(this.config.specDir, 'complexity_assessment.json');
      const fileResult = await validateJsonFile(assessmentPath, ComplexityAssessmentSchema);

      if (fileResult.valid && fileResult.data) {
        this.assessment = fileResult.data as ComplexityAssessment;
        this.emitTyped('log', `Complexity assessed: ${fileResult.data.complexity} (confidence: ${(fileResult.data.confidence * 100).toFixed(0)}%)`);
        return { phase: 'complexity_assessment', success: true, errors: [], retries: 0 };
      }
    } catch {
      // Assessment file not found or invalid — fall through
    }

    // If assessment file wasn't written, treat as failure (caller will fallback)
    return {
      phase: 'complexity_assessment',
      success: false,
      errors: ['Complexity assessment file not created or invalid'],
      retries: 0,
    };
  }

  // ===========================================================================
  // Context Accumulation
  // ===========================================================================

  /**
   * Capture output files from a completed phase and store them in phaseSummaries.
   * These are injected into subsequent phases to eliminate redundant file re-reads.
   */

  /**
   * Validate that a phase produced its expected output files.
   * Returns the list of missing file names (empty if all exist).
   */
  private async validatePhaseOutputs(phase: SpecPhase): Promise<string[]> {
    const expectedFiles = PHASE_OUTPUTS[phase];
    if (!expectedFiles?.length) return []; // Phase has no expected outputs

    const missing: string[] = [];
    for (const fileName of expectedFiles) {
      try {
        await access(join(this.config.specDir, fileName));
      } catch {
        missing.push(fileName);
      }
    }
    return missing;
  }

  /**
   * Validate phase output files against their Zod schemas.
   * Returns null for phases without schema requirements.
   * For phases with schemas (planning, quick_spec), validates and normalizes
   * the output file, writing back coerced data on success.
   */
  private async validatePhaseSchema(
    phase: SpecPhase,
  ): Promise<{ valid: boolean; errors: string[] } | null> {
    if (phase === 'planning' || phase === 'quick_spec') {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const rewriteErrors: string[] = [];
      try {
        try {
          const rewrite = await rewriteImplementationPlanFiles(this.config.specDir);
          if (rewrite?.split) {
            this.emitTyped('log', `Split implementation plan into ${rewrite.filesWritten.length - 1} phase files (${rewrite.totalSubtasks} subtasks)`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.includes('implementation_plan.json') ||
            message.includes('implementation_plan.phase-') ||
            message.includes('subtasks_file') ||
            message.includes('plan_files')
          ) {
            rewriteErrors.push(`Failed to write implementation plan files: ${message}`);
            this.emitTyped('log', `Planning file rewrite failed: ${message}. Checking whether the main implementation_plan.json can still be used...`);
          } else {
            throw error;
          }
        }

        const result = await validateAndNormalizeJsonFile(planPath, ImplementationPlanSchema);
        const hydratedPlan = result.valid
          ? await loadImplementationPlanFromFiles(this.config.specDir)
          : null;
        const languageErrors = result.valid && hydratedPlan
          ? validateImplementationPlanLanguage(hydratedPlan as never, this.config.language)
          : [];
        const executionErrors = result.valid && !hasExecutableSubtasks(hydratedPlan)
          ? ['Implementation plan has no executable subtasks. If using split plan files, ensure every subtasks_file exists and contains subtasks.']
          : [];
        const compactErrors = result.valid && executionErrors.length === 0 && languageErrors.length === 0
          ? await this.compactAggressiveSimplePlan()
          : [];

        if (result.valid && rewriteErrors.length > 0 && executionErrors.length === 0 && languageErrors.length === 0 && compactErrors.length === 0) {
          this.emitTyped('log', 'Split plan file rewrite failed, but the main implementation_plan.json is executable. Continuing without stopping the task.');
        }

        return {
          valid: result.valid && executionErrors.length === 0 && languageErrors.length === 0 && compactErrors.length === 0,
          errors: result.valid
            ? [
                ...(executionErrors.length > 0 ? rewriteErrors : []),
                ...executionErrors,
                ...languageErrors,
                ...compactErrors,
              ]
            : [...rewriteErrors, ...result.errors, ...languageErrors, ...compactErrors],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('implementation_plan.json') ||
          message.includes('implementation_plan.phase-') ||
          message.includes('subtasks_file') ||
          message.includes('plan_files')
        ) {
          return {
            valid: false,
            errors: [`Failed to write implementation plan files: ${message}`],
          };
        }
        return null; // File doesn't exist yet — handled by validatePhaseOutputs
      }
    }
    return null; // No schema for this phase
  }

  private async writeAggressiveQuickSpec(
    phaseNumber: number,
    totalPhases: number,
  ): Promise<SpecPhaseResult> {
    const phase: SpecPhase = 'quick_spec';
    this.emitTyped('phase-start', phase, phaseNumber, totalPhases);

    const plan = buildLocalizedAggressiveQuickSpecPlan(
      this.config.taskDescription ?? 'Complete the requested task',
      this.config.language,
      await inferAggressivePatternFiles(
        this.config.projectDir,
        this.config.taskDescription ?? '',
      ),
    );

    try {
      await writeFile(join(this.config.specDir, 'spec.md'), plan.specMarkdown, 'utf-8');
      await writeFile(
        join(this.config.specDir, 'implementation_plan.json'),
        JSON.stringify(plan.implementationPlan, null, 2),
        'utf-8',
      );

      const result: SpecPhaseResult = { phase, success: true, errors: [], retries: 0 };
      const patternFiles = plan.implementationPlan.phases[0]?.subtasks[0]?.pattern_files ?? [];
      const fileHint = patternFiles.length > 0 ? `; file hints: ${patternFiles.join(', ')}` : '';
      this.emitTyped('log', `Aggressive workflow generated quick spec and one-subtask plan without an AI planning session${fileHint}`);
      this.emitTyped('phase-complete', phase, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SpecPhaseResult = { phase, success: false, errors: [message], retries: 0 };
      this.emitTyped('phase-complete', phase, result);
      return result;
    }
  }

  private async compactAggressiveSimplePlan(): Promise<string[]> {
    if (this.config.workflowConfig?.optimizationLevel !== 'aggressive') {
      return [];
    }

    const complexity = this.assessment?.complexity ?? this.config.complexityOverride;
    if (complexity !== 'simple') {
      return [];
    }

    try {
      const plan = await loadImplementationPlanFromFiles(this.config.specDir) as MutableImplementationPlan | null;
      const subtasks = (plan?.phases ?? [])
        .flatMap((phase) => Array.isArray(phase.subtasks) ? phase.subtasks : []);

      if (!plan || subtasks.length <= 1) {
        return [];
      }

      const firstPhase = plan.phases?.[0];
      const filesToCreate = uniqueStrings(subtasks.flatMap((subtask) => subtask.files_to_create ?? []));
      const filesToModify = uniqueStrings(subtasks.flatMap((subtask) => subtask.files_to_modify ?? []));
      const verification = [...subtasks].reverse().find((subtask) => subtask.verification)?.verification
        ?? { type: 'manual', scenario: 'Review the completed change and run the project checks that apply to this task.' };
      const taskList = subtasks
        .map((subtask) => {
          const label = subtask.title?.trim() || subtask.description?.trim() || subtask.id || 'Implementation step';
          return `- ${label}`;
        })
        .join('\n');

      plan.split_plan = false;
      plan.plan_files = undefined;
      plan.phases = [
        {
          id: firstPhase?.id ?? firstPhase?.phase ?? '1',
          phase: firstPhase?.phase ?? 1,
          name: firstPhase?.name ?? 'Implementation',
          subtasks: [
            {
              id: '1-1',
              title: 'Implement complete task',
              description: [
                'Implement the complete requested change in one focused coding session.',
                '',
                'Scope:',
                taskList,
              ].join('\n'),
              status: 'pending',
              ...(filesToCreate.length > 0 ? { files_to_create: filesToCreate } : {}),
              ...(filesToModify.length > 0 ? { files_to_modify: filesToModify } : {}),
              verification,
            },
          ],
        },
      ];

      await saveImplementationPlanToFiles(this.config.specDir, plan as never);
      this.emitTyped('log', `Aggressive workflow compacted implementation plan from ${subtasks.length} subtasks to 1 coder session`);
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [`Failed to compact aggressive implementation plan: ${message}`];
    }
  }

  private async capturePhaseOutput(phase: SpecPhase): Promise<void> {
    const outputFiles = PHASE_OUTPUTS[phase];
    if (!outputFiles?.length) return;

    for (const fileName of outputFiles) {
      try {
        const filePath = join(this.config.specDir, fileName);
        const content = await readFile(filePath, 'utf-8');
        if (content.trim()) {
          this.phaseSummaries[fileName] = content.length > MAX_PHASE_OUTPUT_SIZE
            ? content.slice(0, MAX_PHASE_OUTPUT_SIZE) + '\n... (truncated)'
            : content;
        }
      } catch {
        // File may not exist if phase didn't produce it — that's fine
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private outcome(
    success: boolean,
    phasesExecuted: SpecPhase[],
    durationMs: number,
    error?: string,
  ): SpecOutcome {
    const outcome: SpecOutcome = {
      success,
      complexity: this.assessment?.complexity,
      phasesExecuted,
      durationMs,
      error,
    };

    this.emitTyped('spec-complete', outcome);
    return outcome;
  }

  /**
   * Typed event emitter helper.
   */
  private emitTyped<K extends keyof SpecOrchestratorEvents>(
    event: K,
    ...args: Parameters<SpecOrchestratorEvents[K]>
  ): void {
    this.emit(event, ...args);
  }
}
