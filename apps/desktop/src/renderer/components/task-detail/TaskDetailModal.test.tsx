/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../shared/types';

vi.mock('../../hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../../stores/project-store', () => ({
  useProjectStore: (selector: (state: { getActiveProject: () => undefined }) => unknown) =>
    selector({ getActiveProject: () => undefined }),
}));

vi.mock('../../stores/task-store', () => ({
  stopTask: vi.fn(),
  submitReview: vi.fn(),
  recoverStuckTask: vi.fn(),
  deleteTask: vi.fn(),
  startTaskOrQueue: vi.fn(),
  loadTasks: vi.fn(),
  useTaskStore: {
    getState: () => ({
      updateTask: vi.fn(),
      updateTaskStatus: vi.fn(),
    }),
  },
}));

vi.mock('./hooks/useTaskDetail', () => ({
  useTaskDetail: vi.fn(),
}));

vi.mock('../TaskEditDialog', () => ({
  TaskEditDialog: () => null,
}));

vi.mock('./TaskMetadata', () => ({
  TaskMetadata: () => <div data-testid="task-metadata" />,
}));

vi.mock('./TaskWarnings', () => ({
  TaskWarnings: () => <div data-testid="task-warnings" />,
}));

vi.mock('./TaskSubtasks', () => ({
  TaskSubtasks: () => <div data-testid="task-subtasks" />,
}));

vi.mock('./TaskLogs', () => ({
  TaskLogs: () => <div data-testid="task-logs" />,
}));

vi.mock('./TaskFiles', () => ({
  TaskFiles: () => <div data-testid="task-files" />,
}));

vi.mock('./TaskReview', () => ({
  TaskReview: () => <div data-testid="task-review" />,
}));

import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskDetailModal } from './TaskDetailModal';

const mockUseTaskDetail = vi.mocked(useTaskDetail);

function createTask(): Task {
  return {
    id: 'task-1',
    specId: 'spec-001',
    projectId: 'project-1',
    title: 'Planning Task',
    description: 'Test planning progress',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    executionProgress: {
      phase: 'planning',
      phaseProgress: 42,
      overallProgress: 8,
      message: 'Generating implementation plan...',
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function createTaskDetailState() {
  return {
    feedback: '',
    feedbackImages: [],
    isSubmitting: false,
    activeTab: 'overview',
    isUserScrolledUp: false,
    isStuck: false,
    isRecovering: false,
    hasCheckedRunning: false,
    showDeleteDialog: false,
    isDeleting: false,
    deleteError: null,
    worktreeChangesInfo: null,
    isCheckingChanges: false,
    isEditDialogOpen: false,
    worktreeStatus: null,
    worktreeDiff: null,
    isLoadingWorktree: false,
    isLoadingDiff: false,
    isMerging: false,
    isDiscarding: false,
    showDiscardDialog: false,
    workspaceError: null,
    showDiffDialog: false,
    stageOnly: false,
    stagedSuccess: null,
    stagedProjectPath: undefined,
    suggestedCommitMessage: undefined,
    phaseLogs: null,
    isLoadingLogs: false,
    expandedPhases: new Set(),
    logsEndRef: { current: null },
    logsContainerRef: { current: null },
    isRunning: true,
    needsReview: false,
    executionPhase: 'planning',
    hasActiveExecution: true,
    isIncomplete: false,
    taskProgress: { completed: 0, total: 0, percentage: 0 },
    mergePreview: null,
    isLoadingPreview: false,
    showConflictDialog: false,
    showPRDialog: false,
    isCreatingPR: false,
    isLoadingPlan: false,
    setFeedback: vi.fn(),
    setFeedbackImages: vi.fn(),
    setIsSubmitting: vi.fn(),
    setActiveTab: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    setIsStuck: vi.fn(),
    setIsRecovering: vi.fn(),
    setHasCheckedRunning: vi.fn(),
    setShowDeleteDialog: vi.fn(),
    setIsDeleting: vi.fn(),
    setDeleteError: vi.fn(),
    setWorktreeStatus: vi.fn(),
    setWorktreeDiff: vi.fn(),
    setIsLoadingWorktree: vi.fn(),
    setIsLoadingDiff: vi.fn(),
    setIsMerging: vi.fn(),
    setIsDiscarding: vi.fn(),
    setShowDiscardDialog: vi.fn(),
    setWorkspaceError: vi.fn(),
    setShowDiffDialog: vi.fn(),
    setStageOnly: vi.fn(),
    setStagedSuccess: vi.fn(),
    setStagedProjectPath: vi.fn(),
    setSuggestedCommitMessage: vi.fn(),
    setShowConflictDialog: vi.fn(),
    setShowPRDialog: vi.fn(),
    setIsCreatingPR: vi.fn(),
    handleLogsScroll: vi.fn(),
    togglePhase: vi.fn(),
    loadMergePreview: vi.fn(),
    handleReviewAgain: vi.fn(),
    reloadPlanForIncompleteTask: vi.fn(),
  };
}

describe('TaskDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTaskDetail.mockReturnValue(createTaskDetailState() as unknown as ReturnType<typeof useTaskDetail>);
  });

  it('shows planning progress before subtasks are generated', () => {
    render(
      <TaskDetailModal
        open={true}
        task={createTask()}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByText('Generating implementation plan...')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('keeps the clear logs action in a dedicated logs header', () => {
    mockUseTaskDetail.mockReturnValue({
      ...createTaskDetailState(),
      activeTab: 'logs',
    } as unknown as ReturnType<typeof useTaskDetail>);

    render(
      <TaskDetailModal
        open={true}
        task={createTask()}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('task-logs-tab')).toHaveClass('flex-col');
    expect(screen.getByTestId('task-logs-actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear logs/i })).toBeInTheDocument();
  });
});
