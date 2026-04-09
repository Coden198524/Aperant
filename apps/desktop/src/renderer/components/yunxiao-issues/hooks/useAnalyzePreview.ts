import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createTask } from '../../../stores/task-store';
import type {
  TaskMetadata,
  YunxiaoAnalyzePreviewProgress,
  YunxiaoAnalyzePreviewResult,
  YunxiaoProposedBatch,
} from '../../../../shared/types';

interface UseAnalyzePreviewProps {
  projectId: string;
}

interface UseAnalyzePreviewReturn {
  isWizardOpen: boolean;
  isAnalyzing: boolean;
  isApproving: boolean;
  analysisProgress: YunxiaoAnalyzePreviewProgress | null;
  analysisResult: YunxiaoAnalyzePreviewResult | null;
  analysisError: string | null;
  openWizard: () => void;
  closeWizard: () => void;
  startAnalysis: () => void;
  approveBatches: (batches: YunxiaoProposedBatch[]) => Promise<void>;
}

export function useAnalyzePreview({ projectId }: UseAnalyzePreviewProps): UseAnalyzePreviewReturn {
  const { t } = useTranslation('common');
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<YunxiaoAnalyzePreviewProgress | null>(null);
  const [analysisResult, setAnalysisResult] = useState<YunxiaoAnalyzePreviewResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const cleanupProgress = window.electronAPI.onYunxiaoAnalyzePreviewProgress((eventProjectId, progress) => {
      if (eventProjectId !== projectId) return;
      setAnalysisProgress(progress);
    });
    const cleanupComplete = window.electronAPI.onYunxiaoAnalyzePreviewComplete((eventProjectId, result) => {
      if (eventProjectId !== projectId) return;
      setIsAnalyzing(false);
      setAnalysisResult(result);
      setAnalysisError(null);
    });
    const cleanupError = window.electronAPI.onYunxiaoAnalyzePreviewError((eventProjectId, error) => {
      if (eventProjectId !== projectId) return;
      setIsAnalyzing(false);
      setAnalysisError(error.error);
    });

    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [projectId]);

  const openWizard = useCallback(() => {
    setIsWizardOpen(true);
    setIsAnalyzing(false);
    setIsApproving(false);
    setAnalysisProgress(null);
    setAnalysisResult(null);
    setAnalysisError(null);
  }, []);

  const closeWizard = useCallback(() => {
    setIsWizardOpen(false);
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
    window.electronAPI.analyzeYunxiaoIssuesPreview(projectId, undefined, 200);
  }, [projectId]);

  const approveBatches = useCallback(async (batches: YunxiaoProposedBatch[]) => {
    if (!projectId || batches.length === 0) return;

    setIsApproving(true);
    try {
      const result = await window.electronAPI.approveYunxiaoIssueBatches(projectId, batches);
      if (!result.success) {
        throw new Error(result.error || t('yunxiaoIssues.messages.approveBatchesFailed', {
          defaultValue: '保存云效分组失败',
        }));
      }

      for (const batch of batches) {
        const workItemIds = batch.issues.map((issue) => issue.workItemId);
        const isSingleIssue = workItemIds.length === 1;
        const firstIssue = batch.issues[0];
        const displayRef = firstIssue?.identifier || firstIssue?.workItemId || batch.primaryWorkItemId;

        const title = isSingleIssue
          ? t('yunxiaoIssues.taskGeneration.singleIssueTitle', {
              identifier: displayRef,
              title: firstIssue?.title || batch.theme,
              defaultValue: '云效缺陷 {{identifier}}：{{title}}',
            })
          : t('yunxiaoIssues.taskGeneration.batchTitle', {
              theme: batch.theme,
              defaultValue: '云效缺陷分组：{{theme}}',
            });

        const issueList = batch.issues
          .map((issue) => `- ${issue.identifier || issue.workItemId}: ${issue.title}`)
          .join('\n');

        const description = isSingleIssue
          ? `${displayRef}\n\n${firstIssue?.title || batch.theme}`
          : t('yunxiaoIssues.taskGeneration.batchDescription', {
              issueList,
              commonThemes: batch.commonThemes.join('、') || t('yunxiaoIssues.taskGeneration.noCommonThemes', {
                defaultValue: '无',
              }),
              reasoning: batch.reasoning,
              defaultValue: `**缺陷列表**\n${issueList}\n\n**共性主题**：${batch.commonThemes.join('、') || '无'}\n\n**分组原因**：${batch.reasoning}`,
            });

        const metadata: TaskMetadata = {
          sourceType: 'yunxiao',
          category: 'bug_fix',
          requireReviewBeforeCoding: true,
          yunxiaoWorkItemId: isSingleIssue ? workItemIds[0] : undefined,
          yunxiaoWorkItemIds: isSingleIssue ? undefined : workItemIds,
          yunxiaoIdentifier: isSingleIssue ? firstIssue?.identifier : undefined,
          yunxiaoBatchTheme: isSingleIssue ? undefined : batch.theme,
        };

        await createTask(projectId, title, description, metadata);
      }
    } catch (error) {
      setAnalysisError(
        error instanceof Error
          ? error.message
          : t('yunxiaoIssues.messages.approveBatchesFailed', {
              defaultValue: '保存云效分组失败',
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
