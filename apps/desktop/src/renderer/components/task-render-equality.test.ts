import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/types';
import { areTaskListsRenderEquivalent, isTaskRenderEquivalent } from './task-render-equality';

function createTask(): Task {
  const timestamp = new Date('2026-01-01T00:00:00Z');

  return {
    id: 'task-1',
    specId: 'spec-1',
    projectId: 'project-1',
    title: 'Show planning progress on kanban cards',
    description: 'Ensure planning progress updates are visible on the board',
    status: 'in_progress',
    reviewReason: undefined,
    subtasks: [],
    logs: ['initial log'],
    executionProgress: {
      phase: 'planning',
      phaseProgress: 10,
      overallProgress: 10,
      message: 'Assessing complexity',
      sequenceNumber: 1,
    },
    tokenUsage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      stepsExecuted: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('task-render-equality', () => {
  it('treats planning progress updates as render-affecting changes', () => {
    const prevTask = createTask();
    const nextTask: Task = {
      ...prevTask,
      executionProgress: {
        ...prevTask.executionProgress!,
        phaseProgress: 55,
        overallProgress: 55,
        message: 'Writing context.md',
        sequenceNumber: 2,
      },
    };

    expect(isTaskRenderEquivalent(prevTask, nextTask)).toBe(false);
    expect(areTaskListsRenderEquivalent([prevTask], [nextTask])).toBe(false);
  });

  it('ignores non-rendering fields such as accumulated logs', () => {
    const prevTask = createTask();
    const nextTask: Task = {
      ...prevTask,
      logs: [...prevTask.logs, 'additional trace'],
    };

    expect(isTaskRenderEquivalent(prevTask, nextTask)).toBe(true);
    expect(areTaskListsRenderEquivalent([prevTask], [nextTask])).toBe(true);
  });

  it('treats subtask completion summary updates as render-affecting changes', () => {
    const prevTask = {
      ...createTask(),
      subtasks: [
        {
          id: 'subtask-1',
          title: 'Review summary',
          description: 'Display completed work',
          status: 'completed' as const,
          files: [],
        },
      ],
    };
    const nextTask: Task = {
      ...prevTask,
      subtasks: [
        {
          ...prevTask.subtasks[0],
          completionSummary: 'Added the summary panel for human review.',
        },
      ],
    };

    expect(isTaskRenderEquivalent(prevTask, nextTask)).toBe(false);
    expect(areTaskListsRenderEquivalent([prevTask], [nextTask])).toBe(false);
  });
});
