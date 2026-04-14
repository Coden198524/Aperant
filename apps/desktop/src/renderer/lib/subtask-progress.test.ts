import { describe, expect, it } from 'vitest';
import type { Subtask } from '../../shared/types';
import { resolveActiveSubtaskIndex } from './subtask-progress';

const subtasks: Subtask[] = [
  { id: 'subtask-1', title: 'First subtask', description: 'First subtask', status: 'pending', files: [] },
  { id: 'subtask-2', title: 'Second subtask', description: 'Second subtask', status: 'pending', files: [] },
  { id: 'subtask-3', title: 'Third subtask', description: 'Third subtask', status: 'pending', files: [] },
];

describe('subtask-progress', () => {
  it('resolves the active subtask index from the current subtask id', () => {
    const activeIndex = resolveActiveSubtaskIndex({
      subtasks,
      currentSubtask: 'subtask-1',
      isRunning: true,
      phase: 'coding',
    });

    expect(activeIndex).toBe(0);
  });

  it('prefers explicit in_progress statuses over current subtask hints', () => {
    const subtasksWithExplicitStatus: Subtask[] = [
      { ...subtasks[0], status: 'completed' },
      { ...subtasks[1], status: 'in_progress' },
      subtasks[2],
    ];

    const activeIndex = resolveActiveSubtaskIndex({
      subtasks: subtasksWithExplicitStatus,
      currentSubtask: 'subtask-3',
      isRunning: true,
      phase: 'coding',
    });

    expect(activeIndex).toBe(1);
  });

  it('supports numeric progress hints in the current subtask text', () => {
    const activeIndex = resolveActiveSubtaskIndex({
      subtasks,
      currentSubtask: '3/3',
      isRunning: true,
      phase: 'coding',
    });

    expect(activeIndex).toBe(2);
  });
});
