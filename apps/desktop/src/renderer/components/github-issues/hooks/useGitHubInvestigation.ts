import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useInvestigationStore,
  useIssuesStore,
  investigateGitHubIssue
} from '../../../stores/github';
import { localizeGitHubErrorMessage } from '../../../lib/github-error-localizer';
import { loadTasks } from '../../../stores/task-store';
import type { GitHubIssue } from '../../../../shared/types';

export function useGitHubInvestigation(projectId: string | undefined) {
  const { t } = useTranslation(['common', 'dialogs']);
  const {
    investigationStatus,
    lastInvestigationResult,
    setInvestigationStatus,
    setInvestigationResult
  } = useInvestigationStore();

  const { setError } = useIssuesStore();

  const localizeInvestigationMessage = useCallback((message: string): string => {
    if (message === 'Fetching issue details...') {
      return t('issues.investigation.progress.fetching', {
        defaultValue: 'Fetching issue details...'
      });
    }

    if (message === 'AI is analyzing the issue...') {
      return t('issues.investigation.progress.analyzing', {
        defaultValue: 'AI is analyzing the issue...'
      });
    }

    if (message === 'Creating task from investigation...') {
      return t('issues.investigation.progress.creatingTask', {
        defaultValue: 'Creating task from investigation...'
      });
    }

    if (message === 'Investigation complete!') {
      return t('issues.investigation.progress.complete', {
        defaultValue: 'Investigation complete!'
      });
    }

    return message;
  }, [t]);

  // Set up event listeners for investigation progress
  useEffect(() => {
    if (!projectId) return;

    const cleanupProgress = window.electronAPI.onGitHubInvestigationProgress(
      (eventProjectId, status) => {
        if (eventProjectId === projectId) {
          setInvestigationStatus({
            ...status,
            message: localizeInvestigationMessage(status.message)
          });
        }
      }
    );

    const cleanupComplete = window.electronAPI.onGitHubInvestigationComplete(
      (eventProjectId, result) => {
        if (eventProjectId === projectId) {
          setInvestigationResult(result);
          // Refresh the task store so the new task appears on the Kanban board
          if (result.success && result.taskId) {
            loadTasks(projectId);
          }
        }
      }
    );

    const cleanupError = window.electronAPI.onGitHubInvestigationError(
      (eventProjectId, error) => {
        if (eventProjectId === projectId) {
          const localizedError = localizeGitHubErrorMessage(t, error) || error;
          setError(localizedError);
          setInvestigationStatus({
            phase: 'error',
            progress: 0,
            message: localizedError
          });
        }
      }
    );

    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [projectId, setInvestigationStatus, setInvestigationResult, setError, localizeInvestigationMessage]);

  const startInvestigation = useCallback((issue: GitHubIssue, selectedCommentIds: number[]) => {
    if (projectId) {
      investigateGitHubIssue(projectId, issue.number, selectedCommentIds);
    }
  }, [projectId]);

  const resetInvestigationStatus = useCallback(() => {
    setInvestigationStatus({ phase: 'idle', progress: 0, message: '' });
  }, [setInvestigationStatus]);

  return {
    investigationStatus,
    lastInvestigationResult,
    startInvestigation,
    resetInvestigationStatus
  };
}
