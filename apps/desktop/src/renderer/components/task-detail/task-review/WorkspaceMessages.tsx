import { AlertCircle, GitMerge, Loader2, Check, RotateCcw, Play } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { persistTaskStatus, startTaskOrQueue } from '../../../stores/task-store';
import { isDirectDevelopmentTask } from '../../../../shared/utils/task-mode';
import type { Task } from '../../../../shared/types';
import { NeedsInputDecisionDialog } from './NeedsInputDecisionDialog';

interface LoadingMessageProps {
  message?: string;
}

/**
 * Displays a loading indicator while workspace info is being fetched
 */
export function LoadingMessage({ message }: LoadingMessageProps) {
  const { t } = useTranslation('taskReview');

  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">
          {message ||
            t('workspaceMessages.loading', {
              defaultValue: 'Loading workspace info...'
            })}
        </span>
      </div>
    </div>
  );
}

interface NoWorkspaceMessageProps {
  task?: Task;
  onClose?: () => void;
}

/**
 * Displays message when no workspace is found for the task
 */
export function NoWorkspaceMessage({ task, onClose }: NoWorkspaceMessageProps) {
  const { t } = useTranslation(['taskReview', 'tasks']);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isProceeding, setIsProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDecisionDialog, setShowDecisionDialog] = useState(false);
  const isDirectModeTask = isDirectDevelopmentTask(task);

  const isPlanReview =
    task?.status === 'human_review' &&
    task.reviewReason === 'plan_review';
  const isNeedsInput =
    task?.status === 'human_review' &&
    task.reviewReason === 'needs_input';
  const isErrorRecovery =
    !!task &&
    (
      task.status === 'error' ||
      task.reviewReason === 'errors' ||
      task.reviewReason === 'stopped'
    );
  const canResumeExecution =
    !!task &&
    (
      isPlanReview ||
      isNeedsInput ||
      isErrorRecovery
    );

  const handleMarkDone = async () => {
    if (!task) return;

    setIsMarkingDone(true);
    try {
      await persistTaskStatus(task.id, 'done', { projectId: task.projectId });
      // Auto-close modal after marking as done
      onClose?.();
    } catch (err) {
      console.error('Error marking task as done:', err);
    } finally {
      setIsMarkingDone(false);
    }
  };

  const handleProceedToCoding = async () => {
    if (!task) return;

    setIsProceeding(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startTaskOrQueue(task.id, task.projectId);
      if (!result.success) {
        setError(result.error || t('tasks:wizard.errors.startFailed'));
      } else if (result.action === 'queued') {
        setNotice(t('tasks:queue.movedToQueue'));
      }
    } catch (err) {
      console.error('Error proceeding to coding:', err);
      setError(
        err instanceof Error ? err.message : t('tasks:wizard.errors.startFailed')
      );
    } finally {
      setIsProceeding(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-4">
      <h3 className="font-medium text-sm text-foreground mb-2 flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-muted-foreground" />
        {isNeedsInput
          ? t('workspaceMessages.needsInputTitle', {
              defaultValue: 'Your Input Needed'
            })
          : isPlanReview
          ? t('workspaceMessages.planReviewTitle', {
              defaultValue: 'Human Review Required'
            })
          : isDirectModeTask
            ? t('workspaceMessages.directModeTitle', {
                defaultValue: 'Direct Mode Task'
              })
          : t('workspaceMessages.noWorkspaceTitle', {
              defaultValue: 'No Workspace Found'
            })}
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        {isNeedsInput
          ? t('workspaceMessages.needsInputDescription', {
              defaultValue:
                'Planning is paused because the independent design review is blocked on open questions only you can resolve. Review the open questions in the task log / design_review, update requirements.md or spec.md, then re-run planning.'
            })
          : isPlanReview
          ? t('workspaceMessages.planReviewDescription', {
              defaultValue:
                'Human review required prior to coding. Review your spec.md for any necessary changes.'
            })
          : isDirectModeTask
            ? t('workspaceMessages.directModeDescription', {
                defaultValue:
                  'This task is running in direct mode and does not create an isolated workspace. Changes are applied directly to your project branch.'
              })
          : t('workspaceMessages.noWorkspaceDescription', {
              defaultValue:
                'No isolated workspace was found for this task. The changes may have been made directly in your project.'
            })}
      </p>

      {/* Allow marking as done */}
      {canResumeExecution ? (
        <Button
          onClick={isNeedsInput ? () => setShowDecisionDialog(true) : handleProceedToCoding}
          disabled={isProceeding}
          size="sm"
          variant="default"
          className="w-full"
        >
          {isProceeding ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('workspaceMessages.updating', {
                defaultValue: 'Updating...'
              })}
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-2" />
              {isNeedsInput
                ? t('workspaceMessages.rerunPlanning', {
                    defaultValue: 'Re-run Planning'
                  })
                : isPlanReview
                ? t('workspaceMessages.proceedToCoding', {
                    defaultValue: 'Proceed to Coding'
                  })
                : isErrorRecovery
                  ? t('workspaceMessages.retryExecution', {
                      defaultValue: 'Retry Execution'
                    })
                  : t('workspaceMessages.continueExecution', {
                      defaultValue: 'Continue Execution'
                    })}
            </>
          )}
        </Button>
      ) : task && task.status === 'human_review' && (
        <Button
          onClick={handleMarkDone}
          disabled={isMarkingDone}
          size="sm"
          variant="default"
          className="w-full"
        >
          {isMarkingDone ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('workspaceMessages.updating', {
                defaultValue: 'Updating...'
              })}
            </>
          ) : (
            <>
              <Check className="h-4 w-4 mr-2" />
              {t('stagedSuccess.markAsDone', {
                defaultValue: 'Mark as Done'
              })}
            </>
          )}
        </Button>
      )}

      {error && (
        <p className="text-xs text-destructive mt-2">{error}</p>
      )}
      {notice && (
        <p className="text-xs text-muted-foreground mt-2">{notice}</p>
      )}

      {isNeedsInput && task && (
        <NeedsInputDecisionDialog
          open={showDecisionDialog}
          onOpenChange={setShowDecisionDialog}
          taskId={task.id}
          projectId={task.projectId}
          onResolved={handleProceedToCoding}
        />
      )}
    </div>
  );
}

interface StagedInProjectMessageProps {
  task: Task;
  projectPath?: string;
  hasWorktree?: boolean;
  onClose?: () => void;
  onReviewAgain?: () => void;
}

/**
 * Displays message when changes have already been staged in the main project
 */
export function StagedInProjectMessage({ task, projectPath, hasWorktree = false, onClose, onReviewAgain }: StagedInProjectMessageProps) {
  const { t } = useTranslation(['taskReview', 'common']);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDeleteWorktreeAndMarkDone = async () => {
    setIsDeleting(true);
    setError(null);

    try {
      // Call the discard/delete worktree command
      // Pass skipStatusChange=true to prevent backend from resetting to 'backlog'
      // since we explicitly set status to 'done' immediately after
      const result = await window.electronAPI.discardWorktree(task.id, true, task.projectId);

      if (!result.success) {
        setError(
          result.error ||
            t('stagedSuccess.errors.failedToDeleteWorktree', {
              defaultValue: 'Failed to delete worktree'
            })
        );
        return;
      }

      // Mark task as done - check result since worktree is already deleted
      const statusResult = await persistTaskStatus(task.id, 'done', { projectId: task.projectId });
      if (!statusResult.success) {
        // Worktree is already deleted but status update failed - inform user of inconsistent state
        setError(
          t('stagedSuccess.errors.worktreeDeletedButStatusFailed', {
            error: statusResult.error || t('common:errors.unknownError'),
            defaultValue: 'Worktree deleted but failed to update task status: {{error}}'
          })
        );
        return;
      }

      // Auto-close modal after marking as done
      onClose?.();
    } catch (err) {
      console.error('Error deleting worktree:', err);
      setError(
        err instanceof Error
          ? err.message
          : t('stagedSuccess.errors.failedToDeleteWorktree', {
              defaultValue: 'Failed to delete worktree'
            })
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMarkDoneOnly = async () => {
    setIsMarkingDone(true);
    setError(null);

    try {
      const result = await persistTaskStatus(task.id, 'done', { keepWorktree: true, projectId: task.projectId });
      if (!result.success) {
        setError(
          result.error ||
            t('stagedSuccess.errors.failedToMarkAsDone', {
              defaultValue: 'Failed to mark as done'
            })
        );
        return;
      }
      onClose?.();
    } catch (err) {
      console.error('Error marking task as done:', err);
      setError(
        err instanceof Error
          ? err.message
          : t('stagedSuccess.errors.failedToMarkAsDone', {
              defaultValue: 'Failed to mark as done'
            })
      );
    } finally {
      setIsMarkingDone(false);
    }
  };

  const handleReviewAgain = async () => {
    if (!onReviewAgain) return;

    setIsResetting(true);
    setError(null);

    try {
      // Clear the staged flag via IPC
      const result = await window.electronAPI.clearStagedState(task.id, task.projectId);

      if (!result.success) {
        setError(
          result.error ||
            t('stagedSuccess.errors.failedToResetStagedState', {
              defaultValue: 'Failed to reset staged state'
            })
        );
        return;
      }

      // Trigger re-render by calling parent callback
      onReviewAgain();
    } catch (err) {
      console.error('Error resetting staged state:', err);
      setError(
        err instanceof Error
          ? err.message
          : t('stagedSuccess.errors.failedToResetStagedState', {
              defaultValue: 'Failed to reset staged state'
            })
      );
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="rounded-xl border border-success/30 bg-success/10 p-4">
      <h3 className="font-medium text-sm text-foreground mb-2 flex items-center gap-2">
        <GitMerge className="h-4 w-4 text-success" />
        {t('workspaceMessages.stagedInProjectTitle', {
          defaultValue: 'Changes Staged in Project'
        })}
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        {task.stagedAt
          ? t('workspaceMessages.stagedInProjectDescriptionWithDate', {
              date: new Date(task.stagedAt).toLocaleDateString(),
              defaultValue:
                "This task's changes have been staged in your main project on {{date}}."
            })
          : t('workspaceMessages.stagedInProjectDescription', {
              defaultValue:
                "This task's changes have been staged in your main project."
            })}
      </p>
      <div className="bg-background/50 rounded-lg p-3 mb-3">
        <p className="text-xs text-muted-foreground mb-2">
          {t('stagedSuccess.nextSteps', {
            defaultValue: 'Next steps:'
          })}
        </p>
        <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
          <li>
            {t('stagedSuccess.reviewChanges', {
              defaultValue: 'Review staged changes with'
            })}{' '}
            <code className="bg-background px-1 rounded">git status</code> and{' '}
            <code className="bg-background px-1 rounded">git diff --staged</code>
          </li>
          <li>
            {t('stagedSuccess.commitWhenReady', {
              defaultValue: 'Commit when ready:'
            })}{' '}
            <code className="bg-background px-1 rounded">git commit -m "your message"</code>
          </li>
          <li>
            {t('stagedSuccess.pushToRemote', {
              defaultValue: 'Push to remote when satisfied'
            })}
          </li>
        </ol>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          {/* Primary action: Mark Done or Delete Worktree & Mark Done */}
          {hasWorktree ? (
            <Button
              onClick={handleDeleteWorktreeAndMarkDone}
              disabled={isDeleting || isMarkingDone || isResetting}
              size="sm"
              variant="default"
              className="flex-1"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('stagedSuccess.cleaningUp', {
                    defaultValue: 'Cleaning up...'
                  })}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {t('stagedSuccess.deleteWorktreeAndMarkDone', {
                    defaultValue: 'Delete Worktree & Mark Done'
                  })}
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleMarkDoneOnly}
              disabled={isDeleting || isMarkingDone || isResetting}
              size="sm"
              variant="default"
              className="flex-1"
            >
              {isMarkingDone ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('stagedSuccess.markingDone', {
                    defaultValue: 'Marking done...'
                  })}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {t('stagedSuccess.markAsDone', {
                    defaultValue: 'Mark as Done'
                  })}
                </>
              )}
            </Button>
          )}
        </div>

        {/* Secondary actions row */}
        <div className="flex gap-2">
          {/* Mark Done Only (when worktree exists) - allows keeping worktree */}
          {hasWorktree && (
            <Button
              onClick={handleMarkDoneOnly}
              disabled={isDeleting || isMarkingDone || isResetting}
              size="sm"
              variant="outline"
              className="flex-1"
            >
              {isMarkingDone ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('stagedSuccess.markingDone', {
                    defaultValue: 'Marking done...'
                  })}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {t('stagedSuccess.markDoneOnly', {
                    defaultValue: 'Mark Done Only'
                  })}
                </>
              )}
            </Button>
          )}

          {/* Review Again button - only show if worktree exists and callback provided */}
          {hasWorktree && onReviewAgain && (
            <Button
              onClick={handleReviewAgain}
              disabled={isDeleting || isMarkingDone || isResetting}
              size="sm"
              variant="outline"
              className="flex-1"
            >
              {isResetting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('stagedSuccess.resetting', {
                    defaultValue: 'Resetting...'
                  })}
                </>
              ) : (
                <>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  {t('stagedSuccess.reviewAgain', {
                    defaultValue: 'Review Again'
                  })}
                </>
              )}
            </Button>
          )}
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        {hasWorktree && (
          <p className="text-xs text-muted-foreground">
            {t('stagedSuccess.worktreeExplanation', {
              defaultValue:
                '"Delete Worktree & Mark Done" cleans up the isolated workspace. "Mark Done Only" keeps it for reference.'
            })}
          </p>
        )}
      </div>
    </div>
  );
}
