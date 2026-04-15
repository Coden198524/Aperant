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
import type { MemoryServiceImpl } from '../memory/memory-service';

// Import all quality improvement modules
import { runPreQASmokeTests, formatSmokeTestResults } from './pre-qa-smoke-tests';
import { runIncrementalValidation, formatValidationResults } from './incremental-validation';
import { enhanceCoderPrompt, shouldInjectPatterns, formatInjectionSummary } from './pattern-injection';
import { generatePreImplementationChecklist, formatChecklistForPrompt, formatChecklistSummary } from './pre-implementation-checklist';
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
  /** Memory service for learning and pattern retrieval */
  memoryService?: MemoryServiceImpl;
  /** Project ID for memory scoping */
  projectId?: string;
}

// Default configuration - all features enabled
const DEFAULT_CONFIG: Required<Omit<QualityConfig, 'memoryService' | 'projectId'>> = {
  enablePreQASmokeTests: true,
  enableIncrementalValidation: true,
  enablePatternInjection: true,
  enablePreImplementationChecklist: true,
  enableSelfCritique: true,
  enableContextAwareRecovery: true,
  enableActiveMemoryLearning: true,
  enableTieredQualityStandards: true,
};

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
    enhancedPrompt = enhancedPrompt + '\n\n' + formatChecklistForPrompt(checklist);
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
): Promise<{ passed: boolean; issues: string[] }> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };
  const issues: string[] = [];

  // Only validate if session completed successfully
  if (sessionResult.outcome !== 'completed') {
    return { passed: true, issues: [] };
  }

  // 1. Run incremental validation (if enabled)
  if (appliedConfig.enableIncrementalValidation) {
    const validationResult = await runIncrementalValidation({
      subtaskId: subtask.id,
      filesModified: subtask.filesToModify || [],
      patternFiles: subtask.patternFiles,
      projectDir,
      specDir,
    });

    console.log(formatValidationResults(validationResult));

    if (!validationResult.passed) {
      const criticalFailures = validationResult.failures.filter(f => f.severity === 'error');
      issues.push(...criticalFailures.map(f => `${f.type}: ${f.message}`));
    }
  }

  // 2. Run self-critique (if enabled)
  // Note: This would require access to generated files, which we don't have here
  // Self-critique should be run within the agent session itself

  return {
    passed: issues.length === 0,
    issues,
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

  // Run pre-QA smoke tests (if enabled)
  if (appliedConfig.enablePreQASmokeTests) {
    const smokeTestResult = await runPreQASmokeTests(projectDir, specDir);
    console.log(formatSmokeTestResults(smokeTestResult));

    if (smokeTestResult.shouldReturnToCoding) {
      const criticalIssues = smokeTestResult.issues
        .filter(i => i.severity === 'critical')
        .map(i => `${i.check}: ${i.output.split('\n')[0]}`);

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
  if (appliedConfig.enableActiveMemoryLearning && config.memoryService && config.projectId) {
    try {
      const knowledge = await extractAndStoreKnowledge({
        sessionResult,
        subtask,
        projectDir,
        specDir,
        memoryService: config.memoryService,
        projectId: config.projectId,
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
  return { ...DEFAULT_CONFIG };
}

/**
 * Create quality configuration with specific features enabled.
 */
export function createQualityConfig(overrides: Partial<QualityConfig>): QualityConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Check if any quality features are enabled.
 */
export function hasQualityFeaturesEnabled(config: QualityConfig): boolean {
  return Object.values(config).some(v => v === true);
}

/**
 * Get list of enabled quality features.
 */
export function getEnabledFeatures(config: QualityConfig): string[] {
  const features: string[] = [];
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  if (appliedConfig.enablePreQASmokeTests) features.push('Pre-QA Smoke Tests');
  if (appliedConfig.enableIncrementalValidation) features.push('Incremental Validation');
  if (appliedConfig.enablePatternInjection) features.push('Pattern Injection');
  if (appliedConfig.enablePreImplementationChecklist) features.push('Pre-Implementation Checklist');
  if (appliedConfig.enableSelfCritique) features.push('Self-Critique');
  if (appliedConfig.enableContextAwareRecovery) features.push('Context-Aware Recovery');
  if (appliedConfig.enableActiveMemoryLearning) features.push('Active Memory Learning');
  if (appliedConfig.enableTieredQualityStandards) features.push('Tiered Quality Standards');

  return features;
}
