/**
 * Build Orchestrator
 * ==================
 *
 * See apps/desktop/src/main/ai/orchestration/build-orchestrator.ts for the TypeScript implementation.
 * Drives the full build lifecycle through phase progression:
 *   planning → coding → qa_review → qa_fixing → complete/failed
 *
 * Each phase invokes `runAgentSession()` with the appropriate agent type,
 * system prompt, and configuration. Phase transitions follow the ordering
 * defined in phase-protocol.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import {
  isTerminalPhase,
  isValidPhaseTransition,
  type CompletablePhase,
} from '../../../shared/constants/phase-protocol';
import type { AgentType } from '../config/agent-configs';
import { GENERAL_AGENT_PROFILE, type ProjectAgentProfile } from '../config/project-agent-profile';
import {
  AUTOCODE_DEFAULT_RUNTIME_CONCURRENCY,
  AUTOCODE_STANDARD_CHANGE_REQUESTS_FILE,
  AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER,
  AUTOCODE_TASK_ARTIFACTS,
  buildAutocodePlanQualityRetryPrompt,
  buildAutocodeDesignPackageMarkdown,
  buildAutocodeDesignQualityRetryPrompt,
  buildAutocodePlanningStructuredOutputRetryPrompt,
  buildAutocodePlanningStructuredOutputValidationRetryPrompt,
  buildAutocodeRuntimeImplementationPlanFromTasksMarkdown,
  buildAutocodeStandardTasksValidationRetryPrompt,
  compactAutocodeRetryText,
  formatAutocodeCodingRecoveryHints,
  formatAutocodeRetryErrorLines,
  isAutocodeImplementationPlanFileFailure,
  isAutocodeWriteToolPlanOutputFailure,
  summarizeAutocodeCodingAttemptFailure,
  stringifyAutocodeContextMarkdown,
  parseAutocodeImplementationPlanMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
  validateAutocodeStandardPlanArtifacts,
  validateAutocodeStandardDesignArtifacts,
  validateAutocodePlanningSchedulingMetadata,
  getAutocodeQaReportStatus,
  getAutocodeDesignDocumentFingerprint,
  getAutocodeDesignPackageFingerprint,
  getAutocodeDesignReviewStatus,
  selectAutocodeDesignRevisionStages,
  validateAutocodeStandardDesignStageArtifacts,
  RequirementsOutputSchema,
  parseAutocodeStandardPlanningOwnerPlan,
  stringifyAutocodeTaskRequirementsMarkdown,
  validateAutocodeQaReportQuality,
  type AutocodeTaskRuntimeConcurrencyResolved,
  type AutocodeStandardPlanningOwnerPlan,
  type AutocodeStandardPlanningOwnerStage,
  type AutocodeDesignPackageStage,
  type Phase,
} from '@autocode/core';
import type { SupportedLanguage } from '../../../shared/constants/i18n';
import {
  ImplementationPlanSchema,
  validateImplementationPlanLanguage,
  writeImplementationPlanFiles,
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
} from '../schema';
import type { SessionResult } from '../session/types';
import { iterateSubtasks } from './subtask-iterator';
import type { SubtaskIteratorConfig } from './subtask-iterator';
import { executeConcurrentWorkItems, type ConcurrentWorkExecutorConfig } from './concurrent-work-executor';
import type { WorkItemInfo } from './work-executor-types';
import { translateLogMessage, translatePhaseMessage } from './log-messages';
import type { WorkflowConfig } from './workflow-config';
import { getRetryLimits, DEFAULT_WORKFLOW_CONFIG } from './workflow-config';

// =============================================================================
// Constants
// =============================================================================

/** Delay between iterations when auto-continuing (ms) */
const AUTO_CONTINUE_DELAY_MS = 500;
const PRE_QA_RETURN_ISSUE_LIMIT = 6;
const PRE_QA_RETURN_ISSUE_MAX_CHARS = 240;
const PRE_QA_RETURN_REASON_MAX_CHARS = 1_800;
const STANDARD_SPEC_SEED_ERROR_PREFIX =
  `${AUTOCODE_TASK_ARTIFACTS.specFile} is still the manual Standard planning seed`;
const STANDARD_CHANGE_REQUESTS_FILE = AUTOCODE_STANDARD_CHANGE_REQUESTS_FILE;
type StandardPlanningOwnerStage = AutocodeStandardPlanningOwnerStage;
const STANDARD_PLANNING_OWNER_STAGE_ORDER =
  AUTOCODE_STANDARD_PLANNING_OWNER_STAGE_ORDER;
const STANDARD_PLANNING_SOURCE_ARTIFACTS = [
  AUTOCODE_TASK_ARTIFACTS.specFile,
  AUTOCODE_TASK_ARTIFACTS.requirements,
  AUTOCODE_TASK_ARTIFACTS.context,
  AUTOCODE_TASK_ARTIFACTS.design,
  AUTOCODE_TASK_ARTIFACTS.requirementModel,
  AUTOCODE_TASK_ARTIFACTS.domainModel,
  AUTOCODE_TASK_ARTIFACTS.designModel,
  AUTOCODE_TASK_ARTIFACTS.implementationModel,
  AUTOCODE_TASK_ARTIFACTS.designReview,
  AUTOCODE_TASK_ARTIFACTS.tasks,
] as const;
const STANDARD_PLANNING_TRANSACTION_ARTIFACTS = [
  ...STANDARD_PLANNING_SOURCE_ARTIFACTS,
  AUTOCODE_TASK_ARTIFACTS.implementationPlan,
] as const;
const STANDARD_PLANNING_CHECKPOINTS = new Set([
  'requirements_validated',
  'spec_validated',
  'design_written',
  'requirement_model_validated',
  'domain_model_validated',
  'design_validated',
  'design_model_validated',
  'implementation_model_validated',
  'design_reviewed',
  'sources_validated',
  'tasks_validated',
  'plan_derived',
  'plan_validated',
  'committed',
]);
const STANDARD_PLANNING_CHECKPOINT_RANK: Record<string, number> = {
  requirements_validated: 10,
  spec_validated: 20,
  sources_validated: 25,
  design_written: 25,
  requirement_model_validated: 30,
  domain_model_validated: 40,
  design_validated: 50,
  design_model_validated: 60,
  implementation_model_validated: 70,
  design_reviewed: 80,
  tasks_validated: 90,
  plan_derived: 100,
  plan_validated: 110,
  committed: 120,
};
const STANDARD_DESIGN_OWNER_STAGES = [
  'requirement_model',
  'domain_model',
  'design',
  'design_model',
  'implementation_model',
  'design_review',
] as const satisfies readonly AutocodeDesignPackageStage[];
const STANDARD_DESIGN_STAGE_CHECKPOINT: Record<AutocodeDesignPackageStage, string> = {
  requirement_model: 'requirement_model_validated',
  domain_model: 'domain_model_validated',
  design: 'design_validated',
  design_model: 'design_model_validated',
  implementation_model: 'implementation_model_validated',
  design_review: 'design_reviewed',
};
const STANDARD_DESIGN_STAGE_ARTIFACT: Partial<Record<AutocodeDesignPackageStage, string>> = {
  requirement_model: AUTOCODE_TASK_ARTIFACTS.requirementModel,
  domain_model: AUTOCODE_TASK_ARTIFACTS.domainModel,
  design: AUTOCODE_TASK_ARTIFACTS.design,
  design_model: AUTOCODE_TASK_ARTIFACTS.designModel,
  implementation_model: AUTOCODE_TASK_ARTIFACTS.implementationModel,
  design_review: AUTOCODE_TASK_ARTIFACTS.designReview,
};
const TRACEABLE_PLANNING_EVIDENCE_PATTERN =
  /\b(spec\.md|requirements\.md|context\.md|research\.md|agents\.md|readme|official|standard|docs?|source|project)\b|[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/i;

function hasOnlyAutocodePlanTaskGranularityErrors(errors: readonly string[]): boolean {
  return errors.length > 0 && errors.every((error) => /\btasks\.md task \S+ is too broad;/.test(error));
}

function hasTraceablePlanningEvidence(value: unknown): boolean {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length >= 6 && TRACEABLE_PLANNING_EVIDENCE_PATTERN.test(text);
}

function hasExecutableSubtasks(plan: ImplementationPlan | null): boolean {
  return plan?.phases?.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0) ?? false;
}

function validatePlanningSchedulingMetadata(
  plan: ImplementationPlan | null,
  config: BuildOrchestratorConfig,
): string[] {
  return validateAutocodePlanningSchedulingMetadata(plan, {
    runtimeConcurrency: config.runtimeConcurrency ?? AUTOCODE_DEFAULT_RUNTIME_CONCURRENCY,
    requireEvidence: true,
  });
}

function hasSubtaskCompletionEvidence(subtask: PlanSubtask): boolean {
  if (subtask.status === 'failed' || subtask.status === 'blocked') {
    return false;
  }

  if (subtask.status === 'completed') {
    return true;
  }

  if (typeof subtask.completed_at === 'string' && subtask.completed_at.trim().length > 0) {
    return true;
  }

  return typeof subtask.completion_summary === 'string' &&
    subtask.completion_summary.trim().length > 0;
}

export function formatPreQAReturnToCodingReason(
  issues: readonly string[],
  attempt: number,
  maxAttempts: number,
): string {
  const normalizedIssues = issues
    .map((issue) => issue.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const visibleIssues = normalizedIssues.length > 0
    ? normalizedIssues
    : ['Quality checks reported failure without details.'];
  const issuesSummary = formatAutocodeRetryErrorLines(visibleIssues, {
    maxErrors: PRE_QA_RETURN_ISSUE_LIMIT,
    maxCharsPerError: PRE_QA_RETURN_ISSUE_MAX_CHARS,
    bulletPrefix: '',
  }).join('; ');

  return compactAutocodeRetryText(
    `Pre-QA quality checks failed (attempt ${attempt}/${maxAttempts}) - ${issuesSummary}. Fix these issues before QA review.`,
    PRE_QA_RETURN_REASON_MAX_CHARS,
  );
}

// =============================================================================
// Types
// =============================================================================

/** Build phase mapped to agent type */
type BuildPhase = 'planning' | 'coding' | 'qa_review' | 'qa_fixing';

interface StandardPlanningArtifactSnapshot {
  suffix: string;
  artifacts: Array<{
    fileName: string;
    content: string | null;
  }>;
}

type StandardPlanningOwnerPlan = AutocodeStandardPlanningOwnerPlan;

interface StandardPlanningTransactionState {
  version: 1;
  id: string;
  phase: 'planning';
  status: 'active' | 'repair_required' | 'failed' | 'completed';
  stage: string;
  createdAt: string;
  updatedAt: string;
  resumedAt?: string;
  resumedFromStage?: string;
  checkpoint?: string;
  changeRequestId?: string;
  ownerStages?: StandardPlanningOwnerStage[];
  detail?: string;
  baselineArtifactHashes: Record<string, string | null>;
  baselineArtifacts?: Record<string, string | null>;
  artifactHashes: Record<string, string | null>;
}

function hasReachedStandardPlanningCheckpoint(
  transaction: StandardPlanningTransactionState,
  checkpoint: string,
): boolean {
  const currentRank = STANDARD_PLANNING_CHECKPOINT_RANK[transaction.checkpoint ?? ''] ?? 0;
  const requiredRank = STANDARD_PLANNING_CHECKPOINT_RANK[checkpoint] ?? Number.POSITIVE_INFINITY;
  return currentRank >= requiredRank;
}

function getValidatedStandardDesignStages(
  transaction: StandardPlanningTransactionState,
): AutocodeDesignPackageStage[] {
  return STANDARD_DESIGN_OWNER_STAGES.filter((stage) =>
    hasReachedStandardPlanningCheckpoint(
      transaction,
      STANDARD_DESIGN_STAGE_CHECKPOINT[stage],
    )
  );
}

async function getStandardPlanningArtifactHashes(
  specDir: string,
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(STANDARD_PLANNING_TRANSACTION_ARTIFACTS.map(async (fileName) => {
    try {
      const content = await readFile(join(specDir, fileName), 'utf-8');
      return [fileName, createHash('sha256').update(content, 'utf8').digest('hex')] as const;
    } catch {
      return [fileName, null] as const;
    }
  }));
  return Object.fromEntries(entries);
}

async function getStandardPlanningArtifactContents(
  specDir: string,
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(STANDARD_PLANNING_TRANSACTION_ARTIFACTS.map(async (fileName) => {
    try {
      return [fileName, await readFile(join(specDir, fileName), 'utf-8')] as const;
    } catch {
      return [fileName, null] as const;
    }
  }));
  return Object.fromEntries(entries);
}

async function writeStandardPlanningTransaction(
  specDir: string,
  transaction: StandardPlanningTransactionState,
): Promise<void> {
  const filePath = join(specDir, AUTOCODE_TASK_ARTIFACTS.planningTransaction);
  const tempPath = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await writeFile(tempPath, JSON.stringify(transaction, null, 2) + '\n', 'utf-8');
  try {
    await rename(tempPath, filePath);
  } catch {
    await unlink(filePath).catch(() => undefined);
    await rename(tempPath, filePath);
  }
}

async function beginStandardPlanningTransaction(
  specDir: string,
  ownerPlan: StandardPlanningOwnerPlan,
): Promise<StandardPlanningTransactionState> {
  const filePath = join(specDir, AUTOCODE_TASK_ARTIFACTS.planningTransaction);
  const now = new Date().toISOString();
  let previous: StandardPlanningTransactionState | null = null;
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as StandardPlanningTransactionState;
    if (parsed?.version === 1 && parsed.phase === 'planning' && parsed.status !== 'completed') {
      const requestCreatedAtMs = ownerPlan.changeRequestCreatedAt
        ? Date.parse(ownerPlan.changeRequestCreatedAt)
        : Number.NaN;
      const transactionCreatedAtMs = Date.parse(parsed.createdAt);
      const compatibleLegacyRequest = Boolean(
        ownerPlan.changeRequestId &&
        !parsed.changeRequestId &&
        Number.isFinite(requestCreatedAtMs) &&
        Number.isFinite(transactionCreatedAtMs) &&
        transactionCreatedAtMs >= requestCreatedAtMs - 1_000,
      );
      const samePlanningRequest = ownerPlan.changeRequestId
        ? parsed.changeRequestId === ownerPlan.changeRequestId || compatibleLegacyRequest
        : !parsed.changeRequestId;
      if (samePlanningRequest) {
        previous = parsed;
      }
    }
  } catch {
    // A missing or malformed journal starts a new planning transaction.
  }

  const artifactHashes = await getStandardPlanningArtifactHashes(specDir);
  const artifactContents = await getStandardPlanningArtifactContents(specDir);
  const previousCheckpoint = previous?.checkpoint ?? (
    previous && STANDARD_PLANNING_CHECKPOINTS.has(previous.stage) ? previous.stage : undefined
  );
  const transaction: StandardPlanningTransactionState = previous
    ? {
        ...previous,
        status: 'active',
        stage: 'resumed',
        resumedAt: now,
        resumedFromStage: previous.stage,
        checkpoint: previousCheckpoint,
        ...(ownerPlan.changeRequestId
          ? { changeRequestId: ownerPlan.changeRequestId }
          : {}),
        ownerStages: [...ownerPlan.stages],
        updatedAt: now,
        baselineArtifactHashes:
          previous.baselineArtifactHashes ?? previous.artifactHashes ?? artifactHashes,
        baselineArtifacts: previous.baselineArtifacts ?? artifactContents,
        artifactHashes,
      }
    : {
        version: 1,
        id: randomUUID(),
        phase: 'planning',
        status: 'active',
        stage: 'started',
        createdAt: now,
        updatedAt: now,
        ...(ownerPlan.changeRequestId
          ? { changeRequestId: ownerPlan.changeRequestId }
          : {}),
        ownerStages: [...ownerPlan.stages],
        baselineArtifactHashes: artifactHashes,
        baselineArtifacts: artifactContents,
        artifactHashes,
      };
  await writeStandardPlanningTransaction(specDir, transaction);
  return transaction;
}
async function updateStandardPlanningTransaction(
  specDir: string,
  transaction: StandardPlanningTransactionState,
  stage: string,
  status: StandardPlanningTransactionState['status'],
  detail?: string,
): Promise<void> {
  transaction.stage = stage;
  transaction.status = status;
  if (STANDARD_PLANNING_CHECKPOINTS.has(stage)) {
    transaction.checkpoint = stage;
  }
  transaction.updatedAt = new Date().toISOString();
  transaction.artifactHashes = await getStandardPlanningArtifactHashes(specDir);
  if (detail) {
    transaction.detail = detail.replace(/\s+/g, ' ').trim().slice(0, 500);
  } else {
    delete transaction.detail;
  }
  await writeStandardPlanningTransaction(specDir, transaction);
}

function shouldResumeStandardPlanningFromExistingTasks(
  transaction: StandardPlanningTransactionState,
): boolean {
  if (!transaction.resumedAt) {
    return false;
  }
  if (hasReachedStandardPlanningCheckpoint(transaction, 'tasks_validated')) {
    return true;
  }

  const fileName = AUTOCODE_TASK_ARTIFACTS.tasks;
  const currentHash = transaction.artifactHashes[fileName];
  const baselineHash = transaction.baselineArtifactHashes[fileName];
  return currentHash !== null && currentHash !== baselineHash;
}

function hasReachedStandardDesignReviewCheckpoint(
  transaction: StandardPlanningTransactionState,
): boolean {
  return hasReachedStandardPlanningCheckpoint(transaction, 'design_reviewed');
}

function hasReachedStandardDesignValidationCheckpoint(
  transaction: StandardPlanningTransactionState,
): boolean {
  return hasReachedStandardPlanningCheckpoint(transaction, 'design_validated');
}

/** Maps build phases to their agent types */
const PHASE_AGENT_MAP: Record<BuildPhase, AgentType> = {
  planning: 'planner',
  coding: 'coder',
  qa_review: 'qa_reviewer',
  qa_fixing: 'qa_fixer',
} as const;

/** Configuration for the build orchestrator */
export interface BuildOrchestratorConfig {
  /** Spec directory path (e.g., .autocode/specs/001-feature/) */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** Source spec directory in main project (for worktree syncing) */
  sourceSpecDir?: string;
  /** CLI model override */
  cliModel?: string;
  /** CLI thinking level override */
  cliThinking?: string;
  /** App UI language */
  language?: SupportedLanguage;
  /** Maximum iterations (0 = unlimited) */
  maxIterations?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Work item concurrency policy shared by Standard subtasks and Spec work packages. */
  runtimeConcurrency?: AutocodeTaskRuntimeConcurrencyResolved;
  /** Maximum retries per concurrent work item (default: subtask retry limit). */
  maxConcurrentWorkItemRetries?: number;
  /** Workflow optimization configuration */
  workflowConfig?: WorkflowConfig;
  /** Rerun planning from human feedback and return to plan review without coding */
  forcePlanning?: boolean;
  /** Project-specific agent routing profile */
  agentProfile?: ProjectAgentProfile;
  /** Callback to generate the system prompt for a given agent type and phase */
  generatePrompt: (agentType: AgentType, phase: BuildPhase, context: PromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: SessionRunConfig) => Promise<SessionResult>;
  /** Optional callback for syncing spec to source (worktree mode) */
  syncSpecToSource?: (specDir: string, sourceSpecDir: string) => Promise<boolean>;
  /** Optional callback to get a resolved LanguageModel for lightweight repair calls */
  getModel?: (agentType: AgentType) => Promise<import('ai').LanguageModel | undefined>;
  /** Quality improvement configuration */
  qualityConfig?: import('./quality-integration').QualityConfig;
  /** Memory service for storing knowledge */
  memoryService?: import('@autocode/core').MemoryService;
}

/** Context passed to prompt generation */
export interface PromptContext {
  /** Current iteration number */
  iteration: number;
  /** Current subtask (if in coding phase) */
  subtask?: SubtaskInfo;
  /** Planning retry context (if replanning after validation failure) */
  planningRetryContext?: string;
  /** Recovery hints for subtask retries */
  recoveryHints?: string;
  /** Number of previous attempts on current subtask */
  attemptCount: number;
  /** Independent Standard design-package owner currently being generated. */
  designStage?: AutocodeDesignPackageStage;
}

/** Minimal subtask info for prompt generation */
export interface SubtaskInfo {
  id: string;
  description: string;
  phaseName?: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  patternFiles?: string[];
  verification?: string;
  dependsOn?: string[];
  hasFileMetadata?: boolean;
  hasDependencyMetadata?: boolean;
  hasVerificationMetadata?: boolean;
  workPackage?: boolean;
  upstreamTaskIds?: string[];
  upstreamSource?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'stuck';
}

function workItemToSubtaskInfo(workItem: WorkItemInfo): SubtaskInfo {
  return {
    id: workItem.id,
    description: workItem.description,
    phaseName: workItem.phaseName ?? workItem.phaseId,
    filesToCreate: workItem.filesToCreate,
    filesToModify: workItem.filesToModify,
    patternFiles: workItem.patternFiles,
    verification: workItem.verification,
    dependsOn: workItem.dependsOn,
    hasFileMetadata: workItem.hasFileMetadata,
    hasDependencyMetadata: workItem.hasDependencyMetadata,
    hasVerificationMetadata: workItem.hasVerificationMetadata,
    workPackage: workItem.workPackage,
    upstreamTaskIds: workItem.upstreamTaskIds,
    upstreamSource: workItem.upstreamSource,
    status: workItem.status,
  };
}

/** Configuration passed to runSession callback */
export interface SessionRunConfig {
  agentType: AgentType;
  phase: Phase;
  systemPrompt: string;
  specDir: string;
  projectDir: string;
  subtaskId?: string;
  sessionNumber: number;
  abortSignal?: AbortSignal;
  cliModel?: string;
  cliThinking?: string;
  /** Standard design-package owner stage used for a focused kickoff message. */
  specPhase?: AutocodeDesignPackageStage;
  /** Optional Zod schema for structured output (uses AI SDK Output.object()) */
  outputSchema?: import('zod').ZodSchema;
}

/** Events emitted by the build orchestrator */
export interface BuildOrchestratorEvents {
  /** Phase transition */
  'phase-change': (phase: ExecutionPhase, message: string) => void;
  /** Iteration started */
  'iteration-start': (iteration: number, phase: BuildPhase) => void;
  /** Session completed */
  'session-complete': (result: SessionResult, phase: BuildPhase) => void;
  /** Build finished (success or failure) */
  'build-complete': (outcome: BuildOutcome) => void;
  /** Log message */
  'log': (message: string) => void;
  /** Error occurred */
  'error': (error: Error, phase: BuildPhase) => void;
}

/** Final build outcome */
export interface BuildOutcome {
  /** Whether the build succeeded */
  success: boolean;
  /** Final phase reached */
  finalPhase: ExecutionPhase;
  /** Total iterations executed */
  totalIterations: number;
  /** Total duration in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Whether the coding phase completed before failure (indicates QA-phase failure) */
  codingCompleted: boolean;
}

// =============================================================================
// Implementation Plan Types
// =============================================================================

/** Structure of implementation_plan.md */
interface ImplementationPlan {
  feature?: string;
  workflow_type?: string;
  phases: PlanPhase[];
}

function isDocumentationWorkflow(plan: ImplementationPlan | null): boolean {
  const workflowType = plan?.workflow_type?.toLowerCase().trim();
  if (workflowType === 'documentation') {
    return true;
  }

  const feature = plan?.feature?.toLowerCase() ?? '';
  return /\b(documentation|document|docs|markdown|source analysis)\b/i.test(feature) ||
    /(\u6587\u6863|\u6e90\u7801\u5206\u6790|\u4ee3\u7801\u5206\u6790)/.test(feature);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringFrom).filter(Boolean)
    : [];
}

function getSessionStructuredJson(result: SessionResult): unknown {
  if (result.structuredOutput) {
    return result.structuredOutput;
  }

  for (let index = result.messages.length - 1; index >= 0; index--) {
    const message = result.messages[index];
    if (message.role !== 'assistant' || !message.content.trim()) {
      continue;
    }
    const text = message.content.trim();
    const candidates = new Set<string>([text]);
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      if (match[1]?.trim()) {
        candidates.add(match[1].trim());
      }
    }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.add(text.slice(firstBrace, lastBrace + 1));
    }
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next compact JSON candidate.
      }
    }
  }

  return undefined;
}

function isProjectDocumentationTaskMetadata(value: unknown): boolean {
  const metadata = asRecord(value);
  if (!metadata) {
    return false;
  }

  return metadata.sourceType === 'project_docs' ||
    typeof metadata.projectDocumentType === 'string' ||
    typeof metadata.projectDocumentOutputDir === 'string' ||
    Array.isArray(metadata.projectDocumentOutputs);
}

function buildFallbackProjectDocumentationContext(metadata: Record<string, unknown>): Record<string, unknown> {
  const outputDir = stringFrom(metadata.projectDocumentOutputDir) || '.autocode/project-docs';
  const outputs = stringArrayFrom(metadata.projectDocumentOutputs);
  const documentType = stringFrom(metadata.projectDocumentType) || 'full';
  const language = stringFrom(metadata.language) || 'en';
  const supportOutputs = [
    `${outputDir}/doc_outline.md`,
    `${outputDir}/evidence_index.md`,
  ];
  const filesToModify = [...outputs, ...supportOutputs];
  const evidenceSources = [
    'task_metadata.json project documentation metadata',
    'requirements.md project documentation requirements',
    'spec.md project documentation scope',
  ];

  return {
    task_description: stringFrom(metadata.taskTitle) || 'Generate project documentation reference pack',
    workflow_type: 'documentation',
    project_documentation: {
      document_type: documentType,
      language,
      output_dir: outputDir,
      outputs: filesToModify.map((path) => ({ path })),
      future_usage: ['spec-phase-context', 'coding-phase-context'],
    },
    files_to_modify: filesToModify,
    files_to_reference: [
      'README*',
      'package.json',
      'src/**/*',
      'apps/**/*',
      'libs/**/*',
      'docs/**/*',
    ],
    implementation_notes: [
      'Fallback context for a project documentation task.',
      'Documentation generation must cite source files or mark claims as inference.',
    ],
    risks: [
      `Fallback context was generated because ${AUTOCODE_TASK_ARTIFACTS.context} was missing.`,
    ],
    verification_suggestions: [
      `Confirm ${supportOutputs[0]} is structured Markdown.`,
      `Confirm ${supportOutputs[1]} is structured Markdown.`,
      'Confirm generated Markdown cites source/evidence files.',
    ],
    evidence_sources: evidenceSources.map((source) => ({
      path: source,
      proves: source,
      confidence: 'medium',
    })),
    assumptions: [],
    created_at: new Date().toISOString(),
  };
}

interface PlanPhase {
  id?: string;
  phase?: number;
  name: string;
  subtasks: PlanSubtask[];
}

interface PlanSubtask {
  id: string;
  description: string;
  status: string;
  completion_summary?: string;
  completed_at?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  pattern_files?: string[];
  depends_on?: unknown;
  verification?: unknown;
}

// =============================================================================
// BuildOrchestrator
// =============================================================================

/**
 * Orchestrates the full build lifecycle through phase progression.
 *
 * Replaces the Python `run_autonomous_agent()` main loop in `agents/coder.py`.
 * Manages transitions between planning, coding, QA review, and QA fixing phases.
 */
export class BuildOrchestrator extends EventEmitter {
  private config: BuildOrchestratorConfig;
  private currentPhase: ExecutionPhase = 'idle';
  private completedPhases: CompletablePhase[] = [];
  private iteration = 0;
  private aborted = false;
  private qaReturnToCodingCount = 0; // Track QA -> coding returns to prevent infinite loops
  private readonly MAX_QA_RETURNS = 2; // Maximum times we can return from QA to coding
  private readonly codingRecoveryHints = new Map<string, string[]>();

  constructor(config: BuildOrchestratorConfig) {
    super();
    this.config = config;
    this.config.agentProfile ??= GENERAL_AGENT_PROFILE;

    // Apply workflow configuration defaults
    if (!this.config.workflowConfig) {
      this.config.workflowConfig = DEFAULT_WORKFLOW_CONFIG;
    }

    // Listen for abort
    config.abortSignal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  private getCodingRecoveryHints(subtask: SubtaskInfo, attempt: number): string[] {
    if (attempt <= 1) {
      return [];
    }

    return this.codingRecoveryHints.get(subtask.id)?.slice(-3) ?? [];
  }

  private recordCodingAttemptResult(
    subtask: SubtaskInfo,
    result: SessionResult,
    attempt: number,
  ): void {
    if (result.outcome === 'completed') {
      this.codingRecoveryHints.delete(subtask.id);
      return;
    }

    if (result.outcome === 'cancelled') {
      return;
    }

    const hints = this.codingRecoveryHints.get(subtask.id) ?? [];
    hints.push(summarizeAutocodeCodingAttemptFailure(subtask, result, attempt));
    this.codingRecoveryHints.set(subtask.id, hints.slice(-3));
  }

  /**
   * Run the full build lifecycle.
   *
   * Phase progression:
   * 1. Check if implementation_plan.md is missing or non-executable
   *    - Missing/empty/invalid: Run planning phase to create a usable plan
   *    - Valid with subtasks: Skip to coding
   * 2. Run coding phase (iterate subtasks)
   * 3. Run QA review
   * 4. If QA fails: run QA fixing, then re-review
   * 5. Complete or fail
   */
  async run(): Promise<BuildOutcome> {
    const startTime = Date.now();

    try {
      // Missing, malformed, or empty plans must re-enter planning.
      const needsPlanningPhase = await this.shouldRunPlanningPhase();

      if (needsPlanningPhase) {
        // Planning phase
        const planResult = await this.runPlanningPhase();
        if (!planResult.success) {
          return this.buildOutcome(false, Date.now() - startTime, planResult.error);
        }

        // Reset subtask statuses to "pending" after first-run planning: the spec
        // pipeline or planner may have created the plan with pre-set "completed"
        // statuses, which would cause isBuildComplete() to skip coding entirely.
        // Request Changes iteration planning must preserve genuine completed
        // progress and reset only the affected upstream tasks.
        if (this.config.forcePlanning !== true) {
          await this.resetSubtaskStatuses();
        }

        if (this.config.forcePlanning === true) {
          this.emitTyped('log', 'Incremental planning completed from human review feedback; returning to continue affected work packages');
          return this.buildOutcome(true, Date.now() - startTime);
        }
      }

      // Validate and normalize the plan before coding.
      // This is critical when the spec_orchestrator creates the plan (before the
      // build orchestrator runs) — it may omit `status` fields or use alternate
      // field names, causing the subtask iterator to find 0 pending subtasks.
      const preCodingPlan = await loadImplementationPlanFromFiles(this.config.specDir);
      const preCodingValidation = preCodingPlan ? ImplementationPlanSchema.safeParse(preCodingPlan) : null;
      if (!preCodingValidation?.success) {
        const errorDetail = preCodingValidation
          ? preCodingValidation.error.issues.map((issue) => issue.message).join('; ')
          : `${AUTOCODE_TASK_ARTIFACTS.implementationPlan} not found`;
        this.emitTyped('log', `${translateLogMessage('Pre-coding plan validation failed', this.config.language)}: ${errorDetail}`);
        return this.buildOutcome(false, Date.now() - startTime,
          `Implementation plan is invalid and cannot be executed: ${errorDetail}`);
      }
      await saveImplementationPlanToFiles(this.config.specDir, preCodingValidation.data as never);

      const designContractError = await this.validateRuntimeDesignContract(preCodingValidation.data as ImplementationPlan);
      if (designContractError) {
        this.emitTyped('log', `Pre-coding design contract validation failed: ${designContractError}`);
        return this.buildOutcome(false, Date.now() - startTime, designContractError);
      }

      // Check if build is already complete
      if (await this.isBuildComplete()) {
        const completedPlan = await this.loadPlan();
        const skipAIQAReview = this.config.workflowConfig?.skipAIQAReview || isDocumentationWorkflow(completedPlan);
        if (skipAIQAReview) {
          this.markPhaseCompleted('qa_review');
          this.transitionPhase('complete', isDocumentationWorkflow(completedPlan)
            ? 'Build complete - documentation QA skipped'
            : 'Build complete - AI QA skipped by aggressive workflow');
          return this.buildOutcome(true, Date.now() - startTime);
        }

        if (await this.hasPassedQAReport()) {
          this.markPhaseCompleted('qa_review');
          this.transitionPhase('complete', translatePhaseMessage('complete', 'Build already complete', this.config.language));
          return this.buildOutcome(true, Date.now() - startTime);
        }

        this.markPhaseCompleted('coding');
        this.emitTyped('log', translateLogMessage('Build already complete; running QA validation before completion', this.config.language));
        await this.resetQAReport();
        const qaResult = await this.runQAPhase();
        if (!qaResult.resumeCoding) {
          return this.buildOutcome(qaResult.success, Date.now() - startTime, qaResult.error);
        }
      }

      while (true) {
        // Coding phase
        const codingResult = await this.runCodingPhase();
        if (!codingResult.success) {
          return this.buildOutcome(false, Date.now() - startTime, codingResult.error);
        }

        // Safety gate: never enter QA if any subtask is still not completed.
        // Keep the task in coding instead of deadlocking in QA.
        const codingActuallyComplete = await this.isBuildComplete();
        if (!codingActuallyComplete) {
          this.emitTyped('log', translateLogMessage('Detected incomplete subtasks after coding phase - continuing coding', this.config.language));
          continue;
        }

        const completedPlan = await this.loadPlan();
        const skipAIQAReview = this.config.workflowConfig?.skipAIQAReview || isDocumentationWorkflow(completedPlan);
        if (skipAIQAReview) {
          const qualityGate = await this.runPreQAQualityGate();
          if (qualityGate.resumeCoding) {
            continue;
          }
          if (!qualityGate.success) {
            return this.buildOutcome(false, Date.now() - startTime, qualityGate.error);
          }

          this.markPhaseCompleted('qa_review');
          this.transitionPhase('complete', isDocumentationWorkflow(completedPlan)
            ? 'Build complete - documentation QA skipped'
            : 'Build complete - AI QA skipped by aggressive workflow');
          this.emitTyped('log', isDocumentationWorkflow(completedPlan)
            ? 'Documentation workflow: skipped AI QA review after successful document generation and local quality gates'
            : 'Aggressive workflow: skipped AI QA review after successful coding and local quality gates');
          return this.buildOutcome(true, Date.now() - startTime);
        }

        // QA review phase
        const qaResult = await this.runQAPhase();
        if (qaResult.resumeCoding) {
          continue;
        }

        return this.buildOutcome(qaResult.success, Date.now() - startTime, qaResult.error);
      }

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.transitionPhase('failed', `Build failed: ${message}`);
      return this.buildOutcome(false, Date.now() - startTime, message);
    }
  }

  // ===========================================================================
  // Phase Runners
  // ===========================================================================

  private shouldDeriveRuntimePlanFromStandardTasks(): boolean {
    return true;
  }

  private async validateRuntimeDesignContract(plan: ImplementationPlan): Promise<string | undefined> {
    const planRecord = plan as unknown as Record<string, unknown>;
    const sourceTask = asRecord(planRecord.source_task);
    const designContract = asRecord(sourceTask?.design_contract);
    const expectedFingerprint = stringFrom(designContract?.fingerprint);
    if (!expectedFingerprint) {
      // Compatibility: an existing validated Standard plan may finish once;
      // its next replan upgrades it to the latest design contract.
      return undefined;
    }

    const designPackage = await this.readStandardDesignPackageArtifacts();
    const { designMarkdown, designReviewMarkdown } = designPackage;
    if (!designMarkdown) {
      return `${AUTOCODE_TASK_ARTIFACTS.design} is missing for the active runtime plan; return to planning.`;
    }
    const actualFingerprint = Number(designContract?.version) === 4
      ? getAutocodeDesignPackageFingerprint(designPackage)
      : getAutocodeDesignDocumentFingerprint(designMarkdown);
    if (actualFingerprint !== expectedFingerprint) {
      return `The approved design package changed after the runtime plan was derived; return to planning before coding.`;
    }
    if (!designReviewMarkdown || getAutocodeDesignReviewStatus(designReviewMarkdown) !== 'PASSED') {
      return `${AUTOCODE_TASK_ARTIFACTS.designReview} is missing or not PASSED; return to planning before coding.`;
    }
    return undefined;
  }

  private async deriveRuntimePlanFromStandardTasks(
    snapshot?: StandardPlanningArtifactSnapshot,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.shouldDeriveRuntimePlanFromStandardTasks()) {
      return { success: true };
    }

    const tasksPath = join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.tasks);
    try {
      const tasksMarkdown = await readFile(tasksPath, 'utf-8');
      const designPackage = await this.readStandardDesignPackageArtifacts();
      const { designMarkdown } = designPackage;
      if (!designMarkdown) {
        throw new Error(AUTOCODE_TASK_ARTIFACTS.design + ' is missing.');
      }
      const previousPlanMarkdown = this.config.forcePlanning === true
        ? this.getStandardPlanningArtifactSnapshotContent(
            snapshot,
            AUTOCODE_TASK_ARTIFACTS.implementationPlan,
          ) ?? await this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.implementationPlan) ?? undefined
        : undefined;
      const now = new Date().toISOString();
      const plan = buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(tasksMarkdown, {
        now,
        language: this.config.language,
        sourcePath: AUTOCODE_TASK_ARTIFACTS.tasks,
        requireTaskEvidence: true,
        includeCompletedTasks: this.config.forcePlanning === true,
        preserveCompletedStateFromPreviousPlanMarkdown: previousPlanMarkdown,
        designMarkdown,
        requirementModelMarkdown: designPackage.requirementModelMarkdown ?? undefined,
        domainModelMarkdown: designPackage.domainModelMarkdown ?? undefined,
        designModelMarkdown: designPackage.designModelMarkdown ?? undefined,
        implementationModelMarkdown: designPackage.implementationModelMarkdown ?? undefined,
        designPath: AUTOCODE_TASK_ARTIFACTS.design,
      });
      await saveImplementationPlanToFiles(this.config.specDir, plan as never);
      this.emitTyped('log', translateLogMessage('Generated runtime work packages from tasks.md', this.config.language));
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  private async validateStandardPlanArtifactQuality(
    tasksMarkdown?: string,
    snapshot?: StandardPlanningArtifactSnapshot,
  ): Promise<string[]> {
    const [specMarkdown, requirementsMarkdown, rawContextMarkdown, designPackage] = await Promise.all([
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.specFile),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.requirements),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.context),
      this.readStandardDesignPackageArtifacts(),
    ]);
    const contextMarkdown = await this.ensureProjectDocumentationContextArtifact(rawContextMarkdown);
    const result = validateAutocodeStandardPlanArtifacts({
      specMarkdown,
      requirementsMarkdown,
      tasksMarkdown: tasksMarkdown ?? await this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.tasks),
      previousTasksMarkdown: this.getStandardPlanningArtifactSnapshotContent(
        snapshot,
        AUTOCODE_TASK_ARTIFACTS.tasks,
      ),
      previousImplementationPlanMarkdown: this.getStandardPlanningArtifactSnapshotContent(
        snapshot,
        AUTOCODE_TASK_ARTIFACTS.implementationPlan,
      ),
      contextMarkdown,
      ...designPackage,
      language: this.config.language,
      requireSpecEvidence: true,
      requireRequirementsEvidence: true,
      requireTaskEvidence: true,
      requireContextEvidence: Boolean(contextMarkdown),
      requireDesign: true,
    });
    return result.errors;
  }

  private getStandardPlanningArtifactSnapshotContent(
    snapshot: StandardPlanningArtifactSnapshot | undefined,
    fileName: string,
  ): string | null | undefined {
    return snapshot?.artifacts.find((artifact) => artifact.fileName === fileName)?.content;
  }

  private async ensureProjectDocumentationContextArtifact(contextMarkdown: string | null): Promise<string | null> {
    if (contextMarkdown !== undefined && contextMarkdown !== null) {
      return contextMarkdown;
    }

    const metadata = asRecord(await this.readOptionalJsonPlanArtifact(AUTOCODE_TASK_ARTIFACTS.taskMetadata));
    if (!metadata || !isProjectDocumentationTaskMetadata(metadata)) {
      return contextMarkdown;
    }

    const fallbackContext = buildFallbackProjectDocumentationContext(metadata);
    try {
      const fallbackMarkdown = stringifyAutocodeContextMarkdown(fallbackContext);
      await writeFile(
        join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.context),
        fallbackMarkdown,
        'utf-8',
      );
      this.emitTyped('log', `Wrote fallback ${AUTOCODE_TASK_ARTIFACTS.context} for project documentation task`);
      return fallbackMarkdown;
    } catch (error) {
      this.emitTyped('log', `Failed to write fallback project documentation ${AUTOCODE_TASK_ARTIFACTS.context}: ${error}`);
      return contextMarkdown;
    }
  }

  private async readOptionalPlanArtifact(fileName: string): Promise<string | null> {
    try {
      return await readFile(join(this.config.specDir, fileName), 'utf-8');
    } catch {
      return null;
    }
  }

  private async readStandardDesignPackageArtifacts() {
    const [
      designMarkdown,
      requirementModelMarkdown,
      domainModelMarkdown,
      designModelMarkdown,
      implementationModelMarkdown,
      designReviewMarkdown,
    ] = await Promise.all([
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.design),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.requirementModel),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.domainModel),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.designModel),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.implementationModel),
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.designReview),
    ]);
    return {
      designMarkdown,
      requirementModelMarkdown,
      domainModelMarkdown,
      designModelMarkdown,
      implementationModelMarkdown,
      designReviewMarkdown,
    };
  }

  private async captureStandardPlanningArtifactSnapshot(
    transaction?: StandardPlanningTransactionState,
  ): Promise<StandardPlanningArtifactSnapshot> {
    const suffix = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const artifacts = await Promise.all(STANDARD_PLANNING_TRANSACTION_ARTIFACTS.map(async (fileName) => ({
      fileName,
      content: transaction?.baselineArtifacts &&
        Object.hasOwn(transaction.baselineArtifacts, fileName)
        ? transaction.baselineArtifacts[fileName]
        : await this.readOptionalPlanArtifact(fileName),
    })));

    return { suffix, artifacts };
  }

  private async restoreStandardPlanningArtifactSnapshot(
    snapshot: StandardPlanningArtifactSnapshot,
    reason: string,
    options: {
      preserveValidatedRequirements?: boolean;
      preserveValidatedSpec?: boolean;
      preserveValidatedDesign?: boolean;
      preserveValidatedDesignStages?: readonly AutocodeDesignPackageStage[];
      preserveValidatedDesignReview?: boolean;
      preserveValidatedTasks?: boolean;
    } = {},
  ): Promise<void> {
    let restoredCount = 0;
    let savedFailedCount = 0;

    for (const artifact of snapshot.artifacts) {
      if (
        options.preserveValidatedRequirements &&
        artifact.fileName === AUTOCODE_TASK_ARTIFACTS.requirements
      ) {
        continue;
      }
      if (
        options.preserveValidatedSpec &&
        artifact.fileName === AUTOCODE_TASK_ARTIFACTS.specFile
      ) {
        continue;
      }
      const designStage = STANDARD_DESIGN_OWNER_STAGES.find((stage) =>
        STANDARD_DESIGN_STAGE_ARTIFACT[stage] === artifact.fileName
      );
      if (
        designStage &&
        (
          options.preserveValidatedDesign ||
          options.preserveValidatedDesignStages?.includes(designStage) ||
          (designStage === 'design_review' && options.preserveValidatedDesignReview)
        )
      ) {
        continue;
      }
      if (options.preserveValidatedTasks && artifact.fileName === AUTOCODE_TASK_ARTIFACTS.tasks) {
        continue;
      }
      const filePath = join(this.config.specDir, artifact.fileName);
      const currentContent = await this.readOptionalPlanArtifact(artifact.fileName);

      if (currentContent !== null && currentContent !== artifact.content) {
        try {
          await writeFile(
            join(this.config.specDir, `${artifact.fileName}.failed-${snapshot.suffix}`),
            currentContent,
            'utf-8',
          );
          savedFailedCount++;
        } catch (error) {
          this.emitTyped('log', `Failed to save failed Standard planning artifact ${artifact.fileName}: ${error}`);
        }
      }

      if (artifact.content === null) {
        if (currentContent === null) {
          continue;
        }
        try {
          await unlink(filePath);
          restoredCount++;
        } catch {
          // The failed artifact may already be gone; restoration is best-effort.
        }
        continue;
      }

      if (currentContent === artifact.content) {
        continue;
      }

      try {
        await writeFile(filePath, artifact.content, 'utf-8');
        restoredCount++;
      } catch (error) {
        this.emitTyped('log', `Failed to restore Standard planning artifact ${artifact.fileName}: ${error}`);
      }
    }

    if (restoredCount > 0 || savedFailedCount > 0) {
      this.emitTyped(
        'log',
        `Restored previous Standard planning artifacts after failed planning (${reason}); saved ${savedFailedCount} failed artifact(s).`,
      );
    }
  }

  private async readOptionalJsonPlanArtifact(fileName: string): Promise<unknown> {
    const content = await this.readOptionalPlanArtifact(fileName);
    if (!content) {
      return undefined;
    }
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  private async tryCompletePlanningFromExistingStandardArtifacts(
    errorMessage: string,
    allowGranularityWarnings: boolean,
    snapshot?: StandardPlanningArtifactSnapshot,
  ): Promise<{ success: boolean; error?: string }> {
    const artifactQualityErrors = await this.validateStandardPlanArtifactQuality(
      undefined,
      snapshot,
    );
    if (artifactQualityErrors.length > 0) {
      if (allowGranularityWarnings && hasOnlyAutocodePlanTaskGranularityErrors(artifactQualityErrors)) {
        this.emitTyped(
          'log',
          `Planner session failed (${errorMessage}); existing Standard artifacts only have task granularity warnings, continuing with the generated plan.`,
        );
      } else {
        return {
          success: false,
          error: `Existing Standard planning artifacts are not ready after planner session failed: ${artifactQualityErrors.join(', ')}`,
        };
      }
    }

    const derivedPlan = await this.deriveRuntimePlanFromStandardTasks(snapshot);
    if (!derivedPlan.success) {
      return {
        success: false,
        error: `${AUTOCODE_TASK_ARTIFACTS.tasks} is missing or invalid: ${derivedPlan.error}`,
      };
    }

    const finalizedPlan = await this.finalizeDerivedRuntimePlan();
    if (!finalizedPlan.success) {
      return {
        success: false,
        error: `Existing Standard runtime plan validation failed: ${finalizedPlan.errors.join(', ')}`,
      };
    }

    if (artifactQualityErrors.length === 0) {
      this.emitTyped('log', `Planner session failed (${errorMessage}); continued with existing valid Standard artifacts.`);
    }
    return { success: true };
  }

  private async finalizeDerivedRuntimePlan(): Promise<{ success: true } | { success: false; errors: string[] }> {
    const hydratedPlan = await loadImplementationPlanFromFiles(this.config.specDir);
    const parsedPlan = hydratedPlan ? ImplementationPlanSchema.safeParse(hydratedPlan) : null;
    const validation = parsedPlan?.success
      ? { valid: true as const, data: parsedPlan.data, errors: [] as string[] }
      : {
          valid: false as const,
          errors: parsedPlan
            ? parsedPlan.error.issues.map((issue) => issue.message)
            : [`File not found or unreadable: ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}`],
        };
    if (validation.valid) {
      await saveImplementationPlanToFiles(this.config.specDir, validation.data as never);
    }
    const normalizedPlan = validation.valid ? validation.data as ImplementationPlan : null;
    const languageErrors = validation.valid && normalizedPlan
      ? validateImplementationPlanLanguage(normalizedPlan as never, this.config.language)
      : [];
    const executionErrors = validation.valid && !hasExecutableSubtasks(normalizedPlan)
      ? ['Implementation plan has no executable subtasks.']
      : [];
    const schedulingErrors = validation.valid
      ? validatePlanningSchedulingMetadata(normalizedPlan, this.config)
      : [];
    const validationErrors = validation.valid
      ? [
          ...executionErrors,
          ...schedulingErrors,
          ...languageErrors,
        ]
      : [...validation.errors, ...languageErrors];

    if (!validation.valid || validationErrors.length > 0) {
      return { success: false, errors: validationErrors };
    }

    if (this.config.sourceSpecDir && this.config.syncSpecToSource) {
      await this.config.syncSpecToSource(this.config.specDir, this.config.sourceSpecDir);
    }
    this.markPhaseCompleted('planning');
    return { success: true };
  }

  private async resolveStandardPlanningOwnerPlan(): Promise<StandardPlanningOwnerPlan> {
    if (this.config.forcePlanning !== true) {
      return {
        stages: ['design', 'design_review', 'tasks'],
        source: 'initial',
      };
    }

    let changeRequestsMarkdown: string;
    try {
      changeRequestsMarkdown = await readFile(
        join(this.config.specDir, STANDARD_CHANGE_REQUESTS_FILE),
        'utf-8',
      );
    } catch {
      this.emitTyped(
        'log',
        'No change_requests.jsonl owner-stage contract was found; using the legacy design-to-tasks planning flow.',
      );
      return {
        stages: ['design', 'design_review', 'tasks'],
        source: 'legacy_force',
      };
    }

    const ownerPlan = parseAutocodeStandardPlanningOwnerPlan(changeRequestsMarkdown);
    if (ownerPlan) {
      this.emitTyped(
        'log',
        `Incremental Standard planning owner stages: ${ownerPlan.stages.join(' -> ')}`,
      );
      return ownerPlan;
    }

    this.emitTyped(
      'log',
      'change_requests.jsonl has no valid Standard planning entry; using the full owner-stage flow for recovery.',
    );
    return {
      stages: [...STANDARD_PLANNING_OWNER_STAGE_ORDER],
      source: 'invalid_change_request',
    };
  }

  private async validateStandardRequirementsAndSpec(
    includeSpec: boolean,
  ): Promise<string[]> {
    const [requirementsMarkdown, specMarkdown] = await Promise.all([
      this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.requirements),
      includeSpec
        ? this.readOptionalPlanArtifact(AUTOCODE_TASK_ARTIFACTS.specFile)
        : Promise.resolve(null),
    ]);
    const quality = validateAutocodeStandardPlanArtifacts({
      requirementsMarkdown,
      ...(includeSpec ? { specMarkdown } : {}),
      language: this.config.language,
      requireRequirementsEvidence: true,
      requireSpecEvidence: includeSpec,
      requireTaskEvidence: false,
      requireContextEvidence: false,
      requireDesign: false,
    });
    return quality.errors;
  }

  private async runStandardRequirementsOwnerStage(
    transaction: StandardPlanningTransactionState,
    maxRetries: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (hasReachedStandardPlanningCheckpoint(transaction, 'requirements_validated')) {
      this.emitTyped('log', 'Reusing checkpointed requirements.md owner output.');
      return { success: true };
    }

    let retryContext: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.aborted) {
        return { success: false, error: 'Build cancelled' };
      }

      this.iteration++;
      this.emitTyped('iteration-start', this.iteration, 'planning');
      const prompt = await this.config.generatePrompt('spec_gatherer', 'planning', {
        iteration: this.iteration,
        planningRetryContext: retryContext,
        attemptCount: attempt,
      });
      const result = await this.config.runSession({
        agentType: 'spec_gatherer',
        phase: 'planning',
        systemPrompt: prompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.iteration,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
        outputSchema: RequirementsOutputSchema,
      });
      this.emitTyped('session-complete', result, 'planning');

      if (result.outcome === 'cancelled') {
        return { success: false, error: 'Build cancelled' };
      }
      if (result.outcome === 'auth_failure' || result.outcome === 'rate_limited') {
        return {
          success: false,
          error: result.error?.message ?? 'Requirements owner session failed',
        };
      }

      const acceptedOutcome = result.outcome === 'completed' ||
        result.outcome === 'max_steps' ||
        result.outcome === 'context_window';
      const structuredJson = acceptedOutcome ? getSessionStructuredJson(result) : undefined;
      const parsedRequirements = RequirementsOutputSchema.safeParse(structuredJson);
      if (acceptedOutcome && parsedRequirements.success) {
        try {
          await writeFile(
            join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.requirements),
            stringifyAutocodeTaskRequirementsMarkdown(parsedRequirements.data),
            'utf-8',
          );
          const errors = await this.validateStandardRequirementsAndSpec(false);
          if (errors.length === 0) {
            await updateStandardPlanningTransaction(
              this.config.specDir,
              transaction,
              'requirements_validated',
              'active',
            );
            return { success: true };
          }
          retryContext = [
            'REPAIR REQUIREMENTS OWNER OUTPUT',
            ...formatAutocodeRetryErrorLines(errors, { maxCharsPerError: 180 }),
            'Return complete requirements JSON only. Preserve unaffected stable IDs.',
          ].join('\n');
        } catch (error) {
          retryContext = `requirements.md could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        const error = result.error?.message ?? (
          parsedRequirements.success
            ? 'Requirements owner session did not complete.'
            : parsedRequirements.error.issues.map((issue) => issue.message).join('; ')
        );
        retryContext = `Requirements owner output was not valid JSON: ${error}`;
      }

      this.emitTyped(
        'log',
        `Requirements owner stage failed validation (attempt ${attempt + 1}/${maxRetries + 1}); retrying only requirements.md.`,
      );
    }

    return {
      success: false,
      error: `requirements.md owner stage failed after ${maxRetries + 1} attempts: ${retryContext ?? 'unknown error'}`,
    };
  }

  private async runStandardSpecOwnerStage(
    transaction: StandardPlanningTransactionState,
    maxRetries: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (hasReachedStandardPlanningCheckpoint(transaction, 'spec_validated')) {
      this.emitTyped('log', 'Reusing checkpointed spec.md owner output.');
      return { success: true };
    }

    let retryContext: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.aborted) {
        return { success: false, error: 'Build cancelled' };
      }

      this.iteration++;
      this.emitTyped('iteration-start', this.iteration, 'planning');
      const prompt = await this.config.generatePrompt('spec_writer', 'planning', {
        iteration: this.iteration,
        planningRetryContext: retryContext,
        attemptCount: attempt,
      });
      const result = await this.config.runSession({
        agentType: 'spec_writer',
        phase: 'planning',
        systemPrompt: prompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.iteration,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
      });
      this.emitTyped('session-complete', result, 'planning');

      if (result.outcome === 'cancelled') {
        return { success: false, error: 'Build cancelled' };
      }
      if (result.outcome === 'auth_failure' || result.outcome === 'rate_limited') {
        return {
          success: false,
          error: result.error?.message ?? 'Specification owner session failed',
        };
      }

      if (
        result.outcome === 'completed' ||
        result.outcome === 'max_steps' ||
        result.outcome === 'context_window'
      ) {
        const errors = await this.validateStandardRequirementsAndSpec(true);
        if (errors.length === 0) {
          await updateStandardPlanningTransaction(
            this.config.specDir,
            transaction,
            'spec_validated',
            'active',
          );
          return { success: true };
        }
        retryContext = [
          'REPAIR SPECIFICATION OWNER OUTPUT',
          ...formatAutocodeRetryErrorLines(errors, { maxCharsPerError: 180 }),
          'Write only spec.md. Keep observable SCN-* behavior and reference R*/AC*/E* IDs.',
        ].join('\n');
      } else {
        retryContext = result.error?.message ?? 'Specification owner session failed.';
      }

      this.emitTyped(
        'log',
        `Specification owner stage failed validation (attempt ${attempt + 1}/${maxRetries + 1}); retrying only spec.md.`,
      );
    }

    return {
      success: false,
      error: `spec.md owner stage failed after ${maxRetries + 1} attempts: ${retryContext ?? 'unknown error'}`,
    };
  }

  private async validateExistingStandardDesignForTaskPlanning(): Promise<string[]> {
    const designPackage = await this.readStandardDesignPackageArtifacts();
    const quality = validateAutocodeStandardDesignArtifacts({
      ...designPackage,
      language: this.config.language,
      requireReview: true,
      requireTaskReferences: false,
    });
    return quality.errors;
  }

  private async validateStandardDesignOwnerStage(
    stage: AutocodeDesignPackageStage,
  ): Promise<string[]> {
    const designPackage = await this.readStandardDesignPackageArtifacts();
    return validateAutocodeStandardDesignStageArtifacts(
      { ...designPackage, language: this.config.language },
      stage,
    ).errors;
  }

  private async runStandardDesignOwnerStage(
    stage: AutocodeDesignPackageStage,
    planningTransaction: StandardPlanningTransactionState,
    options: {
      forceRun?: boolean;
      retryContext?: string;
      maxRetries?: number;
    } = {},
  ): Promise<{ success: boolean; error?: string; errors?: string[] }> {
    const checkpoint = STANDARD_DESIGN_STAGE_CHECKPOINT[stage];
    if (
      !options.forceRun &&
      hasReachedStandardPlanningCheckpoint(planningTransaction, checkpoint)
    ) {
      const checkpointErrors = await this.validateStandardDesignOwnerStage(stage);
      if (checkpointErrors.length === 0) {
        this.emitTyped('log', `Reusing checkpointed ${stage} owner output.`);
        return { success: true };
      }
      this.emitTyped(
        'log',
        `Checkpointed ${stage} artifact is invalid; rerunning its owner: ${checkpointErrors.join(', ')}`,
      );
    }

    let retryContext = options.retryContext;
    const maxRetries = stage === 'design_review' ? 1 : options.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.aborted) {
        return { success: false, error: 'Build cancelled' };
      }

      this.iteration++;
      this.emitTyped('iteration-start', this.iteration, 'planning');
      const agentType: AgentType = stage === 'design_review'
        ? 'design_critic'
        : 'software_designer';
      if (stage === 'design_review') {
        await unlink(join(this.config.specDir, AUTOCODE_TASK_ARTIFACTS.designReview))
          .catch(() => undefined);
      }
      const systemPrompt = await this.config.generatePrompt(agentType, 'planning', {
        iteration: this.iteration,
        planningRetryContext: retryContext,
        attemptCount: attempt,
        designStage: stage,
      });
      const result = await this.config.runSession({
        agentType,
        phase: 'planning',
        specPhase: stage,
        systemPrompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.iteration,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
      });
      this.emitTyped('session-complete', result, 'planning');

      if (result.outcome === 'cancelled') {
        return { success: false, error: 'Build cancelled' };
      }
      if (result.outcome === 'auth_failure' || result.outcome === 'rate_limited') {
        return {
          success: false,
          error: result.error?.message ?? `${stage} owner session failed`,
        };
      }

      const acceptedOutcome = result.outcome === 'completed' ||
        result.outcome === 'max_steps' ||
        result.outcome === 'context_window';
      if (acceptedOutcome) {
        const errors = await this.validateStandardDesignOwnerStage(stage);
        if (errors.length === 0) {
          await updateStandardPlanningTransaction(
            this.config.specDir,
            planningTransaction,
            checkpoint,
            'active',
          );
          return { success: true };
        }
        if (stage === 'design_review') {
          return {
            success: false,
            error: `Independent design review requested revision: ${errors.join(', ')}`,
            errors,
          };
        }
        retryContext = buildAutocodeDesignQualityRetryPrompt(errors);
        this.emitTyped(
          'log',
          `${stage} owner validation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errors.join(', ')}`,
        );
        continue;
      }

      const error = result.error?.message ?? `${stage} owner session failed`;
      retryContext = buildAutocodeDesignQualityRetryPrompt([error]);
      this.emitTyped(
        'log',
        `${stage} owner session failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error}`,
      );
    }

    return {
      success: false,
      error: `${stage} owner failed deterministic validation after ${maxRetries + 1} attempts.`,
    };
  }

  private async ensureStandardDesignForPlanning(
    planningTransaction: StandardPlanningTransactionState,
    requestedOwnerStages: readonly AutocodeStandardPlanningOwnerStage[] = STANDARD_DESIGN_OWNER_STAGES,
  ): Promise<{ success: boolean; error?: string }> {
    const existingPackage = await this.readStandardDesignPackageArtifacts();
    const existingQuality = validateAutocodeStandardDesignArtifacts({
      ...existingPackage,
      language: this.config.language,
      requireReview: true,
      requireTaskReferences: false,
    });
    const mayReuseReviewedDesign = existingQuality.valid && (
      this.config.forcePlanning !== true ||
      hasReachedStandardDesignReviewCheckpoint(planningTransaction)
    );
    if (mayReuseReviewedDesign) {
      await updateStandardPlanningTransaction(
        this.config.specDir,
        planningTransaction,
        'design_reviewed',
        'active',
      );
      return { success: true };
    }

    const selectedStages = STANDARD_DESIGN_OWNER_STAGES.filter((stage) =>
      requestedOwnerStages.includes(stage)
    );
    let generationStages = selectedStages.filter((stage) => stage !== 'design_review');
    if (generationStages.length === 0 && !selectedStages.includes('design_review')) {
      return {
        success: false,
        error: 'No Standard design owner stage was selected.',
      };
    }
    let retryContext: string | undefined = buildAutocodeDesignQualityRetryPrompt(
      existingQuality.errors,
    );

    for (let revision = 0; revision <= 2; revision++) {
      for (const stage of generationStages) {
        const stageResult = await this.runStandardDesignOwnerStage(
          stage,
          planningTransaction,
          {
            forceRun: revision > 0,
            retryContext,
          },
        );
        if (!stageResult.success) {
          return {
            success: false,
            error: stageResult.error ?? `${stage} owner failed.`,
          };
        }
        retryContext = undefined;
      }

      const reviewResult = await this.runStandardDesignOwnerStage(
        'design_review',
        planningTransaction,
        {
          forceRun: revision > 0 || generationStages.length > 0,
          retryContext,
        },
      );
      if (reviewResult.success) {
        return { success: true };
      }
      if (reviewResult.error === 'Build cancelled') {
        return { success: false, error: reviewResult.error };
      }

      const reviewErrors = reviewResult.errors ?? [reviewResult.error ?? 'Design review failed'];
      generationStages = selectAutocodeDesignRevisionStages(reviewErrors)
        .filter((stage) => stage !== 'design_review');
      retryContext = buildAutocodeDesignQualityRetryPrompt(reviewErrors);
      this.emitTyped(
        'log',
        `Independent design review requested revision ${revision + 1}/2; rerunning: ${generationStages.join(' -> ')}`,
      );
    }

    return {
      success: false,
      error: 'Standard design failed deterministic validation or independent review after two revisions.',
    };
  }

  /**
   * Run the planning phase: invoke planner agent to create upstream tasks.md,
   * then derive implementation_plan.md runtime work packages.
   */
  private async runPlanningPhase(): Promise<{ success: boolean; error?: string }> {
    this.transitionPhase('planning', translatePhaseMessage('planning', 'Creating implementation plan', this.config.language));
    const agentType = this.getAgentForPhase('planning');
    let planningRetryContext: string | undefined;
    let validationFailures = 0;

    // Get retry limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig ?? DEFAULT_WORKFLOW_CONFIG);
    const maxPlanningRetries = retryLimits.planning;
    const ownerPlan = await this.resolveStandardPlanningOwnerPlan();
    const requestedDesignOwnerStages = STANDARD_DESIGN_OWNER_STAGES.filter((stage) =>
      ownerPlan.stages.includes(stage)
    );
    const planningTransaction = await beginStandardPlanningTransaction(
      this.config.specDir,
      ownerPlan,
    );
    const artifactSnapshot = await this.captureStandardPlanningArtifactSnapshot(planningTransaction);
    let validatedRequirements = ownerPlan.stages.includes('requirements') &&
      hasReachedStandardPlanningCheckpoint(planningTransaction, 'requirements_validated');
    let validatedSpec = ownerPlan.stages.includes('spec') &&
      hasReachedStandardPlanningCheckpoint(planningTransaction, 'spec_validated');
    let validatedDesign = requestedDesignOwnerStages.length > 0 &&
      hasReachedStandardPlanningCheckpoint(planningTransaction, 'design_reviewed');
    let validatedTasks = hasReachedStandardPlanningCheckpoint(
      planningTransaction,
      'tasks_validated',
    );
    const completePlanning = async (): Promise<{ success: true }> => {
      delete planningTransaction.baselineArtifacts;
      await updateStandardPlanningTransaction(
        this.config.specDir,
        planningTransaction,
        'committed',
        'completed',
      );
      return { success: true };
    };
    const failPlanning = async (error: string): Promise<{ success: false; error: string }> => {
      const validatedDesignStages = getValidatedStandardDesignStages(planningTransaction);
      await this.restoreStandardPlanningArtifactSnapshot(
        artifactSnapshot,
        error.replace(/\s+/g, ' ').slice(0, 180),
        {
          preserveValidatedRequirements: validatedRequirements,
          preserveValidatedSpec: validatedSpec,
          preserveValidatedDesign: validatedDesign,
          preserveValidatedDesignStages: validatedDesignStages,
          preserveValidatedDesignReview: validatedDesignStages.includes('design_review'),
          preserveValidatedTasks: validatedTasks,
        },
      );
      const hasValidatedCheckpoint = validatedRequirements ||
        validatedSpec ||
        validatedDesignStages.length > 0 ||
        validatedDesign ||
        validatedTasks;
      await updateStandardPlanningTransaction(
        this.config.specDir,
        planningTransaction,
        hasValidatedCheckpoint ? 'repair_required' : 'failed',
        hasValidatedCheckpoint ? 'repair_required' : 'failed',
        error,
      );
      return { success: false, error };
    };

    if (ownerPlan.stages.includes('requirements')) {
      const requirementsResult = await this.runStandardRequirementsOwnerStage(
        planningTransaction,
        maxPlanningRetries,
      );
      if (!requirementsResult.success) {
        return failPlanning(requirementsResult.error ?? 'Standard requirements failed.');
      }
      validatedRequirements = true;
    }

    if (ownerPlan.stages.includes('spec')) {
      const specResult = await this.runStandardSpecOwnerStage(
        planningTransaction,
        maxPlanningRetries,
      );
      if (!specResult.success) {
        return failPlanning(specResult.error ?? 'Standard specification failed.');
      }
      validatedSpec = true;
    }

    if (requestedDesignOwnerStages.length > 0) {
      const designResult = await this.ensureStandardDesignForPlanning(
        planningTransaction,
        requestedDesignOwnerStages,
      );
      if (!designResult.success) {
        return failPlanning(designResult.error ?? 'Standard design failed.');
      }
      validatedDesign = true;
    } else {
      const designErrors = await this.validateExistingStandardDesignForTaskPlanning();
      if (designErrors.length > 0) {
        return failPlanning(
          `tasks-only planning requires an existing approved design contract: ${designErrors.join(', ')}`,
        );
      }
    }

    if (shouldResumeStandardPlanningFromExistingTasks(planningTransaction)) {
      this.emitTyped(
        'log',
        'Resuming interrupted Standard task planning from persisted tasks.md before starting another planner session.',
      );
      const resumedResult = await this.tryCompletePlanningFromExistingStandardArtifacts(
        'interrupted planning recovery',
        true,
        artifactSnapshot,
      );
      if (resumedResult.success) {
        validatedTasks = true;
        await updateStandardPlanningTransaction(
          this.config.specDir,
          planningTransaction,
          'plan_validated',
          'active',
        );
        return completePlanning();
      }
      planningRetryContext = buildAutocodeStandardTasksValidationRetryPrompt([
        resumedResult.error ?? 'Persisted Standard planning artifacts require repair.',
      ]);
      this.emitTyped(
        'log',
        `Persisted Standard planning artifacts require focused repair: ${resumedResult.error ?? 'unknown validation error'}`,
      );
    }

    for (let attempt = 0; attempt < maxPlanningRetries + 1; attempt++) {
      if (this.aborted) {
        return failPlanning('Build cancelled');
      }

      this.iteration++;
      this.emitTyped('iteration-start', this.iteration, 'planning');

      const prompt = await this.config.generatePrompt(agentType, 'planning', {
        iteration: this.iteration,
        planningRetryContext,
        attemptCount: attempt,
      });

      const result = await this.config.runSession({
        agentType,
        phase: 'planning',
        systemPrompt: prompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.iteration,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
      });

      this.emitTyped('session-complete', result, 'planning');

      if (result.outcome === 'cancelled') {
        return failPlanning('Build cancelled');
      }

      if (result.outcome === 'auth_failure' || result.outcome === 'rate_limited') {
        return failPlanning(result.error?.message ?? 'Planning session failed');
      }

      if (result.outcome === 'error') {
        const errorMessage = result.error?.message ?? 'Planning session failed';
        const canUseExistingArtifacts = attempt > 0 || validationFailures > 0;
        const existingArtifactResult = canUseExistingArtifacts
          ? await this.tryCompletePlanningFromExistingStandardArtifacts(
            errorMessage,
            true,
            artifactSnapshot,
          )
          : null;
        if (existingArtifactResult?.success) {
          return completePlanning();
        }
        if (
          attempt < maxPlanningRetries &&
          (isAutocodeWriteToolPlanOutputFailure(errorMessage) ||
            isAutocodeImplementationPlanFileFailure(errorMessage))
        ) {
          planningRetryContext = buildAutocodePlanningStructuredOutputRetryPrompt(errorMessage);
          this.emitTyped('log', 'Planning failed while writing tasks.md; retrying with Markdown guidance...');
          continue;
        }
        if (attempt < maxPlanningRetries) {
          planningRetryContext = buildAutocodeStandardTasksValidationRetryPrompt([
            errorMessage,
            existingArtifactResult?.error ?? '',
          ].filter(Boolean));
          this.emitTyped(
            'log',
            'Planner session failed before tasks.md was validated; retrying only the tasks owner stage.',
          );
          continue;
        }
        return failPlanning(existingArtifactResult?.error
          ? `${errorMessage}; ${existingArtifactResult.error}`
          : errorMessage);
      }

      // If the provider returned structured output via constrained decoding,
      // write it to the plan file — this is guaranteed to match the schema.
      if (result.structuredOutput && !this.shouldDeriveRuntimePlanFromStandardTasks()) {
        try {
          const writeResult = await writeImplementationPlanFiles(this.config.specDir, result.structuredOutput);
          const splitNote = writeResult?.split
            ? ` split into ${writeResult.filesWritten.length - 1} phase files`
            : '';
          this.emitTyped('log', translateLogMessage(`Wrote compact implementation plan from structured output${splitNote}`, this.config.language));
        } catch {
          // Non-fatal — fall through to file-based validation
        }
      }

      const artifactQualityErrors = await this.validateStandardPlanArtifactQuality(
        undefined,
        artifactSnapshot,
      );
      if (artifactQualityErrors.length > 0) {
        validationFailures++;
        this.emitTyped('log', `Standard plan artifact quality failed (attempt ${validationFailures}): ${artifactQualityErrors.join(', ')}`);
        if (validationFailures > maxPlanningRetries) {
          if (hasOnlyAutocodePlanTaskGranularityErrors(artifactQualityErrors)) {
            this.emitTyped(
              'log',
              `Standard plan artifact quality still has task granularity warnings after ${validationFailures} attempts; continuing with the generated plan.`,
            );
          } else {
            return failPlanning(
              `Standard plan artifact quality failed after ${validationFailures} attempts: ${artifactQualityErrors.join(', ')}`,
            );
          }
        } else {
          planningRetryContext = buildAutocodePlanQualityRetryPrompt(artifactQualityErrors);
          continue;
        }
      }

      validatedTasks = true;
      await updateStandardPlanningTransaction(
        this.config.specDir,
        planningTransaction,
        'tasks_validated',
        'active',
      );

      const derivedPlan = await this.deriveRuntimePlanFromStandardTasks(artifactSnapshot);
      if (!derivedPlan.success) {
        const validationErrors = [`${AUTOCODE_TASK_ARTIFACTS.tasks} is missing or invalid: ${derivedPlan.error}`];
        validationFailures++;
        this.emitTyped('log', `Standard planning validation failed (attempt ${validationFailures}): ${validationErrors.join(', ')}`);
        if (validationFailures > maxPlanningRetries) {
          return failPlanning(
            `Standard task planning failed after ${validationFailures} attempts: ${validationErrors.join(', ')}`,
          );
        }
        planningRetryContext = buildAutocodeStandardTasksValidationRetryPrompt(validationErrors);
        continue;
      }

      await updateStandardPlanningTransaction(
        this.config.specDir,
        planningTransaction,
        'plan_derived',
        'active',
      );

      // Validate + normalize the implementation plan using Zod schema.
      // Zod coercion handles LLM field name variations (title→description,
      // subtask_id→id, status normalization, etc.) and writes back canonical data.
      const finalizedPlan = await this.finalizeDerivedRuntimePlan();
      if (finalizedPlan.success) {
        await updateStandardPlanningTransaction(
          this.config.specDir,
          planningTransaction,
          'plan_validated',
          'active',
        );
        return completePlanning();
      }
      const validationErrors = finalizedPlan.errors;

      // Plan is invalid. Default to a full planner retry so complex plans can
      // be rewritten with smaller phase files instead of another large schema output.
      validationFailures++;
      this.emitTyped('log', `Plan validation failed (attempt ${validationFailures}): ${validationErrors.join(', ')}. Retrying with Markdown plan guidance...`);

      // Lightweight repair failed or unavailable — fall back to full re-plan
      if (validationFailures > maxPlanningRetries) {
        return failPlanning(
          `Implementation plan validation failed after ${validationFailures} attempts: ${validationErrors.join(', ')}`,
        );
      }

      // Build retry context for the full re-plan (last resort)
      planningRetryContext = buildAutocodePlanningStructuredOutputValidationRetryPrompt(validationErrors);

      this.emitTyped('log', `Falling back to full re-plan (attempt ${validationFailures + 1})...`);
    }

    return failPlanning('Planning exhausted all retries');
  }

  /**
   * Run the coding phase: iterate through subtasks and invoke coder agent.
   */
  private async runCodingPhase(): Promise<{ success: boolean; error?: string }> {
    this.transitionPhase('coding', translatePhaseMessage('coding', 'Starting implementation', this.config.language));
    const agentType = this.getAgentForPhase('coding');

    // Get retry limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig ?? DEFAULT_WORKFLOW_CONFIG);
    const maxSubtaskRetries = retryLimits.subtask;

    // Build common session runner for both serial and concurrent work item execution.
    const runSubtaskSession = async (
      subtask: SubtaskInfo,
      attempt: number,
      sessionNumber = this.iteration,
    ): Promise<SessionResult> => {
      let preImplementationChecklist = '';
      if (this.config.qualityConfig?.enablePreImplementationChecklist) {
        const {
          generatePreImplementationChecklist,
          formatCompactChecklistForPrompt,
        } = await import('./pre-implementation-checklist');
        const checklistResult = await generatePreImplementationChecklist({
          subtask,
          projectDir: this.config.projectDir,
          specDir: this.config.specDir,
          memoryService: this.config.qualityConfig?.memoryService,
        });
        preImplementationChecklist = formatCompactChecklistForPrompt(checklistResult);

        if (checklistResult.riskLevel === 'critical') {
          this.emitTyped('log', `Pre-implementation checklist shows critical risk for ${subtask.id}`);
        }
      }

      const recoveryHints = this.getCodingRecoveryHints(subtask, attempt);
      let prompt = await this.config.generatePrompt(agentType, 'coding', {
        iteration: sessionNumber,
        subtask,
        attemptCount: attempt,
        recoveryHints: recoveryHints.join('\n'),
      });
      if (recoveryHints.length > 0) {
        prompt = `${prompt}\n\n${formatAutocodeCodingRecoveryHints(subtask.id, recoveryHints)}`;
      }
      if (preImplementationChecklist) {
        prompt = `${prompt}\n\n${preImplementationChecklist}`;
      }

      // Determine quality tier and add standards
      if (this.config.qualityConfig?.enableTieredQualityStandards !== false) {
        const { determineQualityTier, formatTierClassification } = await import('./tiered-quality-standards');
        const tierClassification = determineQualityTier(subtask);
        const tierInfo = formatTierClassification(tierClassification);
        prompt = prompt + '\n\n' + tierInfo;
      }

      // Enhance prompt with pattern injection
      if (this.config.qualityConfig?.enablePatternInjection !== false) {
        const { enhanceCoderPrompt } = await import('./pattern-injection');
        const injectionResult = await enhanceCoderPrompt(prompt, {
          subtask,
          projectDir: this.config.projectDir,
          specDir: this.config.specDir,
          memoryService: this.config.qualityConfig?.memoryService,
        });
        prompt = injectionResult.enhancedPrompt;
      }

      const result = await this.config.runSession({
        agentType,
        phase: 'coding',
        systemPrompt: prompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        subtaskId: subtask.id,
        sessionNumber,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
      });
      this.recordCodingAttemptResult(subtask, result, attempt);
      return result;
    };

    const runtimeConcurrency = this.config.runtimeConcurrency ?? AUTOCODE_DEFAULT_RUNTIME_CONCURRENCY;

    if (runtimeConcurrency.mode === 'concurrent' && runtimeConcurrency.workers > 1) {
      const workConfig: ConcurrentWorkExecutorConfig = {
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sourceSpecDir: this.config.sourceSpecDir,
        maxRetries: this.config.maxConcurrentWorkItemRetries ?? maxSubtaskRetries,
        workers: runtimeConcurrency.workers,
        abortSignal: this.config.abortSignal,
        qualityConfig: this.config.qualityConfig,
        runWorkItemSession: (workItem, attempt, sessionNumber) => {
          return runSubtaskSession(workItemToSubtaskInfo(workItem), attempt, sessionNumber);
        },
        onGroupStart: (items, groupNum, totalGroups, mode) => {
          this.emitTyped('log', `Work group ${groupNum}/${totalGroups}: ${items.length} item(s), ${mode}`);
        },
        onWorkItemStart: (workItem, attempt) => {
          this.iteration++;
          this.emitTyped('iteration-start', this.iteration, 'coding');
          this.emitTyped('log', `Working on ${workItem.id}: ${workItem.description} (attempt ${attempt})`);
          return this.iteration;
        },
        onWorkItemSessionComplete: (_workItem, result) => {
          this.emitTyped('session-complete', result, 'coding');
        },
        onWorkItemQualityFailure: (workItem, result, attempt) => {
          this.recordCodingAttemptResult(workItemToSubtaskInfo(workItem), result, attempt);
        },
        onGroupComplete: (items, result) => {
          this.emitTyped('log', `Work group completed: ${result.completed.length}/${items.length} item(s) succeeded`);
        },
        onLog: (message) => {
          this.emitTyped('log', message);
        },
      };

      const workResult = await executeConcurrentWorkItems(workConfig);

      if (workResult.cancelled) {
        return { success: false, error: 'Build cancelled' };
      }

      if (!workResult.success) {
        return {
          success: false,
          error: workResult.error ?? `Concurrent work execution failed: ${workResult.totalCompleted} completed, ${workResult.totalFailed ?? 0} failed`,
        };
      }

      this.emitTyped('log', `Concurrent work execution completed: ${workResult.totalCompleted} item(s)`);
    } else {
      // Fallback to serial execution (existing behavior)
      const iteratorConfig: SubtaskIteratorConfig = {
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sourceSpecDir: this.config.sourceSpecDir,
        maxRetries: maxSubtaskRetries,
        autoContinueDelayMs: AUTO_CONTINUE_DELAY_MS,
        abortSignal: this.config.abortSignal,
        qualityConfig: this.config.qualityConfig,
        onSubtaskStart: (subtask, attempt) => {
          this.iteration++;
          this.emitTyped('iteration-start', this.iteration, 'coding');
          this.emitTyped('log', `Working on ${subtask.id}: ${subtask.description} (attempt ${attempt})`);
        },
        runSubtaskSession,
        onSubtaskComplete: (_subtask, result) => {
          this.emitTyped('session-complete', result, 'coding');
        },
        onSubtaskStuck: (subtask, reason) => {
          this.emitTyped('log', `Subtask ${subtask.id} stuck: ${reason}`);
        },
      };

      const iteratorResult = await iterateSubtasks(iteratorConfig);

      if (iteratorResult.cancelled) {
        return { success: false, error: 'Build cancelled' };
      }

      // Check if all subtasks are completed
      const allCompleted = iteratorResult.completedSubtasks === iteratorResult.totalSubtasks;
      const hasStuckSubtasks = iteratorResult.stuckSubtasks.length > 0;

      if (!allCompleted) {
        if (hasStuckSubtasks && iteratorResult.completedSubtasks === 0) {
          // All subtasks stuck, none completed
          return {
            success: false,
            error: `All subtasks stuck: ${iteratorResult.stuckSubtasks.join(', ')}`,
          };
        } else if (hasStuckSubtasks) {
          // Some subtasks stuck, some completed
          return {
            success: false,
            error: `${iteratorResult.stuckSubtasks.length} subtask(s) stuck (${iteratorResult.completedSubtasks}/${iteratorResult.totalSubtasks} completed): ${iteratorResult.stuckSubtasks.join(', ')}`,
          };
        } else {
          // Some subtasks not completed (shouldn't happen, but guard against it)
          return {
            success: false,
            error: `Coding incomplete: ${iteratorResult.completedSubtasks}/${iteratorResult.totalSubtasks} subtasks completed`,
          };
        }
      }
    }

    // All subtasks completed successfully
    // Sync after coding
    if (this.config.sourceSpecDir && this.config.syncSpecToSource) {
      await this.config.syncSpecToSource(this.config.specDir, this.config.sourceSpecDir);
    }

    this.markPhaseCompleted('coding');
    return { success: true };
  }

  /**
   * Run QA review and optional QA fixing loop.
   */
  private async runQAPhase(): Promise<{ success: boolean; error?: string; resumeCoding?: boolean }> {
    const qualityGate = await this.runPreQAQualityGate();
    if (!qualityGate.success || qualityGate.resumeCoding) {
      return qualityGate;
    }

    // QA review
    this.transitionPhase('qa_review', 'Running QA review');
    const reviewAgentType = this.getAgentForPhase('qa_review');
    const fixAgentType = this.getAgentForPhase('qa_fixing');

    // Get QA cycle limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig ?? DEFAULT_WORKFLOW_CONFIG);
    const maxQACycles = this.config.maxIterations ?? retryLimits.qa;
    this.emitTyped('log', `Starting QA review loop (max ${maxQACycles} cycles)`);

    for (let cycle = 0; cycle < maxQACycles; cycle++) {
      this.emitTyped('log', `QA cycle ${cycle + 1}/${maxQACycles}`);

      if (this.aborted) {
        return { success: false, error: 'Build cancelled' };
      }

      this.iteration++;
      this.emitTyped('iteration-start', this.iteration, 'qa_review');

      const reviewPrompt = await this.config.generatePrompt(reviewAgentType, 'qa_review', {
        iteration: this.iteration,
        attemptCount: cycle,
      });

      const reviewResult = await this.config.runSession({
        agentType: reviewAgentType,
        phase: 'qa',
        systemPrompt: reviewPrompt,
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sessionNumber: this.iteration,
        abortSignal: this.config.abortSignal,
        cliModel: this.config.cliModel,
        cliThinking: this.config.cliThinking,
      });

      this.emitTyped('session-complete', reviewResult, 'qa_review');

      if (reviewResult.outcome === 'cancelled') {
        return { success: false, error: 'Build cancelled' };
      }

      if (!(await this.isBuildComplete())) {
        return this.resumeCodingFromQA('Detected incomplete subtasks during QA review - returning to coding');
      }

      // Check QA result
      const qaStatus = await this.readQAStatus();
      this.emitTyped('log', `QA cycle ${cycle + 1}/${maxQACycles} result: ${qaStatus}`);

      if (qaStatus === 'passed') {
        this.markPhaseCompleted('qa_review');
        this.transitionPhase('complete', 'Build complete - QA passed');
        this.emitTyped('log', 'QA passed - build complete');
        return { success: true };
      }

      if (qaStatus === 'unknown' && cycle < maxQACycles - 1) {
        this.emitTyped('log', `QA status unknown - retrying reviewer without fixer (cycle ${cycle + 1}/${maxQACycles})`);
        await this.resetQAReport();
        this.transitionPhase('qa_review', 'Re-running QA review for a clear verdict');
        continue;
      }

      if (qaStatus === 'failed' && cycle < maxQACycles - 1) {
        this.emitTyped('log', `QA ${qaStatus} - running fixer (cycle ${cycle + 1}/${maxQACycles})`);
        // Run QA fixer — mark qa_review completed BEFORE transitioning to qa_fixing
        // (the phase protocol requires qa_review in completedPhases for the transition)
        this.markPhaseCompleted('qa_review');
        this.transitionPhase('qa_fixing', 'Fixing QA issues');

        this.iteration++;
        this.emitTyped('iteration-start', this.iteration, 'qa_fixing');

        const fixPrompt = await this.config.generatePrompt(fixAgentType, 'qa_fixing', {
          iteration: this.iteration,
          attemptCount: cycle,
        });

        const fixResult = await this.config.runSession({
          agentType: fixAgentType,
          phase: 'qa',
          systemPrompt: fixPrompt,
          specDir: this.config.specDir,
          projectDir: this.config.projectDir,
          sessionNumber: this.iteration,
          abortSignal: this.config.abortSignal,
          cliModel: this.config.cliModel,
          cliThinking: this.config.cliThinking,
        });

        this.emitTyped('session-complete', fixResult, 'qa_fixing');

        if (!(await this.isBuildComplete())) {
          return this.resumeCodingFromQA('Detected incomplete subtasks after QA fixes - returning to coding');
        }

        this.markPhaseCompleted('qa_fixing');

        // Delete qa_report.md before re-review so the reviewer writes a clean verdict.
        // The fixer often edits qa_report.md (changing status to "FIXES_APPLIED" etc.)
        // which corrupts the verdict detection. Deleting ensures a fresh report each cycle.
        await this.resetQAReport();

        // Loop back to QA review
        this.transitionPhase('qa_review', 'Re-running QA review after fixes');
        continue;
      }

      // QA failed and no more cycles
      this.emitTyped('log', `QA ${qaStatus} on final cycle ${cycle + 1}/${maxQACycles} - build failed`);
      this.transitionPhase('failed', 'QA review failed after maximum fix cycles');
      return { success: false, error: 'QA review failed after maximum fix cycles' };
    }

    this.emitTyped('log', 'QA loop exhausted all cycles without resolution');
    return { success: false, error: 'QA exhausted all cycles' };
  }

  private async runPreQAQualityGate(): Promise<{ success: boolean; error?: string; resumeCoding?: boolean }> {
    if (!(await this.isBuildComplete())) {
      return this.resumeCodingFromQA('Detected incomplete subtasks before QA review - returning to coding');
    }

    // Run pre-QA quality checks (integrated)
    this.emitTyped('log', translateLogMessage('Running pre-QA quality checks...', this.config.language));
    const { runPreQAQualityChecks } = await import('./quality-integration');

    const preQAResult = await runPreQAQualityChecks(
      this.config.qualityConfig || {},
      this.config.projectDir,
      this.config.specDir,
    );

    // If critical issues found, return to coding (with limit to prevent infinite loops)
    if (!preQAResult.shouldProceedToQA) {
      if (this.qaReturnToCodingCount >= this.MAX_QA_RETURNS) {
        this.emitTyped('log', `Pre-QA checks failed ${this.MAX_QA_RETURNS} times. Proceeding to QA anyway to get detailed feedback.`);
        // Reset counter and proceed to QA
        this.qaReturnToCodingCount = 0;
      } else {
        this.qaReturnToCodingCount++;
        return this.resumeCodingFromQA(
          formatPreQAReturnToCodingReason(
            preQAResult.issues,
            this.qaReturnToCodingCount,
            this.MAX_QA_RETURNS,
          ),
        );
      }
    } else {
      // Reset counter on success
      this.qaReturnToCodingCount = 0;
    }

    return { success: true };
  }

  // ===========================================================================
  // Phase Transition
  // ===========================================================================

  /**
   * Transition to a new execution phase with validation.
   */
  private transitionPhase(phase: ExecutionPhase, message: string): void {
    if (isTerminalPhase(this.currentPhase) && !isTerminalPhase(phase)) {
      return; // Cannot leave terminal phase
    }

    if (!isValidPhaseTransition(this.currentPhase, phase, this.completedPhases)) {
      this.emitTyped('log', `Blocked phase transition: ${this.currentPhase} -> ${phase}`);
      return;
    }

    this.currentPhase = phase;
    this.emitTyped('phase-change', phase, message);
  }

  /**
   * Mark a build phase as completed.
   */
  private markPhaseCompleted(phase: CompletablePhase): void {
    if (!this.completedPhases.includes(phase)) {
      this.completedPhases.push(phase);
    }
  }

  // ===========================================================================
  // Plan Validation
  // ===========================================================================

  // normalizeSubtaskIds() REMOVED — replaced by Zod schema coercion in
  // ImplementationPlanSchema handles:
  // - subtask_id → id, task_id → id
  // - title → description, name → description
  // - phase_id → id
  // - file_paths → files_to_modify
  // - Status normalization (done→completed, todo→pending, etc.)
  // - Missing status defaults to "pending"

  /**
   * Reset all subtask statuses to "pending" after initial planning.
   *
   * Some LLMs (particularly non-Anthropic models) create implementation plans
   * with subtasks pre-set to "completed". Since no coding has happened yet,
   * all statuses must be "pending" for the coding phase to execute.
   */
  private async resetSubtaskStatuses(): Promise<void> {
    try {
      const plan = await loadImplementationPlanFromFiles(this.config.specDir) as ImplementationPlan | null;
      if (!plan) return;
      let updated = false;

      for (const phase of plan.phases) {
        if (!Array.isArray(phase.subtasks)) continue;
        for (const subtask of phase.subtasks) {
          if (subtask.status !== 'pending') {
            subtask.status = 'pending';
            updated = true;
          }
          if (subtask.completion_summary !== undefined) {
            delete subtask.completion_summary;
            updated = true;
          }
          if (subtask.completed_at !== undefined) {
            delete subtask.completed_at;
            updated = true;
          }
        }
      }

      if (updated) {
        await saveImplementationPlanToFiles(this.config.specDir, plan as never);
        this.emitTyped('log', 'Reset all subtask statuses to "pending" after planning');
      }
    } catch {
      // Non-fatal: validation will catch any plan issues
    }
  }

  // validateImplementationPlan() REMOVED — replaced by Zod schema validation
  // via parsing implementation_plan.md and validating with ImplementationPlanSchema.
  // The Zod schema provides:
  // - Structural validation (required fields, types, array shapes)
  // - Coercion of LLM field name variations (title→description, etc.)
  // - Status enum validation with normalization (done→completed, etc.)
  // - Human-readable error messages for LLM retry feedback

  // ===========================================================================
  // State Queries
  // ===========================================================================

  /**
   * Check whether the build must enter planning before coding can start.
   * Missing, malformed, or empty plans are treated as needing planning.
   */
  private async loadPlan(): Promise<ImplementationPlan | null> {
    return loadImplementationPlanFromFiles(this.config.specDir) as Promise<ImplementationPlan | null>;
  }

  private async shouldRunPlanningPhase(): Promise<boolean> {
    try {
      if (this.config.forcePlanning === true) {
        this.emitTyped('log', 'Force planning requested; running incremental implementation planning before coding');
        return true;
      }

      if (this.config.workflowConfig?.optimizationLevel === 'aggressive') {
        const plan = await loadImplementationPlanFromFiles(this.config.specDir) as ImplementationPlan | null;
        const validation = plan ? ImplementationPlanSchema.safeParse(plan) : null;
        if (validation?.success && hasExecutableSubtasks(validation.data as ImplementationPlan)) {
          await saveImplementationPlanToFiles(this.config.specDir, validation.data as never);
          this.emitTyped('log', 'Aggressive workflow: using existing quick implementation plan and skipping planner session');
          return false;
        }
      }

      const plan = await loadImplementationPlanFromFiles(this.config.specDir) as ImplementationPlan | null;
      if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
        return true;
      }

      const hasSubtasks = plan.phases.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0);
      if (!hasSubtasks) {
        return true;
      }

      const validation = ImplementationPlanSchema.safeParse(plan);
      if (!validation.success) {
        const validationErrors = validation.error.issues
          .map((issue) => issue.message)
          .filter(Boolean);
        this.emitTyped(
          'log',
          `Existing implementation plan is invalid; regenerating plan: ${validationErrors.slice(0, 4).join(', ') || 'schema validation failed'}`,
        );
        return true;
      }

      const schedulingErrors = validatePlanningSchedulingMetadata(validation.data as ImplementationPlan, this.config);
      if (schedulingErrors.length > 0) {
        this.emitTyped('log', `Existing plan is missing scheduling metadata; regenerating plan: ${schedulingErrors.slice(0, 4).join(', ')}`);
        return true;
      }

      return false;
    } catch {
      return true;
    }
  }

  /**
   * Check if all subtasks in the implementation plan are completed.
   */
  private async isBuildComplete(): Promise<boolean> {
    try {
      const plan = await loadImplementationPlanFromFiles(this.config.specDir) as ImplementationPlan | null;
      if (!plan) return false;

      for (const phase of plan.phases) {
        for (const subtask of phase.subtasks) {
          if (!hasSubtaskCompletionEvidence(subtask)) {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read QA status from the spec directory.
   * Returns 'passed', 'failed', or 'unknown'.
   */
  private async hasPassedQAReport(): Promise<boolean> {
    const qaReportPath = join(this.config.specDir, 'qa_report.md');
    try {
      const content = await readFile(qaReportPath, 'utf-8');
      if (getAutocodeQaReportStatus(content) !== 'passed') {
        return false;
      }
      const qualityIssues = this.validateQAReportQuality(content, qaReportPath);
      if (qualityIssues.length > 0) {
        this.emitTyped('log', `Existing QA report has a pass verdict but is incomplete: ${qualityIssues.slice(0, 3).join('; ')}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async readQAStatus(): Promise<'passed' | 'failed' | 'unknown'> {
    const qaReportPath = join(this.config.specDir, 'qa_report.md');
    try {
      const content = await readFile(qaReportPath, 'utf-8');
      const status = getAutocodeQaReportStatus(content);

      if (status === 'passed' || status === 'failed') {
        const qualityIssues = this.validateQAReportQuality(content, qaReportPath);
        if (qualityIssues.length > 0) {
          this.emitTyped('log', `QA status: UNKNOWN (report verdict is ${status} but quality is incomplete: ${qualityIssues.slice(0, 4).join('; ')})`);
          return 'unknown';
        }
      }

      if (status === 'passed') {
        this.emitTyped('log', 'QA status: PASSED');
        return 'passed';
      }

      // Explicitly detect failure patterns so intermediate states don't short-circuit.
      // The QA fixer may write "FIXES_APPLIED" — that's an intermediate state that
      // should NOT count as a verdict. Only the reviewer writes the final verdict.
      if (status === 'failed') {
        this.emitTyped('log', 'QA status: FAILED');
        return 'failed';
      }

      // If the report has content but no recognizable verdict, treat as unknown
      // so the orchestrator can retry rather than permanently failing.
      if (content.trim().length > 0) {
        this.emitTyped('log', `QA status: UNKNOWN (report exists but no clear verdict). First 200 chars: ${content.substring(0, 200)}`);
        return 'unknown';
      }

      this.emitTyped('log', 'QA status: UNKNOWN (empty report)');
      return 'unknown';
    } catch (error) {
      this.emitTyped('log', `QA status: UNKNOWN (error reading report: ${error instanceof Error ? error.message : String(error)})`);
      return 'unknown';
    }
  }

  private validateQAReportQuality(content: string, qaReportPath: string): string[] {
    return validateAutocodeQaReportQuality(content, qaReportPath, {
      isGameMmo: this.getAgentForPhase('qa_review') === 'mmo_qa_reviewer' ||
        this.config.qualityConfig?.projectType === 'game-mmo',
    });
  }

  /**
   * Delete qa_report.md so the next QA review cycle writes a fresh verdict.
   * The QA fixer often edits qa_report.md (adding "FIXES_APPLIED" etc.),
   * which corrupts verdict detection. Resetting ensures clean state.
   */
  private async resetQAReport(): Promise<void> {
    const qaReportPath = join(this.config.specDir, 'qa_report.md');
    try {
      await unlink(qaReportPath);
    } catch {
      // File may not exist — that's fine
    }
  }

  /**
   * Return control from QA back to coding when QA detects unfinished work.
   */
  private async resumeCodingFromQA(
    message: string,
  ): Promise<{ success: false; resumeCoding: true }> {
    this.emitTyped('log', message);
    await this.resetQAReport();

    if (this.currentPhase !== 'coding') {
      this.transitionPhase('coding', message);
    }

    return { success: false, resumeCoding: true };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getAgentForPhase(phase: BuildPhase): AgentType {
    const profile = this.config.agentProfile ?? GENERAL_AGENT_PROFILE;
    switch (phase) {
      case 'planning':
        return profile.planning;
      case 'coding':
        return profile.coding;
      case 'qa_review':
        return profile.qaReview;
      case 'qa_fixing':
        return profile.qaFix;
      default:
        return PHASE_AGENT_MAP[phase];
    }
  }

  private buildOutcome(success: boolean, durationMs: number, error?: string): BuildOutcome {
    const outcome: BuildOutcome = {
      success,
      finalPhase: this.currentPhase,
      totalIterations: this.iteration,
      durationMs,
      error,
      codingCompleted: this.completedPhases.includes('coding'),
    };

    if (!success && !isTerminalPhase(this.currentPhase)) {
      this.transitionPhase('failed', error ?? 'Build failed');
    }

    this.emitTyped('build-complete', outcome);
    return outcome;
  }

  /**
   * Typed event emitter helper.
   */
  private emitTyped<K extends keyof BuildOrchestratorEvents>(
    event: K,
    ...args: Parameters<BuildOrchestratorEvents[K]>
  ): void {
    this.emit(event, ...args);
  }
}
