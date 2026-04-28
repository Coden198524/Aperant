/**
 * Workflow Optimization Metrics Tracker
 * ======================================
 *
 * Tracks and aggregates workflow performance metrics for analysis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { OptimizationLevel } from './workflow-config';

// =============================================================================
// Types
// =============================================================================

/** Single task execution record */
interface TaskExecutionRecord {
  /** Task ID */
  taskId: string;

  /** Optimization level used */
  optimizationLevel: OptimizationLevel;

  /** Start timestamp */
  startTime: number;

  /** End timestamp */
  endTime: number;

  /** Duration in milliseconds */
  durationMs: number;

  /** Total tokens used */
  tokensUsed: number;

  /** Whether task succeeded */
  success: boolean;

  /** Task complexity tier */
  complexity?: 'simple' | 'standard' | 'complex';

  /** Number of phases executed */
  phasesExecuted: number;

  /** Number of retries */
  totalRetries: number;
}

/** Aggregated metrics */
interface AggregatedMetrics {
  /** Total tasks tracked */
  totalTasks: number;

  /** Average completion time (ms) */
  avgCompletionTime: number;

  /** Average token usage */
  avgTokenUsage: number;

  /** Success rate (0-1) */
  successRate: number;

  /** Metrics by optimization level */
  byLevel: {
    [K in OptimizationLevel]: {
      count: number;
      avgTime: number;
      avgTokens: number;
      successRate: number;
    };
  };

  /** Metrics by complexity */
  byComplexity: {
    simple: { count: number; avgTime: number; avgTokens: number };
    standard: { count: number; avgTime: number; avgTokens: number };
    complex: { count: number; avgTime: number; avgTokens: number };
  };

  /** Last updated timestamp */
  lastUpdated: number;
}

// =============================================================================
// Metrics Tracker
// =============================================================================

export class WorkflowMetricsTracker {
  private metricsDir: string;
  private recordsFile: string;
  private aggregatedFile: string;
  private records: TaskExecutionRecord[] = [];
  private aggregated: AggregatedMetrics | null = null;

  constructor() {
    this.metricsDir = join(app.getPath('userData'), 'workflow-metrics');
    this.recordsFile = join(this.metricsDir, 'task-records.jsonl');
    this.aggregatedFile = join(this.metricsDir, 'aggregated-metrics.json');
  }

  /**
   * Initialize metrics tracker - load existing records.
   */
  async initialize(): Promise<void> {
    try {
      await mkdir(this.metricsDir, { recursive: true });
      await this.loadRecords();
      await this.loadAggregated();
    } catch (error) {
      console.error('[WorkflowMetricsTracker] Failed to initialize:', error);
    }
  }

  /**
   * Record a task execution.
   */
  async recordTaskExecution(record: TaskExecutionRecord): Promise<void> {
    try {
      // Append to JSONL file
      const line = JSON.stringify(record) + '\n';
      await writeFile(this.recordsFile, line, { flag: 'a' });

      // Add to in-memory records
      this.records.push(record);

      // Update aggregated metrics
      await this.updateAggregatedMetrics();
    } catch (error) {
      console.error('[WorkflowMetricsTracker] Failed to record task:', error);
    }
  }

  /**
   * Get aggregated metrics.
   */
  getAggregatedMetrics(): AggregatedMetrics | null {
    return this.aggregated;
  }

  /**
   * Get recent task records.
   */
  getRecentRecords(limit = 100): TaskExecutionRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * Compare optimization levels.
   */
  compareOptimizationLevels(): {
    conservative: { avgTime: number; avgTokens: number; successRate: number };
    balanced: { avgTime: number; avgTokens: number; successRate: number };
    aggressive: { avgTime: number; avgTokens: number; successRate: number };
  } | null {
    if (!this.aggregated) return null;

    return {
      conservative: {
        avgTime: this.aggregated.byLevel.conservative.avgTime,
        avgTokens: this.aggregated.byLevel.conservative.avgTokens,
        successRate: this.aggregated.byLevel.conservative.successRate,
      },
      balanced: {
        avgTime: this.aggregated.byLevel.balanced.avgTime,
        avgTokens: this.aggregated.byLevel.balanced.avgTokens,
        successRate: this.aggregated.byLevel.balanced.successRate,
      },
      aggressive: {
        avgTime: this.aggregated.byLevel.aggressive.avgTime,
        avgTokens: this.aggregated.byLevel.aggressive.avgTokens,
        successRate: this.aggregated.byLevel.aggressive.successRate,
      },
    };
  }

  /**
   * Clear all metrics data.
   */
  async clearMetrics(): Promise<void> {
    this.records = [];
    this.aggregated = null;
    try {
      await writeFile(this.recordsFile, '');
      await writeFile(this.aggregatedFile, JSON.stringify(null));
    } catch (error) {
      console.error('[WorkflowMetricsTracker] Failed to clear metrics:', error);
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async loadRecords(): Promise<void> {
    try {
      const content = await readFile(this.recordsFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      this.records = lines.map((line) => JSON.parse(line) as TaskExecutionRecord);
    } catch {
      // File doesn't exist yet - that's fine
      this.records = [];
    }
  }

  private async loadAggregated(): Promise<void> {
    try {
      const content = await readFile(this.aggregatedFile, 'utf-8');
      this.aggregated = JSON.parse(content) as AggregatedMetrics;
    } catch {
      // File doesn't exist yet - will be created on first update
      this.aggregated = null;
    }
  }

  private async updateAggregatedMetrics(): Promise<void> {
    if (this.records.length === 0) {
      this.aggregated = null;
      return;
    }

    const totalTasks = this.records.length;
    const successfulTasks = this.records.filter((r) => r.success).length;

    // Overall metrics
    const avgCompletionTime =
      this.records.reduce((sum, r) => sum + r.durationMs, 0) / totalTasks;
    const avgTokenUsage =
      this.records.reduce((sum, r) => sum + r.tokensUsed, 0) / totalTasks;
    const successRate = successfulTasks / totalTasks;

    // By optimization level
    const byLevel = {
      conservative: this.aggregateByLevel('conservative'),
      balanced: this.aggregateByLevel('balanced'),
      aggressive: this.aggregateByLevel('aggressive'),
    };

    // By complexity
    const byComplexity = {
      simple: this.aggregateByComplexity('simple'),
      standard: this.aggregateByComplexity('standard'),
      complex: this.aggregateByComplexity('complex'),
    };

    this.aggregated = {
      totalTasks,
      avgCompletionTime,
      avgTokenUsage,
      successRate,
      byLevel,
      byComplexity,
      lastUpdated: Date.now(),
    };

    // Save to disk
    try {
      await writeFile(this.aggregatedFile, JSON.stringify(this.aggregated, null, 2));
    } catch (error) {
      console.error('[WorkflowMetricsTracker] Failed to save aggregated metrics:', error);
    }
  }

  private aggregateByLevel(level: OptimizationLevel) {
    const levelRecords = this.records.filter((r) => r.optimizationLevel === level);
    if (levelRecords.length === 0) {
      return { count: 0, avgTime: 0, avgTokens: 0, successRate: 0 };
    }

    const count = levelRecords.length;
    const avgTime = levelRecords.reduce((sum, r) => sum + r.durationMs, 0) / count;
    const avgTokens = levelRecords.reduce((sum, r) => sum + r.tokensUsed, 0) / count;
    const successRate = levelRecords.filter((r) => r.success).length / count;

    return { count, avgTime, avgTokens, successRate };
  }

  private aggregateByComplexity(complexity: 'simple' | 'standard' | 'complex') {
    const complexityRecords = this.records.filter((r) => r.complexity === complexity);
    if (complexityRecords.length === 0) {
      return { count: 0, avgTime: 0, avgTokens: 0 };
    }

    const count = complexityRecords.length;
    const avgTime = complexityRecords.reduce((sum, r) => sum + r.durationMs, 0) / count;
    const avgTokens = complexityRecords.reduce((sum, r) => sum + r.tokensUsed, 0) / count;

    return { count, avgTime, avgTokens };
  }
}

// Singleton instance
let metricsTracker: WorkflowMetricsTracker | null = null;

/**
 * Get the global metrics tracker instance.
 */
export function getMetricsTracker(): WorkflowMetricsTracker {
  if (!metricsTracker) {
    metricsTracker = new WorkflowMetricsTracker();
  }
  return metricsTracker;
}

/**
 * Initialize metrics tracking.
 */
export async function initializeMetricsTracking(): Promise<void> {
  const tracker = getMetricsTracker();
  await tracker.initialize();
}
