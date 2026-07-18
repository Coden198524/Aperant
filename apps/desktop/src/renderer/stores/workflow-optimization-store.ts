/**
 * Workflow Optimization Store
 * ============================
 *
 * Zustand store for managing workflow optimization settings and metrics.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  WorkflowOptimizationSettings,
  WorkflowMetrics,
  OptimizationLevel,
} from '@shared/types/workflow-optimization';
import { DEFAULT_WORKFLOW_OPTIMIZATION_SETTINGS } from '@shared/types/workflow-optimization';

interface WorkflowOptimizationState {
  /** Current workflow optimization settings */
  settings: WorkflowOptimizationSettings;

  /** Workflow performance metrics */
  metrics: WorkflowMetrics | null;

  /** Whether metrics are loading */
  metricsLoading: boolean;

  /** Update optimization level */
  setOptimizationLevel: (level: OptimizationLevel) => void;

  /** Toggle advanced settings visibility */
  toggleAdvancedSettings: () => void;

  /** Update advanced retry settings */
  updateAdvancedRetries: (retries: Partial<WorkflowOptimizationSettings['advancedRetries']>) => void;

  /** Update advanced quality check settings */
  updateAdvancedQualityChecks: (
    checks: Partial<WorkflowOptimizationSettings['advancedQualityChecks']>,
  ) => void;

  /** Update spec creation mode */
  setSpecCreationMode: (mode: 'unified' | 'phased' | 'auto') => void;

  /** Load metrics from main process */
  loadMetrics: () => Promise<void>;

  /** Reset settings to defaults */
  resetSettings: () => void;
}

export const useWorkflowOptimizationStore = create<WorkflowOptimizationState>()(
  persist(
    (set, _get) => ({
      settings: DEFAULT_WORKFLOW_OPTIMIZATION_SETTINGS,
      metrics: null,
      metricsLoading: false,

      setOptimizationLevel: (level) => {
        set((state) => ({
          settings: {
            ...state.settings,
            optimizationLevel: level,
          },
        }));
      },

      toggleAdvancedSettings: () => {
        set((state) => ({
          settings: {
            ...state.settings,
            showAdvancedSettings: !state.settings.showAdvancedSettings,
          },
        }));
      },

      updateAdvancedRetries: (retries) => {
        set((state) => ({
          settings: {
            ...state.settings,
            advancedRetries: {
              ...state.settings.advancedRetries,
              ...retries,
            },
          },
        }));
      },

      updateAdvancedQualityChecks: (checks) => {
        set((state) => ({
          settings: {
            ...state.settings,
            advancedQualityChecks: {
              ...state.settings.advancedQualityChecks,
              ...checks,
            },
          },
        }));
      },

      setSpecCreationMode: (mode) => {
        set((state) => ({
          settings: {
            ...state.settings,
            specCreationMode: mode,
          },
        }));
      },

      loadMetrics: async () => {
        set({ metricsLoading: true });
        try {
          const metrics = await window.electronAPI?.getWorkflowMetrics?.();
          set({ metrics: metrics || null, metricsLoading: false });
        } catch (error) {
          console.error('Failed to load workflow metrics:', error);
          set({ metricsLoading: false });
        }
      },

      resetSettings: () => {
        set({ settings: DEFAULT_WORKFLOW_OPTIMIZATION_SETTINGS });
      },
    }),
    {
      name: 'workflow-optimization-settings',
      partialize: (state) => ({ settings: state.settings }),
    },
  ),
);
