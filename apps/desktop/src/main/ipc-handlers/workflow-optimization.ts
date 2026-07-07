/**
 * IPC Handler for Workflow Optimization
 * ======================================
 *
 * Handles IPC communication for workflow optimization settings and metrics.
 */

import { ipcMain } from 'electron';
import type { WorkflowMetrics } from '../../shared/types/workflow-optimization';
import { getMetricsTracker, initializeMetricsTracking } from '../ai/orchestration/metrics-tracker';

/**
 * Register workflow optimization IPC handlers.
 */
export function registerWorkflowOptimizationHandlers(): void {
  /**
   * Get workflow performance metrics.
   */
  ipcMain.handle('workflow-optimization:get-metrics', async (): Promise<WorkflowMetrics | null> => {
    try {
      await initializeMetricsTracking();
      const tracker = getMetricsTracker();
      const aggregated = tracker.getAggregatedMetrics();

      if (!aggregated) {
        return null;
      }

      // Convert to UI-friendly format
      const metrics: WorkflowMetrics = {
        avgCompletionTime: aggregated.avgCompletionTime,
        avgTokenUsage: aggregated.avgTokenUsage,
        successRate: aggregated.successRate,
        totalTasks: aggregated.totalTasks,
        tasksByLevel: {
          conservative: aggregated.byLevel.conservative.count,
          balanced: aggregated.byLevel.balanced.count,
          aggressive: aggregated.byLevel.aggressive.count,
        },
        avgTimeByLevel: {
          conservative: aggregated.byLevel.conservative.avgTime,
          balanced: aggregated.byLevel.balanced.avgTime,
          aggressive: aggregated.byLevel.aggressive.avgTime,
        },
        avgTokensByLevel: {
          conservative: aggregated.byLevel.conservative.avgTokens,
          balanced: aggregated.byLevel.balanced.avgTokens,
          aggressive: aggregated.byLevel.aggressive.avgTokens,
        },
      };

      return metrics;
    } catch (error) {
      console.error('[WorkflowOptimizationHandler] Failed to get metrics:', error);
      return null;
    }
  });

  /**
   * Clear workflow metrics.
   */
  ipcMain.handle('workflow-optimization:clear-metrics', async (): Promise<void> => {
    try {
      const tracker = getMetricsTracker();
      await tracker.clearMetrics();
    } catch (error) {
      console.error('[WorkflowOptimizationHandler] Failed to clear metrics:', error);
      throw error;
    }
  });

  /**
   * Get recent task records for detailed analysis.
   */
  ipcMain.handle('workflow-optimization:get-recent-records', async (_, limit = 100) => {
    try {
      await initializeMetricsTracking();
      const tracker = getMetricsTracker();
      return tracker.getRecentRecords(limit);
    } catch (error) {
      console.error('[WorkflowOptimizationHandler] Failed to get recent records:', error);
      return [];
    }
  });

  /**
   * Compare optimization levels.
   */
  ipcMain.handle('workflow-optimization:compare-levels', async () => {
    try {
      await initializeMetricsTracking();
      const tracker = getMetricsTracker();
      return tracker.compareOptimizationLevels();
    } catch (error) {
      console.error('[WorkflowOptimizationHandler] Failed to compare levels:', error);
      return null;
    }
  });
}
