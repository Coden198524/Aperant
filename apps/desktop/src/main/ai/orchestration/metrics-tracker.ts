/**
 * Workflow Optimization Metrics Tracker
 * ======================================
 *
 * Tracks and aggregates workflow performance metrics for analysis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import {
  aggregateAutocodeWorkflowMetrics,
  compareAutocodeOptimizationLevels,
  type AutocodeAggregatedMetrics,
  type AutocodeTaskExecutionRecord,
} from '@autocode/core/runtime/workflow-metrics';

// =============================================================================
// Types
// =============================================================================

type TaskExecutionRecord = AutocodeTaskExecutionRecord;
type AggregatedMetrics = AutocodeAggregatedMetrics;

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

    return compareAutocodeOptimizationLevels(this.aggregated);
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
    this.aggregated = aggregateAutocodeWorkflowMetrics(this.records);

    // Save to disk
    try {
      await writeFile(this.aggregatedFile, JSON.stringify(this.aggregated, null, 2));
    } catch (error) {
      console.error('[WorkflowMetricsTracker] Failed to save aggregated metrics:', error);
    }
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
