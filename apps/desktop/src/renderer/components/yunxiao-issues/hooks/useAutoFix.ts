import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadTasks } from '../../../stores/task-store';
import type { YunxiaoAutoFixConfig, YunxiaoAutoFixQueueItem } from '../../../../shared/types';

export function useAutoFix(projectId: string | undefined) {
  const [config, setConfig] = useState<YunxiaoAutoFixConfig | null>(null);
  const [queue, setQueue] = useState<YunxiaoAutoFixQueueItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [runningWorkItemIds, setRunningWorkItemIds] = useState<Set<string>>(new Set());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const [nextConfig, nextQueue] = await Promise.all([
        window.electronAPI.getYunxiaoAutoFixConfig(projectId),
        window.electronAPI.getYunxiaoAutoFixQueue(projectId),
      ]);
      setConfig(nextConfig);
      setQueue(nextQueue);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!projectId) return;

    const cleanupProgress = window.electronAPI.onYunxiaoAutoFixProgress((eventProjectId, progress) => {
      if (eventProjectId !== projectId) return;
      setRunningWorkItemIds((prev) => {
        const next = new Set(prev);
        if (progress.phase === 'complete') {
          next.delete(progress.workItemId);
        } else {
          next.add(progress.workItemId);
        }
        return next;
      });
    });

    const cleanupComplete = window.electronAPI.onYunxiaoAutoFixComplete((eventProjectId) => {
      if (eventProjectId !== projectId) return;
      setRunningWorkItemIds(new Set());
      void window.electronAPI.getYunxiaoAutoFixQueue(projectId).then(setQueue);
      void loadTasks(projectId, { forceRefresh: true });
    });

    const cleanupError = window.electronAPI.onYunxiaoAutoFixError((eventProjectId, error) => {
      if (eventProjectId !== projectId) return;
      if (error.workItemId) {
        setRunningWorkItemIds((prev) => {
          const next = new Set(prev);
          next.delete(error.workItemId!);
          return next;
        });
      } else {
        setRunningWorkItemIds(new Set());
      }
      void window.electronAPI.getYunxiaoAutoFixQueue(projectId).then(setQueue);
    });

    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [projectId]);

  const saveConfig = useCallback(async (nextConfig: YunxiaoAutoFixConfig): Promise<boolean> => {
    if (!projectId) return false;
    const success = await window.electronAPI.saveYunxiaoAutoFixConfig(projectId, nextConfig);
    if (success) {
      setConfig(nextConfig);
    }
    return success;
  }, [projectId]);

  const toggleAutoFix = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!config) return false;
    return saveConfig({ ...config, enabled });
  }, [config, saveConfig]);

  const checkForNewIssues = useCallback(async () => {
    if (!projectId || !config?.enabled) return;
    const newIssues = await window.electronAPI.checkNewYunxiaoIssues(projectId);
    for (const issue of newIssues) {
      window.electronAPI.startYunxiaoAutoFix(projectId, issue.workItemId);
    }
  }, [config?.enabled, projectId]);

  useEffect(() => {
    if (!projectId || !config?.enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      void checkForNewIssues();
    }, 5 * 60 * 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [checkForNewIssues, config?.enabled, projectId]);

  const getQueueItem = useCallback((workItemId: string): YunxiaoAutoFixQueueItem | null => {
    return queue.find((item) => item.workItemId === workItemId) || null;
  }, [queue]);

  const activeQueueCount = useMemo(() => runningWorkItemIds.size, [runningWorkItemIds]);

  return {
    config,
    queue,
    isLoading,
    activeQueueCount,
    getQueueItem,
    toggleAutoFix,
    checkForNewIssues,
    refresh: loadData,
  };
}
