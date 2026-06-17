import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskStatus } from '../../shared/types';
import {
  AUTO_RECOVER_COOLDOWN_MS,
  scanAndRecoverStuckTasks,
} from './useAutoRecoverStuckTasks';

function createTask(id: string, status: TaskStatus): Task {
  return {
    id,
    specId: id,
    projectId: 'project-1',
    title: `Task ${id}`,
    description: 'Test task',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date('2026-04-10T00:00:00.000Z'),
    updatedAt: new Date('2026-04-10T00:00:00.000Z'),
  };
}

describe('scanAndRecoverStuckTasks', () => {
  it('recovers active tasks that have no recent activity and no running process', async () => {
    const checkTaskRunning = vi.fn().mockResolvedValue(false);
    const recoverStuckTask = vi.fn().mockResolvedValue({
      success: true,
      message: 'Recovered',
      autoRestarted: true,
    });

    await scanAndRecoverStuckTasks(
      {
        recoveringTaskIds: new Set<string>(),
        lastRecoveryAttemptAt: new Map<string, number>(),
      },
      {
        tasks: [createTask('001', 'in_progress')],
        hasRecentActivity: () => false,
        checkTaskRunning,
        recoverStuckTask,
        now: () => 1_000,
      }
    );

    expect(checkTaskRunning).toHaveBeenCalledWith('001', 'project-1');
    expect(recoverStuckTask).toHaveBeenCalledWith('001', { autoRestart: true, projectId: 'project-1' });
  });

  it('skips recovery when recent activity exists', async () => {
    const checkTaskRunning = vi.fn().mockResolvedValue(false);
    const recoverStuckTask = vi.fn();

    await scanAndRecoverStuckTasks(
      {
        recoveringTaskIds: new Set<string>(),
        lastRecoveryAttemptAt: new Map<string, number>(),
      },
      {
        tasks: [createTask('002', 'in_progress')],
        hasRecentActivity: () => true,
        checkTaskRunning,
        recoverStuckTask,
      }
    );

    expect(checkTaskRunning).not.toHaveBeenCalled();
    expect(recoverStuckTask).not.toHaveBeenCalled();
  });

  it('skips recovery when the backend reports an active runtime', async () => {
    const checkTaskRunning = vi.fn().mockResolvedValue(true);
    const recoverStuckTask = vi.fn();

    await scanAndRecoverStuckTasks(
      {
        recoveringTaskIds: new Set<string>(),
        lastRecoveryAttemptAt: new Map<string, number>(),
      },
      {
        tasks: [createTask('004', 'in_progress')],
        hasRecentActivity: () => false,
        checkTaskRunning,
        recoverStuckTask,
      }
    );

    expect(checkTaskRunning).toHaveBeenCalledWith('004', 'project-1');
    expect(recoverStuckTask).not.toHaveBeenCalled();
  });

  it('skips repeated recovery attempts during cooldown', async () => {
    const checkTaskRunning = vi.fn().mockResolvedValue(false);
    const recoverStuckTask = vi.fn();

    await scanAndRecoverStuckTasks(
      {
        recoveringTaskIds: new Set<string>(),
        lastRecoveryAttemptAt: new Map<string, number>([['project-1::003', 5_000]]),
      },
      {
        tasks: [createTask('003', 'ai_review')],
        hasRecentActivity: () => false,
        checkTaskRunning,
        recoverStuckTask,
        now: () => 5_000 + AUTO_RECOVER_COOLDOWN_MS - 1,
      }
    );

    expect(checkTaskRunning).not.toHaveBeenCalled();
    expect(recoverStuckTask).not.toHaveBeenCalled();
  });
});
