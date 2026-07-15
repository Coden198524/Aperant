/**
 * Unit tests for Task Store
 * Tests Zustand store for task state management
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTaskStore, hasRecentActivity, clearTaskActivity, isQueueAtCapacity, loadTasks, startTaskOrQueue, recoverStuckTask } from '../stores/task-store';
import { useProjectStore } from '../stores/project-store';
import type { Project, Task, TaskStatus, ImplementationPlan, TokenUsage } from '../../shared/types';

// Helper to create test tasks
function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    specId: 'test-spec-001',
    projectId: 'project-1',
    title: 'Test Task',
    description: 'Test description',
    status: 'backlog' as TaskStatus,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

// Helper to create test implementation plan
function createTestPlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    feature: 'Test Feature',
    workflow_type: 'feature',
    services_involved: [],
    phases: [
      {
        phase: 1,
        name: 'Test Phase',
        type: 'implementation',
        subtasks: [
          { id: 'subtask-1', title: 'First subtask', description: 'Implement first subtask', status: 'pending' },
          { id: 'subtask-2', title: 'Second subtask', description: 'Implement second subtask', status: 'pending' }
        ]
      }
    ],
    final_acceptance: ['Tests pass'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    spec_file: 'spec.md',
    ...overrides
  };
}

function createTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 100,
    completionTokens: 25,
    totalTokens: 125,
    ...overrides
  };
}

function createTestProject(id: string, maxParallelTasks = 1): Project {
  return {
    id,
    name: id,
    path: `E:/Work/${id}`,
    autoBuildPath: '.autocode',
    settings: {
      maxParallelTasks,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Project;
}

describe('Task Store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      isLoading: false,
      error: null
    });
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null,
      activeProjectId: null,
      openProjectIds: [],
      tabOrder: [],
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe('setTasks', () => {
    it('should set tasks array', () => {
      const tasks = [createTestTask({ id: 'task-1' }), createTestTask({ id: 'task-2' })];

      useTaskStore.getState().setTasks(tasks);

      expect(useTaskStore.getState().tasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].id).toBe('task-1');
    });

    it('should replace existing tasks', () => {
      const initialTasks = [createTestTask({ id: 'old-task' })];
      const newTasks = [createTestTask({ id: 'new-task' })];

      useTaskStore.getState().setTasks(initialTasks);
      useTaskStore.getState().setTasks(newTasks);

      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().tasks[0].id).toBe('new-task');
    });

    it('should handle empty array', () => {
      useTaskStore.getState().setTasks([createTestTask()]);
      useTaskStore.getState().setTasks([]);

      expect(useTaskStore.getState().tasks).toHaveLength(0);
    });

    it('should preserve token usage when refreshed tasks omit it', () => {
      useTaskStore.getState().setTasks([
        createTestTask({
          id: 'task-1',
          specId: '001-task',
          projectId: 'project-1',
          tokenUsage: createTokenUsage({ promptTokens: 300, completionTokens: 120, totalTokens: 420 })
        })
      ]);

      useTaskStore.getState().setTasks([
        createTestTask({
          id: 'task-1',
          specId: '001-task',
          projectId: 'project-1',
          status: 'in_progress'
        })
      ]);

      expect(useTaskStore.getState().tasks[0].tokenUsage).toEqual(
        expect.objectContaining({
          promptTokens: 300,
          completionTokens: 120,
          totalTokens: 420
        })
      );
    });

    it('should preserve active local execution state when a stale refresh returns backlog', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({
            id: 'task-1',
            specId: '001-task',
            projectId: 'project-1',
            status: 'in_progress',
            updatedAt: new Date('2026-06-18T10:00:00.000Z'),
            executionProgress: {
              phase: 'planning',
              phaseProgress: 0,
              overallProgress: 0,
            },
          }),
        ],
      });

      useTaskStore.getState().setTasks([
        createTestTask({
          id: 'task-1',
          specId: '001-task',
          projectId: 'project-1',
          status: 'backlog',
          updatedAt: new Date('2026-06-18T09:59:00.000Z'),
          executionProgress: {
            phase: 'idle',
            phaseProgress: 0,
            overallProgress: 0,
          },
        }),
      ]);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.executionProgress?.phase).toBe('planning');
    });
  });

  describe('addTask', () => {
    it('should add task to empty array', () => {
      const task = createTestTask({ id: 'new-task' });

      useTaskStore.getState().addTask(task);

      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().tasks[0].id).toBe('new-task');
    });

    it('should append task to existing array', () => {
      useTaskStore.setState({ tasks: [createTestTask({ id: 'existing' })] });

      useTaskStore.getState().addTask(createTestTask({ id: 'new-task' }));

      expect(useTaskStore.getState().tasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[1].id).toBe('new-task');
    });
  });

  describe('updateTask', () => {
    it('should update task by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original Title' })]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated Title' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated Title');
    });

    it('should update task by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', title: 'Original' })]
      });

      useTaskStore.getState().updateTask('spec-001', { title: 'Updated via specId' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated via specId');
    });

    it('should not modify other tasks', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Task 1' }),
          createTestTask({ id: 'task-2', title: 'Task 2' })
        ]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated Task 1' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated Task 1');
      expect(useTaskStore.getState().tasks[1].title).toBe('Task 2');
    });

    it('should merge updates with existing task', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original', description: 'Original Desc' })]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated');
      expect(useTaskStore.getState().tasks[0].description).toBe('Original Desc');
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'backlog' })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
    });

    it('should update task status by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', status: 'backlog' })]
      });

      useTaskStore.getState().updateTaskStatus('spec-001', 'done');

      expect(useTaskStore.getState().tasks[0].status).toBe('done');
    });

    it('should update updatedAt timestamp', () => {
      const originalDate = new Date('2024-01-01');
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', updatedAt: originalDate })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      expect(useTaskStore.getState().tasks[0].updatedAt.getTime()).toBeGreaterThan(
        originalDate.getTime()
      );
    });

    it('should apply reviewReason when provided', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'human_review', 'plan_review');

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('plan_review');
    });

    it('should mark execution phase stopped when a coding task is stopped', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({
            id: 'task-1',
            status: 'in_progress',
            executionProgress: {
              phase: 'coding',
              phaseProgress: 45,
              overallProgress: 45
            }
          })
        ]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'human_review', 'stopped');

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('stopped');
      expect(task.executionProgress?.phase).toBe('stopped');
    });

    it('should clear reviewReason when not provided', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'human_review', reviewReason: 'plan_review' })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
    });

    it('should update when only reviewReason changes', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'human_review',
          reviewReason: 'plan_review',
          executionProgress: {
            phase: 'qa_review',
            phaseProgress: 100,
            overallProgress: 95
          }
        })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'human_review', 'completed');

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.executionProgress?.overallProgress).toBe(100);
    });
    it('should reset completed review progress when Request Changes restarts execution', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'human_review',
          reviewReason: 'completed',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress', undefined);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress?.phaseProgress).toBe(0);
      expect(task.executionProgress?.overallProgress).toBe(0);
    });

    it('should refresh stale completed progress when in_progress status is repeated', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress', undefined);

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress?.overallProgress).toBe(0);
    });
  });

  describe('updateTaskFromPlan', () => {
    it('should extract subtasks from plan', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', subtasks: [] })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', title: 'Subtask 1', description: 'Implement subtask 1', status: 'completed' },
              { id: 'c2', title: 'Subtask 2', description: 'Implement subtask 2', status: 'pending' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].subtasks[0].id).toBe('c1');
      expect(useTaskStore.getState().tasks[0].subtasks[0].status).toBe('completed');
    });

    it('should extract subtasks from multiple phases', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [{ id: 'c1', title: 'Subtask 1', description: 'Implement subtask 1', status: 'completed' }]
          },
          {
            phase: 2,
            name: 'Phase 2',
            type: 'cleanup',
            subtasks: [{ id: 'c2', title: 'Subtask 2', description: 'Implement subtask 2', status: 'pending' }]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(2);
    });

    it('should preserve task title when plan feature changes during refresh', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original Title' })]
      });

      const plan = createTestPlan({ feature: 'New Feature Name' });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].title).toBe('Original Title');
    });

    it('should keep status when plan has no status', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      const plan = createTestPlan();

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
    });

    it('should promote backlog task to in_progress when active plan update arrives first', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'backlog' })]
      });

      const plan = createTestPlan({
        status: 'in_progress',
        xstateState: 'planning'
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.executionProgress?.phase).toBe('planning');
    });

    it('should reopen completed review when Request Changes active planning plan arrives', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'human_review',
          reviewReason: 'completed',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      const plan = createTestPlan({
        status: 'in_progress',
        xstateState: 'planning',
        executionPhase: 'planning',
        phases: [
          {
            phase: 1,
            name: 'Request Changes iteration',
            type: 'implementation',
            subtasks: [
              { id: 'old-1', title: 'Already done', description: 'Already done', status: 'completed' },
              { id: 'new-1', title: 'Requested change', description: 'Requested change', status: 'pending' }
            ]
          }
        ]
      } as Partial<ImplementationPlan> & { executionPhase: string });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress?.phaseProgress).toBe(0);
      expect(task.executionProgress?.overallProgress).toBe(0);
      expect(task.subtasks.map(subtask => subtask.status)).toEqual(['completed', 'pending']);
    });

    it('should replace completed review with plan review when Request Changes planning awaits approval', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'human_review',
          reviewReason: 'completed',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      const plan = createTestPlan({
        status: 'human_review',
        reviewReason: 'plan_review',
        xstateState: 'plan_review',
        executionPhase: 'planning',
        phases: [
          {
            phase: 1,
            name: 'Replanned implementation',
            type: 'implementation',
            subtasks: [
              { id: 'new-1', title: 'Requested change', description: 'Requested change', status: 'pending' }
            ]
          }
        ]
      } as Partial<ImplementationPlan> & { executionPhase: string });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('plan_review');
      expect(task.executionProgress).toEqual({
        phase: 'planning',
        phaseProgress: 100,
        overallProgress: 100,
      });
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.subtasks.map(subtask => subtask.status)).toEqual(['pending']);
    });
    it('should NOT modify status from non-terminal plan (XState is source of truth)', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'ai_review' })]
      });

      const plan = createTestPlan({
        status: 'in_progress',
        xstateState: 'coding'
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      // Non-terminal plan updates should not steal active XState transitions.
      expect(useTaskStore.getState().tasks[0].status).toBe('ai_review');
    });

    it('should apply terminal completed status from final plan when status IPC is missed', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'coding',
            phaseProgress: 50,
            overallProgress: 50,
          }
        })]
      });

      const plan = createTestPlan({
        workflow_type: 'direct',
        status: 'human_review',
        reviewReason: 'completed',
        executionPhase: 'complete',
        xstateState: 'human_review',
        phases: [
          {
            phase: 1,
            name: 'Direct execution',
            type: 'direct',
            subtasks: [
              {
                id: 'direct-cr-20260701081142794',
                title: 'Direct Request Changes',
                description: 'Direct runtime iteration',
                status: 'completed',
                completed_at: '2026-07-01T08:20:42.717Z',
              }
            ]
          }
        ]
      } as Partial<ImplementationPlan> & { executionPhase: string });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.executionProgress?.overallProgress).toBe(100);
      expect(task.subtasks[0].status).toBe('completed');
    });

    it('should preserve existing status and reviewReason when plan has different values', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'human_review', reviewReason: 'errors' })]
      });

      const plan = createTestPlan({ status: 'ai_review' });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      // Status and reviewReason should remain unchanged - XState is source of truth
      expect(useTaskStore.getState().tasks[0].status).toBe('human_review');
      expect(useTaskStore.getState().tasks[0].reviewReason).toBe('errors');
    });

    it('should promote planning phase to coding when plan shows subtask execution activity', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'planning',
            phaseProgress: 15,
            overallProgress: 10,
          }
        })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Implementation',
            type: 'implementation',
            subtasks: [
              { id: 'c1', title: 'Subtask 1', description: 'Implement subtask 1', status: 'completed' },
              { id: 'c2', title: 'Subtask 2', description: 'Implement subtask 2', status: 'in_progress' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].executionProgress?.phase).toBe('coding');
      expect(useTaskStore.getState().tasks[0].executionProgress?.currentSubtask).toBe('Subtask 2');
    });

    it('should keep RequestChanges replanning in planning despite stale coding subtasks', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'coding',
            phaseProgress: 65,
            overallProgress: 55,
            currentSubtask: 'Old active subtask',
          }
        })]
      });

      const plan = createTestPlan({
        status: 'in_progress',
        xstateState: 'planning',
        executionPhase: 'planning',
        phases: [
          {
            phase: 1,
            name: 'Previous implementation subtasks',
            type: 'implementation',
            subtasks: [
              { id: 'c1', title: 'Old completed subtask', description: 'Already completed before feedback', status: 'completed' },
              { id: 'c2', title: 'Old active subtask', description: 'Was active before RequestChanges', status: 'in_progress' }
            ]
          }
        ]
      } as Partial<ImplementationPlan> & { executionPhase: string });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.status).toBe('in_progress');
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress?.phaseProgress).toBe(0);
      expect(task.executionProgress?.overallProgress).toBe(0);
      expect(task.executionProgress?.currentSubtask).toBeUndefined();
    });

    it('should promote active coding plan when local progress is stale completed', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      const plan = createTestPlan({
        status: 'in_progress',
        xstateState: 'coding',
        executionPhase: 'coding',
        phases: [
          {
            phase: 1,
            name: 'Implementation',
            type: 'implementation',
            subtasks: [
              { id: 'c1', title: 'Changed work', description: 'Apply Request Changes', status: 'in_progress' }
            ]
          }
        ]
      } as Partial<ImplementationPlan> & { executionPhase: string });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.executionProgress?.phaseProgress).toBe(0);
      expect(task.executionProgress?.overallProgress).toBe(0);
      expect(task.executionProgress?.currentSubtask).toBe('Changed work');
    });

    it('should skip update when plan is invalid', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', subtasks: [] })]
      });

      const invalidPlan = { feature: 'Test' } as any;

      useTaskStore.getState().updateTaskFromPlan('task-1', invalidPlan);

      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(0);
    });
  });

  describe('appendLog', () => {
    it('should append log to task by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', logs: [] })]
      });

      useTaskStore.getState().appendLog('task-1', 'First log');
      useTaskStore.getState().appendLog('task-1', 'Second log');

      expect(useTaskStore.getState().tasks[0].logs).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].logs[0]).toBe('First log');
      expect(useTaskStore.getState().tasks[0].logs[1]).toBe('Second log');
    });

    it('should append log to task by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', logs: [] })]
      });

      useTaskStore.getState().appendLog('spec-001', 'Log message');

      expect(useTaskStore.getState().tasks[0].logs).toContain('Log message');
    });

    it('should accumulate logs correctly', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', logs: ['existing log'] })]
      });

      useTaskStore.getState().appendLog('task-1', 'new log');

      expect(useTaskStore.getState().tasks[0].logs).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].logs[0]).toBe('existing log');
      expect(useTaskStore.getState().tasks[0].logs[1]).toBe('new log');
    });
  });

  describe('updateTaskTokenUsage', () => {
    it('should update task token usage by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      useTaskStore.getState().updateTaskTokenUsage('task-1', createTokenUsage({ totalTokens: 320 }));

      expect(useTaskStore.getState().tasks[0].tokenUsage?.totalTokens).toBe(320);
    });

    it('should update task token usage by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001' })]
      });

      useTaskStore.getState().updateTaskTokenUsage('spec-001', createTokenUsage({ promptTokens: 222 }));

      expect(useTaskStore.getState().tasks[0].tokenUsage?.promptTokens).toBe(222);
    });

    it('should preserve stepsExecuted when incoming usage omits it', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          tokenUsage: createTokenUsage({ stepsExecuted: 7 }),
        })]
      });

      useTaskStore.getState().updateTaskTokenUsage('task-1', createTokenUsage({
        promptTokens: 300,
        completionTokens: 80,
        totalTokens: 380,
      }));

      expect(useTaskStore.getState().tasks[0].tokenUsage?.stepsExecuted).toBe(7);
    });

    it('should keep the maximum stepsExecuted across updates', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      useTaskStore.getState().updateTaskTokenUsage('task-1', createTokenUsage({ stepsExecuted: 5 }));
      useTaskStore.getState().updateTaskTokenUsage('task-1', createTokenUsage({ stepsExecuted: 2 }));

      expect(useTaskStore.getState().tasks[0].tokenUsage?.stepsExecuted).toBe(5);
    });

    it('should replace estimated usage with provider-reported usage even when lower', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          tokenUsage: createTokenUsage({
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            stepsExecuted: 2,
            estimated: true,
          }),
        })]
      });

      useTaskStore.getState().updateTaskTokenUsage('task-1', createTokenUsage({
        promptTokens: 320,
        completionTokens: 90,
        totalTokens: 410,
        stepsExecuted: 2,
      }));

      expect(useTaskStore.getState().tasks[0].tokenUsage).toMatchObject({
        promptTokens: 320,
        completionTokens: 90,
        totalTokens: 410,
        stepsExecuted: 2,
      });
      expect(useTaskStore.getState().tasks[0].tokenUsage?.estimated).toBeUndefined();
    });
  });

  describe('selectTask', () => {
    it('should set selected task id', () => {
      useTaskStore.getState().selectTask('task-1');

      expect(useTaskStore.getState().selectedTaskId).toBe('task-1');
    });

    it('should clear selection with null', () => {
      useTaskStore.setState({ selectedTaskId: 'task-1' });

      useTaskStore.getState().selectTask(null);

      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });

  describe('setLoading', () => {
    it('should set loading state to true', () => {
      useTaskStore.getState().setLoading(true);

      expect(useTaskStore.getState().isLoading).toBe(true);
    });

    it('should set loading state to false', () => {
      useTaskStore.setState({ isLoading: true });

      useTaskStore.getState().setLoading(false);

      expect(useTaskStore.getState().isLoading).toBe(false);
    });
  });

  describe('setError', () => {
    it('should set error message', () => {
      useTaskStore.getState().setError('Something went wrong');

      expect(useTaskStore.getState().error).toBe('Something went wrong');
    });

    it('should clear error with null', () => {
      useTaskStore.setState({ error: 'Previous error' });

      useTaskStore.getState().setError(null);

      expect(useTaskStore.getState().error).toBeNull();
    });
  });

  describe('clearTasks', () => {
    it('should clear all tasks and selection', () => {
      useTaskStore.setState({
        tasks: [createTestTask(), createTestTask()],
        selectedTaskId: 'task-1'
      });

      useTaskStore.getState().clearTasks();

      expect(useTaskStore.getState().tasks).toHaveLength(0);
      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });

  describe('getSelectedTask', () => {
    it('should return undefined when no task selected', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })],
        selectedTaskId: null
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeUndefined();
    });

    it('should return selected task', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Task 1' }),
          createTestTask({ id: 'task-2', title: 'Task 2' })
        ],
        selectedTaskId: 'task-2'
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeDefined();
      expect(selected?.title).toBe('Task 2');
    });

    it('should return undefined for non-existent selected id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })],
        selectedTaskId: 'nonexistent'
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeUndefined();
    });
  });

  describe('activity recording for stuck detection', () => {
    afterEach(() => {
      // Clean up activity tracking between tests
      clearTaskActivity('task-1');
    });

    it('should record activity when updateTaskStatus is called', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'backlog' })]
      });

      // Clear any prior activity
      clearTaskActivity('task-1');
      expect(hasRecentActivity('task-1')).toBe(false);

      // Status change should record activity
      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      expect(hasRecentActivity('task-1')).toBe(true);
    });

    it('should record activity when batchAppendLogs is called', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      clearTaskActivity('task-1');
      expect(hasRecentActivity('task-1')).toBe(false);

      // Log append should record activity
      useTaskStore.getState().batchAppendLogs('task-1', ['line 1', 'line 2']);

      expect(hasRecentActivity('task-1')).toBe(true);
    });

    it('should record activity when updateExecutionProgress is called', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      clearTaskActivity('task-1');
      expect(hasRecentActivity('task-1')).toBe(false);

      // Execution progress should record activity
      useTaskStore.getState().updateExecutionProgress('task-1', { phase: 'coding', phaseProgress: 50 });

      expect(hasRecentActivity('task-1')).toBe(true);
    });

    it('should scope activity by project for duplicate task IDs', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', specId: '001-project-docs', projectId: 'project-a', status: 'in_progress' }),
          createTestTask({ id: 'task-1', specId: '001-project-docs', projectId: 'project-b', status: 'in_progress' }),
        ]
      });

      clearTaskActivity('task-1', 'project-a');
      clearTaskActivity('task-1', 'project-b');

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress', undefined, 'project-a');

      expect(hasRecentActivity('task-1', 'project-a')).toBe(true);
      expect(hasRecentActivity('task-1', 'project-b')).toBe(false);

      clearTaskActivity('task-1', 'project-a');
    });

    it('should not record activity for non-existent tasks in updateTaskStatus', () => {
      useTaskStore.setState({ tasks: [] });

      useTaskStore.getState().updateTaskStatus('nonexistent', 'in_progress');

      expect(hasRecentActivity('nonexistent')).toBe(false);
      clearTaskActivity('nonexistent');
    });
  });

  describe('getTasksByStatus', () => {
    it('should return empty array when no tasks match status', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ status: 'backlog' })]
      });

      const tasks = useTaskStore.getState().getTasksByStatus('in_progress');

      expect(tasks).toHaveLength(0);
    });

    it('should return all tasks with matching status', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', status: 'in_progress' }),
          createTestTask({ id: 'task-2', status: 'backlog' }),
          createTestTask({ id: 'task-3', status: 'in_progress' })
        ]
      });

      const tasks = useTaskStore.getState().getTasksByStatus('in_progress');

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id)).toContain('task-1');
      expect(tasks.map((t) => t.id)).toContain('task-3');
    });

    it('should filter by each status type', () => {
      const statuses: TaskStatus[] = ['backlog', 'in_progress', 'ai_review', 'human_review', 'done'];

      useTaskStore.setState({
        tasks: statuses.map((status) => createTestTask({ id: `task-${status}`, status }))
      });

      statuses.forEach((status) => {
        const tasks = useTaskStore.getState().getTasksByStatus(status);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe(status);
      });
    });
  });

  describe('multi-project task loading and queue capacity', () => {
    it('does not let one project at capacity block another project from starting', async () => {
      useProjectStore.setState({
        projects: [
          createTestProject('project-a', 1),
          createTestProject('project-b', 1),
        ],
        activeProjectId: 'project-a',
        selectedProjectId: 'project-a',
      });
      useTaskStore.setState({
        tasks: [
          createTestTask({
            id: 'task-a',
            specId: '001-same',
            projectId: 'project-a',
            status: 'in_progress',
          }),
          createTestTask({
            id: 'task-b',
            specId: '001-same',
            projectId: 'project-b',
            status: 'backlog',
          }),
        ],
      });

      const startTask = vi.fn();
      vi.stubGlobal('window', {
        electronAPI: {
          startTask,
          updateTaskStatus: vi.fn(),
        },
      });

      expect(isQueueAtCapacity(undefined, 'project-a')).toBe(true);
      expect(isQueueAtCapacity(undefined, 'project-b')).toBe(false);

      const result = await startTaskOrQueue('task-b', 'project-b');

      expect(result).toEqual({ action: 'started', success: true });
      expect(startTask).toHaveBeenCalledWith('task-b', { projectId: 'project-b' });
    });

    it('returns failure when recovery succeeds but auto-restart does not', async () => {
      const stoppedTask = createTestTask({
        id: 'task-1',
        specId: '001-task',
        projectId: 'project-1',
        status: 'human_review',
        reviewReason: 'stopped',
      });
      const recover = vi.fn().mockResolvedValue({
        success: true,
        data: {
          taskId: 'task-1',
          recovered: true,
          newStatus: 'human_review',
          message: 'Task recovered but cannot restart: authentication required',
          autoRestarted: false,
        },
      });
      vi.stubGlobal('window', {
        electronAPI: {
          recoverStuckTask: recover,
          getTasks: vi.fn().mockResolvedValue({ success: true, data: [stoppedTask] }),
        },
      });
      useTaskStore.setState({ tasks: [stoppedTask] });

      const result = await recoverStuckTask('task-1', { autoRestart: true, projectId: 'project-1' });

      expect(result).toEqual({
        success: false,
        message: 'Task recovered but cannot restart: authentication required',
        autoRestarted: false,
      });
      expect(recover).toHaveBeenCalledWith('task-1', { autoRestart: true, projectId: 'project-1' });
    });

    it('uses recovery restart for stopped human-review tasks', async () => {
      const stoppedTask = createTestTask({
        id: 'task-1',
        specId: '001-task',
        projectId: 'project-1',
        status: 'human_review',
        reviewReason: 'stopped',
      });
      const recover = vi.fn().mockResolvedValue({
        success: true,
        data: {
          taskId: 'task-1',
          recovered: true,
          newStatus: 'in_progress',
          message: 'Task recovered and restarted',
          autoRestarted: true,
        },
      });
      const startTask = vi.fn();
      vi.stubGlobal('window', {
        electronAPI: {
          recoverStuckTask: recover,
          getTasks: vi.fn().mockResolvedValue({ success: true, data: [stoppedTask] }),
          startTask,
        },
      });
      useTaskStore.setState({ tasks: [stoppedTask] });

      const result = await startTaskOrQueue('task-1', 'project-1');

      expect(result).toEqual({ action: 'started', success: true });
      expect(recover).toHaveBeenCalledWith('task-1', { autoRestart: true, projectId: 'project-1' });
      expect(startTask).not.toHaveBeenCalled();
    });

    it('returns failure when recovery restart cannot start a stopped task', async () => {
      const stoppedTask = createTestTask({
        id: 'task-1',
        specId: '001-task',
        projectId: 'project-1',
        status: 'human_review',
        reviewReason: 'stopped',
      });
      const recover = vi.fn().mockResolvedValue({
        success: true,
        data: {
          taskId: 'task-1',
          recovered: true,
          newStatus: 'human_review',
          message: 'Task recovered but cannot restart: authentication required',
          autoRestarted: false,
        },
      });
      const startTask = vi.fn();
      vi.stubGlobal('window', {
        electronAPI: {
          recoverStuckTask: recover,
          getTasks: vi.fn().mockResolvedValue({ success: true, data: [stoppedTask] }),
          startTask,
        },
      });
      useTaskStore.setState({ tasks: [stoppedTask] });

      const result = await startTaskOrQueue('task-1', 'project-1');

      expect(result).toEqual({
        action: 'started',
        success: false,
        error: 'Task recovered but cannot restart: authentication required',
      });
      expect(recover).toHaveBeenCalledWith('task-1', { autoRestart: true, projectId: 'project-1' });
      expect(startTask).not.toHaveBeenCalled();
    });

    it('optimistically moves a newly started backlog task into planning', async () => {
      const startTask = vi.fn();
      vi.stubGlobal('window', {
        electronAPI: {
          startTask,
        },
      });
      useTaskStore.setState({
        tasks: [
          createTestTask({
            id: 'task-1',
            specId: '001-task',
            projectId: 'project-1',
            status: 'backlog',
          }),
        ],
      });

      const result = await startTaskOrQueue('task-1', 'project-1');

      const task = useTaskStore.getState().tasks[0];
      expect(result).toEqual({ action: 'started', success: true });
      expect(task.status).toBe('in_progress');
      expect(task.executionProgress?.phase).toBe('planning');
      expect(startTask).toHaveBeenCalledWith('task-1', { projectId: 'project-1' });
    });

    it('ignores stale loadTasks results from a project that is no longer visible', async () => {
      let resolveProjectA: (value: { success: true; data: Task[] }) => void = () => {};
      let resolveProjectB: (value: { success: true; data: Task[] }) => void = () => {};
      const projectATasks = [
        createTestTask({ id: 'task-a', specId: '001-docs', projectId: 'project-a', title: 'Project A docs' }),
      ];
      const projectBTasks = [
        createTestTask({ id: 'task-b', specId: '001-docs', projectId: 'project-b', title: 'Project B docs' }),
      ];
      const getTasks = vi.fn((projectId: string) =>
        new Promise<{ success: true; data: Task[] }>((resolve) => {
          if (projectId === 'project-a') {
            resolveProjectA = resolve;
            return;
          }
          resolveProjectB = resolve;
        })
      );
      vi.stubGlobal('window', {
        electronAPI: {
          getTasks,
        },
      });
      useProjectStore.setState({
        projects: [
          createTestProject('project-a'),
          createTestProject('project-b'),
        ],
        activeProjectId: 'project-a',
        selectedProjectId: 'project-a',
      });

      const projectALoad = loadTasks('project-a');
      useProjectStore.setState({
        activeProjectId: 'project-b',
        selectedProjectId: 'project-b',
      });
      const projectBLoad = loadTasks('project-b');

      resolveProjectB({ success: true, data: projectBTasks });
      await projectBLoad;

      expect(useTaskStore.getState().tasks).toEqual(projectBTasks);

      resolveProjectA({ success: true, data: projectATasks });
      await projectALoad;

      expect(useTaskStore.getState().tasks).toEqual(projectBTasks);
    });

    it('serves cached project tasks immediately and refreshes in the background', async () => {
      let resolveRefresh: (value: { success: true; data: Task[] }) => void = () => {};
      const cachedTasks = [
        createTestTask({ id: 'task-cached', specId: '001-cache', projectId: 'project-cache', title: 'Cached task' }),
      ];
      const freshTasks = [
        createTestTask({ id: 'task-fresh', specId: '001-cache', projectId: 'project-cache', title: 'Fresh task' }),
      ];
      const getTasks = vi.fn()
        .mockResolvedValueOnce({ success: true, data: cachedTasks })
        .mockImplementationOnce(() =>
          new Promise<{ success: true; data: Task[] }>((resolve) => {
            resolveRefresh = resolve;
          })
        );

      vi.stubGlobal('window', {
        electronAPI: {
          getTasks,
        },
      });
      useProjectStore.setState({
        projects: [createTestProject('project-cache')],
        activeProjectId: 'project-cache',
        selectedProjectId: 'project-cache',
      });

      await loadTasks('project-cache');
      expect(useTaskStore.getState().tasks).toEqual(cachedTasks);

      const refreshLoad = loadTasks('project-cache', {
        preferCache: true,
        backgroundRefresh: true,
      });

      expect(useTaskStore.getState().tasks).toEqual(cachedTasks);
      expect(useTaskStore.getState().isLoading).toBe(false);
      expect(getTasks).toHaveBeenCalledTimes(2);

      resolveRefresh({ success: true, data: freshTasks });
      await refreshLoad;

      expect(useTaskStore.getState().tasks).toEqual(freshTasks);
    });

    it('keeps an active local task when a refresh result is missing it during startup', async () => {
      const activeTask = createTestTask({
        id: 'task-active',
        specId: '001-active',
        projectId: 'project-1',
        status: 'in_progress',
        executionProgress: {
          phase: 'planning',
          phaseProgress: 0,
          overallProgress: 0,
        },
      });
      const loadedTask = createTestTask({
        id: 'task-loaded',
        specId: '001-loaded',
        projectId: 'project-1',
        status: 'backlog',
      });

      vi.stubGlobal('window', {
        electronAPI: {
          getTasks: vi.fn().mockResolvedValue({ success: true, data: [loadedTask] }),
        },
      });
      useProjectStore.setState({
        projects: [createTestProject('project-1')],
        activeProjectId: 'project-1',
        selectedProjectId: 'project-1',
      });
      useTaskStore.setState({ tasks: [activeTask] });

      await loadTasks('project-1');

      expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual([
        'task-loaded',
        'task-active',
      ]);
      expect(useTaskStore.getState().tasks[1].status).toBe('in_progress');
      expect(useTaskStore.getState().tasks[1].executionProgress?.phase).toBe('planning');
    });

    it('keeps a task waiting for plan review when a refresh result temporarily misses it', async () => {
      const planReviewTask = createTestTask({
        id: 'task-plan-review',
        specId: '001-plan-review',
        projectId: 'project-1',
        status: 'human_review',
        reviewReason: 'plan_review',
        executionProgress: {
          phase: 'idle',
          phaseProgress: 0,
          overallProgress: 0,
        },
      });

      vi.stubGlobal('window', {
        electronAPI: {
          getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
        },
      });
      useProjectStore.setState({
        projects: [createTestProject('project-1')],
        activeProjectId: 'project-1',
        selectedProjectId: 'project-1',
      });
      useTaskStore.setState({ tasks: [planReviewTask] });

      await loadTasks('project-1', { forceRefresh: true });

      expect(useTaskStore.getState().tasks).toEqual([planReviewTask]);
    });
  });

  describe('execution phase regression protection', () => {
    it('should ignore regressive planning update after coding when no sequence number is present', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'coding',
            phaseProgress: 40,
            overallProgress: 35,
          }
        })]
      });

      useTaskStore.getState().updateExecutionProgress('task-1', {
        phase: 'planning',
        phaseProgress: 10,
        overallProgress: 5,
      });

      expect(useTaskStore.getState().tasks[0].executionProgress?.phase).toBe('coding');
    });

    it('should allow authoritative planning restart update after coding', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'in_progress',
          executionProgress: {
            phase: 'coding',
            phaseProgress: 40,
            overallProgress: 35,
          }
        })]
      });

      useTaskStore.getState().updateExecutionProgress('task-1', {
        phase: 'planning',
        phaseProgress: 0,
        overallProgress: 0,
        allowPhaseRegression: true,
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress).not.toHaveProperty('allowPhaseRegression');
    });

    it('should allow qa_fixing to qa_review transition without sequence number', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'ai_review',
          executionProgress: {
            phase: 'qa_fixing',
            phaseProgress: 60,
            overallProgress: 90,
          }
        })]
      });

      useTaskStore.getState().updateExecutionProgress('task-1', {
        phase: 'qa_review',
        phaseProgress: 20,
        overallProgress: 85,
      });

      expect(useTaskStore.getState().tasks[0].executionProgress?.phase).toBe('qa_review');
    });

    it('should ignore stale qa_review progress after completed human review', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          status: 'human_review',
          reviewReason: 'completed',
          executionProgress: {
            phase: 'complete',
            phaseProgress: 100,
            overallProgress: 100,
          }
        })]
      });

      useTaskStore.getState().updateExecutionProgress('task-1', {
        phase: 'qa_review',
        phaseProgress: 100,
        overallProgress: 95,
        sequenceNumber: 999,
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.executionProgress?.overallProgress).toBe(100);
    });
  });

});
