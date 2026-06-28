/**
 * Quality Improvements Integration
 * =================================
 *
 * Central integration point for all quality improvement features.
 * Automatically applies appropriate quality checks and enhancements
 * based on configuration.
 */

import type { SubtaskInfo } from './build-orchestrator';
import type { SessionResult } from '../session/types';
import type { MemoryService } from '@autocode/core';
import type { ProjectType } from '../../../shared/types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactAutocodeRetryLine, loadAutocodeImplementationPlanSync } from '@autocode/core';
import {
  AUTOCODE_DEFAULT_QUALITY_CONFIG,
  createAutocodeQualityConfig,
  getAutocodeDocumentationOutputs,
  getAutocodeEnabledQualityFeatures,
  getDefaultAutocodeQualityConfig,
  hasAutocodeQualityFeaturesEnabled,
  isAutocodeGameMmoDocumentationPlan,
  validateAutocodeCodingSummary,
  validateAutocodeDocumentationEvidenceIndex,
  validateAutocodeDocumentationMarkdown,
  validateAutocodeGameMmoCodingSummary,
  validateAutocodeGameMmoDocumentationSupportContent,
  validateAutocodeMarkdownSupportDocument,
} from '@autocode/core/runtime/agent-quality-integration';

// Import all quality improvement modules
import { runPreQASmokeTests, formatSmokeTestResults } from './pre-qa-smoke-tests';
import { runIncrementalValidation, formatValidationResults } from './incremental-validation';
import { enhanceCoderPrompt, shouldInjectPatterns, formatInjectionSummary } from './pattern-injection';
import { generatePreImplementationChecklist, formatCompactChecklistForPrompt, formatChecklistSummary } from './pre-implementation-checklist';
import { runSelfCritique, formatCritiqueSummary } from './self-critique';
import { analyzeFailureAndRecover, formatFailureAnalysis, formatRecoverySummary, type FailureRecord } from './context-aware-recovery';
import { extractAndStoreKnowledge, formatKnowledgeSummary } from './active-memory-learning';
import { determineQualityTier, formatTierClassification, formatTierSummary, getQAChecksForTier } from './tiered-quality-standards';

// =============================================================================
// Types
// =============================================================================

export interface QualityConfig {
  /** Enable pre-QA smoke tests */
  enablePreQASmokeTests?: boolean;
  /** Enable incremental validation */
  enableIncrementalValidation?: boolean;
  /** Enable pattern injection */
  enablePatternInjection?: boolean;
  /** Enable pre-implementation checklist */
  enablePreImplementationChecklist?: boolean;
  /** Enable self-critique */
  enableSelfCritique?: boolean;
  /** Enable context-aware recovery */
  enableContextAwareRecovery?: boolean;
  /** Enable active memory learning */
  enableActiveMemoryLearning?: boolean;
  /** Enable tiered quality standards */
  enableTieredQualityStandards?: boolean;
  /** Enable local documentation quality checks for documentation-only workflows */
  enableDocumentationQualityGate?: boolean;
  /** Project type used by specialized quality gates */
  projectType?: ProjectType;
  /** Memory service for learning and pattern retrieval */
  memoryService?: MemoryService;
  /** Project ID for memory scoping */
  projectId?: string;
}

// Default configuration - Standard/Spec balanced optimization with lightweight quality gates.
// This aligns with the BALANCED_PRESET from workflow-config.ts
const DEFAULT_CONFIG: Required<Omit<QualityConfig, 'memoryService' | 'projectId' | 'projectType'>> = {
  ...AUTOCODE_DEFAULT_QUALITY_CONFIG,
};

export const QUALITY_SESSION_SUMMARY_MAX_CHARS = 6_000;
// Keep single validation failures large enough to preserve actionable test
// assertion details while still bounding retry prompt growth.
export const QUALITY_ISSUE_MAX_CHARS = 1_600;

// =============================================================================
// Main Integration Functions
// =============================================================================

/**
 * Enhance coder prompt with all applicable quality improvements.
 *
 * @param basePrompt - Original coder prompt
 * @param subtask - Subtask information
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @param failureHistory - History of failed attempts (for recovery)
 * @returns Enhanced prompt
 */
export async function enhancePromptWithQuality(
  basePrompt: string,
  subtask: SubtaskInfo,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
  failureHistory?: FailureRecord[],
): Promise<string> {
  let enhancedPrompt = basePrompt;
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  // 1. Determine quality tier (if enabled)
  if (appliedConfig.enableTieredQualityStandards) {
    const tierClassification = determineQualityTier(subtask);
    console.log(formatTierSummary(tierClassification));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatTierClassification(tierClassification);
  }

  // 2. Add pre-implementation checklist (if enabled and first attempt)
  if (appliedConfig.enablePreImplementationChecklist && (!failureHistory || failureHistory.length === 0)) {
    const checklist = await generatePreImplementationChecklist({
      subtask,
      specDir,
      projectDir,
      memoryService: config.memoryService,
    });
    console.log(formatChecklistSummary(checklist));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatCompactChecklistForPrompt(checklist);
  }

  // 3. Add context-aware recovery (if enabled and has failures)
  if (appliedConfig.enableContextAwareRecovery && failureHistory && failureHistory.length > 0) {
    const analysis = await analyzeFailureAndRecover(
      subtask,
      failureHistory,
      projectDir,
      specDir,
    );
    console.log(formatRecoverySummary(analysis));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatFailureAnalysis(analysis);
  }

  // 4. Inject patterns (if enabled and pattern files exist)
  if (appliedConfig.enablePatternInjection && shouldInjectPatterns(subtask)) {
    const injectionResult = await enhanceCoderPrompt(enhancedPrompt, {
      subtask: {
        id: subtask.id,
        description: subtask.description,
        filesToModify: subtask.filesToModify,
        patternFiles: subtask.patternFiles,
      },
      projectDir,
      specDir,
      memoryService: config.memoryService,
    });
    console.log(formatInjectionSummary(injectionResult));
    enhancedPrompt = injectionResult.enhancedPrompt;
  }

  return enhancedPrompt;
}

/**
 * Validate subtask result with all applicable quality checks.
 *
 * @param subtask - Subtask information
 * @param sessionResult - Session result
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Validation result
 */
export async function validateSubtaskQuality(
  subtask: SubtaskInfo,
  sessionResult: SessionResult,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
  changedFiles?: string[],
): Promise<{
  passed: boolean;
  issues: string[];
  incrementalValidation?: import('./incremental-validation').IncrementalValidationResult;
}> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };
  const issues: string[] = [];
  let incrementalValidation: import('./incremental-validation').IncrementalValidationResult | undefined;

  // Only validate if session completed successfully
  if (sessionResult.outcome !== 'completed') {
    return { passed: true, issues: [] };
  }

  // 1. Run incremental validation (if enabled)
  if (appliedConfig.enableIncrementalValidation) {
    const validationResult = await runIncrementalValidation({
      subtaskId: subtask.id,
      filesModified: changedFiles && changedFiles.length > 0
        ? changedFiles
        : subtask.filesToModify || [],
      patternFiles: subtask.patternFiles,
      projectDir,
      specDir,
    });
    incrementalValidation = validationResult;

    console.log(formatValidationResults(validationResult));

    if (!validationResult.passed) {
      const criticalFailures = validationResult.failures.filter(f => f.severity === 'error');
      issues.push(...criticalFailures.map(f => compactQualityIssue(`${f.type}: ${f.message}`)));
    }
  }

  // 2. Run self-critique (if enabled)
  // Note: This would require access to generated files, which we don't have here
  // Self-critique should be run within the agent session itself
  const summary = compactQualitySessionSummary(sessionResult.messages);
  issues.push(...validateAutocodeCodingSummary(subtask, summary));
  if (appliedConfig.projectType === 'game-mmo') {
    issues.push(...validateAutocodeGameMmoCodingSummary(subtask, summary));
  }

  return {
    passed: issues.length === 0,
    issues,
    incrementalValidation,
  };
}

/**
 * Run pre-QA quality checks.
 *
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Whether checks passed and should proceed to QA
 */
export async function runPreQAQualityChecks(
  config: QualityConfig,
  projectDir: string,
  specDir: string,
): Promise<{ shouldProceedToQA: boolean; issues: string[] }> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  if (appliedConfig.enableDocumentationQualityGate) {
    const documentationResult = runDocumentationQualityGate(projectDir, specDir, appliedConfig.projectType);
    if (documentationResult.isDocumentationWorkflow && documentationResult.issues.length > 0) {
      return {
        shouldProceedToQA: false,
        issues: documentationResult.issues,
      };
    }
  }

  // Run pre-QA smoke tests (if enabled)
  if (appliedConfig.enablePreQASmokeTests) {
    const smokeTestResult = await runPreQASmokeTests(projectDir, specDir);
    console.log(formatSmokeTestResults(smokeTestResult));

    if (smokeTestResult.shouldReturnToCoding) {
      const criticalIssues = smokeTestResult.issues
        .filter(i => i.severity === 'critical')
        .map(i => compactQualityIssue(`${i.check}: ${i.output.split('\n')[0]}`));

      return {
        shouldProceedToQA: false,
        issues: criticalIssues,
      };
    }
  }

  return {
    shouldProceedToQA: true,
    issues: [],
  };
}

export function compactQualityIssue(value: string): string {
  return compactAutocodeRetryLine(value, QUALITY_ISSUE_MAX_CHARS);
}

export function compactQualitySessionSummary(messages: SessionResult['messages']): string {
  const summary = messages.map((message) => (
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  )).join('\n');
  return compactQualityMultiline(summary, QUALITY_SESSION_SUMMARY_MAX_CHARS);
}

function compactQualityMultiline(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const marker = `\n...[quality summary truncated, ${normalized.length} chars total]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(budget * 0.45);
  const tailLength = budget - headLength;
  return `${normalized.slice(0, headLength).trimEnd()}${marker}${normalized.slice(normalized.length - tailLength).trimStart()}`;
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function getDocumentationOutputs(plan: Record<string, unknown>): {
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
  base: 'spec' | 'project';
} {
  const outputs = plan.document_outputs && typeof plan.document_outputs === 'object'
    ? plan.document_outputs as Record<string, unknown>
    : {};
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const firstSubtask = phases
    .flatMap((phase) => phase && typeof phase === 'object' && Array.isArray((phase as Record<string, unknown>).subtasks)
      ? (phase as Record<string, unknown>).subtasks as unknown[]
      : [])
    .find((subtask) => subtask && typeof subtask === 'object') as Record<string, unknown> | undefined;
  const filesToCreate = stringArray(firstSubtask?.files_to_create);
  const markdownFromPlan = typeof outputs.final_markdown === 'string'
    ? outputs.final_markdown
    : filesToCreate.find((file) => file.toLowerCase().endsWith('.md'));

  return {
    finalMarkdown: markdownFromPlan || 'docs/analysis.md',
    outline: typeof outputs.outline === 'string' ? outputs.outline : 'doc_outline.md',
    evidenceIndex: typeof outputs.evidence_index === 'string' ? outputs.evidence_index : 'evidence_index.md',
    base: outputs.base === 'project' ? 'project' : 'spec',
  };
}

function isDocumentationSubtask(subtask: SubtaskInfo): boolean {
  const files = [
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].map((item) => item.trim()).filter(Boolean);
  if (files.length > 0 && files.every((file) => /\.(?:md|mdx|txt|rst|adoc)$/i.test(file))) {
    return true;
  }

  const text = [
    subtask.description,
    ...files,
  ].join(' ').toLowerCase();
  return /\b(documentation|document|docs|markdown|source analysis)\b/.test(text) ||
    /\u6587\u6863|\u6e90\u7801\u5206\u6790|\u4ee3\u7801\u5206\u6790/.test(text);
}

function isGameMmoRiskRelevantSubtask(subtask: SubtaskInfo): boolean {
  const text = [
    subtask.description,
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].join(' ').toLowerCase();

  return /\b(server|client|network|protocol|sync|replication|prediction|reconciliation|database|persistence|save|account|economy|inventory|combat|quest|skill|item|engine|render|animation|asset|streaming|performance|security|anti[-\s]?cheat|telemetry|liveops|gm|tool|editor|build|release)\b/i.test(text) ||
    /\u670d\u52a1\u7aef|\u5ba2\u6237\u7aef|\u7f51\u7edc|\u534f\u8bae|\u540c\u6b65|\u6570\u636e\u5e93|\u6301\u4e45\u5316|\u5b58\u6863|\u8d26\u53f7|\u7ecf\u6d4e|\u80cc\u5305|\u6218\u6597|\u4efb\u52a1|\u6280\u80fd|\u7269\u54c1|\u5f15\u64ce|\u6e32\u67d3|\u52a8\u753b|\u8d44\u6e90|\u6027\u80fd|\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u8fd0\u8425|\u5de5\u5177|\u7f16\u8f91\u5668|\u6784\u5efa|\u53d1\u5e03/.test(text);
}

function validateGameMmoCodingSummary(subtask: SubtaskInfo, sessionResult: SessionResult): string[] {
  if (isDocumentationSubtask(subtask) || !isGameMmoRiskRelevantSubtask(subtask)) {
    return [];
  }

  const summary = [
    ...sessionResult.messages.map((message) => {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      return content;
    }),
  ].join('\n');

  if (!summary.trim()) {
    return ['mmo-quality: completion summary is missing MMO risk and verification details'];
  }

  const lower = summary.toLowerCase();
  const issues: string[] = [];
  const hasVerification = /\bverification\b|\bverified\b|\btest\b|\bbuild\b|\btypecheck\b|\bsmoke\b|\bmanual\b/.test(lower);
  const hasMmoRiskLanguage = /\bserver authority\b|\bnetwork sync\b|\bpersistence\b|\bdata safety\b|\bperformance\b|\bsecurity\b|\banti[-\s]?cheat\b|\bliveops\b|\btooling\b|\bcontent pipeline\b|\u670d\u52a1\u7aef|\u6743\u5a01|\u7f51\u7edc|\u540c\u6b65|\u6301\u4e45\u5316|\u6570\u636e|\u6027\u80fd|\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u8fd0\u8425|\u5de5\u5177/.test(lower);
  const hasBoundaryLanguage = /\bclient\b|\bserver\b|\bauthoritative\b|\btrust boundary\b|\bprotocol\b|\bconfig\b|\bsave\b|\bruntime owner\b/.test(lower);

  if (!hasVerification) {
    issues.push('mmo-quality: completion summary should state verification run or exact verification limitation');
  }
  if (!hasMmoRiskLanguage) {
    issues.push('mmo-quality: completion summary should include relevant MMO risk review domains');
  }
  if (!hasBoundaryLanguage) {
    issues.push('mmo-quality: completion summary should identify runtime owner, authority/trust boundary, or changed protocol/data/config contract when relevant');
  }

  return issues;
}

function runDocumentationQualityGate(
  projectDir: string,
  specDir: string,
  projectType?: ProjectType,
): { isDocumentationWorkflow: boolean; issues: string[] } {
  const plan = loadAutocodeImplementationPlanSync(specDir);
  const isDocumentationWorkflow = typeof plan?.workflow_type === 'string' &&
    plan.workflow_type.toLowerCase() === 'documentation';
  if (!isDocumentationWorkflow || !plan) {
    return { isDocumentationWorkflow: false, issues: [] };
  }

  const outputs = getAutocodeDocumentationOutputs(plan);
  const issues: string[] = [];
  const isGameMmoDocumentation = projectType === 'game-mmo' || isAutocodeGameMmoDocumentationPlan(plan);
  const outputBaseDir = outputs.base === 'project' ? projectDir : specDir;
  const outlinePath = join(outputBaseDir, outputs.outline);
  const evidencePath = join(outputBaseDir, outputs.evidenceIndex);
  const markdownPath = join(outputBaseDir, outputs.finalMarkdown);
  const outline = readTextFile(outlinePath);
  const evidence = readTextFile(evidencePath);

  issues.push(...validateAutocodeMarkdownSupportDocument(outline, outlinePath, [/document type|document_type/i, /audience/i, /section/i]));
  issues.push(...validateAutocodeDocumentationEvidenceIndex(evidence, evidencePath, {
    isGameMmoDocumentation,
  }));
  if (isGameMmoDocumentation) {
    issues.push(...validateAutocodeGameMmoDocumentationSupportContent(outline, evidence, outputs.finalMarkdown));
  }

  if (!existsSync(markdownPath)) {
    issues.push(`documentation: ${outputs.finalMarkdown} is missing`);
  } else {
    const markdown = readFileSync(markdownPath, 'utf-8');
    issues.push(...validateAutocodeDocumentationMarkdown(markdown, outputs.finalMarkdown, {
      isGameMmoDocumentation,
    }));
  }

  return { isDocumentationWorkflow: true, issues };
}

/**
 * Learn from completed session (success or failure).
 *
 * @param subtask - Subtask information
 * @param sessionResult - Session result
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 */
export async function learnFromSession(
  subtask: SubtaskInfo,
  sessionResult: SessionResult,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
): Promise<void> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  // Extract and store knowledge (if enabled)
  if (appliedConfig.enableActiveMemoryLearning) {
    try {
      const knowledge = await extractAndStoreKnowledge({
        sessionResult,
        subtask,
        projectDir,
        specDir,
        memoryService: config.memoryService,
        projectId: config.projectId ?? 'local',
      });

      console.log(formatKnowledgeSummary(knowledge));
    } catch (error) {
      console.error('Failed to extract knowledge from session:', error);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get default quality configuration.
 */
export function getDefaultQualityConfig(): QualityConfig {
  return getDefaultAutocodeQualityConfig() as QualityConfig;
}

/**
 * Create quality configuration with specific features enabled.
 */
export function createQualityConfig(overrides: Partial<QualityConfig>): QualityConfig {
  return createAutocodeQualityConfig(overrides) as QualityConfig;
}

/**
 * Check if any quality features are enabled.
 */
export function hasQualityFeaturesEnabled(config: QualityConfig): boolean {
  return hasAutocodeQualityFeaturesEnabled(config);
}

/**
 * Get list of enabled quality features.
 */
export function getEnabledFeatures(config: QualityConfig): string[] {
  return getAutocodeEnabledQualityFeatures(config);
}
