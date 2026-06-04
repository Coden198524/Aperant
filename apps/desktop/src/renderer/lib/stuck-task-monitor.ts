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

export function subscribeStuckTask(taskId: string, listener: StuckTaskListener): () => void {
  let entry = monitoredTasks.get(taskId);
  if (!entry) {
    entry = {
      listeners: new Set(),
      isChecking: false,
      lastValue: false,
    };
    monitoredTasks.set(taskId, entry);
  }

  entry.listeners.add(listener);
  listener(entry.lastValue);
  ensureMonitorInterval();

  return () => {
    const current = monitoredTasks.get(taskId);
    if (!current) {
      return;
    }

    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      monitoredTasks.delete(taskId);
    }
    stopMonitorIntervalIfIdle();
  };
}

function ensureMonitorInterval(): void {
  if (monitorInterval) {
    return;
  }

  monitorInterval = setInterval(() => {
    for (const taskId of monitoredTasks.keys()) {
      void checkTaskStuckState(taskId);
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

async function checkTaskStuckState(taskId: string): Promise<void> {
  const entry = monitoredTasks.get(taskId);
  if (!entry || entry.isChecking) {
    return;
  }

  if (hasRecentActivity(taskId)) {
    emitStuckState(taskId, false);
    return;
  }

  entry.isChecking = true;
  try {
    const actuallyRunning = await checkTaskRunning(taskId);
    emitStuckState(taskId, hasRecentActivity(taskId) ? false : !actuallyRunning);
  } finally {
    const current = monitoredTasks.get(taskId);
    if (current) {
      current.isChecking = false;
    }
  }
}

function emitStuckState(taskId: string, isStuck: boolean): void {
  const entry = monitoredTasks.get(taskId);
  if (!entry || entry.lastValue === isStuck) {
    return;
  }

  entry.lastValue = isStuck;
  for (const listener of entry.listeners) {
    listener(isStuck);
  }
}
