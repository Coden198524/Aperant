import type { OptimizationLevel } from './workflow-config.js';

export interface AutocodeTaskExecutionRecord {
  taskId: string;
  optimizationLevel: OptimizationLevel;
  startTime: number;
  endTime: number;
  durationMs: number;
  tokensUsed: number;
  success: boolean;
  complexity?: 'simple' | 'standard' | 'complex';
  phasesExecuted: number;
  totalRetries: number;
}

export interface AutocodeLevelMetrics {
  count: number;
  avgTime: number;
  avgTokens: number;
  successRate: number;
}

export interface AutocodeComplexityMetrics {
  count: number;
  avgTime: number;
  avgTokens: number;
}

export interface AutocodeAggregatedMetrics {
  totalTasks: number;
  avgCompletionTime: number;
  avgTokenUsage: number;
  successRate: number;
  byLevel: Record<OptimizationLevel, AutocodeLevelMetrics>;
  byComplexity: {
    simple: AutocodeComplexityMetrics;
    standard: AutocodeComplexityMetrics;
    complex: AutocodeComplexityMetrics;
  };
  lastUpdated: number;
}

export type AutocodeOptimizationMetricsComparison = Record<
  OptimizationLevel,
  Pick<AutocodeLevelMetrics, 'avgTime' | 'avgTokens' | 'successRate'>
>;

export function aggregateAutocodeWorkflowMetrics(
  records: readonly AutocodeTaskExecutionRecord[],
  now = Date.now(),
): AutocodeAggregatedMetrics | null {
  if (records.length === 0) {
    return null;
  }

  const totalTasks = records.length;
  const successfulTasks = records.filter((record) => record.success).length;

  return {
    totalTasks,
    avgCompletionTime: average(records.map((record) => record.durationMs)),
    avgTokenUsage: average(records.map((record) => record.tokensUsed)),
    successRate: successfulTasks / totalTasks,
    byLevel: {
      conservative: aggregateByLevel(records, 'conservative'),
      balanced: aggregateByLevel(records, 'balanced'),
      aggressive: aggregateByLevel(records, 'aggressive'),
    },
    byComplexity: {
      simple: aggregateByComplexity(records, 'simple'),
      standard: aggregateByComplexity(records, 'standard'),
      complex: aggregateByComplexity(records, 'complex'),
    },
    lastUpdated: now,
  };
}

export function compareAutocodeOptimizationLevels(
  aggregated: AutocodeAggregatedMetrics,
): AutocodeOptimizationMetricsComparison {
  return {
    conservative: pickLevelComparison(aggregated.byLevel.conservative),
    balanced: pickLevelComparison(aggregated.byLevel.balanced),
    aggressive: pickLevelComparison(aggregated.byLevel.aggressive),
  };
}

export function getAutocodeEmptyLevelMetrics(): AutocodeLevelMetrics {
  return { count: 0, avgTime: 0, avgTokens: 0, successRate: 0 };
}

export function getAutocodeEmptyComplexityMetrics(): AutocodeComplexityMetrics {
  return { count: 0, avgTime: 0, avgTokens: 0 };
}

function aggregateByLevel(
  records: readonly AutocodeTaskExecutionRecord[],
  level: OptimizationLevel,
): AutocodeLevelMetrics {
  const levelRecords = records.filter((record) => record.optimizationLevel === level);
  if (levelRecords.length === 0) {
    return getAutocodeEmptyLevelMetrics();
  }

  return {
    count: levelRecords.length,
    avgTime: average(levelRecords.map((record) => record.durationMs)),
    avgTokens: average(levelRecords.map((record) => record.tokensUsed)),
    successRate: levelRecords.filter((record) => record.success).length / levelRecords.length,
  };
}

function aggregateByComplexity(
  records: readonly AutocodeTaskExecutionRecord[],
  complexity: 'simple' | 'standard' | 'complex',
): AutocodeComplexityMetrics {
  const complexityRecords = records.filter((record) => record.complexity === complexity);
  if (complexityRecords.length === 0) {
    return getAutocodeEmptyComplexityMetrics();
  }

  return {
    count: complexityRecords.length,
    avgTime: average(complexityRecords.map((record) => record.durationMs)),
    avgTokens: average(complexityRecords.map((record) => record.tokensUsed)),
  };
}

function pickLevelComparison(
  metrics: AutocodeLevelMetrics,
): Pick<AutocodeLevelMetrics, 'avgTime' | 'avgTokens' | 'successRate'> {
  return {
    avgTime: metrics.avgTime,
    avgTokens: metrics.avgTokens,
    successRate: metrics.successRate,
  };
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}
