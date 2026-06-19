import { describe, expect, it } from 'vitest';

import {
  dedupeAutocodeProjectTasks,
  type AutocodeProjectTask,
} from './project-task-loader.js';

function makeTask(overrides: Partial<AutocodeProjectTask> & { specId: string }): AutocodeProjectTask {
  return {
    id: overrides.specId,
    specId: overrides.specId,
    projectRoot: '/repo',
    title: 'Task',
    description: 'Task description',
    status: 'backlog',
    subtasks: [],
    logs: [],
    location: 'main',
    specsPath: `/repo/.autocode/specs/${overrides.specId}`,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('project task loading', () => {
  it('exposes the worktree spec directory when a deduped task has an active worktree copy', () => {
    const mainTask = makeTask({
      specId: '001-worktree-files',
      status: 'human_review',
      reviewReason: 'plan_review',
      location: 'main',
      projectRoot: '/repo',
      specsPath: '/repo/.autocode/specs/001-worktree-files',
    });
    const worktreeTask = makeTask({
      specId: '001-worktree-files',
      status: 'in_progress',
      location: 'worktree',
      projectRoot: '/repo/.autocode/worktrees/tasks/001-worktree-files',
      specsPath: '/repo/.autocode/worktrees/tasks/001-worktree-files/.autocode/specs/001-worktree-files',
      subtasks: [
        {
          id: '1.1',
          title: 'Generated from tasks.md',
          description: 'Runtime work package from worktree tasks.md.',
          status: 'pending',
          files: [],
        },
      ],
    });

    const [task] = dedupeAutocodeProjectTasks([mainTask, worktreeTask]);

    expect(task.status).toBe('human_review');
    expect(task.reviewReason).toBe('plan_review');
    expect(task.location).toBe('worktree');
    expect(task.projectRoot).toBe('/repo/.autocode/worktrees/tasks/001-worktree-files');
    expect(task.specsPath).toBe(
      '/repo/.autocode/worktrees/tasks/001-worktree-files/.autocode/specs/001-worktree-files',
    );
    expect(task.subtasks).toHaveLength(1);
  });
});
