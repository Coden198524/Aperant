import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useToast } from '../../hooks/use-toast';
import { Separator } from '../ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipProvider } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Play,
  Square,
  CheckCircle2,
  RotateCcw,
  Trash2,
  Loader2,
  AlertTriangle,
  Pencil,
  X,
  GitPullRequest
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { calculateProgress } from '../../lib/utils';
import { getTaskExecutionPhaseLabel } from '../../lib/i18n-labels';
import { stopTask, submitReview, recoverStuckTask, deleteTask, useTaskStore, startTaskOrQueue, loadTasks } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { TASK_STATUS_LABELS } from '../../../shared/constants';
import { TaskEditDialog } from '../TaskEditDialog';
import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskMetadata } from './TaskMetadata';
import { TaskWarnings } from './TaskWarnings';
import { TaskSubtasks } from './TaskSubtasks';
import { TaskLogs } from './TaskLogs';
import { TaskFiles } from './TaskFiles';
import { TaskGitChanges } from './TaskGitChanges';
import { TaskReview } from './TaskReview';
import type { Task, TaskLogPhase, WorktreeCreatePROptions } from '../../../shared/types';

interface TaskDetailModalProps {
  open: boolean;
  task: Task | null;
  onOpenChange: (open: boolean) => void;
  onSwitchToTerminals?: () => void;
  onOpenInbuiltTerminal?: (id: string, cwd: string) => void;
}

export function TaskDetailModal({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: TaskDetailModalProps) {
  // Do not mount the detail tree while closed. Several detail tabs perform
  // expensive markdown rendering or IPC loading, so keeping them unmounted
  // prevents background work from blocking the next open.
  if (!open || !task) {
    return null;
  }

  return (
    <TaskDetailModalContent
      open={open}
      task={task}
      onOpenChange={onOpenChange}
      onSwitchToTerminals={onSwitchToTerminals}
      onOpenInbuiltTerminal={onOpenInbuiltTerminal}
    />
  );
}

// Feature flag for Files tab (enabled by default, can be disabled via localStorage)
const isFilesTabEnabled = () => {
  const flag = localStorage.getItem('use_files_tab');
  return flag === null || flag === 'true'; // Enabled by default
};

const MODAL_WIDTH_STORAGE_KEY = 'task_detail_modal_width';
const DEFAULT_MODAL_WIDTH_RATIO = 0.92;
const MIN_MODAL_WIDTH = 760;
const MODAL_SIDE_MARGIN = 48;
const TAB_MOUNT_DELAY_MS = 80;

function getMaxModalWidth(): number {
  if (typeof window === 'undefined') {
    return 1280;
  }
  return Math.max(MIN_MODAL_WIDTH, window.innerWidth - MODAL_SIDE_MARGIN * 2);
}

function clampModalWidth(width: number): number {
  return Math.max(MIN_MODAL_WIDTH, Math.min(width, getMaxModalWidth()));
}

function getInitialModalWidth(): number {
  if (typeof window === 'undefined') {
    return 1280;
  }

  const saved = Number(localStorage.getItem(MODAL_WIDTH_STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) {
    return clampModalWidth(saved);
  }

  return clampModalWidth(Math.min(1280, window.innerWidth * DEFAULT_MODAL_WIDTH_RATIO));
}

function DeferredTabMount({
  active,
  label,
  children,
}: {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }

    const timer = window.setTimeout(() => {
      const scheduleFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 16));
      scheduleFrame(() => setReady(true));
    }, TAB_MOUNT_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{label}</span>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// Separate component to use hooks only when task exists
function TaskDetailModalContent({ open, task, onOpenChange, onSwitchToTerminals, onOpenInbuiltTerminal }: { open: boolean; task: Task; onOpenChange: (open: boolean) => void; onSwitchToTerminals?: () => void; onOpenInbuiltTerminal?: (id: string, cwd: string) => void }) {
  const { t } = useTranslation(['tasks', 'common']);
  const { toast } = useToast();
  const state = useTaskDetail({ task });
  const [isClearingLogs, setIsClearingLogs] = useState(false);
  const [modalWidth, setModalWidth] = useState(getInitialModalWidth);
  const resizeStateRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
  } | null>(null);
  const taskProject = useProjectStore((state) => state.projects.find((project) => project.id === task.projectId));
  const showFilesTab = isFilesTabEnabled();
  const progressPercent = calculateProgress(task.subtasks);
  const completedSubtasks = task.subtasks.filter(s => s.status === 'completed').length;
  const totalSubtasks = task.subtasks.length;
  const isCompletedTerminal =
    task.status === 'done' ||
    task.status === 'pr_created' ||
    (task.status === 'human_review' && task.reviewReason === 'completed');
  const isPlanningExecution = state.hasActiveExecution && state.executionPhase === 'planning';
  const isPlanningExecutionWithoutSubtasks = isPlanningExecution && totalSubtasks === 0;
  const planningProgressPercent = Math.round(
    Math.max(
      0,
      Math.min(100, task.executionProgress?.phaseProgress ?? task.executionProgress?.overallProgress ?? 0)
    )
  );
  const showHeaderProgress = isCompletedTerminal || isPlanningExecutionWithoutSubtasks || totalSubtasks > 0;
  const headerProgressPercent = isCompletedTerminal ? 100 : isPlanningExecutionWithoutSubtasks ? planningProgressPercent : progressPercent;
  const headerProgressLabel = isPlanningExecutionWithoutSubtasks
    ? (task.executionProgress?.message || getTaskExecutionPhaseLabel(t, 'planning'))
    : isCompletedTerminal
      ? t('tasks:detail.completedLabel', { defaultValue: 'Completed' })
    : t('tasks:detail.subtasksSummary', {
        completed: completedSubtasks,
        total: totalSubtasks,
        defaultValue: '{{completed}}/{{total}} subtasks'
      });

  // Event Handlers
  const handleStartStop = async () => {
    if (state.isRunning && !state.isStuck) {
      stopTask(task.id, task.projectId);
    } else {
      // If task is incomplete, validate and reload plan before starting
      if (state.isIncomplete) {
        const isValid = await state.reloadPlanForIncompleteTask();
        if (!isValid) {
          toast({
            title: t('tasks:detail.resumeBlockedTitle', { defaultValue: 'Cannot Resume Task' }),
            description: t('tasks:detail.resumeBlockedDescription', {
              defaultValue: 'Failed to load implementation plan. Please try again or check the task files.'
            }),
            variant: 'destructive',
            duration: 5000,
          });
          return;
        }
      }
      const result = await startTaskOrQueue(task.id, task.projectId);
      if (!result.success) {
        toast({
          title: t('tasks:wizard.errors.startFailed'),
          description: result.error,
          variant: 'destructive',
        });
      } else if (result.action === 'queued') {
        toast({ title: t('tasks:queue.movedToQueue') });
      }
    }
  };

  const handleRecover = async () => {
    state.setIsRecovering(true);
    const result = await recoverStuckTask(task.id, { autoRestart: true, projectId: task.projectId });
    if (result.success) {
      state.setIsStuck(false);
      state.setHasCheckedRunning(false);
    } else {
      toast({
        title: t('tasks:detail.recoverFailed', { defaultValue: 'Recovery failed' }),
        description: result.message,
        variant: 'destructive',
      });
    }
    state.setIsRecovering(false);
  };

  const handleReject = async () => {
    // Allow submission if there's text feedback OR images attached
    if (!state.feedback.trim() && state.feedbackImages.length === 0) {
      return;
    }
    state.setIsSubmitting(true);
    await submitReview(task.id, false, state.feedback, state.feedbackImages, task.projectId);
    state.setIsSubmitting(false);
    state.setFeedback('');
    state.setFeedbackImages([]);
  };

  const handleDelete = async () => {
    state.setIsDeleting(true);
    state.setDeleteError(null);
    const result = await deleteTask(task.id, task.projectId);
    if (result.success) {
      state.setShowDeleteDialog(false);
      onOpenChange(false);
    } else {
      state.setDeleteError(result.error || t('tasks:detail.deleteFailed', { defaultValue: 'Failed to delete task' }));
    }
    state.setIsDeleting(false);
  };

  const handleMerge = async () => {
    state.setIsMerging(true);
    state.setWorkspaceError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { noCommit: state.stageOnly }, task.projectId);
      if (result.success && result.data?.success) {
        if (state.stageOnly && result.data.staged) {
          state.setWorkspaceError(null);
          state.setStagedSuccess(result.data.message || t('tasks:detail.changesStaged', { defaultValue: 'Changes staged in main project' }));
          state.setStagedProjectPath(result.data.projectPath);
          state.setSuggestedCommitMessage(result.data.suggestedCommitMessage);
        } else {
          useTaskStore.getState().updateTaskStatus(task.id, 'done', undefined, task.projectId);
          void loadTasks(task.projectId, { forceRefresh: true });
          onOpenChange(false);
        }
      } else {
        state.setWorkspaceError(result.data?.message || result.error || t('tasks:detail.mergeFailed', { defaultValue: 'Failed to merge changes' }));
      }
    } catch (error) {
      state.setWorkspaceError(error instanceof Error ? error.message : t('tasks:detail.mergeUnknownError', { defaultValue: 'Unknown error during merge' }));
    } finally {
      state.setIsMerging(false);
    }
  };

  const handleDiscard = async () => {
    state.setIsDiscarding(true);
    state.setWorkspaceError(null);
    const result = await window.electronAPI.discardWorktree(task.id, undefined, task.projectId);
    if (result.success && result.data?.success) {
      state.setShowDiscardDialog(false);
      onOpenChange(false);
    } else {
      state.setWorkspaceError(result.data?.message || result.error || t('tasks:detail.discardFailed', { defaultValue: 'Failed to discard changes' }));
    }
    state.setIsDiscarding(false);
  };

  const handleClearLogs = async () => {
    setIsClearingLogs(true);
    try {
      const result = await window.electronAPI.clearTaskLogs(task.projectId, task.specId);
      if (result.success && result.data) {
        state.setPhaseLogs(result.data);
        state.setExpandedPhases(new Set<TaskLogPhase>());
        toast({
          title: t('tasks:logActions.clearSuccessTitle', { defaultValue: 'Logs cleared' }),
          description: t('tasks:logActions.clearSuccessDescription', { defaultValue: 'Task log list has been cleared.' }),
        });
      } else {
        toast({
          title: t('tasks:logActions.clearFailedTitle', { defaultValue: 'Failed to clear logs' }),
          description: result.error || t('tasks:logActions.clearFailedDescription', { defaultValue: 'Please try again.' }),
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: t('tasks:logActions.clearFailedTitle', { defaultValue: 'Failed to clear logs' }),
        description: error instanceof Error ? error.message : t('tasks:logActions.clearFailedDescription', { defaultValue: 'Please try again.' }),
        variant: 'destructive',
      });
    } finally {
      setIsClearingLogs(false);
    }
  };

  const handleCreatePR = async (options: WorktreeCreatePROptions) => {
    state.setIsCreatingPR(true);
    try {
      const result = await window.electronAPI.createWorktreePR(task.id, options, task.projectId);
      if (result.success && result.data) {
        // Update single task in store with new status and prUrl (more efficient than reloading all tasks)
        if (result.data.success && result.data.prUrl && !result.data.alreadyExists) {
          useTaskStore.getState().updateTask(task.id, {
            status: 'done',
            metadata: { ...task.metadata, prUrl: result.data.prUrl }
          }, task.projectId);
        }
        return result.data;
      }
      // Propagate IPC error; let CreatePRDialog use its i18n fallback
      return { success: false, error: result.error, prUrl: undefined, alreadyExists: false };
    } catch (error) {
      // Propagate actual error message; let CreatePRDialog handle i18n fallback for undefined
      return { success: false, error: error instanceof Error ? error.message : undefined, prUrl: undefined, alreadyExists: false };
    } finally {
      state.setIsCreatingPR(false);
    }
  };

  const handleClose = () => {
    // Show toast notification if task is running
    if (state.isRunning && !state.isStuck) {
      toast({
        title: t('tasks:notifications.backgroundTaskTitle'),
        description: t('tasks:notifications.backgroundTaskDescription'),
        duration: 4000,
      });
    }
    onOpenChange(false);
  };

  useEffect(() => {
    if (!open) return;

    const handleWindowResize = () => {
      setModalWidth(width => {
        const next = clampModalWidth(width);
        localStorage.setItem(MODAL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [open]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleResizeStart = (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startWidth: modalWidth,
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const delta = moveEvent.clientX - resizeState.startX;
      const direction = resizeState.side === 'right' ? 1 : -1;
      setModalWidth(clampModalWidth(resizeState.startWidth + delta * direction * 2));
    };

    const handlePointerUp = () => {
      resizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setModalWidth(width => {
        const next = clampModalWidth(width);
        localStorage.setItem(MODAL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  // Helper function to get status badge variant
  const getStatusBadgeVariant = (status: string, isStuck: boolean) => {
    if (isStuck) return 'warning';
    switch (status) {
      case 'done':
        return 'success';
      case 'human_review':
        return 'purple';
      case 'in_progress':
        return 'info';
      default:
        return 'secondary';
    }
  };

  // Render primary action button based on state
  const renderPrimaryAction = () => {
    if (state.isStuck) {
      return (
        <Button
          variant="warning"
          onClick={handleRecover}
          disabled={state.isRecovering}
        >
          {state.isRecovering ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:labels.recovering')}
            </>
          ) : (
            <>
              <RotateCcw className="mr-2 h-4 w-4" />
              {t('tasks:actions.recover')}
            </>
          )}
        </Button>
      );
    }

    if (state.isIncomplete) {
      return (
        <Button variant="default" onClick={handleStartStop} disabled={state.isLoadingPlan}>
          {state.isLoadingPlan ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:detail.loadingPlan', { defaultValue: 'Loading Plan...' })}
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t('tasks:actions.resume')}
            </>
          )}
        </Button>
      );
    }

    if (task.status === 'backlog' || task.status === 'in_progress') {
      return (
        <Button
          variant={state.isRunning ? 'destructive' : 'default'}
          onClick={handleStartStop}
        >
          {state.isRunning ? (
            <>
              <Square className="mr-2 h-4 w-4" />
              {t('tasks:actions.stop')}
            </>
          ) : (
            <>
              <Play className="mr-2 h-4 w-4" />
              {t('tasks:actions.start')}
            </>
          )}
        </Button>
      );
    }

    // In human review, users should generally be able to continue work unless it is
    // already in the "completed" review state awaiting final merge/close actions.
    if (task.status === 'human_review') {
      return (
        <Button variant="default" onClick={handleStartStop}>
          <Play className="mr-2 h-4 w-4" />
          {t('tasks:actions.resume')}
        </Button>
      );
    }

    if (task.status === 'error') {
      return (
        <Button variant="default" onClick={handleStartStop}>
          <Play className="mr-2 h-4 w-4" />
          {t('tasks:actions.resume')}
        </Button>
      );
    }

    if (task.status === 'done' && task.metadata?.prUrl) {
      return (
        <div className="flex items-center gap-4">
          <div className="completion-state text-sm flex items-center gap-2 text-success">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-medium">{t('tasks:status.complete')}</span>
          </div>
           {task.metadata?.prUrl && (
             <button
               type="button"
               onClick={() => {
                 if (task.metadata?.prUrl) {
                   window.electronAPI?.openExternal(task.metadata.prUrl);
                 }
               }}
               className="completion-state text-sm flex items-center gap-2 text-info cursor-pointer hover:underline bg-transparent border-none p-0"
             >
              <GitPullRequest className="h-5 w-5" />
              <span className="font-medium">{t(TASK_STATUS_LABELS[task.status])}</span>
            </button>
          )}
        </div>
      );
    }

    if (task.status === 'done') {
      return (
        <div className="completion-state text-sm flex items-center gap-2 text-success">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-medium">{t('tasks:status.complete')}</span>
        </div>
      );
    }

    return null;
  };


  return (
    <TooltipProvider delayDuration={300}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          {/* Semi-transparent overlay - can see background content */}
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50 bg-black/60',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
            )}
          />

          {/* Full-height centered modal content */}
          <DialogPrimitive.Content
            className={cn(
              'fixed inset-y-0 left-[50%] z-50',
              'translate-x-[-50%]',
              'h-screen',
              'bg-card border-x border-border rounded-none',
              'shadow-2xl overflow-visible flex flex-col',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
              'duration-200'
            )}
            style={{ width: `${modalWidth}px`, maxWidth: `calc(100vw - ${MODAL_SIDE_MARGIN * 2}px)` }}
          >
            <div
              className="absolute inset-y-0 -left-2.5 z-20 w-2.5 cursor-ew-resize touch-none hover:bg-primary/20"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('tasks:detail.resizeWidth', { defaultValue: 'Resize task detail width' })}
              onPointerDown={(event) => handleResizeStart('left', event)}
            />
            <div
              className="absolute inset-y-0 -right-2.5 z-20 w-2.5 cursor-ew-resize touch-none hover:bg-primary/20"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('tasks:detail.resizeWidth', { defaultValue: 'Resize task detail width' })}
              onPointerDown={(event) => handleResizeStart('right', event)}
            />
            {/* Header */}
            <div className="p-5 pb-4 border-b border-border shrink-0">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <DialogPrimitive.Title className="text-xl font-semibold leading-tight text-foreground truncate">
                    {task.title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description asChild>
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs font-mono">
                        {task.specId}
                      </Badge>
                      {state.isStuck ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="h-3 w-3" />
                          {t('tasks:labels.stuck')}
                        </Badge>
                      ) : state.isIncomplete ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {t('tasks:labels.incomplete')}
                          </Badge>
                      ) : (
                        <>
                           <Badge
                             variant={getStatusBadgeVariant(task.status, state.isStuck)}
                             className={cn('text-xs', (task.status === 'in_progress' && !state.isStuck) && 'status-running')}
                           >
                             {t(TASK_STATUS_LABELS[task.status])}
                           </Badge>
                          {task.status === 'human_review' && task.reviewReason && (
                            <Badge
                              variant={task.reviewReason === 'completed' ? 'success' : task.reviewReason === 'errors' ? 'destructive' : 'warning'}
                              className="text-xs"
                            >
                              {task.reviewReason === 'completed' ? t('tasks:reviewReason.completed') :
                               task.reviewReason === 'errors' ? t('tasks:reviewReason.hasErrors') :
                               task.reviewReason === 'plan_review' ? t('tasks:reviewReason.approvePlan') :
                               task.reviewReason === 'stopped' ? t('tasks:reviewReason.stopped') : t('tasks:reviewReason.qaIssues')}
                            </Badge>
                          )}
                        </>
                      )}
                      {/* Compact progress indicator */}
                      {totalSubtasks > 0 && (
                        <span className="text-xs text-muted-foreground ml-1">
                          {t('tasks:detail.subtasksSummary', {
                            completed: completedSubtasks,
                            total: totalSubtasks,
                            defaultValue: '{{completed}}/{{total}} subtasks'
                          })}
                        </span>
                      )}
                    </div>
                  </DialogPrimitive.Description>
                  {window.DEBUG && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                      status={task.status} reviewReason={task.reviewReason ?? 'none'} phase={task.executionProgress?.phase ?? 'none'} reviewRequired={task.metadata?.requireReviewBeforeCoding ? 'true' : 'false'}
                      <br />
                      projectId={taskProject?.id ?? 'none'} projectName={taskProject?.name ?? 'none'}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0 electron-no-drag">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hover:bg-primary/10 hover:text-primary transition-colors"
                    onClick={() => state.setIsEditDialogOpen(true)}
                    disabled={state.isRunning && !state.isStuck}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <DialogPrimitive.Close asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:bg-muted transition-colors"
                    >
                      <X className="h-5 w-5" />
                      <span className="sr-only">{t('common:buttons.close')}</span>
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </div>

              {/* Progress bar - show planning progress before subtasks exist */}
              {showHeaderProgress && (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground truncate">
                      {headerProgressLabel}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {headerProgressPercent}%
                    </span>
                  </div>
                  <Progress
                    value={headerProgressPercent}
                    className={cn(
                      'h-1.5',
                      isPlanningExecutionWithoutSubtasks && '[&>div]:bg-amber-500',
                      isCompletedTerminal && '[&>div]:bg-success'
                    )}
                  />
                </div>
              )}

              {/* Warnings - compact inline */}
              {(state.isStuck || state.isIncomplete) && (
                <div className="mt-3">
                  <TaskWarnings
                    isStuck={state.isStuck}
                    isIncomplete={state.isIncomplete}
                    isRecovering={state.isRecovering}
                    taskProgress={state.taskProgress}
                    onRecover={handleRecover}
                    onResume={handleStartStop}
                  />
                </div>
              )}
            </div>

            {/* Body - Single Column with Tabs */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Tabs value={state.activeTab} onValueChange={state.setActiveTab} className="flex flex-col h-full">
                <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent px-5 h-auto shrink-0">
                  <TabsTrigger
                    value="overview"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
                  >
                    {t('tasks:detail.tabs.overview', { defaultValue: 'Overview' })}
                  </TabsTrigger>
                  <TabsTrigger
                    value="subtasks"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
                  >
                    {t('tasks:detail.tabs.subtasks', {
                      count: task.subtasks.length,
                      defaultValue: 'Subtasks ({{count}})'
                    })}
                  </TabsTrigger>
                  <TabsTrigger
                    value="logs"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
                  >
                    {t('tasks:detail.tabs.logs', { defaultValue: 'Logs' })}
                  </TabsTrigger>
                  {showFilesTab && (
                    <TabsTrigger
                      value="files"
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
                    >
                      {t('tasks:files.tab')}
                    </TabsTrigger>
                  )}
                  <TabsTrigger
                    value="git"
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2.5 text-sm"
                  >
                    {t('tasks:gitChanges.tab')}
                  </TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <ScrollArea className="h-full">
                    <div className="p-5 space-y-5 overflow-x-hidden max-w-full">
                      {/* Metadata */}
                      <TaskMetadata task={task} />

                      {/* Human Review Section */}
                      {state.needsReview && (
                        <>
                          <Separator />
                          <TaskReview
                            task={task}
                            feedback={state.feedback}
                            isSubmitting={state.isSubmitting}
                            worktreeStatus={state.worktreeStatus}
                            worktreeDiff={state.worktreeDiff}
                            isLoadingWorktree={state.isLoadingWorktree}
                            isLoadingDiff={state.isLoadingDiff}
                            isMerging={state.isMerging}
                            isDiscarding={state.isDiscarding}
                            showDiscardDialog={state.showDiscardDialog}
                            showDiffDialog={state.showDiffDialog}
                            workspaceError={state.workspaceError}
                            stageOnly={state.stageOnly}
                            stagedSuccess={state.stagedSuccess}
                            stagedProjectPath={state.stagedProjectPath}
                            suggestedCommitMessage={state.suggestedCommitMessage}
                            mergePreview={state.mergePreview}
                            isLoadingPreview={state.isLoadingPreview}
                            showConflictDialog={state.showConflictDialog}
                            onFeedbackChange={state.setFeedback}
                            onReject={handleReject}
                            images={state.feedbackImages}
                            onImagesChange={state.setFeedbackImages}
                            onMerge={handleMerge}
                            onDiscard={handleDiscard}
                            onShowDiscardDialog={state.setShowDiscardDialog}
                            onShowDiffDialog={state.setShowDiffDialog}
                            onStageOnlyChange={state.setStageOnly}
                            onShowConflictDialog={state.setShowConflictDialog}
                            onLoadMergePreview={state.loadMergePreview}
                            onClose={handleClose}
                            onSwitchToTerminals={onSwitchToTerminals}
                            onOpenInbuiltTerminal={onOpenInbuiltTerminal}
                            onReviewAgain={state.handleReviewAgain}
                            showPRDialog={state.showPRDialog}
                            isCreatingPR={state.isCreatingPR}
                            onShowPRDialog={state.setShowPRDialog}
                            onCreatePR={handleCreatePR}
                          />
                        </>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* Subtasks Tab */}
                <TabsContent value="subtasks" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <DeferredTabMount
                    active={state.activeTab === 'subtasks'}
                    label={t('tasks:detail.loadingTab', { defaultValue: 'Loading...' })}
                  >
                    <TaskSubtasks task={task} />
                  </DeferredTabMount>
                </TabsContent>

                {/* Logs Tab */}
                <TabsContent value="logs" className="flex flex-1 min-h-0 flex-col overflow-hidden mt-0" data-testid="task-logs-tab">
                  <DeferredTabMount
                    active={state.activeTab === 'logs'}
                    label={t('tasks:detail.loadingLogs', { defaultValue: 'Loading logs...' })}
                  >
                    <>
                      <div
                        className="shrink-0 px-5 pt-3 pb-2 border-b border-border flex items-center justify-end"
                        data-testid="task-logs-actions"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleClearLogs}
                          disabled={isClearingLogs}
                        >
                          {isClearingLogs ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              {t('tasks:logActions.clearing', { defaultValue: 'Clearing...' })}
                            </>
                          ) : (
                            <>
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t('tasks:logActions.clearAction', { defaultValue: 'Clear Logs' })}
                            </>
                          )}
                        </Button>
                      </div>
                      <div className="flex-1 min-h-0">
                        <TaskLogs
                          task={task}
                          phaseLogs={state.phaseLogs}
                          isLoadingLogs={state.isLoadingLogs}
                          expandedPhases={state.expandedPhases}
                          isStuck={state.isStuck}
                          logsEndRef={state.logsEndRef}
                          logsContainerRef={state.logsContainerRef}
                          onLogsScroll={state.handleLogsScroll}
                          onTogglePhase={state.togglePhase}
                        />
                      </div>
                    </>
                  </DeferredTabMount>
                </TabsContent>

                {/* Files Tab */}
                {showFilesTab && (
                  <TabsContent value="files" className="flex-1 min-h-0 overflow-hidden mt-0">
                    <DeferredTabMount
                      active={state.activeTab === 'files'}
                      label={t('tasks:detail.loadingFiles', { defaultValue: 'Loading files...' })}
                    >
                      <TaskFiles task={task} />
                    </DeferredTabMount>
                  </TabsContent>
                )}

                {/* Git Changes Tab */}
                <TabsContent value="git" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <DeferredTabMount
                    active={state.activeTab === 'git'}
                    label={t('tasks:detail.loadingGitChanges', { defaultValue: 'Loading git changes...' })}
                  >
                    <TaskGitChanges task={task} />
                  </DeferredTabMount>
                </TabsContent>
              </Tabs>
            </div>

            {/* Footer - Actions */}
            <div className="flex items-center gap-3 px-5 py-3 border-t border-border shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => state.setShowDeleteDialog(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('tasks:actions.delete')}
              </Button>
              <div className="flex-1" />
              {renderPrimaryAction()}
              <Button variant="outline" onClick={handleClose}>
                {t('common:buttons.close')}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Edit Task Dialog */}
      <TaskEditDialog
        task={task}
        open={state.isEditDialogOpen}
        onOpenChange={state.setIsEditDialogOpen}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={state.showDeleteDialog} onOpenChange={state.setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('tasks:deleteDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  {t('tasks:deleteDialog.confirmMessage')} <strong className="text-foreground">"{task.title}"</strong>?
                </p>
                {state.isCheckingChanges && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('tasks:deleteDialog.checkingChanges')}
                  </div>
                )}
                {state.worktreeChangesInfo?.hasChanges && (
                  <div className="bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded-lg text-sm space-y-1">
                    <p className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" />
                      {t('tasks:deleteDialog.uncommittedChanges', { count: state.worktreeChangesInfo.changedFileCount })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('tasks:deleteDialog.uncommittedChangesHint')}
                    </p>
                  </div>
                )}
                <p className="text-destructive">
                  {t('tasks:deleteDialog.destructiveWarning')}
                </p>
                {state.deleteError && (
                  <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
                    {state.deleteError}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={state.isDeleting}>{t('tasks:deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={state.isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {state.isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('tasks:deleteDialog.deleting')}
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('tasks:deleteDialog.deletePermanently')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
