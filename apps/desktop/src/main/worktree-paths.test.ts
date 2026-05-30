import { existsSync } from 'fs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { debugLog } from '../shared/utils/debug-logger';
import { findTaskWorktree } from './worktree-paths';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
}));

describe('worktree path logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not print missing task worktrees to the default console log', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    (existsSync as Mock).mockReturnValue(false);

    const result = findTaskWorktree('E:\\Work\\Project', '001-task');

    expect(result).toBeNull();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith(
      '[worktree-paths] No dedicated worktree found for task:',
      '001-task'
    );

    consoleLog.mockRestore();
  });
});
