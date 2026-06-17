import { checkTaskRunning, hasRecentActivity } from '../stores/task-store';

type StuckTaskListener = (isStuck: boolean) => void;

interface MonitoredTask {
  listeners: Set<StuckTaskListener>;
  isChecking: boolean;
  lastValue: boolean;
}

// XState handles normal process-exit transitions. This shared monitor is a
// last-resort safety net for running tasks that stop producing activity.
const STUCK_CHECK_INTERVAL_MS = 60_000;

const monitoredTasks = new Map<string, MonitoredTask>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

function getMonitorKey(taskId: string, projectId?: string): string {
  return projectId ? `${projectId}::${taskId}` : taskId;
}

export function subscribeStuckTask(taskId: string, projectId: string | undefined, listener: StuckTaskListener): () => void {
  const monitorKey = getMonitorKey(taskId, projectId);
  let entry = monitoredTasks.get(monitorKey);
  if (!entry) {
    entry = {
      listeners: new Set(),
      isChecking: false,
      lastValue: false,
    };
    monitoredTasks.set(monitorKey, entry);
  }

  entry.listeners.add(listener);
  listener(entry.lastValue);
  ensureMonitorInterval();

  return () => {
    const current = monitoredTasks.get(monitorKey);
    if (!current) {
      return;
    }

    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      monitoredTasks.delete(monitorKey);
    }
    stopMonitorIntervalIfIdle();
  };
}

function ensureMonitorInterval(): void {
  if (monitorInterval) {
    return;
  }

  monitorInterval = setInterval(() => {
    for (const monitorKey of monitoredTasks.keys()) {
      void checkTaskStuckState(monitorKey);
    }
  }, STUCK_CHECK_INTERVAL_MS);
}

function stopMonitorIntervalIfIdle(): void {
  if (monitoredTasks.size > 0 || !monitorInterval) {
    return;
  }

  clearInterval(monitorInterval);
  monitorInterval = null;
}

async function checkTaskStuckState(monitorKey: string): Promise<void> {
  const entry = monitoredTasks.get(monitorKey);
  if (!entry || entry.isChecking) {
    return;
  }

  const separatorIndex = monitorKey.indexOf('::');
  const projectId = separatorIndex === -1 ? undefined : monitorKey.slice(0, separatorIndex);
  const taskId = separatorIndex === -1 ? monitorKey : monitorKey.slice(separatorIndex + 2);

  if (hasRecentActivity(taskId, projectId)) {
    emitStuckState(monitorKey, false);
    return;
  }

  entry.isChecking = true;
  try {
    const actuallyRunning = await checkTaskRunning(taskId, projectId);
    emitStuckState(monitorKey, hasRecentActivity(taskId, projectId) ? false : !actuallyRunning);
  } finally {
    const current = monitoredTasks.get(monitorKey);
    if (current) {
      current.isChecking = false;
    }
  }
}

function emitStuckState(monitorKey: string, isStuck: boolean): void {
  const entry = monitoredTasks.get(monitorKey);
  if (!entry || entry.lastValue === isStuck) {
    return;
  }

  entry.lastValue = isStuck;
  for (const listener of entry.listeners) {
    listener(isStuck);
  }
}
