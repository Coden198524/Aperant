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

import { readFile, unlink } from 'node:fs/promises';
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
import { AUTOCODE_TASK_ARTIFACTS, type AutocodeTaskRuntimeConcurrencyResolved, type Phase } from '@autocode/core';
import type { SupportedLanguage } from '../../../shared/constants/i18n';
import {
  ImplementationPlanSchema,
  validateImplementationPlanLanguage,
  IMPLEMENTATION_PLAN_SCHEMA_HINT,
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

/** Maximum planning validation retries before failing (configurable via WorkflowConfig) */
const MAX_PLANNING_VALIDATION_RETRIES = 2; // Reduced from 3 to 2

/** Maximum retries for a single subtask before marking stuck (configurable via WorkflowConfig) */
const MAX_SUBTASK_RETRIES = 2; // Reduced from 3 to 2

/** Delay before retrying after an error (ms) */
const ERROR_RETRY_DELAY_MS = 5_000;

const DEFAULT_RUNTIME_CONCURRENCY: AutocodeTaskRuntimeConcurrencyResolved = {
  mode: 'serial',
  workers: 1,
  unit: 'work_item',
  conflictPolicy: 'lock-and-queue',
};

function isWriteToolPlanOutputFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("tool 'write'") &&
    (lower.includes(AUTOCODE_TASK_ARTIFACTS.implementationPlan) ||
      lower.includes('input json failed') ||
      lower.includes('json parsing failed') ||
      lower.includes('invalid input') ||
      lower.includes('received invalid input type'));
}

function isImplementationPlanFileFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes(AUTOCODE_TASK_ARTIFACTS.implementationPlan);
}

function hasExecutableSubtasks(plan: ImplementationPlan | null): boolean {
  return plan?.phases?.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0) ?? false;
}

function hasSubtaskCompletionEvidence(subtask: PlanSubtask): boolean {
  if (subtask.status === 'completed') {
    return true;
  }

  if (typeof subtask.completed_at === 'string' && subtask.completed_at.trim().length > 0) {
    return true;
  }

  return typeof subtask.completion_summary === 'string' &&
    subtask.completion_summary.trim().length > 0;
}

function buildPlanningStructuredOutputRetryPrompt(errorMessage: string): string {
  return [
    'RETRY IMPLEMENTATION PLAN WRITE',
    '',
    `Previous Write call failed before execution: ${errorMessage}`,
    '',
    `Retry by writing ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with the Write tool.`,
    'Write checklist Markdown, not JSON. Each Write input is one object with file_path and content.',
    'Use forward slashes in file_path.',
    'Use "- [ ] 1. Phase title" and "- [ ] 1.1 Subtask title" with _Files_, _Depends on_, _Requirements_, and _Verification_.',
    'Normal tasks should target 4 phases or fewer and about 24 subtasks or fewer.',
    'For complex tasks, keep necessary subtasks concise in the single Markdown file.',
    'Omit top-level summary, verification_strategy, qa_acceptance, research notes, copied source, and long analysis.',
  ].join('\n');
}

function buildPlanningStructuredOutputValidationRetryPrompt(errors: string[]): string {
  return [
    'REWRITE IMPLEMENTATION PLAN',
    '',
    'The previous implementation plan was missing or invalid.',
    '',
    'Errors:',
    ...errors.map((error) => `- ${error}`),
    '',
    IMPLEMENTATION_PLAN_SCHEMA_HINT,
    '',
    'Retry with the Write tool; do not paste the full plan into the final response.',
    'Use forward slashes in file_path.',
    `Rewrite ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as checklist Markdown with task markers such as "- [ ] 2.1 Title".`,
    'Normal tasks should target 4 phases or fewer and about 24 subtasks or fewer.',
    'For complex tasks, keep descriptions concise instead of splitting files.',
    'Omit top-level summary, verification_strategy, qa_acceptance, research notes, copied source, and long analysis.',
  ].join('\n');
}

// =============================================================================
// Types
// =============================================================================

/** Build phase mapped to agent type */
type BuildPhase = 'planning' | 'coding' | 'qa_review' | 'qa_fixing';

/** Maps build phases to their agent types */
const PHASE_AGENT_MAP: Record<BuildPhase, AgentType> = {
  planning: 'planner',
  coding: 'coder',
  qa_review: 'qa_reviewer',
  qa_fixing: 'qa_fixer',
} as const;

/** Maps build phases to config phase keys */
const PHASE_CONFIG_MAP: Record<BuildPhase, Phase> = {
  planning: 'planning',
  coding: 'coding',
  qa_review: 'qa',
  qa_fixing: 'qa',
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
  memoryService?: import('../memory/memory-service').MemoryServiceImpl;
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
  workPackage?: boolean;
  upstreamTaskIds?: string[];
  upstreamSource?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'stuck';
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

        // Reset subtask statuses to "pending" after first-run planning — the spec
        // pipeline or planner may have created the plan with pre-set "completed"
        // statuses, which would cause isBuildComplete() to skip coding entirely.
        // Only after replanning: resumed builds with an existing executable plan
        // must preserve genuine progress.
        await this.resetSubtaskStatuses();

        if (this.config.forcePlanning === true) {
          this.emitTyped('log', 'Plan regenerated from human review feedback; waiting for plan approval');
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

      // Check if build is already complete
      if (await this.isBuildComplete()) {
        this.transitionPhase('complete', translatePhaseMessage('complete', 'Build already complete', this.config.language));
        return this.buildOutcome(true, Date.now() - startTime);
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

  /**
   * Run the planning phase: invoke planner agent to create implementation_plan.md.
   */
  private async runPlanningPhase(): Promise<{ success: boolean; error?: string }> {
    this.transitionPhase('planning', translatePhaseMessage('planning', 'Creating implementation plan', this.config.language));
    const agentType = this.getAgentForPhase('planning');
    let planningRetryContext: string | undefined;
    let validationFailures = 0;

    // Get retry limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig!);
    const maxPlanningRetries = retryLimits.planning;

    for (let attempt = 0; attempt < maxPlanningRetries + 1; attempt++) {
      if (this.aborted) {
        return { success: false, error: 'Build cancelled' };
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
        return { success: false, error: 'Build cancelled' };
      }

      if (result.outcome === 'auth_failure' || result.outcome === 'rate_limited') {
        return { success: false, error: result.error?.message ?? 'Planning session failed' };
      }

      if (result.outcome === 'error') {
        const errorMessage = result.error?.message ?? 'Planning session failed';
        if (attempt < maxPlanningRetries && (isWriteToolPlanOutputFailure(errorMessage) || isImplementationPlanFileFailure(errorMessage))) {
          planningRetryContext = buildPlanningStructuredOutputRetryPrompt(errorMessage);
          this.emitTyped('log', 'Planning failed while writing implementation plan; retrying with Markdown guidance...');
          continue;
        }
        return { success: false, error: errorMessage };
      }

      // If the provider returned structured output via constrained decoding,
      // write it to the plan file — this is guaranteed to match the schema.
      if (result.structuredOutput) {
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

      // Validate + normalize the implementation plan using Zod schema.
      // Zod coercion handles LLM field name variations (title→description,
      // subtask_id→id, status normalization, etc.) and writes back canonical data.
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
      const validationErrors = validation.valid
        ? [
            ...executionErrors,
            ...languageErrors,
          ]
        : [...validation.errors, ...languageErrors];

      if (validation.valid && validationErrors.length === 0) {
        // Sync to source if in worktree mode
        if (this.config.sourceSpecDir && this.config.syncSpecToSource) {
          await this.config.syncSpecToSource(this.config.specDir, this.config.sourceSpecDir);
        }
        this.markPhaseCompleted('planning');
        return { success: true };
      }

      // Plan is invalid. Default to a full planner retry so complex plans can
      // be rewritten with smaller phase files instead of another large schema output.
      validationFailures++;
      this.emitTyped('log', `Plan validation failed (attempt ${validationFailures}): ${validationErrors.join(', ')}. Retrying with Markdown plan guidance...`);

      // Lightweight repair failed or unavailable — fall back to full re-plan
      if (validationFailures >= maxPlanningRetries) {
        return {
          success: false,
          error: `Implementation plan validation failed after ${validationFailures} attempts: ${validationErrors.join(', ')}`,
        };
      }

      // Build retry context for the full re-plan (last resort)
      planningRetryContext = buildPlanningStructuredOutputValidationRetryPrompt(validationErrors);

      this.emitTyped('log', `Falling back to full re-plan (attempt ${validationFailures + 1})...`);
    }

    return { success: false, error: 'Planning exhausted all retries' };
  }

  /**
   * Run the coding phase: iterate through subtasks and invoke coder agent.
   */
  private async runCodingPhase(): Promise<{ success: boolean; error?: string }> {
    this.transitionPhase('coding', translatePhaseMessage('coding', 'Starting implementation', this.config.language));
    const agentType = this.getAgentForPhase('coding');

    // Get retry limit from workflow config
    const retryLimits = getRetryLimits(this.config.workflowConfig!);
    const maxSubtaskRetries = retryLimits.subtask;

    // Build common session runner for both serial and concurrent work item execution.
    const runSubtaskSession = async (
      subtask: SubtaskInfo,
      attempt: number,
      sessionNumber = this.iteration,
    ): Promise<SessionResult> => {
      // Run pre-implementation checklist if enabled
      if (this.config.qualityConfig?.enablePreImplementationChecklist) {
        const { generatePreImplementationChecklist } = await import('./pre-implementation-checklist');
        const checklistResult = await generatePreImplementationChecklist({
          subtask,
          projectDir: this.config.projectDir,
          specDir: this.config.specDir,
        });

        if (checklistResult.riskLevel === 'critical') {
          this.emitTyped('log', `Pre-implementation checklist shows critical risk for ${subtask.id}`);
        }
      }

      let prompt = await this.config.generatePrompt(agentType, 'coding', {
        iteration: sessionNumber,
        subtask,
        attemptCount: attempt,
      });

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
        });
        prompt = injectionResult.enhancedPrompt;
      }

      return this.config.runSession({
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
    };

    const runtimeConcurrency = this.config.runtimeConcurrency ?? DEFAULT_RUNTIME_CONCURRENCY;

    if (runtimeConcurrency.mode === 'concurrent' && runtimeConcurrency.workers > 1) {
      const workConfig: ConcurrentWorkExecutorConfig = {
        specDir: this.config.specDir,
        projectDir: this.config.projectDir,
        sourceSpecDir: this.config.sourceSpecDir,
        maxRetries: this.config.maxConcurrentWorkItemRetries ?? maxSubtaskRetries,
        workers: runtimeConcurrency.workers,
        abortSignal: this.config.abortSignal,
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
        onSubtaskStart: (subtask, attempt) => {
          this.iteration++;
          this.emitTyped('iteration-start', this.iteration, 'coding');
          this.emitTyped('log', `Working on ${subtask.id}: ${subtask.description} (attempt ${attempt})`);
        },
        runSubtaskSession,
        onSubtaskComplete: (subtask, result) => {
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
    const retryLimits = getRetryLimits(this.config.workflowConfig!);
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

      if ((qaStatus === 'failed' || qaStatus === 'unknown') && cycle < maxQACycles - 1) {
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
        const issuesSummary = preQAResult.issues.join('; ');
        return this.resumeCodingFromQA(
          `Pre-QA quality checks failed (attempt ${this.qaReturnToCodingCount}/${this.MAX_QA_RETURNS}) - ${issuesSummary}. Fix these issues before QA review.`
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
        this.emitTyped('log', 'Force planning requested; regenerating implementation plan before coding');
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

      return !plan.phases.some((phase) => Array.isArray(phase.subtasks) && phase.subtasks.length > 0);
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
  private async readQAStatus(): Promise<'passed' | 'failed' | 'unknown'> {
    const qaReportPath = join(this.config.specDir, 'qa_report.md');
    try {
      const content = await readFile(qaReportPath, 'utf-8');
      const lower = content.toLowerCase();

      if (lower.includes('status: passed') || lower.includes('status: approved')) {
        this.emitTyped('log', 'QA status: PASSED');
        return 'passed';
      }

      // Explicitly detect failure patterns so intermediate states don't short-circuit.
      // The QA fixer may write "FIXES_APPLIED" — that's an intermediate state that
      // should NOT count as a verdict. Only the reviewer writes the final verdict.
      if (
        lower.includes('status: failed') ||
        lower.includes('status: rejected') ||
        lower.includes('status: needs changes')
      ) {
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
