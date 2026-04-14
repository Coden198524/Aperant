import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../../types';
import { updateSubtaskStatusTool } from '../update-subtask-status';
import { updateQaStatusTool } from '../update-qa-status';

const mockExistsSync = vi.fn(() => true);
const mockReadFileSync = vi.fn();
const mockWriteFileAtomic = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock('../../../../utils/atomic-file', () => ({
  writeFileAtomic: (...args: unknown[]) => mockWriteFileAtomic(...args),
}));

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

describe('Auto-Claude plan update tools', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReset();
    mockWriteFileAtomic.mockReset();
  });

  it('updates subtask status through the locked plan updater', async () => {
    let planState = {
      phases: [
        {
          subtasks: [
            { id: 'subtask-1', status: 'pending' },
            { id: 'subtask-2', status: 'in_progress' },
          ],
        },
      ],
    };

    mockReadFileSync.mockImplementation(() => JSON.stringify(planState));
    mockWriteFileAtomic.mockImplementation(async (_planPath: string, content: string | Buffer) => {
      planState = JSON.parse(String(content));
    });

    const result = await updateSubtaskStatusTool.config.execute(
      { subtask_id: 'subtask-1', status: 'completed' },
      baseContext,
    );

    expect(result).toContain("Successfully updated subtask 'subtask-1' to status 'completed'");
    expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    expect(planState.phases[0].subtasks.map((subtask) => subtask.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('updates QA status through the locked plan updater without clobbering the whole file', async () => {
    let planState = {
      feature: 'Test feature',
      phases: [
        {
          subtasks: [
            { id: 'subtask-1', status: 'completed' },
          ],
        },
      ],
      qa_signoff: {
        status: 'pending',
        qa_session: 1,
        issues_found: [],
        tests_passed: {},
        timestamp: '2024-01-01T00:00:00.000Z',
        ready_for_qa_revalidation: false,
      },
    };

    mockReadFileSync.mockImplementation(() => JSON.stringify(planState));
    mockWriteFileAtomic.mockImplementation(async (_planPath: string, content: string | Buffer) => {
      planState = JSON.parse(String(content));
    });

    const result = await updateQaStatusTool.config.execute(
      {
        status: 'rejected',
        issues: '[{\"description\":\"Fix the failing test\"}]',
        tests_passed: '{\"unit\":\"pass\"}',
      },
      baseContext,
    );

    expect(result).toContain("Updated QA status to 'rejected' (session 2)");
    expect(mockWriteFileAtomic).toHaveBeenCalledTimes(1);
    expect(planState.feature).toBe('Test feature');
    expect(planState.phases[0].subtasks[0].status).toBe('completed');
    expect(planState.qa_signoff.qa_session).toBe(2);
    expect(planState.qa_signoff.status).toBe('rejected');
  });
});
