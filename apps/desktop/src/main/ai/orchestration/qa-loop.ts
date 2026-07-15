/**
 * QA Validation Loop
 * ==================
 *
 * See apps/desktop/src/main/ai/orchestration/qa-loop.ts for the TypeScript implementation.
 *
 * Coordinates the QA review/fix iteration cycle:
 *   1. QA Reviewer agent validates the build
 *   2. If rejected 鈫?QA Fixer agent applies fixes
 *   3. Loop back to reviewer
 *   4. Repeat until approved, max iterations, or escalation
 *
 * Enhanced with:
 * - Recurring issue detection (escalate after threshold)
 * - Consecutive error tracking (escalate after MAX_CONSECUTIVE_ERRORS)
 * - Human feedback processing (QA_FIX_REQUEST.md)
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import {
  generateEscalationReport,
  generateManualTestPlan,
  generateQAReport,
} from './qa-reports';

import type { AgentType } from '../config/agent-configs';
import { GENERAL_AGENT_PROFILE, type ProjectAgentProfile } from '../config/project-agent-profile';
import {
  loadAutocodeImplementationPlan,
  updateAutocodeImplementationPlan,
  type Phase,
} from '@autocode/core';
import { QASignoffSchema, validateStructuredOutput } from '../schema';
import type { SessionResult } from '../session/types';
import { compactHeadTailSingleLineText } from './prompt-compaction';

// =============================================================================
// Constants
// =============================================================================

/** Maximum QA review/fix iterations before escalating to human */
const MAX_QA_ITERATIONS = 50;

/** Stop after this many consecutive errors without progress */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Number of times an issue must recur before escalation */
const RECURRING_ISSUE_THRESHOLD = 3;
const QA_HISTORY_MAX_ISSUES_PER_ITERATION = 8;
const QA_ISSUE_TITLE_MAX_CHARS = 180;
const QA_ISSUE_LOCATION_MAX_CHARS = 220;
const QA_ISSUE_DESCRIPTION_MAX_CHARS = 420;
const QA_ISSUE_FIX_MAX_CHARS = 420;

// =============================================================================
// Types
// =============================================================================

/** QA signoff status from implementation_plan.md */
type QAStatus = 'approved' | 'rejected' | 'fixes_applied' | 'unknown';

/** A single QA issue found during review */
export interface QAIssue {
  type?: 'critical' | 'warning';
  title: string;
  description?: string;
  location?: string;
  fix_required?: string;
}

/** Record of a single QA iteration */
export interface QAIterationRecord {
  iteration: number;
  status: 'approved' | 'rejected' | 'error';
  issues: QAIssue[];
  durationMs: number;
  timestamp: string;
}

/** Configuration for the QA loop */
export interface QALoopConfig {
  /** Spec directory path */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** CLI model override */
  cliModel?: string;
  /** CLI thinking level override */
  cliThinking?: string;
  /** Maximum iterations override (default: MAX_QA_ITERATIONS) */
  maxIterations?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Project-specific agent routing profile */
  agentProfile?: ProjectAgentProfile;
  /** Callback to generate system prompt */
  generatePrompt: (agentType: AgentType, context: QAPromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: QASessionRunConfig) => Promise<SessionResult>;
}

/** Context passed to prompt generation */
export interface QAPromptContext {
  /** Current iteration number */
  iteration: number;
  /** Max iterations allowed */
  maxIterations: number;
  /** Whether processing human feedback */
  isHumanFeedback?: boolean;
  /** Previous error context for self-correction */
  previousError?: QAErrorContext;
}

/** Error context for self-correction feedback */
interface QAErrorContext {
  errorType: string;
  errorMessage: string;
  consecutiveErrors: number;
  expectedAction: string;
}

/** Configuration passed to runSession callback */
export interface QASessionRunConfig {
  agentType: AgentType;
  phase: Phase;
  systemPrompt: string;
  specDir: string;
  projectDir: string;
  sessionNumber: number;
  abortSignal?: AbortSignal;
  cliModel?: string;
  cliThinking?: string;
}

/** Events emitted by the QA loop */
export interface QALoopEvents {
  /** QA iteration started */
  'qa-iteration-start': (iteration: number, maxIterations: number) => void;
  /** QA review completed */
  'qa-review-complete': (iteration: number, status: QAStatus, issues: QAIssue[]) => void;
  /** QA fixer started */
  'qa-fix-start': (iteration: number) => void;
  /** QA fixer completed */
  'qa-fix-complete': (iteration: number) => void;
  /** QA loop finished */
  'qa-complete': (outcome: QAOutcome) => void;
  /** Log message */
  'log': (message: string) => void;
  /** Error during QA */
  'error': (error: Error) => void;
}

/** Final QA outcome */
export interface QAOutcome {
  /** Whether QA approved the build */
  approved: boolean;
  /** Total iterations executed */
  totalIterations: number;
  /** Duration in ms */
  durationMs: number;
  /** Reason if not approved */
  reason?: 'max_iterations' | 'recurring_issues' | 'consecutive_errors' | 'cancelled' | 'error';
  /** Error message if failed */
  error?: string;
}

/** QA signoff structure from implementation_plan.md */
interface QASignoff {
  status: string;
  qa_session?: number;
  tests_passed?: Record<string, string>;
  issues_found?: QAIssue[];
}

// =============================================================================
// QALoop
// =============================================================================

/**
 * Orchestrates the QA validation loop: review 鈫?fix 鈫?re-review.
 *
 * Replaces the Python `run_qa_validation_loop()` from `qa/loop.py`.
 */
export class QALoop extends EventEmitter {
  private config: QALoopConfig;
  private sessionNumber = 0;
  private aborted = false;
  private iterationHistory: QAIterationRecord[] = [];

  constructor(config: QALoopConfig) {
    super();
    this.config = config;
    this.config.agentProfile ??= GENERAL_AGENT_PROFILE;

    config.abortSignal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  /**
   * Run the full QA validation loop.
   *
   * @returns QAOutcome indicating whether the build was approved
   */
  async run(): Promise<QAOutcome> {
    const startTime = Date.now();
    const maxIterations = this.config.maxIterations ?? MAX_QA_ITERATIONS;

    try {
      // Verify build is complete
      const buildComplete = await this.isBuildComplete();
      if (!buildComplete) {
        this.emitTyped('log', 'Build is not complete, cannot run QA validation');
        return this.outcome(false, 0, Date.now() - startTime, 'error', 'Build not complete');
      }

      // Check if already approved (unless human feedback pending)
      const hasHumanFeedback = await this.hasHumanFeedback();
      if (!hasHumanFeedback) {
        const currentStatus = await this.readQASignoff();
        if (currentStatus?.status === 'approved') {
          this.emitTyped('log', 'Build already approved by QA');
          return this.outcome(true, 0, Date.now() - startTime);
        }
      }

      // Process human feedback first if present
      if (hasHumanFeedback) {
        await this.processHumanFeedback();
      }

      // Main QA loop
      let consecutiveErrors = 0;
      let lastErrorContext: QAErrorContext | undefined;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (this.aborted) {
          return this.outcome(false, iteration - 1, Date.now() - startTime, 'cancelled');
        }

        const iterationStart = Date.now();
        this.emitTyped('qa-iteration-start', iteration, maxIterations);

        // Run QA reviewer
        this.sessionNumber++;
        const reviewAgentType = this.getReviewAgentType();
        const reviewPrompt = await this.config.generatePrompt(reviewAgentType, {
          iteration,
          maxIterations,
          previousError: lastErrorContext,
        });

        const reviewResult = await this.config.runSession({
          agentType: reviewAgentType,
          phase: 'qa',
          systemPrompt: reviewPrompt,
          specDir: this.config.specDir,
          projectDir: this.config.projectDir,
          sessionNumber: this.sessionNumber,
          abortSignal: this.config.abortSignal,
          cliModel: this.config.cliModel,
          cliThinking: this.config.cliThinking,
        });

        if (reviewResult.outcome === 'cancelled') {
          return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
        }

        // Read QA signoff from implementation_plan.md
        const signoff = await this.readQASignoff();
        const status = this.resolveQAStatus(signoff);
        const issues = signoff?.issues_found ?? [];
        const iterationDuration = Date.now() - iterationStart;

        this.emitTyped('qa-review-complete', iteration, status, issues);

        if (status === 'approved') {
          await this.recordIteration(iteration, 'approved', [], iterationDuration);
          await this.writeReports('approved');
          return this.outcome(true, iteration, Date.now() - startTime);
        }

        if (status === 'rejected') {
          consecutiveErrors = 0;
          lastErrorContext = undefined;
          await this.recordIteration(iteration, 'rejected', issues, iterationDuration);

          // Check for recurring issues
          if (this.hasRecurringIssues(issues)) {
            this.emitTyped('log', 'Recurring issues detected - escalating to human review');
            const recurringIssues = this.getRecurringIssues(issues);
            try {
              const escalationReport = generateEscalationReport(this.iterationHistory, recurringIssues);
              await writeFile(join(this.config.specDir, 'QA_ESCALATION.md'), escalationReport, 'utf-8');
            } catch {
              // Non-fatal
            }
            await this.writeReports('escalated');
            return this.outcome(false, iteration, Date.now() - startTime, 'recurring_issues');
          }

          if (iteration >= maxIterations) {
            break; // Max iterations reached
          }

          // Run QA fixer
          this.emitTyped('qa-fix-start', iteration);
          this.sessionNumber++;
          const fixAgentType = this.getFixAgentType();

          const fixPrompt = await this.config.generatePrompt(fixAgentType, {
            iteration,
            maxIterations,
          });

          const fixResult = await this.config.runSession({
            agentType: fixAgentType,
            phase: 'qa',
            systemPrompt: fixPrompt,
            specDir: this.config.specDir,
            projectDir: this.config.projectDir,
            sessionNumber: this.sessionNumber,
            abortSignal: this.config.abortSignal,
            cliModel: this.config.cliModel,
            cliThinking: this.config.cliThinking,
          });

          if (fixResult.outcome === 'cancelled') {
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
          }

          if (fixResult.outcome === 'error' || fixResult.outcome === 'auth_failure') {
            this.emitTyped('log', `Fixer error: ${fixResult.error?.message ?? 'unknown'}`);
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'error', fixResult.error?.message);
          }

          this.emitTyped('qa-fix-complete', iteration);
          this.emitTyped('log', 'Fixes applied, re-running QA validation...');
          continue;
        }

        // status === 'unknown' 鈥?QA agent didn't update implementation_plan.md
        consecutiveErrors++;
        const errorMsg = 'QA agent did not record a QA status in implementation_plan.md';
        await this.recordIteration(iteration, 'error', [{ title: 'QA error', description: errorMsg }], iterationDuration);

        lastErrorContext = {
          errorType: 'missing_implementation_plan_update',
          errorMessage: errorMsg,
          consecutiveErrors,
          expectedAction: 'Call mcp__autocode__update_qa_status with status: approved or rejected',
        };

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.emitTyped('log', `${MAX_CONSECUTIVE_ERRORS} consecutive errors - escalating to human`);
          await this.writeReports('max_iterations');
          return this.outcome(false, iteration, Date.now() - startTime, 'consecutive_errors');
        }

        this.emitTyped('log', `QA error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), retrying with error feedback...`);
      }

      // Max iterations reached
      await this.writeReports('max_iterations');
      return this.outcome(false, maxIterations, Date.now() - startTime, 'max_iterations');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.outcome(false, 0, Date.now() - startTime, 'error', message);
    }
  }

  // ===========================================================================
  // Status Reading
  // ===========================================================================

  /**
   * Read QA signoff from implementation_plan.md.
   */
  private async readQASignoff(): Promise<QASignoff | null> {
    try {
      const plan = await loadAutocodeImplementationPlan(this.config.specDir) as { qa_signoff?: unknown } | null;
      if (!plan) return null;
      const qa_signoff = plan.qa_signoff;
      if (!qa_signoff) return null;
      const result = validateStructuredOutput(qa_signoff, QASignoffSchema);
      return result.valid && result.data ? (result.data as QASignoff) : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve QA status from signoff data.
   */
  private resolveQAStatus(signoff: QASignoff | null): QAStatus {
    if (!signoff) return 'unknown';
    const status = signoff.status?.toLowerCase();
    if (status === 'approved' || status === 'passed') return 'approved';
    if (status === 'rejected' || status === 'failed' || status === 'issues') return 'rejected';
    if (status === 'fixes_applied') return 'fixes_applied';
    return 'unknown';
  }

  /**
   * Check if all subtasks in the build are completed.
   */
  private async isBuildComplete(): Promise<boolean> {
    try {
      const plan = await loadAutocodeImplementationPlan(this.config.specDir) as { phases?: Array<{ subtasks: Array<{ status: string }> }> } | null;

      if (!plan || !plan.phases) return false;

      for (const phase of plan.phases) {
        for (const subtask of phase.subtasks) {
          if (subtask.status !== 'completed') return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Human Feedback
  // ===========================================================================

  /**
   * Check if human feedback file exists.
   */
  private async hasHumanFeedback(): Promise<boolean> {
    try {
      await readFile(join(this.config.specDir, 'QA_FIX_REQUEST.md'), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Process human feedback by running the fixer agent first.
   */
  private async processHumanFeedback(): Promise<void> {
    this.emitTyped('log', 'Human feedback detected - running QA Fixer first');
    this.emitTyped('qa-fix-start', 0);
    this.sessionNumber++;
    const fixAgentType = this.getFixAgentType();

    const fixPrompt = await this.config.generatePrompt(fixAgentType, {
      iteration: 0,
      maxIterations: this.config.maxIterations ?? MAX_QA_ITERATIONS,
      isHumanFeedback: true,
    });

    const result = await this.config.runSession({
      agentType: fixAgentType,
      phase: 'qa',
      systemPrompt: fixPrompt,
      specDir: this.config.specDir,
      projectDir: this.config.projectDir,
      sessionNumber: this.sessionNumber,
      abortSignal: this.config.abortSignal,
      cliModel: this.config.cliModel,
      cliThinking: this.config.cliThinking,
    });

    // Remove fix request file unless transient error
    if (result.outcome !== 'rate_limited' && result.outcome !== 'auth_failure') {
      try {
        await unlink(join(this.config.specDir, 'QA_FIX_REQUEST.md'));
      } catch {
        // Ignore removal failure
      }
    }

    this.emitTyped('qa-fix-complete', 0);
  }

  // ===========================================================================
  // Recurring Issue Detection
  // ===========================================================================

  /**
   * Check if current issues are recurring (appeared RECURRING_ISSUE_THRESHOLD+ times).
   */
  private hasRecurringIssues(currentIssues: QAIssue[]): boolean {
    if (currentIssues.length === 0) return false;

    // Count occurrences of each issue title across history
    const titleCounts = new Map<string, number>();
    for (const record of this.iterationHistory) {
      for (const issue of record.issues) {
        const title = issue.title.toLowerCase().trim();
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }
    }

    // Check if any current issue exceeds threshold
    for (const issue of currentIssues) {
      const title = issue.title.toLowerCase().trim();
      const count = (titleCounts.get(title) ?? 0) + 1; // +1 for current occurrence
      if (count >= RECURRING_ISSUE_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  /**
   * Record an iteration in the history and persist it to implementation_plan.md.
   */
  private async recordIteration(
    iteration: number,
    status: 'approved' | 'rejected' | 'error',
    issues: QAIssue[],
    durationMs: number,
  ): Promise<void> {
    const record: QAIterationRecord = {
      iteration,
      status,
      issues,
      durationMs,
      timestamp: new Date().toISOString(),
    };

    this.iterationHistory.push(record);

    // Persist to implementation_plan.md
    try {
      await updateAutocodeImplementationPlan(this.config.specDir, (currentPlan) => {
        const plan = currentPlan as {
          qa_iteration_history?: QAIterationRecord[];
          qa_signoff?: QASignoff;
          qa_stats?: Record<string, unknown>;
        };

        if (!plan.qa_iteration_history) {
          plan.qa_iteration_history = [];
        }
        plan.qa_iteration_history.push(compactQAIterationRecord(record));

        if (plan.qa_signoff && typeof plan.qa_signoff === 'object' && !Array.isArray(plan.qa_signoff)) {
          const qaSignoff = plan.qa_signoff as QASignoff;
          if (Array.isArray(qaSignoff.issues_found)) {
            qaSignoff.issues_found = compactQAIssuesForPlan(qaSignoff.issues_found);
          }
        }

        // Update summary stats
        plan.qa_stats = {
          total_iterations: plan.qa_iteration_history.length,
          last_iteration: iteration,
          last_status: status,
        };

        return currentPlan;
      });
    } catch {
      // Non-fatal 鈥?iteration is still tracked in memory
    }
  }

  /**
   * Collect issues that are considered "recurring" from history.
   */
  private getRecurringIssues(currentIssues: QAIssue[]): QAIssue[] {
    const recurring: QAIssue[] = [];
    const titleCounts = new Map<string, number>();

    for (const record of this.iterationHistory) {
      for (const issue of record.issues) {
        const key = issue.title.toLowerCase().trim();
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
      }
    }

    for (const issue of currentIssues) {
      const key = issue.title.toLowerCase().trim();
      const count = (titleCounts.get(key) ?? 0) + 1;
      if (count >= RECURRING_ISSUE_THRESHOLD) {
        recurring.push(issue);
      }
    }

    return recurring;
  }

  /**
   * Write all QA reports to disk at the end of the loop.
   */
  private async writeReports(finalStatus: 'approved' | 'escalated' | 'max_iterations'): Promise<void> {
    const specDir = this.config.specDir;
    const projectDir = this.config.projectDir;

    try {
      const qaReport = generateQAReport(this.iterationHistory, finalStatus);
      await writeFile(join(specDir, 'qa_report.md'), qaReport, 'utf-8');
    } catch {
      // Non-fatal
    }

    try {
      const manualTestPlan = await generateManualTestPlan(specDir, projectDir);
      await writeFile(join(specDir, 'MANUAL_TEST_PLAN.md'), manualTestPlan, 'utf-8');
    } catch {
      // Non-fatal
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getReviewAgentType(): AgentType {
    return (this.config.agentProfile ?? GENERAL_AGENT_PROFILE).qaReview;
  }

  private getFixAgentType(): AgentType {
    return (this.config.agentProfile ?? GENERAL_AGENT_PROFILE).qaFix;
  }

  private outcome(
    approved: boolean,
    totalIterations: number,
    durationMs: number,
    reason?: QAOutcome['reason'],
    error?: string,
  ): QAOutcome {
    const outcome: QAOutcome = {
      approved,
      totalIterations,
      durationMs,
      reason: approved ? undefined : reason,
      error,
    };

    this.emitTyped('qa-complete', outcome);
    return outcome;
  }

  /**
   * Typed event emitter helper.
   */
  private emitTyped<K extends keyof QALoopEvents>(
    event: K,
    ...args: Parameters<QALoopEvents[K]>
  ): void {
    this.emit(event, ...args);
  }
}

function compactQAIterationRecord(record: QAIterationRecord): QAIterationRecord {
  return {
    ...record,
    issues: compactQAIssuesForPlan(record.issues),
  };
}

function compactQAIssuesForPlan(issues: QAIssue[]): QAIssue[] {
  const visible = issues.slice(0, QA_HISTORY_MAX_ISSUES_PER_ITERATION).map(compactQAIssueForPlan);
  const omitted = issues.length - visible.length;
  if (omitted > 0) {
    visible.push({
      type: 'warning',
      title: `... ${omitted} more QA issue(s) omitted from plan history`,
      description: 'Read qa_report.md or rerun QA for full details if needed.',
    });
  }
  return visible;
}

function compactQAIssueForPlan(issue: QAIssue): QAIssue {
  return {
    ...(issue.type ? { type: issue.type } : {}),
    title: compactSingleLine(issue.title, QA_ISSUE_TITLE_MAX_CHARS),
    ...(issue.location ? { location: compactSingleLine(issue.location, QA_ISSUE_LOCATION_MAX_CHARS) } : {}),
    ...(issue.description ? { description: compactSingleLine(issue.description, QA_ISSUE_DESCRIPTION_MAX_CHARS) } : {}),
    ...(issue.fix_required ? { fix_required: compactSingleLine(issue.fix_required, QA_ISSUE_FIX_MAX_CHARS) } : {}),
  };
}

function compactSingleLine(value: string, maxChars: number): string {
  return compactHeadTailSingleLineText(value, maxChars);
}
