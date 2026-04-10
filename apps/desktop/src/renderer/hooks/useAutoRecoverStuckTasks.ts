import { useEffect, useRef } from 'react';
import type { Task, TaskStatus } from '../../shared/types';
import { useTaskStore, hasRecentActivity, checkTaskRunning, recoverStuckTask } from '../stores/task-store';

export const AUTO_RECOVER_SCAN_INTERVAL_MS = 30_000;
export const AUTO_RECOVER_COOLDOWN_MS = 3 * 60_000;

interface AutoRecoverRuntimeState {
  recoveringTaskIds: Set<string>;
  lastRecoveryAttemptAt: Map<string, number>;
}

interface AutoRecoverScanDeps {
  tasks: Task[];
  hasRecentActivity: (taskId: string) => boolean;
  checkTaskRunning: (taskId: string) => Promise<boolean>;
  recoverStuckTask: (
    taskId: string,
    options: { autoRestart?: boolean; targetStatus?: TaskStatus }
  ) => Promise<{ success: boolean; message: string; autoRestarted?: boolean }>;
  now?: () => number;
}

export function isAutoRecoverCandidateStatus(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'ai_review';
}

export async function scanAndRecoverStuckTasks(
  runtimeState: AutoRecoverRuntimeState,
  deps: AutoRecoverScanDeps
): Promise<void> {
  const currentTaskIds = new Set<string>();

  for (const task of deps.tasks) {
    if (isAutoRecoverCandidateStatus(task.status)) {
      currentTaskIds.add(task.id);
    }
  }

  for (const taskId of Array.from(runtimeState.recoveringTaskIds)) {
    if (!currentTaskIds.has(taskId)) {
      runtimeState.recoveringTaskIds.delete(taskId);
    }
  }

  for (const taskId of Array.from(runtimeState.lastRecoveryAttemptAt.keys())) {
    if (!currentTaskIds.has(taskId)) {
      runtimeState.lastRecoveryAttemptAt.delete(taskId);
    }
  }

  const scanStartedAt = deps.now?.() ?? Date.now();
  const candidates = deps.tasks.filter((task) => isAutoRecoverCandidateStatus(task.status));

  await Promise.allSettled(
    candidates.map(async (task) => {
      const taskId = task.id;

      if (runtimeState.recoveringTaskIds.has(taskId)) {
        return;
      }

      const lastRecoveryAttemptAt = runtimeState.lastRecoveryAttemptAt.get(taskId);
      if (
        typeof lastRecoveryAttemptAt === 'number' &&
        scanStartedAt - lastRecoveryAttemptAt < AUTO_RECOVER_COOLDOWN_MS
      ) {
        return;
      }

      if (deps.hasRecentActivity(taskId)) {
        return;
      }

      runtimeState.recoveringTaskIds.add(taskId);

      try {
        const actuallyRunning = await deps.checkTaskRunning(taskId);

        if (actuallyRunning || deps.hasRecentActivity(taskId)) {
          return;
        }

        runtimeState.lastRecoveryAttemptAt.set(taskId, deps.now?.() ?? Date.now());

        const result = await deps.recoverStuckTask(taskId, { autoRestart: true });
        if (!result.success) {
          console.warn('[AutoRecover] Failed to recover stuck task:', taskId, result.message);
          return;
        }

        console.warn(
          `[AutoRecover] Recovered stuck task ${taskId}${result.autoRestarted ? ' and restarted execution' : ''}`
        );
      } catch (error) {
        console.error('[AutoRecover] Unexpected error while recovering stuck task:', taskId, error);
      } finally {
        runtimeState.recoveringTaskIds.delete(taskId);
      }
    })
  );
}

export function useAutoRecoverStuckTasks(): void {
  const runtimeStateRef = useRef<AutoRecoverRuntimeState>({
    recoveringTaskIds: new Set<string>(),
    lastRecoveryAttemptAt: new Map<string, number>(),
  });
  const scanInProgressRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const runScan = async () => {
      if (disposed || scanInProgressRef.current) {
        return;
      }

      scanInProgressRef.current = true;

      try {
        await scanAndRecoverStuckTasks(runtimeStateRef.current, {
          tasks: useTaskStore.getState().tasks,
          hasRecentActivity,
          checkTaskRunning,
          recoverStuckTask,
        });
      } finally {
        scanInProgressRef.current = false;
      }
    };

    void runScan();
    const intervalId = window.setInterval(() => {
      void runScan();
    }, AUTO_RECOVER_SCAN_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, []);
}
