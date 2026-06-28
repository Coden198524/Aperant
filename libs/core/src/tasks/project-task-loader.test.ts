import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dedupeAutocodeProjectTasks,
  loadAutocodeProjectTasks,
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

  it('moves stale review tasks with incomplete work packages back to coding', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '001-stale-review');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Stale review',
        'Status: review',
        'Review Reason: completed',
        'Execution Phase: complete',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-06-20T00:00:00.000Z',
        '<!-- autocode-plan-meta: {"planStatus":"review","xstateState":"human_review","last_updated":"2026-06-20T00:00:00.000Z"} -->',
        '',
        '- [ ] 1. Implementation',
        '  - [x] wp-1 Completed package',
        '  - [!] wp-2 Failed package',
        '  - [-] wp-3 Blocked package',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('coding');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: coding');
      expect(rawPlan).toContain('Execution Phase: coding');
      expect(rawPlan).toContain('"xstateState":"coding"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps plan review tasks in human review even when runtime subtasks are pending', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '001-plan-review');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Plan review',
        'Status: human_review',
        'Review Reason: plan_review',
        'Execution Phase: planning',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-06-20T00:00:00.000Z',
        '<!-- autocode-plan-meta: {"planStatus":"review","xstateState":"plan_review","last_updated":"2026-06-20T00:00:00.000Z"} -->',
        '',
        '- [ ] 1. Implementation',
        '  - [ ] wp-1 Pending package',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('plan_review');
      expect(task.executionProgress?.phase).toBe('planning');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('Review Reason: plan_review');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
