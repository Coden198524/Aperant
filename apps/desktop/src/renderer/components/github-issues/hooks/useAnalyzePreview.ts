import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeGitHubErrorMessage } from '../../../lib/github-error-localizer';
import { createTask } from '../../../stores/task-store';
import type {
  AnalyzePreviewResult,
  AnalyzePreviewProgress,
  ProposedBatch,
} from '../../../../preload/api/modules/github-api';
import type { TaskMetadata } from '../../../../shared/types';

interface UseAnalyzePreviewProps {
  projectId: string;
}

interface UseAnalyzePreviewReturn {
  // State
  isWizardOpen: boolean;
  isAnalyzing: boolean;
  isApproving: boolean;
  analysisProgress: AnalyzePreviewProgress | null;
  analysisResult: AnalyzePreviewResult | null;
  analysisError: string | null;

  // Actions
  openWizard: () => void;
  closeWizard: () => void;
  startAnalysis: () => void;
  approveBatches: (batches: ProposedBatch[]) => Promise<void>;
}

export function useAnalyzePreview({ projectId }: UseAnalyzePreviewProps): UseAnalyzePreviewReturn {
  const { t } = useTranslation(['common', 'dialogs']);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalyzePreviewProgress | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalyzePreviewResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const localizeAnalyzePreviewMessage = useCallback((message: string): string => {
    if (message === 'Fetching issues for analysis...') {
      return t('issues.batchReview.progress.fetching', {
        defaultValue: 'Fetching issues for analysis...'
      });
    }

    const analyzingMatch = message.match(/^Analyzing (\d+) issues\.\.\.$/u);
    if (analyzingMatch) {
      return t('issues.batchReview.progress.analyzingCount', {
        count: Number(analyzingMatch[1]),
        defaultValue: 'Analyzing {{count}} issues...'
      });
    }

    return message;
  }, [t]);

  // Subscribe to analysis events
  useEffect(() => {
    if (!projectId) return;

    const cleanupProgress = window.electronAPI.github.onAnalyzePreviewProgress(
      (eventProjectId, progress) => {
        if (eventProjectId === projectId) {
          setAnalysisProgress({
            ...progress,
            message: localizeAnalyzePreviewMessage(progress.message)
          });
        }
      }
    );

    const cleanupComplete = window.electronAPI.github.onAnalyzePreviewComplete(
      (eventProjectId, result) => {
        if (eventProjectId === projectId) {
          setIsAnalyzing(false);
          setAnalysisResult(result);
          setAnalysisError(null);
        }
      }
    );

    const cleanupError = window.electronAPI.github.onAnalyzePreviewError(
      (eventProjectId, error) => {
        if (eventProjectId === projectId) {
          setIsAnalyzing(false);
          setAnalysisError(localizeGitHubErrorMessage(t, error.error) || error.error);
        }
      }
    );

    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [projectId, localizeAnalyzePreviewMessage]);

  const openWizard = useCallback(() => {
    setIsWizardOpen(true);
    // Reset state when opening
    setAnalysisProgress(null);
    setAnalysisResult(null);
    setAnalysisError(null);
  }, []);

  const closeWizard = useCallback(() => {
    setIsWizardOpen(false);
    // Reset state when closing
    setIsAnalyzing(false);
    setIsApproving(false);
    setAnalysisProgress(null);
    setAnalysisResult(null);
    setAnalysisError(null);
  }, []);

  const startAnalysis = useCallback(() => {
    if (!projectId) return;

    setIsAnalyzing(true);
    setAnalysisProgress(null);
    setAnalysisResult(null);
    setAnalysisError(null);

    // Call the API to start analysis (max 200 issues)
    window.electronAPI.github.analyzeIssuesPreview(projectId, undefined, 200);
  }, [projectId]);

  const approveBatches = useCallback(async (batches: ProposedBatch[]) => {
    if (!projectId || batches.length === 0) return;

    setIsApproving(true);
    try {
      const result = await window.electronAPI.github.approveBatches(projectId, batches);
      if (!result.success) {
        throw new Error(
          localizeGitHubErrorMessage(t, result.error) ||
            t('issues.taskGeneration.approveFailed', {
              defaultValue: 'Failed to approve batches'
            })
        );
      }

      // Create tasks for each approved batch
      for (const batch of batches) {
        const issueNumbers = batch.issues.map(i => i.issueNumber);
        const isSingleIssue = issueNumbers.length === 1;

        // Build task title
        const batchTheme = batch.theme || issueNumbers.map(n => `#${n}`).join(', ');
        const title = isSingleIssue
          ? t('issues.taskGeneration.singleIssueTitle', {
              number: issueNumbers[0],
              title: batch.issues[0].title,
              defaultValue: 'GitHub Issue #{{number}}: {{title}}'
            })
          : t('issues.taskGeneration.batchTitle', {
              theme: batchTheme,
              defaultValue: 'GitHub Issues: {{theme}}'
            });

        // Build task description
        const issueList = batch.issues
          .map(i => `- #${i.issueNumber}: ${i.title}`)
          .join('\n');

        const description = isSingleIssue
          ? batch.issues[0].title
          : t('issues.taskGeneration.batchDescription', {
              issueList,
              commonThemes: batch.commonThemes.join(', ') || t('issues.taskGeneration.noCommonThemes', {
                defaultValue: 'None'
              }),
              reasoning: batch.reasoning,
              defaultValue: '**Issues in this batch:**\n{{issueList}}\n\n**Common themes:** {{commonThemes}}\n\n**Reasoning:** {{reasoning}}'
            });

        // Build metadata
        const metadata: TaskMetadata = {
          sourceType: 'github',
          githubIssueNumbers: issueNumbers,
          githubIssueNumber: isSingleIssue ? issueNumbers[0] : undefined,
          githubBatchTheme: batch.theme,
        };

        // Create the task
        await createTask(projectId, title, description, metadata);
      }
    } catch (error) {
      setAnalysisError(
        error instanceof Error
          ? localizeGitHubErrorMessage(t, error.message) || error.message
          : t('issues.taskGeneration.approveFailed', {
              defaultValue: 'Failed to approve batches'
            })
      );
      throw error;
    } finally {
      setIsApproving(false);
    }
  }, [projectId, t]);

  return {
    isWizardOpen,
    isAnalyzing,
    isApproving,
    analysisProgress,
    analysisResult,
    analysisError,
    openWizard,
    closeWizard,
    startAnalysis,
    approveBatches,
  };
}
