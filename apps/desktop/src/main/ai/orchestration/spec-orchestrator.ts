/**
 * Spec Orchestrator
 * =================
 *
 * Drives the spec creation pipeline through complexity-first phase selection:
 *   complexity_assessment → [phases based on tier]
 *
 * Complexity assessment runs FIRST to gate the workflow:
 *   - SIMPLE: Standard light planning → validation (2 phases — no discovery/requirements)
 *   - STANDARD: discovery → requirements → spec_writing → planning → validation
 *   - COMPLEX: Full pipeline including research and self-critique
 *
 * Context accumulation: after each phase, output files are captured and injected
 * into the next phase's kickoff message, eliminating redundant file re-reads.
 */

import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { EventEmitter } from 'events';

import type { AgentType } from '../config/agent-configs';
import { GENERAL_AGENT_PROFILE, type ProjectAgentProfile } from '../config/project-agent-profile';
import {
  AUTOCODE_TASK_ARTIFACTS,
  buildAutocodePlanQualityRetryPrompt,
  buildAutocodeRuntimeImplementationPlanFromTasksMarkdown,
  formatAutocodeRetryErrorLines,
  isAutocodeProjectDataPath,
  saveAutocodeImplementationPlan,
  saveAutocodeTaskRequirementsSync,
  stringifyAutocodeContextMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
  validateAutocodeStandardPlanArtifacts,
  type Phase,
} from '@autocode/core';
import type { SupportedLanguage } from '../../../shared/constants/i18n';
import {
  validateJsonFile,
  ComplexityAssessmentSchema,
  ImplementationPlanSchema,
  validateImplementationPlanLanguage,
  ComplexityAssessmentOutputSchema,
  buildValidationRetryPrompt,
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
  RequirementsOutputSchema,
  type RequirementsOutput,
  type SpecContextOutput,
  type ResearchOutput,
} from '../schema';
import type { ZodSchema } from 'zod';
import type { SessionResult } from '../session/types';
import type { WorkflowConfig } from './workflow-config';
import { getRetryLimits, DEFAULT_WORKFLOW_CONFIG } from './workflow-config';
import {
  inferAutocodeSpecComplexityFallback,
  parseAutocodeProjectDocsReferenceSummary,
  selectAutocodeSpecPhases,
  shouldForceSplitAutocodeImplementationPlan,
  shouldRunAutocodeSpecResearchPhase,
} from '@autocode/core/runtime/spec-orchestrator-strategy';

// =============================================================================
// Constants
// =============================================================================

/** Maximum retries for a single phase (configurable via WorkflowConfig) */
const MAX_PHASE_RETRIES = 2;

/** Maximum characters of a single phase output summary to carry forward. */
const MAX_PHASE_OUTPUT_SIZE = 2_600;
const PHASE_OUTPUT_EXCERPT_MAX_CHARS = 900;
const PHASE_OUTPUT_LINE_MAX_CHARS = 220;
const PHASE_OUTPUT_HEADING_LIMIT = 8;
const PHASE_OUTPUT_BULLET_LIMIT = 14;
const PHASE_OUTPUT_PARAGRAPH_LIMIT = 3;
const PHASE_OUTPUT_JSON_ARRAY_LIMIT = 6;
const PHASE_OUTPUT_JSON_OBJECT_KEY_LIMIT = 18;
const SPEC_ARTIFACT_TASK_DESCRIPTION_MAX_CHARS = 4_000;
const SPEC_ARTIFACT_TASK_DESCRIPTION_COMPACTION_NOTICE =
  '\n\n...[task description middle omitted for artifact budget; read task metadata if exact omitted detail is required]...\n\n';

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

function formatSpecPhaseNameForLog(phase: SpecPhase, language?: SupportedLanguage): string {
  const labels: Record<SpecPhase, string> = language === 'zh-CN'
    ? {
        complexity_assessment: '\u590d\u6742\u5ea6\u8bc4\u4f30',
        discovery: '\u9879\u76ee\u53d1\u73b0',
        requirements: '\u9700\u6c42\u5206\u6790',
        historical_context: '\u5386\u53f2\u4e0a\u4e0b\u6587',
        research: '\u7814\u7a76\u9a8c\u8bc1',
        context: '\u4e0a\u4e0b\u6587\u5efa\u6a21',
        spec_writing: '\u89c4\u683c\u6587\u6863',
        self_critique: '\u81ea\u6211\u5ba1\u67e5',
        planning: '\u4efb\u52a1\u8ba1\u5212',
        validation: '\u8ba1\u5212\u6821\u9a8c',
        quick_spec: '\u6807\u51c6\u8f7b\u91cf\u89c4\u5212',
      }
    : {
        complexity_assessment: 'Complexity assessment',
        discovery: 'Project discovery',
        requirements: 'Requirements analysis',
        historical_context: 'Historical context',
        research: 'Research validation',
        context: 'Context modeling',
        spec_writing: 'Specification writing',
        self_critique: 'Self critique',
        planning: 'Task planning',
        validation: 'Plan validation',
        quick_spec: 'Standard light planning',
      };

  return labels[phase] ?? phase.replace(/_/g, ' ');
}

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
 * - SIMPLE: skip discovery & requirements entirely; the internal quick_spec phase writes a light Standard plan.
 * - STANDARD: discovery builds context.md, requirements gathers formal reqs,
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

type DocumentationProfile = 'general-source' | 'game-mmo-source';

const GAME_MMO_DOCUMENTATION_FOCUS = [
  'gameplay systems, progression loops, combat, quests, items, economy, social, and faction mechanics',
  'client runtime, engine integration, rendering, animation, asset loading, world/scene streaming, and UI integration',
  'server authority, simulation boundaries, network protocol, replication, synchronization, prediction, and reconciliation',
  'data/config/content pipeline, persistence, account state, economy state, migrations, and tooling data contracts',
  'GM/editor/production tools, build/release pipeline, performance budgets, security/anti-cheat, telemetry, and live operations',
] as const;

/** Maps each phase to the output files it typically produces */
const PHASE_OUTPUTS: Partial<Record<SpecPhase, string[]>> = {
  discovery: [AUTOCODE_TASK_ARTIFACTS.context],
  requirements: [AUTOCODE_TASK_ARTIFACTS.requirements],
  complexity_assessment: ['complexity_assessment.json'],
  research: [AUTOCODE_TASK_ARTIFACTS.research],
  context: [AUTOCODE_TASK_ARTIFACTS.context],
  spec_writing: ['spec.md'],
  self_critique: ['spec.md'],
  planning: [AUTOCODE_TASK_ARTIFACTS.tasks],
  quick_spec: [AUTOCODE_TASK_ARTIFACTS.specFile, AUTOCODE_TASK_ARTIFACTS.tasks],
};

const STRUCTURED_JSON_PHASE_OUTPUTS: Partial<Record<SpecPhase, string>> = {
  requirements: AUTOCODE_TASK_ARTIFACTS.requirements,
};

/** State file name for tracking spec creation progress */
const SPEC_STATE_FILE = 'spec_state.json';

/** Spec creation state for resume support */
interface SpecState {
  complexity?: ComplexityTier;
  complexityReasoning?: string;
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
  /** Generated project documentation reference text injected into all phases. */
  projectDocsReference?: string;
  /** @deprecated Use projectDocsReference. */
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
  /** Project-specific agent routing profile */
  agentProfile?: ProjectAgentProfile;
  /** Callback to generate the system prompt for a given agent type and phase */
  generatePrompt: (agentType: AgentType, phase: SpecPhase, context: SpecPromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: SpecSessionRunConfig) => Promise<SessionResult>;
}

interface StandardLightPlan {
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
        requirements?: string[];
        evidence?: string;
        verification: {
          type: string;
          run: string;
          scenario?: string;
        };
      }>;
    }>;
    documentation_depth?: 'standard' | 'deep' | 'architecture';
    project_type?: ProjectAgentProfile['id'];
    documentation_profile?: DocumentationProfile;
    documentation_focus?: string[];
    document_outputs?: {
      final_markdown: string;
      outline: string;
      evidence_index: string;
    };
    source_task: {
      original_request: string;
      constraint_terms: string[];
    };
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
  /** Generated project documentation reference text. */
  projectDocsReference?: string;
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
  /** Generated project documentation reference text for kickoff enrichment. */
  projectDocsReference?: string;
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

interface FallbackComplexityAssessment {
  complexity: ComplexityTier;
  confidence: number;
  reasoning: string;
  needs_research?: boolean;
  needs_self_critique?: boolean;
}

interface MinimalPlanSubtask {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  requirements?: string[];
  upstream_task_ids?: string[];
  work_package?: boolean;
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
}

function hasExecutableSubtasks(plan: MinimalImplementationPlan | null): boolean {
  return plan?.phases?.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0) ?? false;
}

function isSparseProjectDocsReference(projectDocsReference: string | undefined): boolean {
  if (!projectDocsReference) {
    return false;
  }

  try {
    const parsed = JSON.parse(projectDocsReference) as {
      services?: Record<string, unknown>;
      infrastructure?: Record<string, unknown>;
    };
    const services = parsed.services && typeof parsed.services === 'object'
      ? Object.keys(parsed.services).length
      : 0;
    const infrastructure = parsed.infrastructure && typeof parsed.infrastructure === 'object'
      ? Object.keys(parsed.infrastructure).length
      : 0;
    return services === 0 && infrastructure === 0;
  } catch {
    return projectDocsReference.trim().length > 0 &&
      projectDocsReference.length < 512 &&
      !/(project-docs|index\.md|package\.json|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle)/i.test(projectDocsReference);
  }
}

function isSourceDocumentationTask(taskDescription: string | undefined): boolean {
  const task = normalizeTaskDescription(taskDescription).toLowerCase();
  if (!task) {
    return false;
  }

  const hasDocumentationOutput =
    /\b(document|documentation|docs|readme|guide|manual|summary|report|markdown|write[-\s]?up|architecture overview|design note)\b/i.test(task) ||
    /(\u6587\u6863|\u8bf4\u660e|\u603b\u7ed3|\u62a5\u544a|\u6307\u5357|\u624b\u518c|\u67b6\u6784\u6982\u8ff0|\u8bbe\u8ba1\u8bf4\u660e)/.test(task);
  const hasSourceAnalysis =
    /\b(analy[sz]e|inspect|review|understand|summari[sz]e|explain|map|overview)\b.*\b(source|code|codebase|project|module|class|api|architecture|flow|implementation)\b/i.test(task) ||
    /\b(source|code|codebase|project|module|class|api|architecture|flow|implementation)\b.*\b(analy[sz]e|inspect|review|understand|summari[sz]e|explain|map|overview)\b/i.test(task) ||
    /(\u5206\u6790|\u68b3\u7406|\u9605\u8bfb|\u7406\u89e3|\u89e3\u91ca|\u6982\u8ff0).*(\u6e90\u7801|\u4ee3\u7801|\u9879\u76ee|\u6a21\u5757|\u7c7b|\u63a5\u53e3|\u67b6\u6784|\u6d41\u7a0b|\u5b9e\u73b0)/.test(task) ||
    /(\u6e90\u7801|\u4ee3\u7801|\u9879\u76ee|\u6a21\u5757|\u7c7b|\u63a5\u53e3|\u67b6\u6784|\u6d41\u7a0b|\u5b9e\u73b0).*(\u5206\u6790|\u68b3\u7406|\u9605\u8bfb|\u7406\u89e3|\u89e3\u91ca|\u6982\u8ff0)/.test(task);
  const hasDocumentationOnlyConstraint =
    /\b(do not|don't|without)\b.*\b(modify|change|edit)\b.*\b(source|code|product code)\b/i.test(task) ||
    /\b(documentation|docs|markdown|document)\b.*\bonly\b/i.test(task) ||
    /(\u4e0d\u4fee\u6539|\u7981\u6b62\u4fee\u6539|\u4ec5|\u53ea).*(\u6e90\u4ee3\u7801|\u6e90\u7801|\u4ee3\u7801|\u4ea7\u54c1\u4ee3\u7801|\u6587\u6863|\u5206\u6790\u6587\u6863)/.test(task);
  const implementationAsDocumentNoun =
    /\bimplementation\s+(plan|scheme|design|document|documentation|guide|markdown|analysis)\b/i.test(task) ||
    /(\u5b9e\u73b0\u65b9\u6848|\u5b9e\u73b0\u8bf4\u660e|\u5b9e\u73b0\u6587\u6863|\u5b9e\u73b0\u5206\u6790)/.test(task);
  const hasMutationIntent =
    /\b(implement|add|fix|change|modify|refactor|rewrite|migrate|port|delete|remove|replace|build|create app|develop)\b/i.test(task) ||
    /(\u5b9e\u73b0|\u4fee\u590d|\u4fee\u6539|\u6539\u9020|\u91cd\u6784|\u8fc1\u79fb|\u79fb\u690d|\u5220\u9664|\u66ff\u6362|\u5f00\u53d1|\u7f16\u5199\u7a0b\u5e8f)/.test(task);

  return hasDocumentationOutput &&
    hasSourceAnalysis &&
    (!hasMutationIntent || hasDocumentationOnlyConstraint || implementationAsDocumentNoun);
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

function compactSpecArtifactTaskDescription(taskDescription: string | undefined): string {
  const normalized = (taskDescription ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!normalized) {
    return 'Create the requested software change.';
  }
  if (normalized.length <= SPEC_ARTIFACT_TASK_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }

  const budget = Math.max(
    0,
    SPEC_ARTIFACT_TASK_DESCRIPTION_MAX_CHARS - SPEC_ARTIFACT_TASK_DESCRIPTION_COMPACTION_NOTICE.length,
  );
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    normalized.slice(0, headBudget).trimEnd(),
    SPEC_ARTIFACT_TASK_DESCRIPTION_COMPACTION_NOTICE,
    normalized.slice(-tailBudget).trimStart(),
  ].join('');
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

const CONSTRAINT_TERM_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'C++', pattern: /c\+\+|cpp|cxx/i },
  { label: 'C', pattern: /(?:^|[^\w+#])c(?:$|[^\w+#])|clang|gcc/i },
  { label: 'Python', pattern: /python|py\b/i },
  { label: 'JavaScript', pattern: /javascript|js\b/i },
  { label: 'TypeScript', pattern: /typescript|ts\b/i },
  { label: 'Java', pattern: /java\b/i },
  { label: 'Go', pattern: /go\b|golang/i },
  { label: 'Rust', pattern: /rust|cargo/i },
  { label: 'C#', pattern: /c#|csharp|\.net/i },
  { label: 'Web', pattern: /html|web|\u7f51\u9875|\u9875\u9762|\u6d4f\u89c8\u5668/i },
  { label: 'Console', pattern: /console|\u63a7\u5236\u53f0/i },
  { label: 'Desktop', pattern: /desktop|electron|\u684c\u9762/i },
  { label: 'Mobile', pattern: /mobile|android|ios|\u79fb\u52a8/i },
  { label: 'CLI', pattern: /\bcli\b|command line|\u547d\u4ee4\u884c/i },
];

function extractConstraintTerms(taskDescription: string): string[] {
  return CONSTRAINT_TERM_PATTERNS
    .filter((item) => item.pattern.test(taskDescription))
    .map((item) => item.label);
}

function buildConstraintReminder(task: string, language?: SupportedLanguage): string {
  const terms = extractConstraintTerms(task);
  if (terms.length === 0) {
    return '';
  }

  const termList = terms.join(', ');
  return language === 'zh-CN'
    ? `必须保持原始请求中的技术/平台约束：${termList}。不要改成其他语言、运行环境或交付形态，除非用户明确要求。`
    : `Preserve the original technical/platform constraints: ${termList}. Do not switch language, runtime, or delivery format unless the user explicitly asked for it.`;
}

const COMMON_LOW_VALUE_ROOT_FILES = new Set([
  'task_logs.jsonl',
  'task_metadata.json',
  AUTOCODE_TASK_ARTIFACTS.requirements,
  AUTOCODE_TASK_ARTIFACTS.implementationPlan,
  'spec.md',
]);

const DOCUMENTATION_SOURCE_FILE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.cs', '.java', '.kt', '.go', '.rs', '.py',
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
]);

const DOCUMENTATION_ENTRY_FILE_NAMES = [
  'main', 'index', 'app', 'application', 'program', 'server', 'client',
  'game', 'engine', 'core',
];

const DOCUMENTATION_SUPPORT_FILES = ['doc_outline.md', 'evidence_index.md'];

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
    if (!file || isAutocodeProjectDataPath(file)) {
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
    const task = normalizeTaskDescription(taskDescription);
    const entries = await readdir(projectDir, { withFileTypes: true });
    const rootFileHints = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        score: scoreLocalizedAggressiveRootCandidate(entry.name, task),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 4)
      .map((entry) => entry.name);

    if (!isSourceDocumentationTask(taskDescription)) {
      return rootFileHints;
    }

    const sourceDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^(src|source|sources|lib|include|app|apps|packages|core|engine)$/i.test(name))
      .slice(0, 3);
    const sourceFileHints = await inferDocumentationSourceFileHints(projectDir, sourceDirs);

    const manifestHints = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^(package\.json|tsconfig\.json|vite\.config\.[cm]?[jt]s|CMakeLists\.txt|Makefile|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|build\.gradle|settings\.gradle)$/i.test(name))
      .slice(0, 3);

    return Array.from(new Set([...manifestHints, ...rootFileHints, ...sourceFileHints])).slice(0, 8);
  } catch {
    return [];
  }
}

async function inferDocumentationSourceFileHints(projectDir: string, sourceDirs: string[]): Promise<string[]> {
  const hints: Array<{ path: string; score: number }> = [];
  for (const dir of sourceDirs) {
    try {
      const entries = await readdir(join(projectDir, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        if (!DOCUMENTATION_SOURCE_FILE_EXTENSIONS.has(ext)) {
          continue;
        }
        const base = entry.name.slice(0, entry.name.length - ext.length).toLowerCase();
        const entryScore = DOCUMENTATION_ENTRY_FILE_NAMES.some((name) => base === name || base.includes(name)) ? 20 : 0;
        const headerScore = ['.h', '.hpp'].includes(ext) ? 5 : 0;
        hints.push({
          path: `${dir}/${entry.name}`,
          score: entryScore + headerScore,
        });
      }
    } catch {
    }
  }

  return hints
    .filter((hint) => hint.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 5)
    .map((hint) => hint.path);
}

function _buildAggressiveStandardLightPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
): StandardLightPlan {
  const task = normalizeTaskDescription(taskDescription);
  const feature = oneLine(task, 120);
  const title = language === 'zh-CN' ? '实现完整任务' : 'Implement complete task';
  const phaseName = language === 'zh-CN' ? '实现' : 'Implementation';
  const verificationRun = language === 'zh-CN'
    ? '根据项目类型运行最小可用验证；若没有自动化验证，说明已完成的人工检查。'
    : 'Run the smallest available project-specific verification; if none exists, describe the manual check completed.';
  const specMarkdown = [
    `# Specification: ${feature}`,
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
              id: '1.1',
              title,
              description: [
                task,
                '',
                'Implement the complete requested change in one focused coding session. Read only directly relevant files before editing.',
                'Done when: Requested behavior is complete and focused verification is recorded.',
              ].join('\n'),
              status: 'pending',
              files_to_create: [],
              files_to_modify: [],
              ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
              requirements: ['1.1'],
              evidence: 'spec.md scope and user task description',
              verification: {
                type: 'manual',
                run: verificationRun,
              },
            },
          ],
        },
      ],
      source_task: {
        original_request: task,
        constraint_terms: extractConstraintTerms(task),
      },
    },
  };
}

function buildLocalizedAggressiveStandardLightPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
): StandardLightPlan {
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
  const constraintReminder = buildConstraintReminder(task, language);
  const specMarkdown = isChinese
    ? [
        `# \u89c4\u683c\uff1a${feature}`,
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
        ...(constraintReminder ? [`- ${constraintReminder}`] : []),
        '- \u9664\u975e\u73b0\u6709\u4ee3\u7801\u660e\u786e\u9700\u8981\uff0c\u5426\u5219\u4e0d\u5f15\u5165\u65b0\u8bbe\u8ba1\u6a21\u5f0f\u3002',
        '',
        '## \u6210\u529f\u6807\u51c6',
        '- \u5df2\u5b9e\u73b0\u7528\u6237\u8bf7\u6c42\u7684\u884c\u4e3a\u3002',
        '- \u5df2\u8bb0\u5f55\u6709\u9488\u5bf9\u6027\u7684\u9a8c\u8bc1\u6216\u4eba\u5de5\u68c0\u67e5\u7ed3\u679c\u3002',
        '',
      ].join('\n')
    : [
        `# Specification: ${feature}`,
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
        ...(constraintReminder ? [`- ${constraintReminder}`] : []),
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
              id: '1.1',
              title,
              description: [
                task,
                '',
                implementationInstruction,
                ...(constraintReminder ? ['', constraintReminder] : []),
                'Done when: Requested behavior is complete and focused verification is recorded.',
              ].join('\n'),
              status: 'pending',
              files_to_create: filesToCreate,
              files_to_modify: [],
              ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
              requirements: ['1.1'],
              evidence: 'spec.md scope and user task description',
              verification: {
                type: 'manual',
                run: verificationRun,
              },
            },
          ],
        },
      ],
      source_task: {
        original_request: task,
        constraint_terms: extractConstraintTerms(task),
      },
    },
  };
}

function inferDocumentationOutputFile(task: string): string {
  const markdownPath = task.match(/(?:^|[\s"'`(（])([A-Za-z0-9_./-]+\.md)(?=$|[\s"'`)），。；;])/i)?.[1];
  if (markdownPath) {
    return markdownPath.replace(/\\/g, '/');
  }
  if (/\breadme\b|README/i.test(task)) {
    return 'README.md';
  }
  return 'docs/analysis.md';
}

function inferDocumentationDepth(task: string): 'standard' | 'deep' | 'architecture' {
  if (/\b(architecture|system design|large[-\s]?scale|end-to-end|deep|comprehensive)\b/i.test(task) ||
    /(\u67b6\u6784|\u7cfb\u7edf\u8bbe\u8ba1|\u5927\u578b|\u5b8c\u6574|\u6df1\u5ea6|\u5168\u9762)/.test(task)) {
    return 'architecture';
  }
  if (/\b(source analysis|code analysis|implementation analysis|flow|data flow|call chain)\b/i.test(task) ||
    /(\u6e90\u7801\u5206\u6790|\u4ee3\u7801\u5206\u6790|\u5b9e\u73b0\u5206\u6790|\u6d41\u7a0b|\u6570\u636e\u6d41|\u8c03\u7528\u94fe)/.test(task)) {
    return 'deep';
  }
  return 'standard';
}

function getDocumentationQualityGuidance(
  outputFile: string,
  depth: 'standard' | 'deep' | 'architecture',
  language?: SupportedLanguage,
): string[] {
  if (language === 'zh-CN') {
    return [
      `文档深度：${depth}。`,
      '先写 `doc_outline.md`：包含文档类型、目标读者、章节列表、每节要回答的问题、预计引用的文件。',
      '再写 `evidence_index.md`：记录已阅读文件、每个关键结论的证据文件、推断项和未确认项。',
      `最后写 \`${outputFile}\`：按大纲生成结构化 Markdown。`,
      '最终 Markdown 必须包含：概览、范围、关键文件/模块、核心流程、数据/状态流、边界与风险、未确认项。',
      '关键结论要标明来源文件；事实、推断、风险要分开写。',
      '可以使用表格、流程列表和短小 Mermaid 图；不要复制大段源码。',
    ];
  }

  return [
    `Documentation depth: ${depth}.`,
    'First write `doc_outline.md` with document type, audience, sections, questions each section answers, and planned source references.',
    'Then write `evidence_index.md` as a claim-to-source ledger with files read, subsystem, evidence-backed claims, confidence, inferred/unverified claims, uncovered areas, and open questions.',
    `Finally write \`${outputFile}\` as structured Markdown from the outline and evidence.`,
    'Final Markdown must include: overview, scope, source evidence matrix, key files/modules, entry points, module ownership, public interfaces, core flows, data/state flow, boundaries and risks, and open questions.',
    'Cite concrete source/config paths for important claims; separate facts, inferences, and risks.',
    'Do not rely on README/manifests alone; follow imports/routes/IPC/API/schema/config/test/build evidence until ownership and flows are clear.',
    'Use tables, flow lists, and small Mermaid diagrams where useful; do not copy large source blocks.',
  ];
}

function getDocumentationProfile(agentProfile?: ProjectAgentProfile): DocumentationProfile {
  return agentProfile?.id === 'game-mmo' ? 'game-mmo-source' : 'general-source';
}

function getGameMmoDocumentationQualityGuidance(language?: SupportedLanguage): string[] {
  if (language === 'zh-CN') {
    return [
      '游戏项目必须按大型网络游戏专业维度组织：玩法系统、客户端/引擎、服务端权威、网络同步、数据配置/持久化、工具链、性能、安全反作弊、运营。',
      '每个重要系统要说明：入口文件、运行时归属、关键数据、状态变化、跨端协议/同步边界、配置来源、生产工具入口、风险和待验证点。',
      '文档要区分策划数值/内容配置、客户端表现、服务端判定、网络协议、存档/经济状态和 GM/运营工具，避免把不同层混在一起。',
      '优先输出系统矩阵、跨端流程、数据生命周期、状态机/时序图、协议/配置证据表，以及性能和安全关注点。',
    ];
  }

  return [
    'For game projects, structure the document around large-online-game dimensions: gameplay systems, client/engine, server authority, network sync, data/config/persistence, tooling, performance, security/anti-cheat, and live operations.',
    'For each important system, identify entry files, runtime ownership, key data, state transitions, cross-end protocol/sync boundaries, configuration sources, production-tool entry points, risks, and open questions.',
    '`evidence_index.md` needs concrete source/config paths for each major system where present; if a domain is absent, mark it as not found or uncovered instead of guessing.',
    'The final document must include a system matrix with source entry points, runtime owner, authoritative side, protocol/config/data path, verification hooks, risks, and open questions.',
    'Separate design/content data, client presentation, server adjudication, network protocol, save/economy state, and GM/liveops tools instead of merging them into one generic flow.',
    'Prefer system matrices, cross-end flows, data lifecycle notes, state/sequence diagrams, protocol/config evidence tables, and performance/security notes.',
  ];
}

function getProfiledDocumentationQualityGuidance(
  outputFile: string,
  depth: 'standard' | 'deep' | 'architecture',
  language: SupportedLanguage | undefined,
  profile: DocumentationProfile,
): string[] {
  const guidance = getDocumentationQualityGuidance(outputFile, depth, language);
  return profile === 'game-mmo-source'
    ? [...guidance, ...getGameMmoDocumentationQualityGuidance(language)]
    : guidance;
}

function buildSourceDocumentationStandardLightPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
  agentProfile?: ProjectAgentProfile,
): StandardLightPlan {
  const task = normalizeTaskDescription(taskDescription);
  const feature = oneLine(task, 120);
  const outputFile = inferDocumentationOutputFile(task);
  const documentationDepth = inferDocumentationDepth(task);
  const documentationProfile = getDocumentationProfile(agentProfile);
  const isGameMmoDocumentation = documentationProfile === 'game-mmo-source';
  const qualityGuidance = getProfiledDocumentationQualityGuidance(
    outputFile,
    documentationDepth,
    language,
    documentationProfile,
  );
  const isChinese = language === 'zh-CN';
  const phaseName = isChinese ? '\u6587\u6863\u5206\u6790' : 'Documentation analysis';
  const title = isChinese ? '\u5206\u6790\u6e90\u7801\u5e76\u751f\u6210\u6587\u6863' : 'Analyze source and generate documentation';
  const outputHint = isChinese
    ? `\u751f\u6210\u6216\u66f4\u65b0\u7528\u6237\u8981\u6c42\u7684 Markdown \u6587\u6863\u3002\u672a\u6307\u5b9a\u8f93\u51fa\u6587\u4ef6\u65f6\u4f7f\u7528 ${outputFile}\u3002\u540c\u65f6\u751f\u6210 doc_outline.md \u548c evidence_index.md\u3002`
    : `Create or update the requested Markdown document. When no output file is specified, use ${outputFile}. Also create doc_outline.md and evidence_index.md.`;
  const readRule = isChinese
    ? '\u53ea\u505a\u6587\u6863\u5206\u6790\uff0c\u4e0d\u4fee\u6539\u4ea7\u54c1\u4ee3\u7801\u3002\u5148\u7528\u9879\u76ee\u6587\u6863\u53c2\u8003\u548c\u7528\u6237\u6307\u5b9a\u6587\u4ef6\u5b9a\u4f4d\u8303\u56f4\uff0c\u518d\u6cbf\u5165\u53e3\u3001\u516c\u5171\u63a5\u53e3\u3001\u914d\u7f6e\u548c\u6838\u5fc3\u8c03\u7528\u94fe\u6269\u5c55\u8bc1\u636e\u3002'
    : 'This is documentation analysis only; do not modify product code. Use the project documentation reference and user-specified files to narrow scope, but do not stop at README/manifests; expand evidence through entry points, public interfaces, imports/routes/IPC/API/schema/config/test/build files, and core call chains.';
  const verificationRun = isChinese
    ? `\u786e\u8ba4 ${outputFile}\u3001doc_outline.md \u548c evidence_index.md \u5df2\u751f\u6210\uff0cMarkdown \u5305\u542b\u7ed3\u6784\u5316\u6e90\u7801\u5206\u6790\u3001\u8bc1\u636e\u6587\u4ef6\u3001\u6d41\u7a0b/\u6570\u636e\u6d41\u548c\u672a\u786e\u8ba4\u9879\u3002\u4e0d\u8981\u4e3a\u7eaf\u6587\u6863\u4efb\u52a1\u8fd0\u884c\u7f16\u8bd1\u6216 QA\u3002`
    : `Confirm ${outputFile}, doc_outline.md, and evidence_index.md exist; evidence_index.md cites concrete source/config paths; Markdown contains structured source analysis, source evidence matrix, flows/data flow, and open questions. Do not run build or QA for documentation-only tasks.`;
  const profileSpecLines = isGameMmoDocumentation
    ? isChinese
      ? [
          '- 文档画像：大型网络游戏 / MMO 源码专业分析。',
          '- 重点覆盖：玩法系统、客户端/引擎、服务端权威、网络同步、数据配置/持久化、工具链、性能、安全反作弊、运营。',
        ]
      : [
          '- Documentation profile: large online game / MMO source analysis.',
          '- Cover gameplay systems, client/engine, server authority, network sync, data/config/persistence, tooling, performance, security/anti-cheat, and live operations.',
        ]
    : [];
  const specMarkdown = isChinese
    ? [
        `# \u6587\u6863\u5206\u6790\u4efb\u52a1\uff1a${feature}`,
        '',
        '## \u76ee\u6807',
        task,
        '',
        '## \u8303\u56f4',
        `- \u8f93\u51fa Markdown \u6587\u6863\uff1a\`${outputFile}\`\u3002`,
        '- \u8f93\u51fa\u652f\u6491\u6587\u4ef6\uff1a`doc_outline.md`\u3001`evidence_index.md`\u3002',
        `- \u6587\u6863\u6df1\u5ea6\uff1a${documentationDepth}\u3002`,
        '- \u9605\u8bfb\u8db3\u591f\u7684\u5173\u952e\u6e90\u7801\u6587\u4ef6\uff0c\u652f\u6301\u7ed3\u8bba\u53ef\u8ffd\u6eaf\u3002',
        '- \u4e0d\u505a\u4ea7\u54c1\u4ee3\u7801\u6539\u52a8\u3002',
        ...profileSpecLines,
        '',
        '## \u8d28\u91cf\u6807\u51c6',
        ...qualityGuidance.map((item) => `- ${item}`),
        '',
        '## \u9a8c\u6536',
        '- \u6587\u6863\u5df2\u751f\u6210\u6216\u66f4\u65b0\u3002',
        '- \u6587\u6863\u5305\u542b\u4ee3\u7801\u8bc1\u636e\u3001\u6838\u5fc3\u6d41\u7a0b\u3001\u8fb9\u754c\u98ce\u9669\u548c\u672a\u786e\u8ba4\u9879\u3002',
        '',
      ].join('\n')
    : [
        `# Documentation Analysis Task: ${feature}`,
        '',
        '## Goal',
        task,
        '',
        '## Scope',
        `- Output Markdown documentation: \`${outputFile}\`.`,
        '- Output support files: `doc_outline.md`, `evidence_index.md`.',
        `- Documentation depth: ${documentationDepth}.`,
        '- Read enough key source files to make conclusions traceable.',
        '- Cite concrete source/config file paths for major claims.',
        '- Do not change product code.',
        ...profileSpecLines,
        '',
        '## Quality Standard',
        ...qualityGuidance.map((item) => `- ${item}`),
        '',
        '## Acceptance',
        '- Documentation is created or updated.',
        '- The document includes code evidence, core flows, boundaries/risks, and open questions.',
        '',
      ].join('\n');

  return {
    specMarkdown,
    implementationPlan: {
      feature,
      workflow_type: 'documentation',
      phases: [
        {
          id: '1',
          phase: 1,
          name: phaseName,
          depends_on: [],
          subtasks: [
            {
              id: '1.1',
              title,
              description: [
                task,
                '',
                readRule,
                outputHint,
                ...qualityGuidance,
                isChinese
                  ? '\u4f18\u5148\u7528\u8868\u683c\u3001\u5206\u5c42\u6807\u9898\u3001\u6d41\u7a0b\u5217\u8868\u5448\u73b0\uff0c\u907f\u514d\u5927\u6bb5\u5806\u53e0\u6587\u5b57\u3002'
                  : 'Prefer tables, layered headings, and flow lists instead of long prose blocks.',
                'Done when: Requested documentation and evidence support files exist and focused verification is recorded.',
              ].join('\n'),
              status: 'pending',
              files_to_create: [outputFile, ...DOCUMENTATION_SUPPORT_FILES],
              files_to_modify: [],
              ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
              requirements: ['1.1'],
              evidence: 'spec.md documentation scope; project source files; evidence_index.md',
              verification: {
                type: 'manual',
                run: verificationRun,
              },
            },
          ],
        },
      ],
      documentation_depth: documentationDepth,
      project_type: agentProfile?.id,
      documentation_profile: documentationProfile,
      documentation_focus: isGameMmoDocumentation
        ? [...GAME_MMO_DOCUMENTATION_FOCUS]
        : undefined,
      document_outputs: {
        final_markdown: outputFile,
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      source_task: {
        original_request: task,
        constraint_terms: extractConstraintTerms(task),
      },
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
      'RETRY TASKS WRITE',
      '',
      'The previous Write call was rejected before execution.',
      `Retry by writing ${AUTOCODE_TASK_ARTIFACTS.tasks} instead of returning task text in the final response.`,
      '',
      'Retry rules:',
      `- Use the Write tool to create ${normalizedSpecDir}/${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runtime derives it from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      '- Pass one JSON object with file_path and content, not a string containing JSON.',
      '- Use forward slashes in file_path.',
      '- Write checklist Markdown, not JSON.',
      '- Use "- [ ] 1. Phase title" and "- [ ] 1.1 Subtask title" items.',
      '- Keep descriptions concise and preserve necessary subtasks in the single Markdown file.',
      '- Omit source code, long analysis, and copied documentation.',
      '',
      'Write input shape:',
      `{"file_path":"${normalizedSpecDir}/${AUTOCODE_TASK_ARTIFACTS.tasks}","content":"..."}`,
    ].join('\n');
  }

  if (phase === 'quick_spec') {
    return [
      'RETRY QUICK SPEC WRITES',
      '',
      'The previous Write call was rejected before execution.',
      '',
      'Retry rules:',
      `- Use the Write tool to create ${normalizedSpecDir}/spec.md.`,
      `- Use the Write tool to create ${normalizedSpecDir}/${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runtime derives it from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      '- Pass one JSON object per Write call with file_path and content.',
      '- For spec.md, write a compact 20-60 line version first.',
      `- Keep ${AUTOCODE_TASK_ARTIFACTS.tasks} concise and parseable.`,
      '- Do not paste the task list into the final response.',
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
    : phase === 'discovery' || phase === 'context'
      ? [
          `For ${AUTOCODE_TASK_ARTIFACTS.context}, write concise Markdown with sections: Task, Scoped Services, Architecture Summary, Files To Modify, Files To Reference, Design Patterns, Implementation Notes, Risks, Verification Suggestions, Standards References, Assumptions, Evidence Sources.`,
          'Evidence Sources must be Markdown bullets that cite exact files, symbols, lines, project docs, or verified references.',
          'Do not write JSON for project context.',
        ]
    : [
        'Keep the required file content concise; use JSON only for app-parsed structured files and Markdown for prose/reference artifacts.',
      ];

  return [
    'RETRY WRITE WITH VALID INPUT',
    '',
    'The previous Write call was rejected because the tool input JSON was incomplete, malformed, or the wrong type.',
    '',
    'Write input shape:',
    `{"file_path":"${targetFiles.split(', ')[0]}","content":"..."}`,
    '',
    'Retry rules:',
    `- Use the Write tool to create: ${targetFiles}`,
    '- Pass one JSON object with file_path and content, not a string containing JSON.',
    '- For multiple required files, call Write once per file.',
    '- Use forward slashes in file_path.',
    '- Keep each Write content short enough that the JSON closes correctly.',
    '- If the error text ended after "file_path", the content key was omitted or the tool JSON was truncated.',
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
      `Include ${AUTOCODE_TASK_ARTIFACTS.context} sections for files to modify, files to reference, scoped services, design patterns, evidence sources, standards references, assumptions, implementation notes, risks, and verification suggestions.`,
      `For ${AUTOCODE_TASK_ARTIFACTS.context}, Evidence Sources must be Markdown bullets with path, optional symbol, optional lines, what it proves, and confidence.`,
      'Every major architecture or pattern claim must be backed by evidence_sources; put uncertain claims in assumptions instead of presenting them as fact.',
    ],
    context: [
      'Focus on task-specific architecture, files, patterns, risks, and verification suggestions.',
      'Do not copy source code or broad repository inventories.',
    ],
    requirements: [
      'Include task_description, workflow_type, services_involved, user_requirements, acceptance_criteria, constraints, evidence_sources, standards_references, assumptions, and created_at.',
      'Keep each requirement and criterion short and actionable.',
      'Every requirement and acceptance criterion must come from the user request, project source/docs, or a verified standards reference; put gaps in assumptions.',
    ],
    research: [
      'Include concise verified findings only; link to sources instead of copying documentation.',
      'Keep code snippets out unless they are one-line API examples.',
    ],
  };

  const finalJsonTarget = fileName === AUTOCODE_TASK_ARTIFACTS.requirements
    ? `${fileName} data`
    : fileName === AUTOCODE_TASK_ARTIFACTS.research
      ? `${fileName} data`
    : fileName;
  const diskFormat = fileName === AUTOCODE_TASK_ARTIFACTS.requirements || fileName === AUTOCODE_TASK_ARTIFACTS.research
    ? 'Markdown'
    : 'JSON';

  return [
    `RETURN ${finalJsonTarget} AS FINAL JSON`,
    '',
    'Your previous structured output could not be parsed or validated.',
    `Return final JSON instead of calling Write for this ${diskFormat} file.`,
    '',
    `Return the complete ${finalJsonTarget} as the final response JSON object.`,
    `The orchestrator will validate that final JSON and write ${fileName} to disk as ${diskFormat}.`,
    '',
    'Retry rules:',
    `- Target file: ${normalizedSpecDir}/${fileName}.`,
    '- No markdown fence and no prose outside the JSON object.',
    '- Use forward slashes in any file paths.',
    '- Keep the JSON compact so it can be parsed reliably.',
    '- Prefer summaries and exact file paths over copied source code, large tables, or long analysis.',
    ...(phaseGuidance[phase] ?? []).map((line) => `- ${line}`),
  ].join('\n');
}

function getStructuredJsonOutputSchema(phase: SpecPhase): ZodSchema | undefined {
  switch (phase) {
    case 'requirements':
      return RequirementsOutputSchema;
    default:
      return undefined;
  }
}

function isAutocodePlanQualityError(error: string): boolean {
  return /too large|Evidence|evidence_sources|context\.md|requirements\.md|spec\.md|tasks\.md/i.test(error);
}

async function writeStructuredJsonOutput(
  specDir: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  if (fileName === AUTOCODE_TASK_ARTIFACTS.requirements) {
    saveAutocodeTaskRequirementsSync(specDir, data as never);
    return;
  }
  if (fileName === AUTOCODE_TASK_ARTIFACTS.research) {
    await writeFile(join(specDir, fileName), stringifyResearchMarkdown(data), 'utf-8');
    return;
  }
  await writeFile(join(specDir, fileName), `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function stringifyResearchMarkdown(data: unknown): string {
  const research = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Partial<ResearchOutput>
    : {};
  const lines: string[] = ['# Research', ''];

  const integrations = Array.isArray(research.integrations_researched)
    ? research.integrations_researched
    : [];
  lines.push('## Integrations Researched', '');
  if (integrations.length === 0) {
    lines.push('- None required.', '');
  } else {
    integrations.forEach((integration) => {
      lines.push(`### ${singleLineMarkdown(integration.name) || 'Integration'}`, '');
      lines.push(`- Type: ${singleLineMarkdown(integration.type) || 'unknown'}`);
      const pkg = integration.verified_package;
      if (pkg) {
        lines.push(`- Package: ${singleLineMarkdown(pkg.name) || 'unknown'} (${singleLineMarkdown(pkg.version) || 'unknown'})`);
        lines.push(`- Install: ${singleLineMarkdown(pkg.install_command) || 'unknown'}`);
        lines.push(`- Verified: ${pkg.verified ? 'yes' : 'no'}`);
      }
      const api = integration.api_patterns;
      if (api) {
        addMarkdownBullets(lines, 'Imports', api.imports);
        lines.push(`- Initialization: ${singleLineMarkdown(api.initialization) || 'unknown'}`);
        addMarkdownBullets(lines, 'Key functions', api.key_functions);
        lines.push(`- Verified against: ${singleLineMarkdown(api.verified_against) || 'unknown'}`);
      }
      const config = integration.configuration;
      if (config) {
        addMarkdownBullets(lines, 'Environment variables', config.env_vars);
        addMarkdownBullets(lines, 'Config files', config.config_files);
        addMarkdownBullets(lines, 'Dependencies', config.dependencies);
      }
      addMarkdownBullets(lines, 'Gotchas', integration.gotchas);
      addMarkdownBullets(lines, 'Sources', integration.research_sources);
      lines.push('');
    });
  }

  lines.push('## Recommendations', '');
  addPlainBullets(lines, research.recommendations, 'No extra recommendations.');

  lines.push('## Unverified Claims', '');
  const claims = Array.isArray(research.unverified_claims) ? research.unverified_claims : [];
  if (claims.length === 0) {
    lines.push('- None.', '');
  } else {
    claims.forEach((claim) => {
      lines.push(`- ${singleLineMarkdown(claim.claim)} (${claim.risk_level || 'medium'}): ${singleLineMarkdown(claim.reason)}`);
    });
    lines.push('');
  }

  if (research.created_at) {
    lines.push('## Metadata', '', `- Created At: ${singleLineMarkdown(research.created_at)}`, '');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function addMarkdownBullets(lines: string[], label: string, values: unknown): void {
  const items = Array.isArray(values)
    ? values.map(singleLineMarkdown).filter(Boolean)
    : [];
  if (items.length > 0) {
    lines.push(`- ${label}: ${items.join('; ')}`);
  }
}

function addPlainBullets(lines: string[], values: unknown, emptyText: string): void {
  const items = Array.isArray(values)
    ? values.map(singleLineMarkdown).filter(Boolean)
    : [];
  if (items.length === 0) {
    lines.push(`- ${emptyText}`, '');
    return;
  }
  lines.push(...items.map((item) => `- ${item}`), '');
}

function singleLineMarkdown(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function compactPhaseOutputForCarryover(fileName: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= MAX_PHASE_OUTPUT_SIZE) {
    return normalized;
  }

  if (fileName.endsWith('.json')) {
    const jsonSummary = summarizePhaseOutputJson(normalized);
    if (jsonSummary) {
      return limitPhaseOutputText(jsonSummary);
    }
  }

  const headings: string[] = [];
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let inFence = false;

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,4}\s+\S/.test(line)) {
      pushCompactPhaseLine(
        headings,
        line.replace(/^#{1,4}\s+/, ''),
        PHASE_OUTPUT_HEADING_LIMIT,
      );
      continue;
    }
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      pushCompactPhaseLine(
        bullets,
        line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''),
        PHASE_OUTPUT_BULLET_LIMIT,
      );
      continue;
    }
    if (line.length >= 28) {
      pushCompactPhaseLine(paragraphs, line, PHASE_OUTPUT_PARAGRAPH_LIMIT);
    }
  }

  const lines = [
    `Compact phase output summary for ${fileName}. Read the artifact directly for exact wording or omitted detail.`,
    '',
    'Content excerpt:',
    limitPhaseOutputText(
      normalized,
      '\n...[phase output middle omitted; read artifact if needed]...\n',
      PHASE_OUTPUT_EXCERPT_MAX_CHARS,
    ),
    '',
  ];
  appendCompactPhaseSection(lines, 'Key headings', headings);
  appendCompactPhaseSection(lines, 'Selected bullets', bullets);
  appendCompactPhaseSection(lines, 'Selected notes', paragraphs);

  if (headings.length === 0 && bullets.length === 0 && paragraphs.length === 0) {
    lines.push(limitPhaseOutputText(normalized, '\n...[truncated; read artifact if needed]'));
  }

  return limitPhaseOutputText(lines.join('\n').trimEnd());
}

function summarizePhaseOutputJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    const summary = summarizePhaseJsonValue(parsed);
    return [
      'Compact JSON phase output summary. Read the artifact directly for exact values.',
      JSON.stringify(summary, null, 2),
    ].join('\n');
  } catch {
    return null;
  }
}

function summarizePhaseJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, PHASE_OUTPUT_JSON_ARRAY_LIMIT).map(summarizePhaseJsonValue);
    return value.length > items.length
      ? [...items, `... ${value.length - items.length} more item(s)`]
      : items;
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string'
      ? compactPhaseLine(value)
      : value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const entries = Object.entries(record);
  for (const [key, item] of entries.slice(0, PHASE_OUTPUT_JSON_OBJECT_KEY_LIMIT)) {
    result[key] = summarizePhaseJsonValue(item);
  }
  const omitted = entries.length - Object.keys(result).length;
  if (omitted > 0) {
    result.__omitted_keys = omitted;
  }
  return result;
}

function appendCompactPhaseSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`## ${title}`, '', ...items.map((item) => `- ${item}`), '');
}

function pushCompactPhaseLine(target: string[], value: string, limit: number): void {
  if (target.length >= limit) {
    return;
  }
  const compact = compactPhaseLine(value);
  if (compact && !target.includes(compact)) {
    target.push(compact);
  }
}

function compactPhaseLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PHASE_OUTPUT_LINE_MAX_CHARS) {
    return normalized;
  }
  return limitPhaseOutputText(normalized, ' ... [middle omitted] ... ', PHASE_OUTPUT_LINE_MAX_CHARS);
}

function limitPhaseOutputText(
  value: string,
  suffix = '\n...[compact phase output truncated; read artifact if needed]',
  maxChars = MAX_PHASE_OUTPUT_SIZE,
): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const budget = Math.max(0, maxChars - suffix.length);
  if (budget <= 0) {
    return normalized.slice(0, maxChars);
  }
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${normalized.slice(0, headBudget).trimEnd()}${suffix}${normalized.slice(-tailBudget).trimStart()}`;
}

function getLastAssistantText(result: SessionResult): string | null {
  for (let index = result.messages.length - 1; index >= 0; index--) {
    const message = result.messages[index];
    if (message.role === 'assistant' && message.content.trim()) {
      return message.content.trim();
    }
  }
  return null;
}

function parseJsonFromFinalText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = buildJsonTextCandidates(text);
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next candidate.
    }
  }

  return { ok: false, error: 'no valid JSON object found in final assistant message' };
}

function normalizeComplexityAssessmentOutput(value: unknown): ComplexityAssessment | null {
  const validation = ComplexityAssessmentSchema.safeParse(value);
  return validation.success ? validation.data as ComplexityAssessment : null;
}

function buildJsonTextCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  candidates.add(trimmed);

  const fenceMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenceMatches) {
    if (match[1]?.trim()) {
      candidates.add(match[1].trim());
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  return [...candidates].filter(Boolean);
}

function normalizeStructuredJsonOutput(
  phase: SpecPhase,
  value: unknown,
  taskDescription?: string,
): unknown {
  switch (phase) {
    case 'requirements':
      return normalizeRequirementsOutput(value, taskDescription);
    default:
      return value;
  }
}

function stringFrom(...values: unknown[]): string {
  for (const value of values) {
    const text = stringifyCompact(value);
    if (text) {
      return text;
    }
  }
  return '';
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyCompact).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function stringArrayFrom(...values: unknown[]): string[] {
  for (const value of values) {
    const items = toStringArray(value);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const text = stringifyCompact(value);
    return text ? [text] : [];
  }
  return value.map(stringifyCompact).filter(Boolean);
}


function firstArray(values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequirementsOutput(
  value: unknown,
  fallbackTaskDescription?: string,
): RequirementsOutput | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const taskDescription = compactSpecArtifactTaskDescription(
    stringFrom(record.task_description, record.task, record.taskDescription, record.summary) ||
      normalizeTaskDescription(fallbackTaskDescription),
  );
  return {
    task_description: taskDescription,
    workflow_type: isInvestigationTaskDescription(normalizeTaskDescription(taskDescription).toLowerCase())
      ? 'investigation'
      : normalizeWorkflowType(record.workflow_type, record.workflowType, record.type),
    services_involved: stringArrayFrom(record.services_involved, record.scoped_services, record.services),
    user_requirements: stringArrayFrom(record.user_requirements, record.requirements, record.functional_requirements, taskDescription)
      .map((item) => compactSpecArtifactTaskDescription(item)),
    acceptance_criteria: stringArrayFrom(record.acceptance_criteria, record.acceptanceCriteria, record.success_criteria, record.validation_scenarios),
    constraints: stringArrayFrom(record.constraints, record.non_functional_requirements, record.risks),
    evidence_sources: stringArrayFrom(record.evidence_sources, record.evidence, record.sources, record.source_references),
    standards_references: stringArrayFrom(record.standards_references, record.standards, record.industry_standards, record.official_docs),
    assumptions: stringArrayFrom(record.assumptions, record.inferred_claims, record.unknowns),
    created_at: stringFrom(record.created_at, record.createdAt) || new Date().toISOString(),
  };
}

function normalizeWorkflowType(...values: unknown[]): RequirementsOutput['workflow_type'] {
  const allowed: RequirementsOutput['workflow_type'][] = ['feature', 'refactor', 'investigation', 'migration', 'simple', 'bugfix'];
  const text = stringFrom(...values).toLowerCase();
  return allowed.find((item) => text.includes(item)) ?? 'feature';
}

function normalizeResearchOutput(value: unknown): ResearchOutput | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const integrations = firstArray([
    record.integrations_researched,
    record.integrations,
    record.external_dependencies,
    record.packages,
    record.libraries,
  ]);

  return {
    integrations_researched: integrations.map(normalizeResearchIntegration).filter(Boolean),
    unverified_claims: normalizeUnverifiedClaims(record.unverified_claims, record.unknowns, record.risks),
    recommendations: uniqueStrings([
      ...toStringArray(record.recommendations),
      ...toStringArray(record.recommended_approach),
      ...toStringArray(record.implementation_guidance),
      ...toStringArray(record.validation_plan),
      ...toStringArray(record.summary),
      ...toStringArray(record.conclusion),
    ]),
    created_at: stringFrom(record.created_at, record.createdAt) || new Date().toISOString(),
  };
}

function normalizeResearchIntegration(value: unknown): ResearchOutput['integrations_researched'][number] | null {
  const record = isRecord(value) ? value : { name: stringifyCompact(value) };
  const name = stringFrom(record.name, record.package, record.library, record.dependency, record.title);
  if (!name) {
    return null;
  }

  const verifiedPackage = isRecord(record.verified_package) ? record.verified_package : {};
  const apiPatterns = isRecord(record.api_patterns) ? record.api_patterns : {};
  const configuration = isRecord(record.configuration) ? record.configuration : {};
  const verified = record.verified ?? verifiedPackage.verified;

  return {
    name,
    type: stringFrom(record.type, record.category) || 'library',
    verified_package: {
      name: stringFrom(verifiedPackage.name, record.package, record.package_name, name),
      install_command: stringFrom(verifiedPackage.install_command, record.install_command, record.install) || '',
      version: stringFrom(verifiedPackage.version, record.version) || 'unspecified',
      verified: typeof verified === 'boolean' ? verified : false,
    },
    api_patterns: {
      imports: stringArrayFrom(apiPatterns.imports, record.imports),
      initialization: stringFrom(apiPatterns.initialization, record.initialization, record.setup),
      key_functions: stringArrayFrom(apiPatterns.key_functions, record.key_functions, record.apis, record.api),
      verified_against: stringFrom(apiPatterns.verified_against, record.verified_against, record.source) || 'not verified',
    },
    configuration: {
      env_vars: stringArrayFrom(configuration.env_vars, record.env_vars),
      config_files: stringArrayFrom(configuration.config_files, record.config_files),
      dependencies: stringArrayFrom(configuration.dependencies, record.dependencies),
    },
    gotchas: stringArrayFrom(record.gotchas, record.risks, record.notes),
    research_sources: stringArrayFrom(record.research_sources, record.sources, record.documentation),
  };
}

function normalizeUnverifiedClaims(...values: unknown[]): ResearchOutput['unverified_claims'] {
  const items = firstArray(values);
  return items.map((item) => {
    if (typeof item === 'string') {
      return {
        claim: item,
        reason: 'Not independently verified during this phase',
        risk_level: 'low' as const,
      };
    }

    const record = isRecord(item) ? item : {};
    const claim = stringFrom(record.claim, record.description, record.risk, record.issue);
    if (!claim) {
      return null;
    }

    return {
      claim,
      reason: stringFrom(record.reason, record.status, record.mitigation) || 'Not independently verified during this phase',
      risk_level: normalizeRiskLevel(record.risk_level, record.severity),
    };
  }).filter((item): item is ResearchOutput['unverified_claims'][number] => Boolean(item));
}

function normalizeRiskLevel(...values: unknown[]): ResearchOutput['unverified_claims'][number]['risk_level'] {
  const text = stringFrom(...values).toLowerCase();
  if (text.includes('high') || text.includes('critical') || text.includes('block')) {
    return 'high';
  }
  if (text.includes('medium') || text.includes('moderate')) {
    return 'medium';
  }
  return 'low';
}

type RequirementsWorkflowType = RequirementsOutput['workflow_type'];

function inferRequirementsWorkflowType(
  taskDescription?: string,
  complexity?: ComplexityTier,
): RequirementsWorkflowType {
  const normalizedTask = normalizeTaskDescription(taskDescription);
  const text = normalizedTask.toLowerCase();
  if (isSourceDocumentationTask(normalizedTask) || isInvestigationTaskDescription(text)) {
    return 'investigation';
  }
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
  const description = compactSpecArtifactTaskDescription(taskDescription);
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
    evidence_sources: ['User task description'],
    standards_references: [],
    assumptions: ['Fallback requirements were generated because the requirements phase did not produce validated output.'],
    created_at: new Date().toISOString(),
  };
}

function buildFallbackContextOutput(taskDescription?: string): SpecContextOutput {
  const description = compactSpecArtifactTaskDescription(taskDescription);
  return {
    task_description: description,
    scoped_services: [],
    architecture_summary: 'Project structure is empty or insufficiently indexed; continue from the task description and existing project conventions.',
    files_to_modify: [],
    files_to_reference: [],
    design_patterns: [],
    evidence_sources: [{
      path: 'User task description',
      proves: 'Fallback context starts from the user task because discovery did not produce validated output.',
      confidence: 'low',
    }],
    standards_references: [],
    assumptions: ['Fallback context was generated because discovery did not produce validated output.'],
    implementation_notes: [
      'Use the task description as the source of truth.',
      'Inspect only files directly relevant to the implementation before editing.',
    ],
    risks: [
      `Discovery fallback was used because the model did not produce ${AUTOCODE_TASK_ARTIFACTS.context}.`,
    ],
    verification_suggestions: [
      'Run the smallest available project-specific verification, or document a manual check if no automated check exists.',
    ],
    created_at: new Date().toISOString(),
  };
}

function shouldRunResearchPhase(
  assessment: ComplexityAssessment | null,
  taskDescription?: string,
  projectDocsReference?: string,
): boolean {
  return shouldRunAutocodeSpecResearchPhase(assessment, taskDescription, projectDocsReference);
}

function isInvestigationTaskDescription(text: string): boolean {
  const hasInvestigationIntent =
    /\b(analy[sz]e|investigate|inspect|review|understand|summari[sz]e|explain|map|audit|document)\b/i.test(text) ||
    /(\u5206\u6790|\u8c03\u67e5|\u68b3\u7406|\u9605\u8bfb|\u7406\u89e3|\u89e3\u91ca|\u6982\u8ff0|\u5ba1\u8ba1|\u6587\u6863)/.test(text);
  const hasImplementationIntent =
    /\b(implement|add|fix|change|modify|refactor|rewrite|migrate|port|delete|remove|replace|build|create|develop)\b/i.test(text) ||
    /(\u5b9e\u73b0|\u6dfb\u52a0|\u4fee\u590d|\u4fee\u6539|\u6539\u9020|\u91cd\u6784|\u8fc1\u79fb|\u79fb\u690d|\u5220\u9664|\u66ff\u6362|\u6784\u5efa|\u521b\u5efa|\u5f00\u53d1)/.test(text);
  const hasDocumentationOnlyConstraint =
    /\b(do not|don't|without)\b.*\b(modify|change|edit)\b/i.test(text) ||
    /\b(documentation|docs|markdown|report|analysis)\b.*\bonly\b/i.test(text) ||
    /(\u4e0d\u4fee\u6539|\u7981\u6b62\u4fee\u6539|\u4ec5|\u53ea).*(\u6587\u6863|\u5206\u6790|\u62a5\u544a|\u6e90\u7801|\u4ee3\u7801)/.test(text);

  return hasInvestigationIntent && (!hasImplementationIntent || hasDocumentationOnlyConstraint);
}

function hasTaskExternalResearchSignal(text: string): boolean {
  return /(\bapi\b|\bsdk\b|\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\bcloud\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\brest\b|\bplugin\b|\bextension\b|\bpackage\b|\blibrary\b|\bdependency\b|\bintegration\b|\bthird[-\s]?party\b|\bexternal\b|\bauth\b|\bdatabase\b|\bqueue\b|\bmessage broker\b|\bkafka\b|\brabbitmq\b|接口|集成|第三方|外部|依赖|包|库|插件|认证|授权|支付|云服务|数据库|消息队列)/i.test(text);
}

function hasProjectExternalResearchSignal(text: string): boolean {
  return /(\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\bkafka\b|\brabbitmq\b|\bthird[-\s]?party\b|\bexternal api\b|\bapi client\b|第三方|外部接口|认证|授权|支付|云服务|数据库|消息队列)/i.test(text);
}

interface MmoAssessmentHints {
  signals: string[];
  needsResearch: boolean;
  needsSelfCritique: boolean;
  promoteToStandard: boolean;
}

function inferMmoAssessmentHints(
  taskDescription: string | undefined,
  projectDocsReference: string | undefined,
): MmoAssessmentHints {
  const taskText = normalizeTaskDescription(taskDescription).toLowerCase();
  const projectText = (projectDocsReference ?? '').toLowerCase();
  const combinedText = `${taskText}\n${projectText}`;
  const signals: string[] = [];

  const broadAnalysisTask =
    /\b(analy[sz]e|inspect|review|understand|summari[sz]e|document|map|overview|architecture|systems?|mechanics?|gameplay|source|codebase)\b/i.test(taskText) ||
    /(\u5206\u6790|\u68b3\u7406|\u7406\u89e3|\u6982\u8ff0|\u6587\u6863|\u67b6\u6784|\u7cfb\u7edf|\u73a9\u6cd5|\u673a\u5236|\u6e90\u7801|\u4ee3\u7801)/.test(taskText);

  const signalPatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'engine/rendering', pattern: /\b(engine|renderer|rendering|ogre|direct3d|d3d|shader|hlsl)\b|(\u5f15\u64ce|\u6e32\u67d3|\u7740\u8272\u5668)/i },
    { label: 'server authority', pattern: /\b(server|gateway|login|auth|world|zone|realm|shard|cluster)\b|(\u670d\u52a1\u5668|\u670d\u52a1\u7aef|\u7f51\u5173|\u767b\u5f55|\u4e16\u754c\u670d|\u5206\u7ebf|\u5206\u533a)/i },
    { label: 'network sync', pattern: /\b(network|socket|packet|protocol|sync|replication|latency)\b|(\u7f51\u7edc|\u534f\u8bae|\u5c01\u5305|\u540c\u6b65|\u5ef6\u8fdf)/i },
    { label: 'gameplay systems', pattern: /\b(gameplay|combat|quest|skill|item|npc|ai|mechanic|system)\b|(\u73a9\u6cd5|\u6218\u6597|\u4efb\u52a1|\u6280\u80fd|\u9053\u5177|\u7269\u54c1|\u7cfb\u7edf|\u673a\u5236)/i },
    { label: 'data persistence', pattern: /\b(database|mysql|postgres|redis|sql|db|persistence|storage)\b|(\u6570\u636e\u5e93|\u6301\u4e45\u5316|\u5b58\u50a8)/i },
    { label: 'asset/world pipeline', pattern: /\b(asset|resource|map|terrain|scene|animation|skeleton|navmesh|world)\b|(\u8d44\u6e90|\u8d44\u4ea7|\u5730\u56fe|\u573a\u666f|\u52a8\u753b|\u9aa8\u9abc|\u4e16\u754c)/i },
    { label: 'security/anti-cheat', pattern: /\b(anti[-\s]?cheat|gameguard|nprotect|security|cheat|hack)\b|(\u53cd\u4f5c\u5f0a|\u5916\u6302|\u5b89\u5168)/i },
    { label: 'build/tooling', pattern: /\b(build|cmake|sln|solution|compiler|toolchain|pipeline|packaging)\b|(\u6784\u5efa|\u7f16\u8bd1|\u5de5\u5177\u94fe|\u6253\u5305)/i },
    { label: 'native/script stack', pattern: /\b(c\+\+|cpp|cxx|lua|c#|csharp)\b/i },
    { label: 'large MMO shape', pattern: /\b(mmo|mmorpg|world of warcraft|wow|large|massive|multiplayer)\b|(\u5927\u578b|\u7f51\u7edc\u6e38\u620f|\u591a\u4eba|\u9b54\u517d\u4e16\u754c)/i },
  ];

  for (const { label, pattern } of signalPatterns) {
    if (pattern.test(combinedText)) {
      signals.push(label);
    }
  }

  const uniqueSignals = uniqueStrings(signals);
  return {
    signals: uniqueSignals,
    needsResearch: broadAnalysisTask && uniqueSignals.length > 0,
    needsSelfCritique: broadAnalysisTask && uniqueSignals.length >= 2,
    promoteToStandard: broadAnalysisTask && uniqueSignals.length > 0,
  };
}

function inferComplexityFallback(
  taskDescription: string,
  projectDocsReference: string | undefined,
  workflowConfig: WorkflowConfig,
): FallbackComplexityAssessment {
  return inferAutocodeSpecComplexityFallback({
    taskDescription,
    projectDocsReference,
    workflowConfig,
  });
}

function parseProjectDocsReferenceSummary(projectDocsReference: string | undefined): {
  serviceCount: number;
  languageCount: number;
  infrastructureCount: number;
  hasLargeProjectSignal: boolean;
} {
  return parseAutocodeProjectDocsReferenceSummary(projectDocsReference);
}

function selectSpecPhases(
  complexity: ComplexityTier,
  assessment: ComplexityAssessment | null,
  taskDescription: string | undefined,
  projectDocsReference: string | undefined,
  workflowConfig: WorkflowConfig,
): SpecPhase[] {
  return selectAutocodeSpecPhases({
    complexity,
    assessment,
    taskDescription,
    projectDocsReference,
    workflowConfig,
  }) as SpecPhase[];
}

function shouldForceSplitImplementationPlan(
  complexity: ComplexityTier | undefined,
  workflowConfig: WorkflowConfig | undefined,
): boolean {
  return shouldForceSplitAutocodeImplementationPlan(complexity, workflowConfig);
}

function buildPlanStructuredOutputValidationRetryPrompt(
  phase: SpecPhase,
  errors: string[],
  schemaHint?: string,
): string {
  const lines = [
    '## TASKS VALIDATION',
    '',
    'The previous tasks.md was missing, invalid, or could not be converted into runtime work packages.',
    '',
    '### Errors',
    ...formatAutocodeRetryErrorLines(errors),
    '',
  ];

  if (schemaHint) {
    lines.push('### Schema', schemaHint, '');
  }

  lines.push(
    '### Fix',
    `1. Use the Write tool to rewrite ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
    '2. Use checklist Markdown with "- [ ] 1. Phase title" and "- [ ] 1.1 Subtask title" items.',
    '3. Keep each task concise and include _Files_, _Depends on_, _Requirements_, and _Verification_ metadata.',
    `4. Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runtime derives it from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
    '5. Omit top-level summary, verification_strategy, qa_acceptance, research notes, copied source, and long analysis.',
  );

  if (phase === 'quick_spec') {
    lines.push('6. If spec.md is missing, use Write to recreate a compact spec.md as well.');
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
    if (this.config.projectDocsReference === undefined && this.config.projectIndex !== undefined) {
      this.config.projectDocsReference = this.config.projectIndex;
    }
    this.config.agentProfile ??= GENERAL_AGENT_PROFILE;

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
        complexityReasoning: this.assessment?.reasoning,
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
   * 1. Complexity assessment — gate the workflow (uses task description + project docs reference)
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
        this.assessment = await this.restoreComplexityAssessmentFromFile() ??
          this.assessment ??
          this.buildFallbackComplexityAssessment('Resume state omitted complexity');
        this.applyProjectProfileAssessmentHints();
        await this.persistComplexityAssessment();
        complexity = this.assessment.complexity;
        this.emitTyped('log', `Skipping complexity assessment (already completed): ${complexity}`);
      } else {
        // Fast-path heuristic: catch obviously simple tasks before expensive AI assessment
        const heuristicResult = this.assessComplexityHeuristic(
          this.config.taskDescription ?? '',
          this.config.projectDocsReference,
        );
        if (heuristicResult) {
          complexity = heuristicResult;
          this.assessment = {
            complexity: heuristicResult,
            confidence: 0.9,
            reasoning: `Heuristic: task description matches ${heuristicResult} pattern`,
          };
          this.applyProjectProfileAssessmentHints();
          complexity = this.assessment.complexity;
          this.emitTyped('log', `Complexity heuristic: ${heuristicResult} (skipping AI assessment)`);
          await this.persistComplexityAssessment();
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
              this.applyProjectProfileAssessmentHints();
              complexity = this.assessment.complexity;
              this.emitTyped('log', `Restored complexity from file: ${complexity} (confidence: ${(this.assessment.confidence * 100).toFixed(0)}%)`);
              await this.persistComplexityAssessment();
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
              this.assessment = this.buildFallbackComplexityAssessment('AI assessment failed');
              this.applyProjectProfileAssessmentHints();
              this.emitTyped('log', `Complexity fallback: ${this.assessment.complexity} (${this.assessment.reasoning})`);
              await this.persistComplexityAssessment();
              await this.capturePhaseOutput('complexity_assessment');
            }

            complexity = this.assessment?.complexity ?? 'standard';
            await this.saveState();
          }
        } else {
          // Heuristic fallback
          this.assessment = this.buildFallbackComplexityAssessment('AI assessment disabled');
          this.applyProjectProfileAssessmentHints();
          complexity = this.assessment.complexity;
          await this.persistComplexityAssessment();
          phasesExecuted.push('complexity_assessment');
          this.completedPhases.push('complexity_assessment');
          await this.saveState();
        }
      }

      if (!this.config.complexityOverride) {
        complexity = await this.escalateComplexityIfNeeded(complexity);
      }

      // ===================================================================
      // Step 2: Determine and run phases based on assessed complexity
      // ===================================================================
      const phasesToRun = selectSpecPhases(
        complexity,
        this.assessment,
        this.config.taskDescription,
        this.config.projectDocsReference,
        this.config.workflowConfig!,
      );

      this.emitTyped('log', `Running ${complexity} workflow: ${phasesToRun
        .map((phase) => formatSpecPhaseNameForLog(phase, this.config.language))
        .join(' → ')}`);

      for (const phase of phasesToRun) {
        if (
          phase === 'quick_spec' &&
          complexity === 'simple' &&
          (
            this.config.workflowConfig?.optimizationLevel === 'aggressive' ||
            isSourceDocumentationTask(this.config.taskDescription)
          )
        ) {
          const phaseNumber = phasesExecuted.length + 1;
          const totalPhases = phasesToRun.length + (phasesExecuted.includes('complexity_assessment') ? 1 : 0);
          const result = await this.writeAggressiveStandardLightPlan(phaseNumber, totalPhases);
          phasesExecuted.push(phase);
          if (!result.success) {
            await this.saveState();
            return this.outcome(false, phasesExecuted, Date.now() - startTime, result.errors.join('; '));
          }
          this.completedPhases.push(phase);
          await this.capturePhaseOutput(phase);
          await this.saveState();
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

        if (!result.success) {
          await this.saveState(); // Save state even on failure for resume
          return this.outcome(false, phasesExecuted, Date.now() - startTime, result.errors.join('; '));
        }

        this.completedPhases.push(phase);

        // Capture phase outputs for injection into subsequent phases
        if (phase === 'validation') {
          await this.writeSpecValidationReport();
        }
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
  private assessComplexityHeuristic(
    taskDescription: string,
    projectDocsReference?: string,
  ): ComplexityTier | null {
    const task = normalizeTaskDescription(taskDescription);
    const desc = task.toLowerCase().trim();
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    const compactLength = desc.replace(/\s+/g, '').length;

    if (isSourceDocumentationTask(task)) {
      return 'simple';
    }

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

    const hasSimpleProject = isSparseProjectDocsReference(projectDocsReference);
    const hasCreateIntent = /\b(create|build|implement|add|make|develop|generate|write)\b|创建|新建|实现|开发|编写|生成|制作/.test(desc);
    const hasSingleDeliverableSignal = /\b(local|standalone|single|small|simple|static|demo|prototype|app|application|tool|utility|page|site|script|program|game)\b|本地|单个|简单|小型|静态|演示|应用|工具|页面|脚本|程序|游戏/.test(desc);
    const hasComplexSignal = hasTaskExternalResearchSignal(desc) ||
      /\b(migrate|migration|refactor|architecture|distributed|microservice|multi[-\s]?service|production|security|permission|role|workflow|pipeline|concurrent|scalable|enterprise)\b|迁移|重构|架构|分布式|微服务|多服务|生产|安全|权限|角色|流程|管线|并发|可扩展|企业/.test(desc);

    if (
      hasSimpleProject &&
      hasCreateIntent &&
      hasSingleDeliverableSignal &&
      !hasComplexSignal &&
      (wordCount <= 80 || compactLength <= 180)
    ) {
      return 'simple';
    }

    // Long descriptions or complex signal words → let AI decide
    return null;
  }

  private buildFallbackComplexityAssessment(reason: string): ComplexityAssessment {
    const fallbackComplexity = inferComplexityFallback(
      this.config.taskDescription ?? '',
      this.config.projectDocsReference,
      this.config.workflowConfig!,
    );

    return {
      complexity: fallbackComplexity.complexity,
      confidence: fallbackComplexity.confidence,
      reasoning: `${reason}; ${fallbackComplexity.reasoning}`,
      needs_research: fallbackComplexity.needs_research,
      needs_self_critique: fallbackComplexity.needs_self_critique,
    };
  }

  private applyProjectProfileAssessmentHints(): void {
    if (!this.assessment || (this.config.agentProfile ?? GENERAL_AGENT_PROFILE).id !== 'game-mmo') {
      return;
    }

    const hints = inferMmoAssessmentHints(this.config.taskDescription, this.config.projectDocsReference);
    if (hints.signals.length === 0) {
      return;
    }

    const previous = this.assessment;
    const next: ComplexityAssessment = {
      ...previous,
      complexity: !this.config.complexityOverride && hints.promoteToStandard && previous.complexity === 'simple'
        ? 'standard'
        : previous.complexity,
      needs_research: previous.needs_research || hints.needsResearch,
      needs_self_critique: previous.needs_self_critique || hints.needsSelfCritique,
    };

    const changed =
      next.complexity !== previous.complexity ||
      next.needs_research !== previous.needs_research ||
      next.needs_self_critique !== previous.needs_self_critique;

    if (!changed) {
      return;
    }

    next.reasoning = [
      previous.reasoning,
      `MMO routing hints: ${hints.signals.join(', ')}`,
    ].filter(Boolean).join('; ');

    this.assessment = next;
    this.emitTyped('log', `Applied MMO routing hints: ${hints.signals.join(', ')}`);
  }

  private async persistComplexityAssessment(): Promise<void> {
    if (!this.assessment) {
      return;
    }

    try {
      await writeStructuredJsonOutput(this.config.specDir, 'complexity_assessment.json', this.assessment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitTyped('log', `Failed to persist complexity assessment: ${message}`);
    }
  }

  private async restoreComplexityAssessmentFromFile(): Promise<ComplexityAssessment | null> {
    try {
      const assessmentPath = join(this.config.specDir, 'complexity_assessment.json');
      await access(assessmentPath);
      const result = await validateJsonFile(assessmentPath, ComplexityAssessmentSchema);
      return result.valid && result.data ? result.data as ComplexityAssessment : null;
    } catch {
      return null;
    }
  }

  private async escalateComplexityIfNeeded(current: ComplexityTier): Promise<ComplexityTier> {
    if (current === 'complex') {
      return current;
    }

    const fallback = inferComplexityFallback(
      this.config.taskDescription ?? '',
      this.config.projectDocsReference,
      this.config.workflowConfig!,
    );

    if (fallback.complexity !== 'complex') {
      return current;
    }

    this.assessment = {
      complexity: 'complex',
      confidence: Math.max(this.assessment?.confidence ?? 0, fallback.confidence),
      reasoning: [
        this.assessment?.reasoning,
        `Escalated by local complexity guard: ${fallback.reasoning}`,
      ].filter(Boolean).join('; '),
      needs_research: this.assessment?.needs_research ?? fallback.needs_research,
      needs_self_critique: true,
    };
    this.emitTyped('log', `Complexity escalated to complex by local guard (${fallback.reasoning})`);
    await this.persistComplexityAssessment();
    await this.capturePhaseOutput('complexity_assessment');
    await this.saveState();

    return 'complex';
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
    const agentType = this.getAgentForPhase(phase);
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
        projectDocsReference: this.config.projectDocsReference,
        priorPhaseOutputs: phaseOutputs,
        attemptCount: attempt,
        // Carry both schema and tool-use retry context (at most one is set at a time)
        schemaRetryContext: schemaRetryContext ?? toolUseRetryContext,
      });
      // Clear single-use retry context
      toolUseRetryContext = undefined;

      // Small structured phases can use constrained final JSON and are then
      // persisted as Markdown when appropriate. Planner phases write files
      // directly with the Write tool because task lists can be large.
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
        projectDocsReference: this.config.projectDocsReference,
        ...(outputSchema ? { outputSchema } : {}),
      });

      this.emitTyped('session-complete', result, phase);

      if (result.outcome === 'cancelled') {
        return { phase, success: false, errors: ['Cancelled'], retries: attempt };
      }

      if (result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window') {
        // Structured phases are persisted here; plan files are written by the planner.
        if (structuredJsonFile && result.structuredOutput) {
          try {
            const normalized = normalizeStructuredJsonOutput(
              phase,
              result.structuredOutput,
              this.config.taskDescription,
            );
            await writeStructuredJsonOutput(this.config.specDir, structuredJsonFile, normalized);
            this.emitTyped('log', `Wrote ${structuredJsonFile} from structured output`);
          } catch (writeErr) {
            this.emitTyped('log', `Failed to write structured ${structuredJsonFile}: ${writeErr}`);
          }
        }
        if (structuredJsonFile && outputSchema && !result.structuredOutput) {
          const recovered = await this.writeStructuredOutputFromFinalText(
            phase,
            structuredJsonFile,
            outputSchema,
            result,
          );
          if (recovered) {
            this.emitTyped('log', `Wrote ${structuredJsonFile} from final response JSON`);
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

          if (phase === 'requirements' && missingFiles.includes(AUTOCODE_TASK_ARTIFACTS.requirements) && attempt >= maxPhaseRetries) {
            try {
              await writeStructuredJsonOutput(
                this.config.specDir,
                AUTOCODE_TASK_ARTIFACTS.requirements,
                buildFallbackRequirementsOutput(this.config.taskDescription, this.assessment?.complexity),
              );
              const remainingMissing = await this.validatePhaseOutputs(phase);
              if (remainingMissing.length === 0) {
                this.emitTyped('log', `Wrote fallback ${AUTOCODE_TASK_ARTIFACTS.requirements} from task description`);
                errors.pop();
                const phaseResult: SpecPhaseResult = { phase, success: true, errors: [], retries: attempt };
                this.emitTyped('phase-complete', phase, phaseResult);
                return phaseResult;
              }
            } catch (fallbackErr) {
              this.emitTyped('log', `Failed to write fallback ${AUTOCODE_TASK_ARTIFACTS.requirements}: ${fallbackErr}`);
            }
          }

          if (
            (phase === 'discovery' || phase === 'context') &&
            missingFiles.includes(AUTOCODE_TASK_ARTIFACTS.context) &&
            attempt >= maxPhaseRetries
          ) {
            try {
              await writeFile(
                join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.context),
                stringifyAutocodeContextMarkdown(buildFallbackContextOutput(this.config.taskDescription)),
                'utf-8',
              );
              const remainingMissing = await this.validatePhaseOutputs(phase);
              if (remainingMissing.length === 0) {
                this.emitTyped('log', `Wrote fallback ${AUTOCODE_TASK_ARTIFACTS.context} from task description`);
                errors.pop();
                const phaseResult: SpecPhaseResult = { phase, success: true, errors: [], retries: attempt };
                this.emitTyped('phase-complete', phase, phaseResult);
                return phaseResult;
              }
            } catch (fallbackErr) {
              this.emitTyped('log', `Failed to write fallback ${AUTOCODE_TASK_ARTIFACTS.context}: ${fallbackErr}`);
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

            if (isPlanningPhase && missingFiles.includes(AUTOCODE_TASK_ARTIFACTS.tasks)) {
              toolUseRetryContext = buildWriteToolJsonRetryPrompt(phase, this.config.specDir);
              continue;
            }

            // Build a directive retry prompt when the model hallucinated tool usage.
            // This is common with Codex models that generate text claiming to have
            // written files without actually invoking the Write tool.
            if (noToolCalls) {
              const fileList = missingFiles.map(f => `${this.config.specDir}/${f}`).join(', ');
              toolUseRetryContext = [
                'WRITE TOOL REQUIRED',
                '',
                'The previous attempt produced no tool calls.',
                'Use the Write tool to create the required output file(s); do not describe file contents in text.',
                '',
                `Missing file(s): ${fileList}`,
                '',
                'Steps:',
                '1. Call Write once per missing file.',
                '2. Include full file content in each Write call.',
                '3. Return only a short confirmation after the files are written.',
              ].join('\n');
            }
            continue; // Retry the phase
          }
          // All retries exhausted — fall through to failure
          break;
        }

        // Schema validation for phases with structured output requirements
        // (e.g., planning phase must produce valid implementation_plan.md)
        const schemaValidation = await this.validatePhaseSchema(phase);
        if (schemaValidation && !schemaValidation.valid) {
          errors.push(`Schema validation failed: ${schemaValidation.errors.join(', ')}`);
          this.emitTyped('log', `Phase ${phase} schema validation failed (attempt ${attempt + 1}): ${schemaValidation.errors.join(', ')}`);
          if (attempt < maxPhaseRetries) {
            // Build LLM-friendly error feedback so the agent knows what to fix
            const schemaHint = undefined;
            const isQualityFailure = schemaValidation.errors.some(isAutocodePlanQualityError);
            schemaRetryContext = isPlanningPhase
              ? isQualityFailure
                ? buildAutocodePlanQualityRetryPrompt(schemaValidation.errors)
                : buildPlanStructuredOutputValidationRetryPrompt(phase, schemaValidation.errors, schemaHint)
              : isQualityFailure
                ? buildAutocodePlanQualityRetryPrompt(schemaValidation.errors)
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
    const agentType = this.getAgentForPhase('complexity_assessment');

    const prompt = await this.config.generatePrompt(agentType, 'complexity_assessment', {
      phaseNumber,
      totalPhases: 1,
      phaseName: 'complexity_assessment',
      taskDescription: this.config.taskDescription,
      projectDocsReference: this.config.projectDocsReference,
      attemptCount: 0,
    });

    // Pass clean output schema for constrained decoding (all fields required,
    // no preprocess/passthrough). Providers with native structured output
    // (Anthropic, OpenAI) enforce this at the token level.
    const sessionResult = await this.config.runSession({
      agentType,
      phase: 'spec',
      specPhase: 'complexity_assessment',
      systemPrompt: prompt,
      specDir: this.config.specDir,
      projectDir: this.config.projectDir,
      sessionNumber: this.sessionNumber,
      abortSignal: this.config.abortSignal,
      cliModel: this.config.cliModel,
      cliThinking: this.config.cliThinking,
      projectDocsReference: this.config.projectDocsReference,
      outputSchema: ComplexityAssessmentOutputSchema,
    });

    this.emitTyped('session-complete', sessionResult, 'complexity_assessment');

    if (sessionResult.outcome === 'cancelled') {
      return { phase: 'complexity_assessment', success: false, errors: ['Cancelled'], retries: 0 };
    }

    // Prefer structured output from constrained decoding (no file I/O needed)
    const structuredAssessment = sessionResult.structuredOutput
      ? normalizeComplexityAssessmentOutput(sessionResult.structuredOutput)
      : null;
    if (structuredAssessment) {
      this.assessment = structuredAssessment;
      this.applyProjectProfileAssessmentHints();
      this.emitTyped('log', `Complexity assessed (structured output): ${this.assessment.complexity} (confidence: ${(this.assessment.confidence * 100).toFixed(0)}%)`);
      await this.persistComplexityAssessment();
      return { phase: 'complexity_assessment', success: true, errors: [], retries: 0 };
    }

    // Fallback: read assessment from file (agent wrote it via tool)
    try {
      const assessmentPath = join(this.config.specDir, 'complexity_assessment.json');
      const fileResult = await validateJsonFile(assessmentPath, ComplexityAssessmentSchema);

      if (fileResult.valid && fileResult.data) {
        this.assessment = fileResult.data as ComplexityAssessment;
        this.applyProjectProfileAssessmentHints();
        await this.persistComplexityAssessment();
        this.emitTyped('log', `Complexity assessed: ${fileResult.data.complexity} (confidence: ${(fileResult.data.confidence * 100).toFixed(0)}%)`);
        return { phase: 'complexity_assessment', success: true, errors: [], retries: 0 };
      }
    } catch {
      // Assessment file not found or invalid — fall through
    }

    const finalText = getLastAssistantText(sessionResult);
    if (finalText) {
      const parsed = parseJsonFromFinalText(finalText);
      if (parsed.ok) {
        const finalAssessment = normalizeComplexityAssessmentOutput(parsed.value);
        if (finalAssessment) {
          this.assessment = finalAssessment;
          this.applyProjectProfileAssessmentHints();
          this.emitTyped('log', `Complexity assessed (final JSON): ${this.assessment.complexity} (confidence: ${(this.assessment.confidence * 100).toFixed(0)}%)`);
          await this.persistComplexityAssessment();
          return { phase: 'complexity_assessment', success: true, errors: [], retries: 0 };
        }
      }
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

  private async writeStructuredOutputFromFinalText(
    phase: SpecPhase,
    fileName: string,
    schema: ZodSchema,
    result: SessionResult,
  ): Promise<boolean> {
    const finalText = getLastAssistantText(result);
    if (!finalText) {
      return false;
    }

    const parsed = parseJsonFromFinalText(finalText);
    if (!parsed.ok) {
      this.emitTyped('log', `Could not parse final JSON for ${phase}: ${parsed.error}`);
      return false;
    }

    const normalized = normalizeStructuredJsonOutput(phase, parsed.value, this.config.taskDescription);
    const validation = schema.safeParse(normalized);
    if (!validation.success) {
      this.emitTyped('log', `Final JSON for ${phase} did not match schema: ${validation.error.issues.map((issue) => issue.message).join(', ')}`);
      return false;
    }

    await writeStructuredJsonOutput(this.config.specDir, fileName, validation.data);
    return true;
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
    const qualityValidation = await this.validateStandardPlanArtifactQuality(phase);
    if (qualityValidation && !qualityValidation.valid) {
      return qualityValidation;
    }

    if (phase === 'planning' || phase === 'quick_spec') {
      let compactErrors: string[] = [];
      try {
        await this.deriveRuntimePlanFromTasks();
        compactErrors = await this.compactAggressiveSimplePlan();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          valid: false,
          errors: [`Failed to generate implementation plan from ${AUTOCODE_TASK_ARTIFACTS.tasks}: ${message}`],
        };
      }

      const planFileName = AUTOCODE_TASK_ARTIFACTS.implementationPlan;
      try {
        const hydratedPlan = await loadImplementationPlanFromFiles(this.config.specDir);
        const parsedPlan = hydratedPlan ? ImplementationPlanSchema.safeParse(hydratedPlan) : null;
        const result = parsedPlan?.success
          ? { valid: true as const, data: parsedPlan.data, errors: [] as string[] }
          : {
              valid: false as const,
              errors: parsedPlan
                ? parsedPlan.error.issues.map((issue) => issue.message)
                : [`File not found or unreadable: ${planFileName}`],
            };
        if (result.valid) {
          await saveImplementationPlanToFiles(this.config.specDir, result.data as never);
        }
        const normalizedPlan = result.valid ? result.data : null;
        const languageErrors = result.valid && normalizedPlan
          ? validateImplementationPlanLanguage(normalizedPlan as never, this.config.language)
          : [];
        const executionErrors = result.valid && !hasExecutableSubtasks(normalizedPlan)
          ? ['Implementation plan has no executable subtasks.']
          : [];

        return {
          valid: result.valid && executionErrors.length === 0 && languageErrors.length === 0 && compactErrors.length === 0,
          errors: result.valid
            ? [
                ...executionErrors,
                ...languageErrors,
                ...compactErrors,
              ]
            : [...result.errors, ...languageErrors, ...compactErrors],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(AUTOCODE_TASK_ARTIFACTS.implementationPlan)) {
          return {
            valid: false,
            errors: [`Failed to write implementation plan: ${message}`],
          };
        }
        return null; // File doesn't exist yet — handled by validatePhaseOutputs
      }
    }
    return null; // No schema for this phase
  }

  private async validateStandardPlanArtifactQuality(
    phase: SpecPhase,
  ): Promise<{ valid: boolean; errors: string[] } | null> {
    const specMarkdown = await this.readOptionalArtifact(AUTOCODE_TASK_ARTIFACTS.specFile);
    const requirementsMarkdown = await this.readOptionalArtifact(AUTOCODE_TASK_ARTIFACTS.requirements);
    const tasksMarkdown = await this.readOptionalArtifact(AUTOCODE_TASK_ARTIFACTS.tasks);
    const contextMarkdown = await this.readOptionalArtifact(AUTOCODE_TASK_ARTIFACTS.context);

    const shouldValidate = (
      phase === 'discovery' ||
      phase === 'context' ||
      phase === 'requirements' ||
      phase === 'spec_writing' ||
      phase === 'self_critique' ||
      phase === 'planning' ||
      phase === 'quick_spec'
    );
    if (!shouldValidate) {
      return null;
    }

    const validatesContextArtifact =
      phase === 'discovery' ||
      phase === 'context' ||
      Boolean(contextMarkdown && (
        phase === 'spec_writing' ||
        phase === 'self_critique' ||
        phase === 'planning'
      ));

    const result = validateAutocodeStandardPlanArtifacts({
      contextMarkdown: validatesContextArtifact
        ? contextMarkdown
        : undefined,
      requirementsMarkdown: phase === 'requirements' || phase === 'spec_writing' || phase === 'self_critique' || phase === 'planning'
        ? requirementsMarkdown
        : undefined,
      specMarkdown: phase === 'spec_writing' || phase === 'self_critique' || phase === 'planning' || phase === 'quick_spec'
        ? specMarkdown
        : undefined,
      tasksMarkdown: phase === 'planning' || phase === 'quick_spec'
        ? tasksMarkdown
        : undefined,
      requireContextEvidence: validatesContextArtifact,
      requireRequirementsEvidence: phase === 'requirements' || phase === 'spec_writing' || phase === 'self_critique' || phase === 'planning',
      requireSpecEvidence: phase === 'spec_writing' || phase === 'self_critique' || phase === 'planning',
      requireTaskEvidence: phase === 'planning' || phase === 'quick_spec',
    });
    return result.valid
      ? { valid: true, errors: [] }
      : { valid: false, errors: result.errors };
  }

  private async readOptionalArtifact(fileName: string): Promise<string | null> {
    try {
      return await readFile(join(this.config.specDir, fileName), 'utf-8');
    } catch {
      return null;
    }
  }

  private async deriveRuntimePlanFromTasks(): Promise<void> {
    const tasksMarkdown = await readFile(join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.tasks), 'utf-8');
    const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(tasksMarkdown, {
      now: new Date().toISOString(),
      language: this.config.language,
      sourcePath: AUTOCODE_TASK_ARTIFACTS.tasks,
      requireTaskEvidence: true,
    });
    await saveAutocodeImplementationPlan(this.config.specDir, plan);
  }

  private async writeAggressiveStandardLightPlan(
    phaseNumber: number,
    totalPhases: number,
  ): Promise<SpecPhaseResult> {
    const phase: SpecPhase = 'quick_spec';
    this.emitTyped('phase-start', phase, phaseNumber, totalPhases);

    const patternFiles = await inferAggressivePatternFiles(
      this.config.projectDir,
      this.config.taskDescription ?? '',
    );
    const plan = isSourceDocumentationTask(this.config.taskDescription)
      ? buildSourceDocumentationStandardLightPlan(
          this.config.taskDescription ?? 'Complete the requested task',
          this.config.language,
          patternFiles,
          this.config.agentProfile,
        )
      : buildLocalizedAggressiveStandardLightPlan(
          this.config.taskDescription ?? 'Complete the requested task',
          this.config.language,
          patternFiles,
        );

    try {
      await writeFile(join(this.config.specDir, 'spec.md'), plan.specMarkdown, 'utf-8');
      await writeFile(
        join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.tasks),
        stringifyAutocodeImplementationPlanMarkdown(plan.implementationPlan as never).replace(
          /^# Implementation Plan/m,
          '# Tasks',
        ),
        'utf-8',
      );
      await this.deriveRuntimePlanFromTasks();

      const result: SpecPhaseResult = { phase, success: true, errors: [], retries: 0 };
      const patternFiles = plan.implementationPlan.phases[0]?.subtasks[0]?.pattern_files ?? [];
      const fileHint = patternFiles.length > 0 ? `; file hints: ${patternFiles.join(', ')}` : '';
      this.emitTyped('log', `${plan.implementationPlan.workflow_type === 'documentation' ? 'Documentation analysis' : 'Aggressive workflow'} generated a Standard light plan and one-task source without an AI planning session${fileHint}`);
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
      const evidence = uniqueStrings(subtasks.flatMap((subtask) => typeof subtask.evidence === 'string' ? [subtask.evidence] : []));
      const upstreamTaskIds = uniqueStrings(subtasks.flatMap((subtask) => {
        const ids = Array.isArray(subtask.upstream_task_ids)
          ? subtask.upstream_task_ids.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        return ids.length > 0
          ? ids
          : subtask.id
            ? [String(subtask.id)]
            : [];
      }));
      const requirements = uniqueStrings([
        ...upstreamTaskIds,
        ...subtasks.flatMap((subtask) =>
          Array.isArray(subtask.requirements)
            ? subtask.requirements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [],
        ),
      ]);
      const verification = [...subtasks].reverse().find((subtask) => subtask.verification)?.verification
        ?? { type: 'manual', scenario: 'Review the completed change and run the project checks that apply to this task.' };
      const taskItems = subtasks.flatMap((subtask) => {
        const description = typeof subtask.description === 'string' ? subtask.description : '';
        if (subtask.work_package === true && /\bIncluded tasks:/i.test(description)) {
          const includedItems = description
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^-\s+\S+\s+.+/.test(line));
          if (includedItems.length > 0) {
            return includedItems;
          }
        }
        const label = subtask.title?.trim() || subtask.description?.trim() || subtask.id || 'Implementation step';
        return [`- ${label}`];
      });
      const taskList = taskItems.join('\n');
      const sourceTaskTitles = taskItems
        .map((item) => item.replace(/^-\s+/, '').replace(/^\S+\s+/, '').trim())
        .filter(Boolean);
      const compactTitle = sourceTaskTitles.length > 1
        ? `Work package: ${sourceTaskTitles[0]} (+${sourceTaskTitles.length - 1} related tasks)`
        : sourceTaskTitles[0]
          ? `Work package: ${sourceTaskTitles[0]}`
          : 'Work package: Implement complete task';

      plan.phases = [
        {
          id: firstPhase?.id ?? firstPhase?.phase ?? '1',
          phase: firstPhase?.phase ?? 1,
          name: firstPhase?.name ?? 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: compactTitle,
              description: [
                'Implement the complete requested change in one focused coding session.',
                '',
                'Scope:',
                taskList,
                '',
                'Done when: All included scope items are complete and focused verification is recorded.',
              ].join('\n'),
              status: 'pending',
              ...(filesToCreate.length > 0 ? { files_to_create: filesToCreate } : {}),
              ...(filesToModify.length > 0 ? { files_to_modify: filesToModify } : {}),
              ...(requirements.length > 0 ? { requirements } : {}),
              ...(evidence.length > 0 ? { evidence: evidence.join('; ') } : {}),
              verification,
              upstream_source: AUTOCODE_TASK_ARTIFACTS.tasks,
              upstream_task_ids: upstreamTaskIds,
              work_package: true,
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

  private async writeSpecValidationReport(): Promise<void> {
    const rows: Array<[string, string]> = [];
    const addRow = (item: string, status: string): void => {
      rows.push([item, status]);
    };

    let implementationPlanValid = false;
    let executablePlan = false;
    try {
      await access(join(this.config.specDir, 'spec.md'));
      addRow('spec.md', 'present');
    } catch {
      addRow('spec.md', 'missing');
    }

    try {
      const plan = await loadImplementationPlanFromFiles(this.config.specDir);
      const result = plan ? ImplementationPlanSchema.safeParse(plan) : null;
      implementationPlanValid = result?.success === true;
      addRow(
        AUTOCODE_TASK_ARTIFACTS.implementationPlan,
        result?.success
          ? 'valid'
          : `invalid: ${result ? result.error.issues.map((issue) => issue.message).join('; ') : 'file missing'}`,
      );

      executablePlan = hasExecutableSubtasks(plan);
      addRow('executable subtasks', executablePlan ? 'present' : 'missing');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addRow(AUTOCODE_TASK_ARTIFACTS.implementationPlan, `unreadable: ${message}`);
    }

    const passed = rows.every(([, status]) => !status.startsWith('missing') && !status.startsWith('invalid') && !status.startsWith('unreadable')) &&
      implementationPlanValid &&
      executablePlan;
    const report = [
      '# Spec Validation Report',
      '',
      `Status: ${passed ? 'PASSED' : 'FAILED'}`,
      '',
      '| Check | Result |',
      '| --- | --- |',
      ...rows.map(([item, status]) => `| ${item} | ${status.replace(/\|/g, '\\|')} |`),
      '',
    ].join('\n');

    try {
      await writeFile(join(this.config.specDir, 'spec_validation_report.md'), report, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitTyped('log', `Failed to write validation report: ${message}`);
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
          this.phaseSummaries[fileName] = compactPhaseOutputForCarryover(fileName, content);
        }
      } catch {
        // File may not exist if phase didn't produce it — that's fine
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getAgentForPhase(phase: SpecPhase): AgentType {
    const profile = this.config.agentProfile ?? GENERAL_AGENT_PROFILE;
    if (profile.id === 'game-mmo') {
      if (phase === 'planning') {
        return profile.planning;
      }
      if (phase === 'validation') {
        return profile.qaReview;
      }
      if (phase === 'quick_spec' || phase === 'spec_writing') {
        return profile.specOrchestrator;
      }
      if (phase === 'self_critique') {
        return 'mmo_system_designer';
      }
      if (phase === 'research' || phase === 'context' || phase === 'historical_context') {
        return 'mmo_engine_architect';
      }
      if (phase === 'discovery' || phase === 'requirements' || phase === 'complexity_assessment') {
        return 'mmo_system_designer';
      }
    }

    return PHASE_AGENT_MAP[phase];
  }

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
