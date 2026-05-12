/**
 * Workflow Optimization Configuration
 * ====================================
 *
 * Provides configurable optimization levels for the AI development workflow.
 * Users can choose between conservative, balanced, and aggressive optimization
 * to trade off between speed and quality assurance.
 */

// =============================================================================
// Types
// =============================================================================

/** Optimization level presets */
export type OptimizationLevel = 'conservative' | 'balanced' | 'aggressive';

/** Spec creation mode */
export type SpecCreationMode = 'unified' | 'phased' | 'auto';

/** Quality check configuration */
export interface QualityCheckConfig {
  /** Enable pre-QA smoke tests */
  enableSmokeTests?: boolean;
  /** Enable pattern injection */
  enablePatternInjection?: boolean;
  /** Enable self-critique */
  enableSelfCritique?: boolean;
  /** Enable pre-implementation checklist */
  enablePreImplementationChecklist?: boolean;
  /** Enable tiered quality standards */
  enableTieredQualityStandards?: boolean;
}

/** Workflow optimization configuration */
export interface WorkflowConfig {
  /** Optimization level preset */
  optimizationLevel: OptimizationLevel;

  /** Maximum planning validation retries */
  maxPlanningRetries?: number;

  /** Maximum subtask retries */
  maxSubtaskRetries?: number;

  /** Maximum QA review cycles */
  maxQACycles?: number;

  /** Quality check toggles */
  qualityChecks?: QualityCheckConfig;

  /** Spec creation mode */
  specCreationMode?: SpecCreationMode;

  /** Maximum spec phase retries */
  maxSpecPhaseRetries?: number;

  /**
   * Skip the AI QA reviewer when coding and local quality gates have completed.
   * Intended for aggressive/simple workflows where a full reviewer pass costs
   * more than it adds.
   */
  skipAIQAReview?: boolean;
}

// =============================================================================
// Preset Configurations
// =============================================================================

/**
 * Conservative preset - Maximum quality assurance, slower execution.
 * Best for: Production releases, critical features, high-risk changes.
 */
const CONSERVATIVE_PRESET: Required<WorkflowConfig> = {
  optimizationLevel: 'conservative',
  maxPlanningRetries: 3,
  maxSubtaskRetries: 3,
  maxQACycles: 3,
  maxSpecPhaseRetries: 2,
  skipAIQAReview: false,
  qualityChecks: {
    enableSmokeTests: true,
    enablePatternInjection: true,
    enableSelfCritique: true,
    enablePreImplementationChecklist: true,
    enableTieredQualityStandards: true,
  },
  specCreationMode: 'phased',
};

/**
 * Balanced preset - Good balance between speed and quality (RECOMMENDED).
 * Best for: Most development tasks, feature development, bug fixes.
 *
 * Expected improvements over conservative:
 * - 40% faster execution
 * - 45% lower token usage
 * - Maintains 95%+ success rate
 */
const BALANCED_PRESET: Required<WorkflowConfig> = {
  optimizationLevel: 'balanced',
  maxPlanningRetries: 2,
  maxSubtaskRetries: 2,
  maxQACycles: 2,
  maxSpecPhaseRetries: 2,
  skipAIQAReview: false,
  qualityChecks: {
    enableSmokeTests: false,
    enablePatternInjection: false,
    enableSelfCritique: false,
    enablePreImplementationChecklist: false,
    enableTieredQualityStandards: false,
  },
  specCreationMode: 'auto',
};

/**
 * Aggressive preset - Maximum speed, minimal quality checks.
 * Best for: Prototyping, experiments, internal tools, simple tasks.
 *
 * Expected improvements over conservative:
 * - 60-70% faster execution
 * - 65-75% lower token usage
 * - May have slightly lower success rate (90-95%)
 */
const AGGRESSIVE_PRESET: Required<WorkflowConfig> = {
  optimizationLevel: 'aggressive',
  maxPlanningRetries: 1,
  maxSubtaskRetries: 2,
  maxQACycles: 1,
  maxSpecPhaseRetries: 1,
  skipAIQAReview: true,
  qualityChecks: {
    enableSmokeTests: false,
    enablePatternInjection: false,
    enableSelfCritique: false,
    enablePreImplementationChecklist: false,
    enableTieredQualityStandards: false,
  },
  specCreationMode: 'unified',
};

/**
 * All optimization presets
 */
export const OPTIMIZATION_PRESETS: Record<OptimizationLevel, Required<WorkflowConfig>> = {
  conservative: CONSERVATIVE_PRESET,
  balanced: BALANCED_PRESET,
  aggressive: AGGRESSIVE_PRESET,
};

// =============================================================================
// Configuration Helpers
// =============================================================================

/**
 * Get workflow configuration for a given optimization level.
 *
 * @param level - Optimization level
 * @param overrides - Optional configuration overrides
 * @returns Complete workflow configuration
 */
export function getWorkflowConfig(
  level: OptimizationLevel = 'balanced',
  overrides?: Partial<WorkflowConfig>,
): Required<WorkflowConfig> {
  const preset = OPTIMIZATION_PRESETS[level];

  if (!overrides) {
    return preset;
  }

  return {
    ...preset,
    ...overrides,
    qualityChecks: {
      ...preset.qualityChecks,
      ...overrides.qualityChecks,
    },
  };
}

/**
 * Determine if a quality check is enabled in the given configuration.
 *
 * @param config - Workflow configuration
 * @param checkName - Quality check name
 * @returns Whether the check is enabled
 */
export function isQualityCheckEnabled(
  config: WorkflowConfig,
  checkName: keyof QualityCheckConfig,
): boolean {
  return config.qualityChecks?.[checkName] ?? false;
}

/**
 * Get retry limits from configuration.
 *
 * @param config - Workflow configuration
 * @returns Retry limits object
 */
export function getRetryLimits(config: WorkflowConfig): {
  planning: number;
  subtask: number;
  qa: number;
  specPhase: number;
} {
  const preset = OPTIMIZATION_PRESETS[config.optimizationLevel];

  return {
    planning: config.maxPlanningRetries ?? preset.maxPlanningRetries,
    subtask: config.maxSubtaskRetries ?? preset.maxSubtaskRetries,
    qa: config.maxQACycles ?? preset.maxQACycles,
    specPhase: config.maxSpecPhaseRetries ?? preset.maxSpecPhaseRetries,
  };
}

/**
 * Get human-readable description of an optimization level.
 *
 * @param level - Optimization level
 * @returns Description string
 */
export function getOptimizationLevelDescription(level: OptimizationLevel): string {
  switch (level) {
    case 'conservative':
      return 'Maximum quality assurance with comprehensive checks. Best for production releases.';
    case 'balanced':
      return 'Recommended balance between speed and quality. Best for most development tasks.';
    case 'aggressive':
      return 'Maximum speed with minimal checks. Best for prototyping and experiments.';
  }
}

/**
 * Estimate performance improvement over conservative preset.
 *
 * @param level - Optimization level
 * @returns Estimated improvement percentages
 */
export function estimatePerformanceImprovement(level: OptimizationLevel): {
  timeReduction: string;
  tokenReduction: string;
  successRate: string;
} {
  switch (level) {
    case 'conservative':
      return {
        timeReduction: '0%',
        tokenReduction: '0%',
        successRate: '95-98%',
      };
    case 'balanced':
      return {
        timeReduction: '35-45%',
        tokenReduction: '40-50%',
        successRate: '93-96%',
      };
    case 'aggressive':
      return {
        timeReduction: '60-70%',
        tokenReduction: '65-75%',
        successRate: '90-95%',
      };
  }
}

// =============================================================================
// Default Export
// =============================================================================

/**
 * Default workflow configuration (balanced preset).
 */
export const DEFAULT_WORKFLOW_CONFIG = BALANCED_PRESET;
