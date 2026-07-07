/**
 * Workflow Optimization Settings Component
 * =========================================
 *
 * UI for configuring workflow optimization settings.
 */

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkflowOptimizationStore } from '@/stores/workflow-optimization-store';
import {
  getOptimizationLevelDescription,
  estimatePerformanceImprovement,
} from '../../../main/ai/orchestration/workflow-config';
import type { OptimizationLevel } from '../../../main/ai/orchestration/workflow-config';

export function WorkflowOptimizationSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const {
    settings,
    metrics,
    metricsLoading,
    setOptimizationLevel,
    toggleAdvancedSettings,
    updateAdvancedRetries,
    updateAdvancedQualityChecks,
    setSpecCreationMode,
    loadMetrics,
    resetSettings,
  } = useWorkflowOptimizationStore();

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const handleOptimizationLevelChange = (level: OptimizationLevel) => {
    setOptimizationLevel(level);
  };

  const renderOptimizationLevelCard = (level: OptimizationLevel) => {
    const isSelected = settings.optimizationLevel === level;
    const description = getOptimizationLevelDescription(level);
    const improvement = estimatePerformanceImprovement(level);

    return (
      <div
        key={level}
        className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
          isSelected
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
        }`}
        onClick={() => handleOptimizationLevelChange(level)}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold capitalize">{level}</h3>
          {isSelected && (
            <span className="text-xs bg-blue-500 text-white px-2 py-1 rounded">
              {t('common:active')}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{description}</p>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-gray-500 dark:text-gray-400">Time</div>
            <div className="font-semibold text-green-600 dark:text-green-400">
              {improvement.timeReduction}
            </div>
          </div>
          <div>
            <div className="text-gray-500 dark:text-gray-400">Tokens</div>
            <div className="font-semibold text-green-600 dark:text-green-400">
              {improvement.tokenReduction}
            </div>
          </div>
          <div>
            <div className="text-gray-500 dark:text-gray-400">Success</div>
            <div className="font-semibold">{improvement.successRate}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold mb-2">{t('settings:workflowOptimization.title')}</h2>
        <p className="text-gray-600 dark:text-gray-400">
          {t('settings:workflowOptimization.description')}
        </p>
      </div>

      {/* Optimization Level Selection */}
      <div>
        <h3 className="text-lg font-semibold mb-3">
          {t('settings:workflowOptimization.optimizationLevel')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {renderOptimizationLevelCard('conservative')}
          {renderOptimizationLevelCard('balanced')}
          {renderOptimizationLevelCard('aggressive')}
        </div>
      </div>

      {/* Performance Metrics */}
      {metrics && !metricsLoading && (
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
          <h3 className="text-lg font-semibold mb-3">
            {t('settings:workflowOptimization.performanceMetrics')}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Total Tasks</div>
              <div className="text-2xl font-bold">{metrics.totalTasks}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Avg Time</div>
              <div className="text-2xl font-bold">
                {(metrics.avgCompletionTime / 1000 / 60).toFixed(1)}m
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Avg Tokens</div>
              <div className="text-2xl font-bold">
                {(metrics.avgTokenUsage / 1000).toFixed(1)}K
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Success Rate</div>
              <div className="text-2xl font-bold">{(metrics.successRate * 100).toFixed(1)}%</div>
            </div>
          </div>

          {/* Comparison by Level */}
          <div className="mt-4">
            <h4 className="text-sm font-semibold mb-2">By Optimization Level</h4>
            <div className="space-y-2">
              {(['conservative', 'balanced', 'aggressive'] as const).map((level) => {
                const levelMetrics = metrics.tasksByLevel[level];
                const avgTime = metrics.avgTimeByLevel[level];
                const avgTokens = metrics.avgTokensByLevel[level];
                if (levelMetrics === 0) return null;

                return (
                  <div
                    key={level}
                    className="flex items-center justify-between text-sm p-2 bg-white dark:bg-gray-700 rounded"
                  >
                    <span className="capitalize font-medium">{level}</span>
                    <div className="flex gap-4 text-xs">
                      <span>{levelMetrics} tasks</span>
                      <span>{(avgTime / 1000 / 60).toFixed(1)}m</span>
                      <span>{(avgTokens / 1000).toFixed(1)}K tokens</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Advanced Settings */}
      <div>
        <button
          onClick={toggleAdvancedSettings}
          className="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          {settings.showAdvancedSettings ? '▼' : '▶'} Advanced Settings
        </button>

        {settings.showAdvancedSettings && (
          <div className="mt-4 space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
            {/* Retry Configuration */}
            <div>
              <h4 className="text-sm font-semibold mb-2">Retry Limits</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-600 dark:text-gray-400">
                    Planning Retries
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={settings.advancedRetries?.maxPlanningRetries ?? 1}
                    onChange={(e) =>
                      updateAdvancedRetries({ maxPlanningRetries: Number(e.target.value) })
                    }
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 dark:text-gray-400">
                    Subtask Retries
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={settings.advancedRetries?.maxSubtaskRetries ?? 2}
                    onChange={(e) =>
                      updateAdvancedRetries({ maxSubtaskRetries: Number(e.target.value) })
                    }
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 dark:text-gray-400">QA Cycles</label>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={settings.advancedRetries?.maxQACycles ?? 1}
                    onChange={(e) =>
                      updateAdvancedRetries({ maxQACycles: Number(e.target.value) })
                    }
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 dark:text-gray-400">
                    Planning Phase Retries
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={settings.advancedRetries?.maxSpecPhaseRetries ?? 1}
                    onChange={(e) =>
                      updateAdvancedRetries({ maxSpecPhaseRetries: Number(e.target.value) })
                    }
                    className="w-full px-2 py-1 text-sm border rounded"
                  />
                </div>
              </div>
            </div>

            {/* Quality Checks */}
            <div>
              <h4 className="text-sm font-semibold mb-2">Quality Checks</h4>
              <div className="space-y-2">
                {[
                  { key: 'enableSmokeTests', label: 'Pre-QA Smoke Tests' },
                  { key: 'enablePatternInjection', label: 'Pattern Injection' },
                  { key: 'enableSelfCritique', label: 'Self-Critique' },
                  { key: 'enablePreImplementationChecklist', label: 'Pre-Implementation Checklist' },
                  { key: 'enableTieredQualityStandards', label: 'Tiered Quality Standards' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={
                        settings.advancedQualityChecks?.[
                          key as keyof typeof settings.advancedQualityChecks
                        ] ?? false
                      }
                      onChange={(e) =>
                        updateAdvancedQualityChecks({
                          [key]: e.target.checked,
                        })
                      }
                      className="rounded"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            {/* Standard Planning Mode */}
            <div>
              <h4 className="text-sm font-semibold mb-2">Standard Planning Mode</h4>
              <select
                value={settings.specCreationMode ?? 'auto'}
                onChange={(e) =>
                  setSpecCreationMode(e.target.value as 'unified' | 'phased' | 'auto')
                }
                className="w-full px-2 py-1 text-sm border rounded"
              >
                <option value="auto">Auto (Recommended)</option>
                <option value="phased">Phased (Separate stages)</option>
                <option value="unified">Unified (Single stage)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Reset Button */}
      <div className="flex justify-end">
        <button
          onClick={resetSettings}
          className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
