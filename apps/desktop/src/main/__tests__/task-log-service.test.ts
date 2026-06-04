import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskLogs } from '../../shared/types';

const existsSyncMock = vi.fn();
const findTaskWorktreeMock = vi.fn();
const readAutocodeTaskLogsFromSpecDirMock = vi.fn();
const mergeAutocodeTaskLogsMock = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
  };
});

vi.mock('@autocode/core', () => ({
  AUTOCODE_TASK_ARTIFACTS: {
    taskLogs: 'task_logs.json',
  },
  mergeAutocodeTaskLogs: (...args: unknown[]) => mergeAutocodeTaskLogsMock(...args),
  readAutocodeTaskLogsFromSpecDir: (...args: unknown[]) => readAutocodeTaskLogsFromSpecDirMock(...args),
}));

vi.mock('../worktree-paths', () => ({
  findTaskWorktree: (...args: unknown[]) => findTaskWorktreeMock(...args),
}));

vi.mock('../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

function createLogs(specId: string, content: string): TaskLogs {
  return {
    spec_id: specId,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    phases: {
      planning: {
        phase: 'planning',
        status: 'completed',
        started_at: null,
        completed_at: null,
        entries: [],
      },
      coding: {
        phase: 'coding',
        status: 'active',
        started_at: null,
        completed_at: null,
        entries: [
          {
            timestamp: '2026-01-01T00:00:00.000Z',
            phase: 'coding',
            type: 'text',
            content,
          },
        ],
      },
      validation: {
        phase: 'validation',
        status: 'pending',
        started_at: null,
        completed_at: null,
        entries: [],
      },
    },
  };
}

describe('TaskLogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it('keeps raw file cache separate from merged log cache', async () => {
    const { TaskLogService } = await import('../task-log-service');

    const projectRoot = 'E:\\repo';
    const specsRelPath = '.autocode\\specs';
    const specId = '001-direct';
    const mainSpecDir = path.join(projectRoot, specsRelPath, specId);
    const worktreePath = path.join(projectRoot, '.autocode\\worktrees\\tasks', specId);
    const worktreeSpecDir = path.join(worktreePath, specsRelPath, specId);

    const mainLogs = createLogs(specId, 'main');
    const worktreeLogs = createLogs(specId, 'worktree');
    const mergedLogs = createLogs(specId, 'merged');

    findTaskWorktreeMock.mockReturnValue(worktreePath);
    readAutocodeTaskLogsFromSpecDirMock.mockImplementation((specDir: string) => {
      if (specDir === mainSpecDir) return mainLogs;
      if (specDir === worktreeSpecDir) return worktreeLogs;
      return null;
    });
    mergeAutocodeTaskLogsMock.mockReturnValue(mergedLogs);

    const service = new TaskLogService();
    expect(service.loadLogs(mainSpecDir, projectRoot, specsRelPath, specId)).toBe(mergedLogs);
    expect(service.getCachedLogs(mainSpecDir)).toBe(mergedLogs);

    readAutocodeTaskLogsFromSpecDirMock.mockImplementation((specDir: string) => {
      if (specDir === mainSpecDir) return null;
      if (specDir === worktreeSpecDir) return worktreeLogs;
      return null;
    });

    expect(service.loadLogsFromPath(mainSpecDir)).toBe(mainLogs);
    service.loadLogs(mainSpecDir, projectRoot, specsRelPath, specId);
    expect(mergeAutocodeTaskLogsMock).toHaveBeenLastCalledWith(mainLogs, worktreeLogs);
  });
});
