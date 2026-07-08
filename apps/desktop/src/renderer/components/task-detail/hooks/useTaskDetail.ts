import { useState, useRef, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../../stores/project-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { checkTaskRunning, isIncompleteHumanReview, getTaskProgress, useTaskStore, loadTasks, hasRecentActivity } from '../../../stores/task-store';
import type { Task, TaskLogs, TaskLogPhase, WorktreeStatus, WorktreeDiff, MergeConflict, MergeStats, GitConflictInfo, ImageAttachment } from '../../../../shared/types';

/**
 * Validates task subtasks structure to prevent infinite loops during resume.
 * Returns true if task has valid subtasks, false otherwise.
 */
function validateTaskSubtasks(task: Task): boolean {
  // Check if subtasks array exists
  if (!task.subtasks || !Array.isArray(task.subtasks)) {
    console.warn('[validateTaskSubtasks] Task has no subtasks array:', task.id);
    return false;
  }

  // If subtasks array is empty and task is incomplete, it needs plan reload
  if (task.subtasks.length === 0) {
    console.warn('[validateTaskSubtasks] Task has empty subtasks array:', task.id);
    return false;
  }

  // Validate each subtask has minimum required fields
  for (let i = 0; i < task.subtasks.length; i++) {
    const subtask = task.subtasks[i];
    if (!subtask || typeof subtask !== 'object') {
      console.warn(`[validateTaskSubtasks] Invalid subtask at index ${i}:`, subtask);
      return false;
    }

    // Title is the primary display field
    if (!subtask.title || typeof subtask.title !== 'string' || subtask.title.trim() === '') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing title:`, subtask);
      return false;
    }

    // ID is required for tracking
    if (!subtask.id || typeof subtask.id !== 'string') {
      console.warn(`[validateTaskSubtasks] Subtask at index ${i} missing id:`, subtask);
      return false;
    }
  }

  return true;
}

const LOG_PHASES: TaskLogPhase[] = ['planning', 'coding', 'validation'];

function getActiveLogPhase(logs: TaskLogs | null): TaskLogPhase | undefined {
  if (!logs) {
    return undefined;
  }

  return LOG_PHASES.find(phase => logs.phases[phase]?.status === 'active');
}

function getDefaultExpandedPhases(logs: TaskLogs | null): Set<TaskLogPhase> {
  const activePhase = getActiveLogPhase(logs);
  if (activePhase) {
    return new Set([activePhase]);
  }

  return new Set(
    LOG_PHASES.filter(phase => (logs?.phases[phase]?.entries.length ?? 0) > 0)
  );
}

function mergeExpandedPhases(
  previous: Set<TaskLogPhase>,
  logs: TaskLogs
): Set<TaskLogPhase> {
  const activePhase = getActiveLogPhase(logs);

  if (previous.size === 0) {
    return getDefaultExpandedPhases(logs);
  }

  if (!activePhase) {
    return previous;
  }

  const next = new Set(previous);
  next.add(activePhase);
  return next;
}

export interface UseTaskDetailOptions {
  task: Task;
}

export function useTaskDetail({ task }: UseTaskDetailOptions) {
  const [feedback, setFeedback] = useState('');
  const [feedbackImages, setFeedbackImages] = useState<ImageAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [hasCheckedRunning, setHasCheckedRunning] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [worktreeChangesInfo, setWorktreeChangesInfo] = useState<{ hasChanges: boolean; worktreePath?: string; changedFileCount?: number } | null>(null);
  const [isCheckingChanges, setIsCheckingChanges] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [worktreeDiff, setWorktreeDiff] = useState<WorktreeDiff | null>(null);
  const [isLoadingWorktree, setIsLoadingWorktree] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [showDiffDialog, setShowDiffDialog] = useState(false);
  const [stageOnly, setStageOnly] = useState(false); // Default to full merge for proper cleanup (fixes #243)
  const [stagedSuccess, setStagedSuccess] = useState<string | null>(null);
  const [stagedProjectPath, setStagedProjectPath] = useState<string | undefined>(undefined);
  const [suggestedCommitMessage, setSuggestedCommitMessage] = useState<string | undefined>(undefined);
  const [phaseLogs, setPhaseLogs] = useState<TaskLogs | null>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<TaskLogPhase>>(new Set());
  const [isLoadingPlan, setIsLoadingPlan] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // Merge preview state
  const [mergePreview, setMergePreview] = useState<{
    files: string[];
    conflicts: MergeConflict[];
    summary: MergeStats;
    gitConflicts?: GitConflictInfo;
  } | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showPRDialog, setShowPRDialog] = useState(false);
  const [isCreatingPR, setIsCreatingPR] = useState(false);

  const taskProject = useProjectStore((state) => state.projects.find((project) => project.id === task.projectId));
  const logOrder = useSettingsStore(s => s.settings.logOrder);
  const isRunning = task.status === 'in_progress';
  // isActiveTask includes ai_review for stuck detection (CHANGELOG documents this feature)
  const isActiveTask = task.status === 'in_progress' || task.status === 'ai_review';
  const needsReview = task.status === 'human_review';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed' && executionPhase !== 'stopped';
  const isIncomplete = isIncompleteHumanReview(task);
  const taskProgress = getTaskProgress(task);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal process-exit transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isActiveTask) {
      setIsStuck(false);
      setHasCheckedRunning(false);
      return;
    }

    const intervalId = setInterval(() => {
      if (hasRecentActivity(task.id, task.projectId)) {
        setIsStuck(false);
        return;
      }

      checkTaskRunning(task.id, task.projectId).then((actuallyRunning) => {
        if (hasRecentActivity(task.id, task.projectId)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
        setHasCheckedRunning(true);
      });
    }, 60_000);

    return () => clearInterval(intervalId);
  }, [task.id, task.projectId, isActiveTask]);

  // Check for uncommitted worktree changes when delete dialog opens
  useEffect(() => {
    if (showDeleteDialog && task) {
      setIsCheckingChanges(true);
      window.electronAPI.checkWorktreeChanges(task.id, task.projectId).then((result) => {
        if (result.success && result.data) {
          setWorktreeChangesInfo(result.data);
        }
        setIsCheckingChanges(false);
      }).catch(() => setIsCheckingChanges(false));
    } else {
      setWorktreeChangesInfo(null);
    }
  }, [showDeleteDialog, task]);

  // Handle scroll events in logs to detect if user scrolled away from anchor
  const handleLogsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isReverseOrder = logOrder === 'reverse-chronological';

    // Check distance from top for reverse order, bottom for chronological
    const isAtAnchor = isReverseOrder
      ? target.scrollTop < 100
      : target.scrollHeight - target.scrollTop - target.clientHeight < 100;

    setIsUserScrolledUp(!isAtAnchor);
  };

  // Auto-scroll logs to anchor (top for reverse, bottom for chronological) only if user hasn't scrolled away
  useEffect(() => {
    const isReverseOrder = logOrder === 'reverse-chronological';

    if (activeTab === 'logs' && !isUserScrolledUp) {
      if (isReverseOrder && logsContainerRef.current) {
        logsContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (!isReverseOrder && logsEndRef.current) {
        logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [activeTab, isUserScrolledUp, logOrder, phaseLogs]);

  // Reset scroll state when switching to logs tab
  useEffect(() => {
    if (activeTab === 'logs') {
      setIsUserScrolledUp(false);
    }
  }, [activeTab]);

  // Reset feedback images when task changes to prevent image leakage between tasks
  useEffect(() => {
    setFeedbackImages([]);
  }, []);

  const loadWorktreeDiff = useCallback(async (force = false) => {
    if (!needsReview) {
      return;
    }

    if (!force && (isLoadingDiff || worktreeDiff)) {
      return;
    }

    setIsLoadingDiff(true);
    try {
      const diffResult = await window.electronAPI.getWorktreeDiff(task.id, task.projectId);
      if (diffResult.success && diffResult.data) {
        setWorktreeDiff(diffResult.data);
        return;
      }

      setWorkspaceError(diffResult.error || 'Failed to load workspace diff');
    } catch (err) {
      console.error('Failed to load worktree diff:', err);
      setWorkspaceError(err instanceof Error ? err.message : 'Failed to load workspace diff');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [isLoadingDiff, needsReview, task.id, task.projectId, worktreeDiff]);

  // Load worktree status when task is in human_review.
  // Diff is loaded lazily when the user actually opens the dialog because it can be expensive.
  useEffect(() => {
    if (needsReview) {
      let cancelled = false;
      setIsLoadingWorktree(true);
      setWorkspaceError(null);
      setWorktreeDiff(null);

      const timer = window.setTimeout(() => {
        window.electronAPI.getWorktreeStatus(task.id, task.projectId).then((statusResult) => {
          if (!cancelled && statusResult.success && statusResult.data) {
            setWorktreeStatus(statusResult.data);
          }
        }).catch((err) => {
          if (!cancelled) {
            console.error('Failed to load worktree info:', err);
          }
        }).finally(() => {
          if (!cancelled) {
            setIsLoadingWorktree(false);
          }
        });
      }, 120);

      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    } else {
      setWorktreeStatus(null);
      setWorktreeDiff(null);
      setIsLoadingDiff(false);
    }
  }, [task.id, task.projectId, needsReview]);

  useEffect(() => {
    if (showDiffDialog && needsReview && !worktreeDiff && !isLoadingDiff) {
      void loadWorktreeDiff();
    }
  }, [showDiffDialog, needsReview, worktreeDiff, isLoadingDiff, loadWorktreeDiff]);

  // Clear task-scoped log state immediately when the modal switches to another task.
  useEffect(() => {
    setPhaseLogs(null);
    setExpandedPhases(new Set());
    setIsLoadingLogs(false);
  }, [task.projectId, task.specId]);

  // Load and watch phase logs - only when Logs tab is active
  useEffect(() => {
    if (activeTab !== 'logs') return;

    let cancelled = false;

    const loadLogs = async () => {
      setIsLoadingLogs(true);
      try {
        const result = await window.electronAPI.getTaskLogs(task.projectId, task.specId);
        if (cancelled) {
          return;
        }

        if (result.success) {
          const logs = result.data ?? null;
          setPhaseLogs(logs);
          setExpandedPhases(getDefaultExpandedPhases(logs));
        } else {
          setPhaseLogs(null);
          setExpandedPhases(new Set());
          console.error('Failed to load task logs:', result.error);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load task logs:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingLogs(false);
        }
      }
    };

    void loadLogs();

    // Start watching for log changes
    void window.electronAPI.watchTaskLogs(task.projectId, task.specId);

    // Listen for log changes
    const unsubscribe = window.electronAPI.onTaskLogsChanged((specId, logs, projectId) => {
      if (specId === task.specId && (!projectId || projectId === task.projectId)) {
        setPhaseLogs(logs);
        setExpandedPhases(prev => mergeExpandedPhases(prev, logs));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      void window.electronAPI.unwatchTaskLogs(task.specId, task.projectId);
    };
  }, [task.projectId, task.specId, activeTab]);

  // Toggle phase expansion
  const togglePhase = useCallback((phase: TaskLogPhase) => {
    setExpandedPhases(prev => {
      const next = new Set(prev);
      if (next.has(phase)) {
        next.delete(phase);
      } else {
        next.add(phase);
      }
      return next;
    });
  }, []);

  // Add a feedback image
  const addFeedbackImage = useCallback((image: ImageAttachment) => {
    setFeedbackImages(prev => [...prev, image]);
  }, []);

  // Add multiple feedback images at once
  const addFeedbackImages = useCallback((images: ImageAttachment[]) => {
    setFeedbackImages(prev => [...prev, ...images]);
  }, []);

  // Remove a feedback image by ID
  const removeFeedbackImage = useCallback((imageId: string) => {
    setFeedbackImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Clear all feedback images
  const clearFeedbackImages = useCallback(() => {
    setFeedbackImages([]);
  }, []);

  // Track if we've already loaded preview for this task to prevent infinite loops
  const hasLoadedPreviewRef = useRef<string | null>(null);

  // Clear merge preview state when switching to a different task
  useEffect(() => {
    if (hasLoadedPreviewRef.current !== task.id) {
      setMergePreview(null);
      hasLoadedPreviewRef.current = null;
    }
  }, [task.id, task.projectId]);

  // Load merge preview (conflict detection) and refresh worktree status
  const loadMergePreview = useCallback(async () => {
    setIsLoadingPreview(true);
    // Clear any previous workspace error before loading
    setWorkspaceError(null);

    try {
      // Fetch both merge preview and updated worktree status in parallel
      // This ensures the branch information (currentProjectBranch) is refreshed
      // when the user clicks the refresh button after switching branches locally
      // Use Promise.allSettled to handle partial failures - if one API call fails,
      // the other's result is still processed rather than being discarded
      const [previewResult, statusResult] = await Promise.allSettled([
        window.electronAPI.mergeWorktreePreview(task.id, task.projectId),
        window.electronAPI.getWorktreeStatus(task.id, task.projectId)
      ]);

      const errors: string[] = [];

      // Process merge preview result if fulfilled
      if (previewResult.status === 'fulfilled') {
        const result = previewResult.value;
        if (result.success && result.data?.preview) {
          setMergePreview(result.data.preview);
        } else if (!result.success && result.error) {
          errors.push(`Merge preview: ${result.error}`);
        }
      } else {
        console.error('[useTaskDetail] Failed to load merge preview:', previewResult.reason);
        errors.push('Failed to load merge preview');
      }

      // Update worktree status with fresh branch information if fulfilled
      if (statusResult.status === 'fulfilled') {
        const result = statusResult.value;
        if (result.success && result.data) {
          setWorktreeStatus(result.data);
        } else if (!result.success && result.error) {
          errors.push(`Worktree status: ${result.error}`);
        }
      } else {
        console.error('[useTaskDetail] Failed to load worktree status:', statusResult.reason);
        errors.push('Failed to load worktree status');
      }

      // Set workspace error if any API calls failed
      if (errors.length > 0) {
        setWorkspaceError(errors.join('; '));
      }
    } catch (err) {
      console.error('[useTaskDetail] Unexpected error in loadMergePreview:', err);
      setWorkspaceError('An unexpected error occurred while loading workspace information');
    } finally {
      hasLoadedPreviewRef.current = task.id;
      setIsLoadingPreview(false);
    }
  }, [task.id]);

  // Handle "Review Again" - clears staged state and reloads worktree info
  const handleReviewAgain = useCallback(async () => {
    // Clear staged success state if it was set in this session
    setStagedSuccess(null);
    setStagedProjectPath(undefined);
    setSuggestedCommitMessage(undefined);

    // Reset merge preview to force re-check
    setMergePreview(null);
    hasLoadedPreviewRef.current = null;

    // Reset workspace error state
    setWorkspaceError(null);
    setWorktreeDiff(null);

    // Reload worktree status
    setIsLoadingWorktree(true);
    try {
      const statusResult = await window.electronAPI.getWorktreeStatus(task.id, task.projectId);
      if (statusResult.success && statusResult.data) {
        setWorktreeStatus(statusResult.data);
      }

      // Reload task data from store to reflect cleared staged state
      // (clearStagedState IPC already invalidated the cache)
      await loadTasks(task.projectId);
    } catch (err) {
      console.error('Failed to reload worktree info:', err);
    } finally {
      setIsLoadingWorktree(false);
    }
  }, [task.id, task.projectId]);

  // NOTE: Merge preview is NO LONGER auto-loaded on modal open.
  // User must click "Check for Conflicts" button to trigger the expensive preview operation.
  // This improves modal open performance significantly (avoids 1-30+ second Python subprocess).

  /**
   * Reloads implementation plan for an incomplete task to ensure subtasks are properly loaded.
   * This prevents the "Task Incomplete" infinite loop when resuming stuck tasks.
   */
  const reloadPlanForIncompleteTask = useCallback(async (): Promise<boolean> => {
    if (!taskProject) {
      console.error('[reloadPlanForIncompleteTask] Task project not found');
      return false;
    }

    // Only reload if task is incomplete and subtasks are invalid
    if (!isIncomplete) {
      return true; // Not incomplete, no reload needed
    }

    // Check if subtasks are valid
    if (validateTaskSubtasks(task)) {
      console.log('[reloadPlanForIncompleteTask] Subtasks are valid, no reload needed');
      return true; // Subtasks are valid, proceed
    }

    console.warn('[reloadPlanForIncompleteTask] Task has invalid subtasks, reloading plan:', {
      taskId: task.id,
      specId: task.specId,
      subtaskCount: task.subtasks?.length || 0
    });

    setIsLoadingPlan(true);
    try {
      // Reload tasks from the project to get fresh implementation plan
      const result = await window.electronAPI.getTasks(task.projectId);

      if (!result.success || !result.data) {
        console.error('[reloadPlanForIncompleteTask] Failed to reload tasks:', result.error);
        return false;
      }

      // Find the updated task in the result
      const updatedTask = result.data.find(t => t.id === task.id || t.specId === task.specId);
      if (!updatedTask) {
        console.error('[reloadPlanForIncompleteTask] Task not found in reloaded tasks');
        return false;
      }

      // Validate the reloaded subtasks
      if (!validateTaskSubtasks(updatedTask)) {
        console.error('[reloadPlanForIncompleteTask] Reloaded task still has invalid subtasks');
        return false;
      }

      console.log('[reloadPlanForIncompleteTask] Successfully reloaded plan with valid subtasks:', {
        taskId: task.id,
        subtaskCount: updatedTask.subtasks?.length ?? 0
      });

      // FIX (PR Review): Update the Zustand store with the reloaded task data
      // Without this, the UI continues to display stale/invalid subtasks
      const store = useTaskStore.getState();
      store.updateTask(task.id, {
        subtasks: updatedTask.subtasks,
        title: updatedTask.title,
        description: updatedTask.description,
        metadata: updatedTask.metadata,
        updatedAt: new Date()
      }, task.projectId);

      return true;
    } catch (err) {
      console.error('[reloadPlanForIncompleteTask] Error reloading plan:', err);
      return false;
    } finally {
      setIsLoadingPlan(false);
    }
  }, [taskProject, task, isIncomplete]);

  return {
    // State
    feedback,
    feedbackImages,
    isSubmitting,
    activeTab,
    isUserScrolledUp,
    isStuck,
    isRecovering,
    hasCheckedRunning,
    showDeleteDialog,
    isDeleting,
    deleteError,
    worktreeChangesInfo,
    isCheckingChanges,
    isEditDialogOpen,
    worktreeStatus,
    worktreeDiff,
    isLoadingWorktree,
    isLoadingDiff,
    isMerging,
    isDiscarding,
    showDiscardDialog,
    workspaceError,
    showDiffDialog,
    stageOnly,
    stagedSuccess,
    stagedProjectPath,
    suggestedCommitMessage,
    phaseLogs,
    isLoadingLogs,
    expandedPhases,
    logsEndRef,
    logsContainerRef,
    selectedProject: taskProject,
    isRunning,
    needsReview,
    executionPhase,
    hasActiveExecution,
    isIncomplete,
    taskProgress,
    mergePreview,
    isLoadingPreview,
    showConflictDialog,
    showPRDialog,
    isCreatingPR,
    isLoadingPlan,

    // Setters
    setFeedback,
    setFeedbackImages,
    setIsSubmitting,
    setActiveTab,
    setIsUserScrolledUp,
    setIsStuck,
    setIsRecovering,
    setHasCheckedRunning,
    setShowDeleteDialog,
    setIsDeleting,
    setDeleteError,
    setWorktreeChangesInfo,
    setIsCheckingChanges,
    setIsEditDialogOpen,
    setWorktreeStatus,
    setWorktreeDiff,
    setIsLoadingWorktree,
    setIsLoadingDiff,
    setIsMerging,
    setIsDiscarding,
    setShowDiscardDialog,
    setWorkspaceError,
    setShowDiffDialog,
    setStageOnly,
    setStagedSuccess,
    setStagedProjectPath,
    setSuggestedCommitMessage,
    setPhaseLogs,
    setIsLoadingLogs,
    setExpandedPhases,
    setMergePreview,
    setIsLoadingPreview,
    setShowConflictDialog,
    setShowPRDialog,
    setIsCreatingPR,

    // Handlers
    handleLogsScroll,
    togglePhase,
    loadWorktreeDiff,
    loadMergePreview,
    addFeedbackImage,
    addFeedbackImages,
    removeFeedbackImage,
    clearFeedbackImages,
    handleReviewAgain,
    reloadPlanForIncompleteTask,
  };
}
