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
import { join, extname } from 'node:path';
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
  type SpecContextOutput,
  type ResearchOutput,
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

function isEmptyOrUnstructuredProjectIndex(projectIndex: string | undefined): boolean {
  if (!projectIndex) {
    return false;
  }

  try {
    const parsed = JSON.parse(projectIndex) as {
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
    return projectIndex.trim().length > 0 &&
      projectIndex.length < 512 &&
      !/(package\.json|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle)/i.test(projectIndex);
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
  'task_logs.json',
  'task_metadata.json',
  'requirements.json',
  'implementation_plan.json',
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
      source_task: {
        original_request: task,
        constraint_terms: extractConstraintTerms(task),
      },
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
  const constraintReminder = buildConstraintReminder(task, language);
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
        ...(constraintReminder ? [`- ${constraintReminder}`] : []),
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
              id: '1-1',
              title,
              description: [
                task,
                '',
                implementationInstruction,
                ...(constraintReminder ? ['', constraintReminder] : []),
              ].join('\n'),
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

function buildSourceDocumentationQuickSpecPlan(
  taskDescription: string | undefined,
  language?: SupportedLanguage,
  patternFiles: string[] = [],
): QuickSpecPlan {
  const task = normalizeTaskDescription(taskDescription);
  const feature = oneLine(task, 120);
  const outputFile = inferDocumentationOutputFile(task);
  const isChinese = language === 'zh-CN';
  const phaseName = isChinese ? '\u6587\u6863\u5206\u6790' : 'Documentation analysis';
  const title = isChinese ? '\u5206\u6790\u6e90\u7801\u5e76\u751f\u6210\u6587\u6863' : 'Analyze source and generate documentation';
  const outputHint = isChinese
    ? `\u751f\u6210\u6216\u66f4\u65b0\u7528\u6237\u8981\u6c42\u7684 Markdown \u6587\u6863\u3002\u672a\u6307\u5b9a\u8f93\u51fa\u6587\u4ef6\u65f6\u4f7f\u7528 ${outputFile}\u3002`
    : `Create or update the requested Markdown document. When no output file is specified, use ${outputFile}.`;
  const readRule = isChinese
    ? '\u53ea\u505a\u6587\u6863\u5206\u6790\uff0c\u4e0d\u4fee\u6539\u4ea7\u54c1\u4ee3\u7801\u3002\u5148\u7528\u9879\u76ee\u7d22\u5f15\u548c\u7528\u6237\u6307\u5b9a\u6587\u4ef6\u5b9a\u4f4d\u8303\u56f4\uff0c\u518d\u7cbe\u8bfb\u5c11\u91cf\u5173\u952e\u6e90\u7801\u6587\u4ef6\u3002'
    : 'This is documentation analysis only; do not modify product code. Use the project index and user-specified files to narrow scope, then read only a small set of key source files.';
  const verificationRun = isChinese
    ? '\u786e\u8ba4 Markdown \u6587\u6863\u5df2\u751f\u6210\uff0c\u4e14\u5305\u542b\u7ed3\u6784\u5316\u7684\u6e90\u7801\u5206\u6790\u7ed3\u679c\u3002\u4e0d\u8981\u4e3a\u7eaf\u6587\u6863\u4efb\u52a1\u8fd0\u884c\u7f16\u8bd1\u6216 QA\u3002'
    : 'Confirm the Markdown document exists and contains structured source analysis. Do not run build or QA for documentation-only tasks.';
  const specMarkdown = isChinese
    ? [
        `# \u6587\u6863\u5206\u6790\u4efb\u52a1\uff1a${feature}`,
        '',
        '## \u76ee\u6807',
        task,
        '',
        '## \u8303\u56f4',
        `- \u8f93\u51fa Markdown \u6587\u6863\uff1a\`${outputFile}\`\u3002`,
        '- \u53ea\u9605\u8bfb\u4e0e\u95ee\u9898\u76f4\u63a5\u76f8\u5173\u7684\u6e90\u7801\u6587\u4ef6\u3002',
        '- \u4e0d\u505a\u4ea7\u54c1\u4ee3\u7801\u6539\u52a8\u3002',
        '',
        '## \u9a8c\u6536',
        '- \u6587\u6863\u5df2\u751f\u6210\u6216\u66f4\u65b0\u3002',
        '- \u5185\u5bb9\u6709\u7ed3\u6784\uff0c\u80fd\u652f\u6301\u4eba\u5de5\u5ba1\u6838\u3002',
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
        '- Read only source files directly relevant to the request.',
        '- Do not change product code.',
        '',
        '## Acceptance',
        '- Documentation is created or updated.',
        '- The content is structured and reviewable.',
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
              id: '1-1',
              title,
              description: [
                task,
                '',
                readRule,
                outputHint,
                isChinese
                  ? '\u4f18\u5148\u7528\u8868\u683c\u3001\u5206\u5c42\u6807\u9898\u3001\u6d41\u7a0b\u5217\u8868\u5448\u73b0\uff0c\u907f\u514d\u5927\u6bb5\u5806\u53e0\u6587\u5b57\u3002'
                  : 'Prefer tables, layered headings, and flow lists instead of long prose blocks.',
              ].join('\n'),
              status: 'pending',
              files_to_create: [outputFile],
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
    'Your previous structured output could not be parsed or validated.',
    'Do NOT call the Write tool for this JSON file.',
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

function normalizeStructuredJsonOutput(phase: SpecPhase, value: unknown): unknown {
  switch (phase) {
    case 'discovery':
    case 'context':
      return normalizeSpecContextOutput(value);
    case 'requirements':
      return normalizeRequirementsOutput(value);
    case 'research':
      return normalizeResearchOutput(value);
    default:
      return value;
  }
}

function normalizeSpecContextOutput(value: unknown): SpecContextOutput | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return {
    task_description: stringFrom(record.task_description, record.task, record.taskDescription, record.summary),
    scoped_services: stringArrayFrom(record.scoped_services, record.services_involved, record.services),
    architecture_summary: stringFrom(record.architecture_summary, record.architecture, record.current_state, record.summary, record.tech_stack),
    files_to_modify: normalizeFileModifications(record.files_to_modify, record.filesToModify, record.likely_files_to_create),
    files_to_reference: normalizeFileReferences(record.files_to_reference, record.filesToReference, record.pattern_files),
    design_patterns: normalizeDesignPatterns(record.design_patterns, record.patterns),
    implementation_notes: stringArrayFrom(record.implementation_notes, record.notes, record.notes_for_next_phase),
    risks: stringArrayFrom(record.risks, record.risk_notes),
    verification_suggestions: stringArrayFrom(record.verification_suggestions, record.validation_strategy, record.recommended_checks),
    created_at: stringFrom(record.created_at, record.createdAt) || new Date().toISOString(),
  };
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

function normalizeFileModifications(...values: unknown[]): SpecContextOutput['files_to_modify'] {
  const items = firstArray(values);
  return items.map((item) => {
    if (typeof item === 'string') {
      return {
        path: item,
        reason: 'Relevant file for the requested change',
        change_needed: 'Create or update this file to implement the task',
      };
    }
    const record = isRecord(item) ? item : {};
    const pathValue = stringFrom(record.path, record.file, record.file_path, record.name);
    return {
      path: pathValue,
      reason: stringFrom(record.reason, record.purpose, record.description) || 'Relevant file for the requested change',
      change_needed: stringFrom(record.change_needed, record.changeNeeded, record.action, record.status) || 'Create or update this file to implement the task',
    };
  }).filter((item) => item.path);
}

function normalizeFileReferences(...values: unknown[]): SpecContextOutput['files_to_reference'] {
  const items = firstArray(values);
  return items.map((item) => {
    if (typeof item === 'string') {
      return {
        path: item,
        reason: 'Reference file for existing patterns',
        pattern: 'Review relevant implementation patterns',
      };
    }
    const record = isRecord(item) ? item : {};
    const pathValue = stringFrom(record.path, record.file, record.file_path, record.name);
    return {
      path: pathValue,
      reason: stringFrom(record.reason, record.purpose, record.description) || 'Reference file for existing patterns',
      pattern: stringFrom(record.pattern, record.guidance, record.existing_usage) || 'Review relevant implementation patterns',
    };
  }).filter((item) => item.path);
}

function normalizeDesignPatterns(...values: unknown[]): SpecContextOutput['design_patterns'] {
  const items = firstArray(values);
  return items.map((item) => {
    if (typeof item === 'string') {
      return {
        name: item,
        existing_usage: 'Not detected',
        files: [],
        guidance: item,
      };
    }
    const record = isRecord(item) ? item : {};
    const name = stringFrom(record.name, record.pattern, record.title, record.guidance);
    return {
      name,
      existing_usage: stringFrom(record.existing_usage, record.existingUsage, record.usage) || 'Not detected',
      files: stringArrayFrom(record.files, record.paths),
      guidance: stringFrom(record.guidance, record.description, record.reason) || name,
    };
  }).filter((item) => item.name);
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

function normalizeRequirementsOutput(value: unknown): RequirementsOutput | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const taskDescription = stringFrom(record.task_description, record.task, record.taskDescription, record.summary);
  return {
    task_description: taskDescription,
    workflow_type: normalizeWorkflowType(record.workflow_type, record.workflowType, record.type),
    services_involved: stringArrayFrom(record.services_involved, record.scoped_services, record.services),
    user_requirements: stringArrayFrom(record.user_requirements, record.requirements, record.functional_requirements, taskDescription),
    acceptance_criteria: stringArrayFrom(record.acceptance_criteria, record.acceptanceCriteria, record.success_criteria, record.validation_scenarios),
    constraints: stringArrayFrom(record.constraints, record.non_functional_requirements, record.risks),
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

function buildFallbackContextOutput(taskDescription?: string): SpecContextOutput {
  const description = taskDescription?.trim() || 'Create the requested software change.';
  return {
    task_description: description,
    scoped_services: [],
    architecture_summary: 'Project structure is empty or insufficiently indexed; continue from the task description and existing project conventions.',
    files_to_modify: [],
    files_to_reference: [],
    design_patterns: [],
    implementation_notes: [
      'Use the task description as the source of truth.',
      'Inspect only files directly relevant to the implementation before editing.',
    ],
    risks: [
      'Discovery fallback was used because the model did not produce context.json.',
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
  projectIndex?: string,
): boolean {
  if (assessment?.needs_research === true) {
    return true;
  }
  if (assessment?.needs_research === false) {
    return false;
  }

  const taskText = (taskDescription ?? '').toLowerCase();
  if (hasTaskExternalResearchSignal(taskText)) {
    return true;
  }

  return hasProjectExternalResearchSignal((projectIndex ?? '').toLowerCase());
}

function hasTaskExternalResearchSignal(text: string): boolean {
  return /(\bapi\b|\bsdk\b|\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\bcloud\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\brest\b|\bplugin\b|\bextension\b|\bpackage\b|\blibrary\b|\bdependency\b|\bintegration\b|\bthird[-\s]?party\b|\bexternal\b|\bauth\b|\bdatabase\b|\bqueue\b|\bmessage broker\b|\bkafka\b|\brabbitmq\b|接口|集成|第三方|外部|依赖|包|库|插件|认证|授权|支付|云服务|数据库|消息队列)/i.test(text);
}

function hasProjectExternalResearchSignal(text: string): boolean {
  return /(\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\bkafka\b|\brabbitmq\b|\bthird[-\s]?party\b|\bexternal api\b|\bapi client\b|第三方|外部接口|认证|授权|支付|云服务|数据库|消息队列)/i.test(text);
}

function inferComplexityFallback(
  taskDescription: string,
  projectIndex: string | undefined,
  workflowConfig: WorkflowConfig,
): FallbackComplexityAssessment {
  const taskText = normalizeTaskDescription(taskDescription).toLowerCase();
  const projectText = (projectIndex ?? '').toLowerCase();
  const parsedIndex = parseProjectIndexSummary(projectIndex);
  const signals: string[] = [];

  const hasBroadChangeIntent = /(\bmigrate|\bmigration|\bport\b|\bremove\b|\bdelete\b|\breplace\b|\brewrite\b|\brefactor\b|\brework\b|\bredesign\b|\brestructure\b|\bswitch\b|\bconvert\b|\bdeprecate\b|\bdrop\b|\bphase[-\s]?out\b|迁移|移植|移除|删除|替换|重写|重构|改造|重新设计|切换|转换|废弃|下线)/i.test(taskText);
  if (hasBroadChangeIntent) {
    signals.push('broad change intent');
  }

  const affectedAreas = [
    /\bruntime\b|运行时/,
    /\beditor\b|\badmin\b|\bdashboard\b|\bui\b|\binterface\b|编辑器|后台|界面/,
    /\bbuild\b|\bcompile\b|\bpackag(e|ing)\b|\bbundle\b|\btoolchain\b|\bgenerator\b|\bmakefile\b|\bcmake\b|\bgradle\b|\bmaven\b|构建|编译|打包|工具链|项目生成/,
    /\bci\b|\bworkflow\b|\bpipeline\b|\bdeploy\b|\brelease\b|\bpublish\b|流水线|发布|部署/,
    /\basset\b|\bresource\b|\btemplate\b|\bexample\b|\bdocumentation\b|\bdocs\b|资产|资源|模板|示例|文档/,
    /\bapi\b|\bsdk\b|\bplugin\b|\bextension\b|\bmodule\b|\babi\b|接口|插件|扩展|模块/,
    /\bseriali[sz]ation\b|\bschema\b|\bmetadata\b|\breflection\b|\bcompatib/i,
    /序列化|元数据|反射|兼容|回滚|迁移工具/,
    /\bplatform\b|\bwindows\b|\blinux\b|\bmacos\b|\bandroid\b|\bios\b|\bcross[-\s]?platform\b|平台|跨平台/,
    /\bsecurity\b|\bauth\b|\bpermission\b|\brole\b|安全|认证|权限|角色/,
  ];
  const affectedAreaCount = affectedAreas.reduce((count, pattern) => {
    return count + (pattern.test(taskText) || pattern.test(projectText) ? 1 : 0);
  }, 0);
  if (affectedAreaCount >= 3) {
    signals.push(`${affectedAreaCount} affected areas`);
  }

  if (parsedIndex.serviceCount >= 3) {
    signals.push(`${parsedIndex.serviceCount} services`);
  }
  if (parsedIndex.languageCount >= 3) {
    signals.push(`${parsedIndex.languageCount} languages`);
  }
  if (parsedIndex.infrastructureCount >= 2) {
    signals.push(`${parsedIndex.infrastructureCount} infrastructure signals`);
  }
  if (parsedIndex.hasLargeProjectSignal) {
    signals.push('large project profile');
  }

  const isConservative = workflowConfig.optimizationLevel === 'conservative' ||
    workflowConfig.specCreationMode === 'phased' ||
    workflowConfig.qualityChecks?.enableSelfCritique === true;
  const hasLargeProjectContext = parsedIndex.hasLargeProjectSignal ||
    parsedIndex.serviceCount >= 3 ||
    parsedIndex.languageCount >= 3 ||
    parsedIndex.infrastructureCount >= 2 ||
    /\bmonorepo\b|大型|多模块|多服务|多平台/.test(projectText);
  const hasComplexTaskShape = hasBroadChangeIntent && affectedAreaCount >= 3;
  const hasLargeMultiSubsystemProject = parsedIndex.hasLargeProjectSignal &&
    (parsedIndex.languageCount >= 3 || parsedIndex.infrastructureCount >= 2 || parsedIndex.serviceCount >= 2);
  const hasEngineOrPlatformSurface = /(\bengine\b|\brenderer\b|\bcompiler\b|\bshader\b|\bruntime\b|\bkernel\b|\bplatform\b|\bframework\b|\bsdk\b|\bplugin\b|\bcross[-\s]?platform\b)/i.test(taskText) ||
    /(\bengine\b|\brenderer\b|\bcompiler\b|\bshader\b|\bruntime\b|\bkernel\b|\bplatform\b|\bframework\b|\bsdk\b|\bplugin\b|\bcross[-\s]?platform\b)/i.test(projectText);

  if (
    isConservative &&
    hasBroadChangeIntent &&
    hasLargeMultiSubsystemProject &&
    (affectedAreaCount >= 2 || hasEngineOrPlatformSurface)
  ) {
    return {
      complexity: 'complex',
      confidence: 0.78,
      reasoning: `local fallback detected conservative broad change in large multi-subsystem project (${signals.join(', ')})`,
      needs_research: shouldRunResearchPhase(null, taskDescription, projectIndex),
      needs_self_critique: true,
    };
  }

  if ((hasComplexTaskShape && hasLargeProjectContext) || (isConservative && hasComplexTaskShape && affectedAreaCount >= 4)) {
    return {
      complexity: 'complex',
      confidence: 0.75,
      reasoning: `local fallback detected ${signals.join(', ')}`,
      needs_research: shouldRunResearchPhase(null, taskDescription, projectIndex),
      needs_self_critique: true,
    };
  }

  if (hasComplexTaskShape || (hasBroadChangeIntent && hasLargeProjectContext)) {
    return {
      complexity: 'standard',
      confidence: 0.65,
      reasoning: `local fallback detected ${signals.join(', ') || 'moderate scope'}`,
      needs_research: shouldRunResearchPhase(null, taskDescription, projectIndex),
      needs_self_critique: isConservative,
    };
  }

  return {
    complexity: 'standard',
    confidence: 0.5,
    reasoning: signals.length > 0
      ? `local fallback detected ${signals.join(', ')}`
      : 'local fallback did not find enough signal for complex routing',
    needs_research: shouldRunResearchPhase(null, taskDescription, projectIndex),
    needs_self_critique: false,
  };
}

function parseProjectIndexSummary(projectIndex: string | undefined): {
  serviceCount: number;
  languageCount: number;
  infrastructureCount: number;
  hasLargeProjectSignal: boolean;
} {
  const summary = {
    serviceCount: 0,
    languageCount: 0,
    infrastructureCount: 0,
    hasLargeProjectSignal: false,
  };

  if (!projectIndex?.trim()) {
    return summary;
  }

  try {
    const parsed = JSON.parse(projectIndex) as Record<string, unknown>;
    const services = isRecord(parsed.services) ? parsed.services : {};
    summary.serviceCount = Object.keys(services).length;

    const languages = new Set<string>();
    for (const service of Object.values(services)) {
      if (isRecord(service)) {
        stringArrayFrom(service.languages, service.language).forEach((language) => languages.add(language.toLowerCase()));
        stringArrayFrom(service.frameworks, service.framework).forEach((framework) => languages.add(framework.toLowerCase()));
      }
    }

    const project = isRecord(parsed.project) ? parsed.project : {};
    const sourceSummary = isRecord(parsed.source_summary) ? parsed.source_summary : {};
    stringArrayFrom(project.languages).forEach((language) => languages.add(language.toLowerCase()));
    stringArrayFrom(sourceSummary.languages).forEach((language) => languages.add(language.toLowerCase()));
    summary.languageCount = languages.size;

    const infrastructure = isRecord(parsed.infrastructure) ? parsed.infrastructure : {};
    summary.infrastructureCount = Object.values(infrastructure)
      .filter((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))
      .length;
    summary.infrastructureCount += stringArrayFrom(sourceSummary.build_files).length > 0 ? 1 : 0;
    summary.infrastructureCount += stringArrayFrom(sourceSummary.project_files).length > 0 ? 1 : 0;

    const sourceCount = Number(project.sourceFileCount ?? project.source_file_count ?? sourceSummary.source_file_count ?? parsed.sourceFileCount ?? parsed.source_file_count ?? 0);
    const totalCount = Number(project.totalFileCount ?? project.total_file_count ?? sourceSummary.total_file_count ?? parsed.totalFileCount ?? parsed.total_file_count ?? 0);
    summary.hasLargeProjectSignal = project.size === 'large' || sourceCount >= 250 || totalCount >= 1500;
  } catch {
    const text = projectIndex.toLowerCase();
    summary.hasLargeProjectSignal = /"size"\s*:\s*"large"|sourcefilecount"\s*:\s*[3-9]\d\d|source_file_count"\s*:\s*[3-9]\d\d|totalfilecount"\s*:\s*[2-9]\d{3,}|total_file_count"\s*:\s*[2-9]\d{3,}/.test(text);
    summary.infrastructureCount = (text.match(/ci_workflows|docker|workflow|pipeline|deployment/g) ?? []).length;
  }

  return summary;
}

function selectSpecPhases(
  complexity: ComplexityTier,
  assessment: ComplexityAssessment | null,
  taskDescription: string | undefined,
  projectIndex: string | undefined,
  workflowConfig: WorkflowConfig,
): SpecPhase[] {
  const phases = workflowConfig.optimizationLevel === 'aggressive' && complexity === 'simple'
    ? [...AGGRESSIVE_SIMPLE_PHASES]
    : [...COMPLEXITY_PHASES[complexity]];
  if (complexity === 'simple' && isSourceDocumentationTask(taskDescription)) {
    return ['quick_spec'];
  }
  const needsResearch = shouldRunResearchPhase(assessment, taskDescription, projectIndex);
  const researchIndex = phases.indexOf('research');

  if (needsResearch && researchIndex === -1) {
    const insertBefore = phases.indexOf('context') !== -1
      ? phases.indexOf('context')
      : phases.indexOf('spec_writing');
    if (insertBefore !== -1) {
      phases.splice(insertBefore, 0, 'research');
    }
  } else if (!needsResearch && researchIndex !== -1) {
    phases.splice(researchIndex, 1);
  }

  if (assessment?.needs_self_critique && !phases.includes('self_critique')) {
    const planningIdx = phases.indexOf('planning');
    if (planningIdx !== -1) {
      phases.splice(planningIdx, 0, 'self_critique');
    }
  }

  return phases;
}

function shouldForceSplitImplementationPlan(
  complexity: ComplexityTier | undefined,
  workflowConfig: WorkflowConfig | undefined,
): boolean {
  if (complexity !== 'complex') {
    return false;
  }
  return workflowConfig?.optimizationLevel === 'conservative' ||
    workflowConfig?.specCreationMode === 'phased';
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
        if (!this.assessment) {
          this.assessment = await this.restoreComplexityAssessmentFromFile() ??
            this.buildFallbackComplexityAssessment('Resume state omitted complexity');
        }
        complexity = this.assessment.complexity;
        this.emitTyped('log', `Skipping complexity assessment (already completed): ${complexity}`);
      } else {
        // Fast-path heuristic: catch obviously simple tasks before expensive AI assessment
        const heuristicResult = this.assessComplexityHeuristic(
          this.config.taskDescription ?? '',
          this.config.projectIndex,
        );
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
              this.assessment = this.buildFallbackComplexityAssessment('AI assessment failed');
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
          complexity = this.assessment.complexity;
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
        this.config.projectIndex,
        this.config.workflowConfig!,
      );

      this.emitTyped('log', `Running ${complexity} workflow: ${phasesToRun.join(' → ')}`);

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
          const result = await this.writeAggressiveQuickSpec(phaseNumber, totalPhases);
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
    projectIndex?: string,
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

    const hasSimpleProject = isEmptyOrUnstructuredProjectIndex(projectIndex);
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
      this.config.projectIndex,
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
      this.config.projectIndex,
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

          if (
            (phase === 'discovery' || phase === 'context') &&
            missingFiles.includes('context.json') &&
            attempt >= maxPhaseRetries
          ) {
            try {
              await writeStructuredJsonOutput(
                this.config.specDir,
                'context.json',
                buildFallbackContextOutput(this.config.taskDescription),
              );
              const remainingMissing = await this.validatePhaseOutputs(phase);
              if (remainingMissing.length === 0) {
                this.emitTyped('log', 'Wrote fallback context.json from task description');
                errors.pop();
                const phaseResult: SpecPhaseResult = { phase, success: true, errors: [], retries: attempt };
                this.emitTyped('phase-complete', phase, phaseResult);
                return phaseResult;
              }
            } catch (fallbackErr) {
              this.emitTyped('log', `Failed to write fallback context.json: ${fallbackErr}`);
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
    const structuredAssessment = sessionResult.structuredOutput
      ? normalizeComplexityAssessmentOutput(sessionResult.structuredOutput)
      : null;
    if (structuredAssessment) {
      this.assessment = structuredAssessment;
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

    const normalized = normalizeStructuredJsonOutput(phase, parsed.value);
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
    if (phase === 'planning' || phase === 'quick_spec') {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const rewriteErrors: string[] = [];
      try {
        try {
          const rewrite = await rewriteImplementationPlanFiles(this.config.specDir, {
            forceSplit: shouldForceSplitImplementationPlan(
              this.assessment?.complexity ?? this.config.complexityOverride,
              this.config.workflowConfig,
            ),
            threshold: 16,
          });
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

    const patternFiles = await inferAggressivePatternFiles(
      this.config.projectDir,
      this.config.taskDescription ?? '',
    );
    const plan = isSourceDocumentationTask(this.config.taskDescription)
      ? buildSourceDocumentationQuickSpecPlan(
          this.config.taskDescription ?? 'Complete the requested task',
          this.config.language,
          patternFiles,
        )
      : buildLocalizedAggressiveQuickSpecPlan(
          this.config.taskDescription ?? 'Complete the requested task',
          this.config.language,
          patternFiles,
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
      this.emitTyped('log', `${plan.implementationPlan.workflow_type === 'documentation' ? 'Documentation analysis' : 'Aggressive workflow'} generated quick spec and one-subtask plan without an AI planning session${fileHint}`);
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

  private async writeSpecValidationReport(): Promise<void> {
    const rows: Array<[string, string]> = [];
    const addRow = (item: string, status: string): void => {
      rows.push([item, status]);
    };

    let implementationPlanValid = false;
    let executablePlan = false;
    let splitPlan = false;
    let planFileCount = 0;

    try {
      await access(join(this.config.specDir, 'spec.md'));
      addRow('spec.md', 'present');
    } catch {
      addRow('spec.md', 'missing');
    }

    try {
      const result = await validateAndNormalizeJsonFile(
        join(this.config.specDir, 'implementation_plan.json'),
        ImplementationPlanSchema,
      );
      implementationPlanValid = result.valid;
      addRow('implementation_plan.json', result.valid ? 'valid' : `invalid: ${result.errors.join('; ')}`);

      const plan = result.valid ? await loadImplementationPlanFromFiles(this.config.specDir) : null;
      executablePlan = hasExecutableSubtasks(plan);
      splitPlan = Boolean((plan as { split_plan?: boolean } | null)?.split_plan);
      planFileCount = Array.isArray((plan as { plan_files?: unknown[] } | null)?.plan_files)
        ? ((plan as { plan_files?: unknown[] }).plan_files?.length ?? 0)
        : 0;
      addRow('executable subtasks', executablePlan ? 'present' : 'missing');
      addRow('split plan', splitPlan ? `yes (${planFileCount} files)` : 'no');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addRow('implementation_plan.json', `unreadable: ${message}`);
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
