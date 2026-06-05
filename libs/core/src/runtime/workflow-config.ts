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
  skipAIQAReview?: boolean;
}

export interface AutocodeSessionQualityConfig {
  enablePreQASmokeTests: boolean;
  enableIncrementalValidation: boolean;
  enablePatternInjection: boolean;
  enablePreImplementationChecklist: boolean;
  enableSelfCritique: boolean;
  enableContextAwareRecovery: boolean;
  enableActiveMemoryLearning: boolean;
  enableTieredQualityStandards: boolean;
  enableDocumentationQualityGate: boolean;
  projectType?: string;
}

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
    enableSelfCritique: true,
    enablePreImplementationChecklist: true,
    enableTieredQualityStandards: true,
  },
  specCreationMode: 'auto',
};

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

export const OPTIMIZATION_PRESETS: Record<OptimizationLevel, Required<WorkflowConfig>> = {
  conservative: CONSERVATIVE_PRESET,
  balanced: BALANCED_PRESET,
  aggressive: AGGRESSIVE_PRESET,
};

export const DEFAULT_WORKFLOW_CONFIG = BALANCED_PRESET;

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

export function getWorkflowConfigFromMode(mode?: string): WorkflowConfig | undefined {
  if (!mode || mode === 'off') return undefined;
  return isOptimizationLevel(mode) ? OPTIMIZATION_PRESETS[mode] : undefined;
}

export function isOptimizationLevel(value: string): value is OptimizationLevel {
  return value === 'conservative' || value === 'balanced' || value === 'aggressive';
}

export function isQualityCheckEnabled(
  config: WorkflowConfig,
  checkName: keyof QualityCheckConfig,
): boolean {
  return config.qualityChecks?.[checkName] ?? false;
}

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

export function buildAutocodeSessionQualityConfig(
  workflowConfig: WorkflowConfig | undefined,
  projectType?: string,
): AutocodeSessionQualityConfig | undefined {
  if (!workflowConfig) {
    return undefined;
  }

  const qualityChecks = workflowConfig.qualityChecks ?? {};
  const conservativeMode = workflowConfig.optimizationLevel === 'conservative';
  const standardQualityMode = workflowConfig.optimizationLevel === 'balanced' || conservativeMode;
  const gameMmoMode = projectType === 'game-mmo';

  return {
    enablePreQASmokeTests: qualityChecks.enableSmokeTests ?? false,
    enableIncrementalValidation: standardQualityMode || gameMmoMode,
    enablePatternInjection: qualityChecks.enablePatternInjection ?? gameMmoMode,
    enablePreImplementationChecklist: qualityChecks.enablePreImplementationChecklist ?? gameMmoMode,
    enableSelfCritique: qualityChecks.enableSelfCritique ?? false,
    enableContextAwareRecovery: standardQualityMode || gameMmoMode,
    enableActiveMemoryLearning: true,
    enableTieredQualityStandards: qualityChecks.enableTieredQualityStandards ?? gameMmoMode,
    enableDocumentationQualityGate: true,
    projectType,
  };
}
