import { ipcRenderer } from 'electron';
import type {
  AutocodeOptimizationMetricsComparison,
  AutocodeTaskExecutionRecord,
} from '@autocode/core/runtime/workflow-metrics';
import type { WorkflowMetrics } from '../../shared/types/workflow-optimization';

export interface WorkflowOptimizationAPI {
  /** Get workflow performance metrics */
  getWorkflowMetrics: () => Promise<WorkflowMetrics | null>;

  /** Clear workflow metrics */
  clearWorkflowMetrics: () => Promise<void>;

  /** Get recent task records for detailed analysis */
  getRecentRecords: (limit?: number) => Promise<AutocodeTaskExecutionRecord[]>;

  /** Compare optimization levels */
  compareOptimizationLevels: () => Promise<AutocodeOptimizationMetricsComparison | null>;
}

export const createWorkflowOptimizationAPI = (): WorkflowOptimizationAPI => ({
  getWorkflowMetrics: () => ipcRenderer.invoke('workflow-optimization:get-metrics'),
  clearWorkflowMetrics: () => ipcRenderer.invoke('workflow-optimization:clear-metrics'),
  getRecentRecords: (limit?: number) => ipcRenderer.invoke('workflow-optimization:get-recent-records', limit),
  compareOptimizationLevels: () => ipcRenderer.invoke('workflow-optimization:compare-levels'),
});
