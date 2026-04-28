/**
 * Workflow Optimization Settings Types
 * =====================================
 *
 * Type definitions for workflow optimization settings in the UI.
 */

export type OptimizationLevel = 'conservative' | 'balanced' | 'aggressive';
export type SpecCreationMode = 'unified' | 'phased' | 'auto';

export interface QualityCheckConfig {
  enableSmokeTests?: boolean;
  enablePatternInjection?: boolean;
  enableSelfCritique?: boolean;
  enablePreImplementationChecklist?: boolean;
  enableTieredQualityStandards?: boolean;
}

export interface WorkflowConfig {
  optimizationLevel: OptimizationLevel;
  maxPlanningRetries?: number;
  maxSubtaskRetries?: number;
  maxQACycles?: number;
  qualityChecks?: QualityCheckConfig;
  specCreationMode?: SpecCreationMode;
  maxSpecPhaseRetries?: number;
}

/** User-facing workflow optimization settings */
export interface WorkflowOptimizationSettings {
  /** Selected optimization level */
  optimizationLevel: OptimizationLevel;

  /** Whether to show advanced settings */
  showAdvancedSettings: boolean;

  /** Advanced retry configuration (overrides preset) */
  advancedRetries?: {
    maxPlanningRetries?: number;
    maxSubtaskRetries?: number;
    maxQACycles?: number;
    maxSpecPhaseRetries?: number;
  };

  /** Advanced quality check configuration (overrides preset) */
  advancedQualityChecks?: {
    enableSmokeTests?: boolean;
    enablePatternInjection?: boolean;
    enableSelfCritique?: boolean;
    enablePreImplementationChecklist?: boolean;
    enableTieredQualityStandards?: boolean;
  };

  /** Spec creation mode override */
  specCreationMode?: 'unified' | 'phased' | 'auto';
}

/** Default workflow optimization settings */
export const DEFAULT_WORKFLOW_OPTIMIZATION_SETTINGS: WorkflowOptimizationSettings = {
  optimizationLevel: 'balanced',
  showAdvancedSettings: false,
};

/** Workflow optimization metrics for display */
export interface WorkflowMetrics {
  /** Average task completion time (ms) */
  avgCompletionTime: number;

  /** Average token usage per task */
  avgTokenUsage: number;

  /** Success rate (0-1) */
  successRate: number;

  /** Total tasks completed */
  totalTasks: number;

  /** Tasks by optimization level */
  tasksByLevel: {
    conservative: number;
    balanced: number;
    aggressive: number;
  };

  /** Average time by optimization level (ms) */
  avgTimeByLevel: {
    conservative: number;
    balanced: number;
    aggressive: number;
  };

  /** Average tokens by optimization level */
  avgTokensByLevel: {
    conservative: number;
    balanced: number;
    aggressive: number;
  };
}

/** Convert UI settings to WorkflowConfig */
export function settingsToWorkflowConfig(
  settings: WorkflowOptimizationSettings,
): WorkflowConfig {
  const config: WorkflowConfig = {
    optimizationLevel: settings.optimizationLevel,
  };

  // Apply advanced overrides if enabled
  if (settings.showAdvancedSettings) {
    if (settings.advancedRetries) {
      config.maxPlanningRetries = settings.advancedRetries.maxPlanningRetries;
      config.maxSubtaskRetries = settings.advancedRetries.maxSubtaskRetries;
      config.maxQACycles = settings.advancedRetries.maxQACycles;
      config.maxSpecPhaseRetries = settings.advancedRetries.maxSpecPhaseRetries;
    }

    if (settings.advancedQualityChecks) {
      config.qualityChecks = settings.advancedQualityChecks;
    }

    if (settings.specCreationMode) {
      config.specCreationMode = settings.specCreationMode;
    }
  }

  return config;
}
