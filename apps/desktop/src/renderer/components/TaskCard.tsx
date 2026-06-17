import { useState, useEffect, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { buildAutocodeTaskCardViewModel } from '@autocode/core/frontend/task-view-model';
import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, Archive, GitPullRequest, MoreVertical, Trash2 } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { buildTokenHoverTitle, cn, formatTokenCount, sanitizeMarkdownForDisplay } from '../lib/utils';
import { resolveActiveSubtaskIndex } from '../lib/subtask-progress';
import { PhaseProgressIndicator } from './PhaseProgressIndicator';
import {
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  TASK_IMPACT_COLORS,
  TASK_PRIORITY_COLORS,
  EXECUTION_PHASE_BADGE_COLORS,
  TASK_STATUS_COLUMNS,
  TASK_STATUS_LABELS,
  JSON_ERROR_PREFIX,
  JSON_ERROR_TITLE_SUFFIX
} from '../../shared/constants';
import { stopTask, recoverStuckTask, isIncompleteHumanReview, archiveTasks, startTaskOrQueue, deleteTask } from '../stores/task-store';
import { useToast } from '../hooks/use-toast';
import { subscribeStuckTask } from '../lib/stuck-task-monitor';
import type { Task, TaskCategory, ReviewReason, TaskStatus } from '../../shared/types';
import {
  getTaskCategoryLabel,
  getTaskComplexityLabel,
  getTaskExecutionPhaseLabel,
  getTaskImpactLabel,
  getTaskPriorityLabel,
  getTaskSeverityLabel
} from '../lib/i18n-labels';

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Zap> = {
  feature: Target,
  bug_fix: Bug,
  refactoring: Wrench,
  documentation: FileCode,
  security: Shield,
  performance: Gauge,
  ui_ux: Palette,
  infrastructure: Wrench,
  testing: FileCode
};

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange?: (newStatus: TaskStatus) => unknown;
  // Optional selectable mode props for multi-selection
  isSelectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

function resolveCardDevelopmentMode(task: Task): 'direct' | 'standard' {
  if (task.metadata?.developmentMode === 'direct' || task.metadata?.developmentMode === 'standard') {
    return task.metadata.developmentMode;
  }
  if (task.metadata?.workflowMode === 'off') {
    return 'direct';
  }
  return 'standard';
}

// Custom comparator for React.memo - only re-render when relevant task data changes
function taskCardPropsAreEqual(prevProps: TaskCardProps, nextProps: TaskCardProps): boolean {
  const prevTask = prevProps.task;
  const nextTask = nextProps.task;

  // Fast path: same reference (include selectable props)
  if (
    prevTask === nextTask &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.onStatusChange === nextProps.onStatusChange &&
    prevProps.isSelectable === nextProps.isSelectable &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.onToggleSelect === nextProps.onToggleSelect
  ) {
    return true;
  }

  // Check selectable props first (cheap comparison)
  if (
    prevProps.isSelectable !== nextProps.isSelectable ||
    prevProps.isSelected !== nextProps.isSelected
  ) {
    return false;
  }

  // Compare only the fields that affect rendering
  const isEqual = (
    prevTask.id === nextTask.id &&
    prevTask.status === nextTask.status &&
    prevTask.title === nextTask.title &&
    prevTask.description === nextTask.description &&
    prevTask.updatedAt === nextTask.updatedAt &&
    prevTask.reviewReason === nextTask.reviewReason &&
    prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
    prevTask.executionProgress?.phaseProgress === nextTask.executionProgress?.phaseProgress &&
    prevTask.executionProgress?.currentSubtask === nextTask.executionProgress?.currentSubtask &&
    prevTask.subtasks.length === nextTask.subtasks.length &&
    prevTask.metadata?.category === nextTask.metadata?.category &&
    prevTask.metadata?.complexity === nextTask.metadata?.complexity &&
    prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
    prevTask.metadata?.prUrl === nextTask.metadata?.prUrl &&
    prevTask.tokenUsage?.stepsExecuted === nextTask.tokenUsage?.stepsExecuted &&
    prevTask.tokenUsage?.promptTokens === nextTask.tokenUsage?.promptTokens &&
    prevTask.tokenUsage?.completionTokens === nextTask.tokenUsage?.completionTokens &&
    prevTask.tokenUsage?.totalTokens === nextTask.tokenUsage?.totalTokens &&
    prevTask.subtasks.every((s, i) =>
      s.status === nextTask.subtasks[i]?.status &&
      s.title === nextTask.subtasks[i]?.title &&
      s.description === nextTask.subtasks[i]?.description &&
      s.completionSummary === nextTask.subtasks[i]?.completionSummary
    )
  );

  // Only log when actually re-rendering (reduces noise significantly)
  if (window.DEBUG && !isEqual) {
    const changes: string[] = [];
    if (prevTask.status !== nextTask.status) changes.push(`status: ${prevTask.status} -> ${nextTask.status}`);
    if (prevTask.executionProgress?.phase !== nextTask.executionProgress?.phase) {
      changes.push(`phase: ${prevTask.executionProgress?.phase} -> ${nextTask.executionProgress?.phase}`);
    }
    if (prevTask.subtasks.length !== nextTask.subtasks.length) {
      changes.push(`subtasks: ${prevTask.subtasks.length} -> ${nextTask.subtasks.length}`);
    }
    console.log(`[TaskCard] Re-render: ${prevTask.id} | ${changes.join(', ') || 'other fields'}`);
  }

  return isEqual;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onStatusChange,
  isSelectable,
  isSelected,
  onToggleSelect
}: TaskCardProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const { toast } = useToast();
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [worktreeChangesInfo, setWorktreeChangesInfo] = useState<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number } | null>(null);
  const [isCheckingChanges, setIsCheckingChanges] = useState(false);
  const taskView = useMemo(
    () => buildAutocodeTaskCardViewModel(task, null, { descriptionMaxLength: 120 }),
    [task]
  );

  const isRunning = task.status === 'in_progress';
  const isExecutionActive = task.status === 'in_progress' || task.status === 'ai_review';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed';
  const activeBatchCount = taskView.activeSubtaskCount;
  const hasParallelSubtasks = isRunning && taskView.hasParallelSubtasks;
  const developmentMode = resolveCardDevelopmentMode(task);

  // Check if task is in human_review but has no completed subtasks (crashed/incomplete)
  const isIncomplete = isIncompleteHumanReview(task);

  // Memoize expensive computations to avoid running on every render
  // Truncate description for card display - full description shown in modal
  // Handle JSON error tasks with i18n
  const sanitizedDescription = useMemo(() => {
    if (!task.description) return null;
    // Check for JSON error marker and use i18n
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      const translatedDesc = t('errors:task.jsonError.description', { error: errorMessage });
      return sanitizeMarkdownForDisplay(translatedDesc, 120);
    }
    return sanitizeMarkdownForDisplay(task.description, 120);
  }, [task.description, t]);

  // Memoize title with JSON error suffix handling
  const displayTitle = useMemo(() => {
    if (task.title.endsWith(JSON_ERROR_TITLE_SUFFIX)) {
      const baseName = task.title.slice(0, -JSON_ERROR_TITLE_SUFFIX.length);
      return `${baseName} ${t('errors:task.jsonError.titleSuffix')}`;
    }
    return task.title;
  }, [task.title, t]);

  // Memoize relative time (recalculates only when updatedAt changes)
  const relativeTime = useMemo(
    () => taskView.updatedAtRelativeLabel,
    [taskView.updatedAtRelativeLabel]
  );

  const tokenBadges = useMemo(() => {
    const stepsExecuted = task.tokenUsage?.stepsExecuted || 0;
    const promptTokens = task.tokenUsage?.promptTokens || 0;
    const completionTokens = task.tokenUsage?.completionTokens || 0;
    const totalTokens = task.tokenUsage?.totalTokens || 0;

    // For running tasks, show current usage even if 0
    const isActiveTask = task.status === 'in_progress' || task.status === 'ai_review';
    const hasTokenUsage = promptTokens > 0 || completionTokens > 0 || totalTokens > 0;

    if (!isActiveTask && stepsExecuted <= 0 && !hasTokenUsage) return [];

    return [
      {
        key: 'requests',
        label: t('detail.requestsShort', { defaultValue: 'Steps' }),
        title: t('detail.requests', { defaultValue: 'Model steps' }),
        value: String(stepsExecuted),
        variant: 'secondary' as const,
      },
      {
        key: 'prompt',
        label: t('detail.promptTokensShort', { defaultValue: '输入' }),
        title: t('detail.promptTokens', { defaultValue: '输入 Token' }),
        value: formatTokenCount(promptTokens),
        variant: 'secondary' as const,
      },
      {
        key: 'completion',
        label: t('detail.completionTokensShort', { defaultValue: '输出' }),
        title: t('detail.completionTokens', { defaultValue: '输出 Token' }),
        value: formatTokenCount(completionTokens),
        variant: 'secondary' as const,
      },
      {
        key: 'total',
        label: t('detail.totalTokensShort', { defaultValue: '总计' }),
        title: t('detail.totalTokens', { defaultValue: '总计 Token' }),
        value: formatTokenCount(totalTokens),
        variant: 'secondary' as const,
      },
    ];
  }, [
    task.status,
    task.tokenUsage?.stepsExecuted,
    task.tokenUsage?.promptTokens,
    task.tokenUsage?.completionTokens,
    task.tokenUsage?.totalTokens,
    t,
  ]);

  const activeSubtaskSummary = useMemo(() => {
    if (!isRunning || task.subtasks.length === 0) {
      return null;
    }

    if (hasParallelSubtasks) {
      return t('detail.parallelSubtaskSummary', {
        count: activeBatchCount,
        defaultValue: '{{count}} subtasks running in parallel',
      });
    }

    const activeIndex = resolveActiveSubtaskIndex({
      subtasks: task.subtasks,
      currentSubtask: task.executionProgress?.currentSubtask,
      isRunning,
      phase: executionPhase,
    });

    if (activeIndex < 0) {
      return t('detail.activeSubtaskSyncing', { defaultValue: 'Syncing current subtask status...' });
    }

    return t('detail.activeSubtaskSummary', {
      index: activeIndex + 1,
      defaultValue: 'Executing #{{index}}',
    });
  }, [activeBatchCount, executionPhase, hasParallelSubtasks, isRunning, task.subtasks, task.executionProgress?.currentSubtask, t]);

  // Memoize status menu items to avoid recreating on every render
  const statusMenuItems = useMemo(() => {
    if (!onStatusChange) return null;
    return TASK_STATUS_COLUMNS.filter(status => status !== task.status).map((status) => (
      <DropdownMenuItem
        key={status}
        onClick={() => onStatusChange(status)}
      >
        {t(TASK_STATUS_LABELS[status])}
      </DropdownMenuItem>
    ));
  }, [task.status, onStatusChange, t]);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isRunning) {
      setIsStuck(false);
      return undefined;
    }

    return subscribeStuckTask(task.id, task.projectId, setIsStuck);
  }, [task.id, task.projectId, isRunning]);

  useEffect(() => {
    if (!showDeleteDialog) {
      setWorktreeChangesInfo(null);
      setDeleteError(null);
      return;
    }

    setIsCheckingChanges(true);
    window.electronAPI.checkWorktreeChanges(task.id, task.projectId).then((result) => {
      if (result.success && result.data) {
        setWorktreeChangesInfo(result.data);
      }
      setIsCheckingChanges(false);
    }).catch(() => {
      setIsCheckingChanges(false);
    });
  }, [showDeleteDialog, task.id, task.projectId]);

  const handleStartStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      // Allow stopping both running and stuck tasks
      // User should be able to force-stop a stuck task
      stopTask(task.id, task.projectId);
    } else {
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

  const handleRecover = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRecovering(true);
    // Auto-restart the task after recovery (no need to click Start again)
    const result = await recoverStuckTask(task.id, { autoRestart: true, projectId: task.projectId });
    if (result.success) {
      setIsStuck(false);
    }
    setIsRecovering(false);
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await archiveTasks(task.projectId, [task.id]);
    if (!result.success) {
      console.error('[TaskCard] Failed to archive task:', task.id, result.error);
    }
  };

  const handleViewPR = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.metadata?.prUrl && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(task.metadata.prUrl);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent | Event) => {
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    setDeleteError(null);
    const result = await deleteTask(task.id, task.projectId);
    if (result.success) {
      setShowDeleteDialog(false);
    } else {
      setDeleteError(result.error || t('detail.deleteFailed', { defaultValue: 'Failed to delete task' }));
    }
    setIsDeleting(false);
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'info';
      case 'ai_review':
        return 'warning';
      case 'human_review':
        return 'purple';
      case 'done':
        return 'success';
      default:
        return 'secondary';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'in_progress':
        return t('labels.running');
      case 'ai_review':
        return t('labels.aiReview');
      case 'human_review':
        return t('labels.needsReview');
      case 'done':
        return t('status.complete');
      default:
        return t('labels.pending');
    }
  };

  const getReviewReasonLabel = (reason?: ReviewReason): { label: string; variant: 'success' | 'destructive' | 'warning' } | null => {
    if (!reason) return null;
    switch (reason) {
      case 'completed':
        return { label: t('reviewReason.completed'), variant: 'success' };
      case 'errors':
        return { label: t('reviewReason.hasErrors'), variant: 'destructive' };
      case 'qa_rejected':
        return { label: t('reviewReason.qaIssues'), variant: 'warning' };
      case 'plan_review':
        return { label: t('reviewReason.approvePlan'), variant: 'warning' };
      case 'stopped':
        return { label: t('reviewReason.stopped'), variant: 'warning' };
      default:
        return null;
    }
  };

  // When executionPhase is 'complete', always show 'completed' badge regardless of reviewReason
  // This ensures the user sees "Complete" when the task finished successfully
  const effectiveReviewReason: ReviewReason | undefined =
    executionPhase === 'complete' ? 'completed' : task.reviewReason;
  const reviewReasonInfo = task.status === 'human_review' ? getReviewReasonLabel(effectiveReviewReason) : null;
  const shouldShowResumeAction =
    isIncomplete ||
    task.status === 'error' ||
    (task.status === 'human_review' && task.reviewReason !== 'completed');

  const isArchived = !!task.metadata?.archivedAt;

  return (
    <Card
      className={cn(
        'card-surface task-card-enhanced cursor-pointer',
        isRunning && !isStuck && 'ring-2 ring-primary border-primary task-running-pulse',
        isStuck && 'ring-2 ring-warning border-warning task-stuck-pulse',
        isArchived && 'opacity-60 hover:opacity-80',
        isSelectable && isSelected && 'ring-2 ring-ring border-ring bg-accent/10'
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className={isSelectable ? 'flex gap-3' : undefined}>
          {/* Checkbox for selectable mode - stops event propagation */}
          {isSelectable && (
            <div className="flex-shrink-0 pt-0.5">
              <Checkbox
                checked={isSelected}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                aria-label={t('tasks:actions.selectTask', { title: displayTitle })}
              />
            </div>
          )}

          <div className={isSelectable ? 'flex-1 min-w-0' : undefined}>
            {/* Title - full width, no wrapper */}
            <h3
              className="font-semibold text-sm text-foreground line-clamp-2 leading-snug"
              title={displayTitle}
            >
              {displayTitle}
            </h3>

        {/* Description - sanitized to handle markdown content (memoized) */}
        {sanitizedDescription && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
            {sanitizedDescription}
          </p>
        )}

        {/* Metadata badges */}
        {(task.metadata || isStuck || isIncomplete || hasActiveExecution || hasParallelSubtasks || reviewReasonInfo) && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {/* Stuck indicator - highest priority */}
            {isStuck && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-warning/10 text-warning border-warning/30 badge-priority-urgent"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {t('labels.stuck')}
              </Badge>
            )}
            {/* Incomplete indicator - task in human_review but no subtasks completed */}
            {isIncomplete && !isStuck && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-orange-500/10 text-orange-400 border-orange-500/30"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {t('labels.incomplete')}
              </Badge>
            )}
            {/* Archived indicator - task has been released */}
            {task.metadata?.archivedAt && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-muted text-muted-foreground border-border"
              >
                <Archive className="h-2.5 w-2.5" />
                {t('status.archived')}
              </Badge>
            )}
            {/* Execution phase badge - shown when actively running */}
            {hasActiveExecution && executionPhase && !isStuck && !isIncomplete && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] px-1.5 py-0.5 flex items-center gap-1',
                  EXECUTION_PHASE_BADGE_COLORS[executionPhase]
                )}
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {getTaskExecutionPhaseLabel(t, executionPhase)}
              </Badge>
            )}
            {hasParallelSubtasks && !isStuck && !isIncomplete && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-info/10 text-info border-info/30"
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {t('detail.parallelSubtaskLabel', {
                  count: activeBatchCount,
                  defaultValue: 'Parallel: {{count}}',
                })}
              </Badge>
            )}
             {/* Status badge - hide when execution phase badge is showing */}
             {!hasActiveExecution && (
               task.status === 'done' ? (
                    <Badge
                      variant={getStatusBadgeVariant(task.status)}
                      className="text-[10px] px-1.5 py-0.5"
                    >
                      {getStatusLabel(task.status)}
                    </Badge>
                  ) : (
                   <Badge
                     variant={isStuck ? 'warning' : isIncomplete ? 'warning' : getStatusBadgeVariant(task.status)}
                     className="text-[10px] px-1.5 py-0.5"
                   >
                     {isStuck ? t('labels.needsRecovery') : isIncomplete ? t('labels.needsResume') : getStatusLabel(task.status)}
                   </Badge>
                 )
             )}
            {/* Review reason badge - explains why task needs human review */}
            {reviewReasonInfo && !isStuck && !isIncomplete && (
              <Badge
                variant={reviewReasonInfo.variant}
                className="text-[10px] px-1.5 py-0.5"
              >
                {reviewReasonInfo.label}
              </Badge>
            )}
            {/* Development mode badge */}
            {developmentMode !== 'standard' && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
              >
                <Zap className="h-2.5 w-2.5" />
                {t(`metadata.developmentMode.${developmentMode}`, {
                  defaultValue: 'Direct',
                })}
              </Badge>
            )}
            {/* Category badge with icon */}
            {task.metadata?.category && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_CATEGORY_COLORS[task.metadata.category])}
              >
                {CategoryIcon[task.metadata.category] && (
                  (() => {
                    const Icon = CategoryIcon[task.metadata.category!];
                    return <Icon className="h-2.5 w-2.5 mr-0.5" />;
                  })()
                )}
                {getTaskCategoryLabel(t, task.metadata.category)}
              </Badge>
            )}
            {/* Impact badge - high visibility for important tasks */}
            {task.metadata?.impact && (task.metadata.impact === 'high' || task.metadata.impact === 'critical') && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.impact])}
              >
                {getTaskImpactLabel(t, task.metadata.impact)}
              </Badge>
            )}
            {/* Complexity badge */}
            {task.metadata?.complexity && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_COMPLEXITY_COLORS[task.metadata.complexity])}
              >
                {getTaskComplexityLabel(t, task.metadata.complexity)}
              </Badge>
            )}
            {/* Priority badge - only show urgent/high */}
            {task.metadata?.priority && (task.metadata.priority === 'urgent' || task.metadata.priority === 'high') && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_PRIORITY_COLORS[task.metadata.priority])}
              >
                {getTaskPriorityLabel(t, task.metadata.priority)}
              </Badge>
            )}
            {/* Security severity - always show */}
            {task.metadata?.securitySeverity && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.securitySeverity])}
              >
                {getTaskSeverityLabel(t, task.metadata.securitySeverity)} {t('metadata.severity')}
              </Badge>
            )}
          </div>
        )}

        {/* Progress section - Phase-aware with animations */}
        {(task.subtasks.length > 0 || hasActiveExecution || isRunning || isStuck) && (
          <div className="mt-4">
            <PhaseProgressIndicator
              phase={executionPhase}
              subtasks={task.subtasks}
              phaseProgress={task.executionProgress?.phaseProgress}
              currentSubtask={task.executionProgress?.currentSubtask}
              isStuck={isStuck}
              isRunning={isExecutionActive}
            />
            {activeSubtaskSummary && (
              <p className="mt-2 text-[11px] text-info truncate" title={activeSubtaskSummary}>
                {activeSubtaskSummary}
              </p>
            )}
          </div>
        )}

        {tokenBadges.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {tokenBadges.map((stat) => (
              <Badge
                key={stat.key}
                variant={stat.variant}
                className="px-1.5 py-0.5 text-[10px] font-mono"
                title={
                  stat.key === 'prompt'
                    ? buildTokenHoverTitle(
                        t('detail.promptTokens', { defaultValue: 'Prompt Tokens' }),
                        task.tokenUsage?.promptTokens || 0
                      )
                    : stat.key === 'completion'
                      ? buildTokenHoverTitle(
                          t('detail.completionTokens', { defaultValue: 'Completion Tokens' }),
                          task.tokenUsage?.completionTokens || 0
                        )
                      : stat.key === 'total'
                        ? buildTokenHoverTitle(
                            t('detail.totalTokens', { defaultValue: 'Total Tokens' }),
                            task.tokenUsage?.totalTokens || 0
                          )
                        : stat.title
                }
              >
                {stat.key === 'total' && <Gauge className="mr-1 h-2.5 w-2.5" />}
                <span className="text-muted-foreground mr-1">{stat.label}</span>
                <span className="tabular-nums">{stat.value}</span>
              </Badge>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{relativeTime}</span>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Action buttons */}
            {isStuck ? (
              <Button
                variant="warning"
                size="sm"
                className="h-7 px-2.5"
                onClick={handleRecover}
                disabled={isRecovering}
              >
                {isRecovering ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    {t('labels.recovering')}
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-1.5 h-3 w-3" />
                    {t('actions.recover')}
                  </>
                )}
              </Button>
            ) : isIncomplete ? (
              <Button
                variant="default"
                size="sm"
                className="h-7 px-2.5"
                onClick={handleStartStop}
              >
                <Play className="mr-1.5 h-3 w-3" />
                {t('actions.resume')}
              </Button>
            ) : task.status === 'done' && task.metadata?.prUrl ? (
              <div className="flex gap-1">
                {task.metadata?.prUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 cursor-pointer"
                    onClick={handleViewPR}
                    title={t('tooltips.viewPR')}
                  >
                    <GitPullRequest className="h-3 w-3" />
                  </Button>
                )}
                {!task.metadata?.archivedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 cursor-pointer"
                    onClick={handleArchive}
                    title={t('tooltips.archiveTask')}
                  >
                    <Archive className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ) : task.status === 'done' && !task.metadata?.archivedAt ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 hover:bg-muted-foreground/10"
                onClick={handleArchive}
                title={t('tooltips.archiveTask')}
              >
                <Archive className="mr-1.5 h-3 w-3" />
                {t('actions.archive')}
              </Button>
            ) : (
              task.status === 'backlog' ||
              task.status === 'in_progress' ||
              (task.status === 'human_review' && task.reviewReason !== 'completed') ||
              task.status === 'error'
            ) && (
              <Button
                variant={isRunning ? 'destructive' : 'default'}
                size="sm"
                className="h-7 px-2.5"
                onClick={handleStartStop}
              >
                {isRunning ? (
                  <>
                    <Square className="mr-1.5 h-3 w-3" />
                    {t('actions.stop')}
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-3 w-3" />
                    {shouldShowResumeAction ? t('actions.resume') : t('actions.start')}
                  </>
                )}
              </Button>
            )}

            {/* Move to menu for keyboard accessibility */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('actions.taskActions')}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {statusMenuItems && (
                  <>
                    <DropdownMenuLabel>{t('actions.moveTo')}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {statusMenuItems}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  onClick={handleDeleteClick}
                  disabled={isRunning && !isStuck}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {/* Close content wrapper for selectable mode */}
        </div>
        {/* Close flex container for selectable mode */}
        </div>
      </CardContent>
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('deleteDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  {t('deleteDialog.confirmMessage')} <strong className="text-foreground">"{displayTitle}"</strong>?
                </p>
                {isCheckingChanges && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('deleteDialog.checkingChanges')}
                  </div>
                )}
                {worktreeChangesInfo?.hasChanges && (
                  <div className="bg-amber-500/10 border border-amber-500/30 px-3 py-2 rounded-lg text-sm space-y-1">
                    <p className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4" />
                      {t('deleteDialog.uncommittedChanges', { count: worktreeChangesInfo.changedFileCount })}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('deleteDialog.uncommittedChangesHint')}
                    </p>
                  </div>
                )}
                <p className="text-destructive">
                  {t('deleteDialog.destructiveWarning')}
                </p>
                {deleteError && (
                  <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
                    {deleteError}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('deleteDialog.deleting')}
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteDialog.deletePermanently')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}, taskCardPropsAreEqual);
