import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('repairs completed legacy direct CLI runs that left the plan in coding', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '008-direct-cli');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the runtime issue and validation passed.\n', 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'success',
        message: 'Autocode CLI run completed.',
        updatedAt: '2026-07-01T06:05:24.493Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T06:05:28.090Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","tokenUsage":{"promptTokens":10,"completionTokens":5,"totalTokens":15,"sessionId":"codex-session"},"direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-1","summary_file":"direct_summary.md"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [ ] direct-cr-1 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.subtasks[0]?.status).toBe('completed');
      expect(existsSync(join(specDir, 'direct_session.json'))).toBe(true);
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('Execution Phase: complete');
      expect(rawPlan).toContain('"outcome":"completed"');
      expect(rawPlan).toContain('- [x] direct. Direct execution');
      expect(rawPlan).toContain('  - [x] direct-cr-1 Direct Request Changes');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('repairs Direct run results that report completed as the success status', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '008-direct-cli-completed');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the runtime issue and validation passed.\n', 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'completed',
        message: 'Autocode CLI run completed.',
        updatedAt: '2026-07-01T06:05:24.493Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T06:05:28.090Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-1","summary_file":"direct_summary.md"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [ ] direct-cr-1 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.subtasks[0]?.status).toBe('completed');
      const directSession = JSON.parse(readFileSync(join(specDir, 'direct_session.json'), 'utf8')) as { lastOutcome?: string };
      expect(directSession.lastOutcome).toBe('completed');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('Execution Phase: complete');
      expect(rawPlan).toContain('"outcome":"completed"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('does not repair Direct max_steps outcomes as completed', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '008-direct-max-steps');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'max_steps',
        message: 'Direct session reached max steps.',
        updatedAt: '2026-07-01T06:05:24.493Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T06:05:28.090Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"max_steps","completed_at":"2026-07-01T06:05:24.493Z","current_subtask_id":"direct-implementation","summary_file":"direct_summary.md"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [ ] direct-implementation Direct model execution',
        '    - Implement the task directly.',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.subtasks[0]?.status).toBe('pending');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: coding');
      expect(rawPlan).toContain('"outcome":"max_steps"');
      expect(rawPlan).not.toContain('Status: human_review');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not complete a newer direct Request Changes node with an older run result', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '008-direct-cli');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'success',
        message: 'Older Direct run completed.',
        updatedAt: '2026-07-01T06:05:24.493Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T07:49:20.827Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-20260701074920826","change_request_id":"cr-20260701074920826","summary_file":"direct_summary.md"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [/] direct-cr-20260701074920826 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Started: 2026-07-01T07:49:20.827Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.subtasks[0]?.status).toBe('in_progress');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: coding');
      expect(rawPlan).toContain('"outcome":"running"');
      expect(rawPlan).toContain('  - [/] direct-cr-20260701074920826 Direct Request Changes');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('moves a direct Request Changes node back to coding when only older completion evidence exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '008-direct-cli');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'success',
        message: 'Older Direct run completed.',
        updatedAt: '2026-07-01T06:05:24.493Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_session.json'), JSON.stringify({
        version: 1,
        sessionId: 'direct-008-direct-cli',
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-07-01T07:45:26.989Z',
        iteration: 1,
        provider: 'codex-cli',
        lastOutcome: 'success',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'task_logs.jsonl'), [
        JSON.stringify({
          record_type: 'phase',
          timestamp: '2026-07-01T07:51:35.717Z',
          phase: 'coding',
          status: 'active',
          started_at: '2026-07-01T07:49:20.827Z',
          completed_at: null,
        }),
        '',
      ].join('\n'), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: human_review',
        'Review Reason: completed',
        'Execution Phase: complete',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T07:50:11.417Z',
        '<!-- autocode-plan-meta: {"planStatus":"review","xstateState":"human_review","direct_execution":{"enabled":true,"outcome":"completed","current_subtask_id":"direct-cr-20260701074920826","change_request_id":"cr-20260701074920826","summary_file":"direct_summary.md","completed_at":"2026-07-01T07:50:11.417Z"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [x] direct-cr-20260701074920826 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Completion: Completed by Autocode Direct CLI run._',
        '    - _Started: 2026-07-01T07:49:20.827Z_',
        '    - _Completed: 2026-07-01T07:49:21.139Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('in_progress');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.subtasks[0]?.status).toBe('in_progress');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: coding');
      expect(rawPlan).toContain('Execution Phase: coding');
      expect(rawPlan).toContain('"outcome":"running"');
      expect(rawPlan).not.toContain('Review Reason: completed');
      expect(rawPlan).toContain('- [/] direct. Direct execution');
      expect(rawPlan).toContain('  - [/] direct-cr-20260701074920826 Direct Request Changes');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts fresh completed direct plan metadata without requiring a run-result file', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '009-direct-plan-complete');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the issue. Validation passed.\n', 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T07:50:11.417Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"completed","current_subtask_id":"direct-cr-20260701074920826","summary_file":"direct_summary.md","completed_at":"2026-07-01T07:50:11.417Z"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [/] direct-cr-20260701074920826 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Started: 2026-07-01T07:49:20.827Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.subtasks[0]?.status).toBe('completed');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('Execution Phase: complete');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses recorded Direct subtask duration instead of paused wall-clock span', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '009-direct-duration');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct duration task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the issue. Validation passed.\n', 'utf8');
      const planMetadata = JSON.stringify({
        planStatus: 'review',
        xstateState: 'human_review',
        direct_execution: {
          enabled: true,
          outcome: 'completed',
          current_subtask_id: 'direct-cr-1',
          summary_file: 'direct_summary.md',
          completed_at: '2026-07-01T02:00:00.000Z',
        },
        subtaskMetadata: {
          'direct-cr-1': {
            completion_summary: 'Completed by Autocode Direct CLI run.',
            notes: 'Completed by Autocode Direct CLI run.',
            started_at: '2026-07-01T00:00:00.000Z',
            completed_at: '2026-07-01T02:00:00.000Z',
            duration_ms: 4500,
          },
        },
      });
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct duration task',
        'Workflow: direct',
        'Status: human_review',
        'Review Reason: completed',
        'Execution Phase: complete',
        'Created: 2026-07-01T00:00:00.000Z',
        'Updated: 2026-07-01T02:00:00.000Z',
        `<!-- autocode-plan-meta: ${planMetadata} -->`,
        '',
        '- [x] direct. Direct execution',
        '  - [x] direct-cr-1 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.subtasks[0]?.id).toBe('direct-cr-1');
      expect(task.subtasks[0]?.startedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(task.subtasks[0]?.completedAt).toBe('2026-07-01T02:00:00.000Z');
      expect(task.subtasks[0]?.durationMs).toBe(4500);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('uses run-result file mtime as freshness evidence when updatedAt is missing', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '010-direct-mtime');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the issue. Validation passed.\n', 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'success',
        message: 'Autocode CLI run completed without an updatedAt timestamp.',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T07:49:20.827Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"running","current_subtask_id":"direct-cr-20260701074920826","summary_file":"direct_summary.md"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [/] direct-cr-20260701074920826 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Started: 2026-07-01T07:49:20.827Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('"outcome":"completed"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('recovers a direct task marked error when fallback backfilled started_at after a successful run result', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '012-direct-backfilled-start');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'direct_summary.md'), 'Fixed the issue. Validation passed.\n', 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 0,
        status: 'success',
        message: 'Autocode CLI run completed.',
        updatedAt: '2026-07-06T15:24:31.992Z',
        quality: {
          mode: 'direct',
          outcome: 'completed',
          validation: {
            status: 'reported_passed',
            reason: 'enter-game-order-ok',
          },
        },
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: error',
        'Review Reason: errors',
        'Execution Phase: failed',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-06T15:24:40.709Z',
        '<!-- autocode-plan-meta: {"planStatus":"pending","xstateState":"error","direct_execution":{"enabled":true,"outcome":"error","current_subtask_id":"direct-cr-20260706090517930","change_request_id":"cr-20260706090517930","summary_file":"direct_summary.md","ai_coding_quality":{"fallbackReason":"stale-successful-run-result"}},"subtaskMetadata":{"direct-cr-20260706090517930":{"notes":"Direct process exited cleanly, but the success result belongs to an older Direct iteration.","started_at":"2026-07-06T15:24:39.929Z"}}} -->',
        '',
        '- [!] direct. Direct execution',
        '  - [!] direct-cr-20260706090517930 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Started: 2026-07-06T15:24:39.929Z_',
        '    - _Updated: 2026-07-06T15:24:40.703Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('human_review');
      expect(task.reviewReason).toBe('completed');
      expect(task.executionProgress?.phase).toBe('complete');
      expect(task.subtasks[0]?.status).toBe('completed');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: human_review');
      expect(rawPlan).toContain('Review Reason: completed');
      expect(rawPlan).toContain('"outcome":"completed"');
      expect(rawPlan).toContain('  - [x] direct-cr-20260706090517930 Direct Request Changes');
      expect(rawPlan).toContain('Autocode CLI run completed.');
      expect(rawPlan).not.toContain('Direct process exited cleanly, but the success result belongs to an older Direct iteration.');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks stale completed direct plan metadata as error when a fresh failed run-result exists', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-loader-'));
    try {
      const specDir = join(projectRoot, '.autocode', 'specs', '011-direct-failed-run-result');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, 'task_metadata.json'), JSON.stringify({
        developmentMode: 'direct',
        workflowMode: 'off',
        taskTitle: 'Direct task',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'autocode-run-result.json'), JSON.stringify({
        phase: 'direct',
        exitCode: 1,
        status: 'failed',
        message: 'Direct validation failed.',
        updatedAt: '2026-07-01T07:51:00.000Z',
      }, null, 2), 'utf8');
      writeFileSync(join(specDir, 'implementation_plan.md'), [
        '# Implementation Plan',
        'Feature: Direct task',
        'Workflow: direct',
        'Status: coding',
        'Execution Phase: coding',
        'Created: 2026-06-20T00:00:00.000Z',
        'Updated: 2026-07-01T07:50:11.417Z',
        '<!-- autocode-plan-meta: {"planStatus":"coding","xstateState":"coding","direct_execution":{"enabled":true,"outcome":"completed","current_subtask_id":"direct-cr-20260701074920826","summary_file":"direct_summary.md","completed_at":"2026-07-01T07:50:11.417Z"}} -->',
        '',
        '- [ ] direct. Direct execution',
        '  - [/] direct-cr-20260701074920826 Direct Request Changes',
        '    - Continue the same Direct model session.',
        '    - _Started: 2026-07-01T07:49:20.827Z_',
        '',
      ].join('\n'), 'utf8');

      const [task] = loadAutocodeProjectTasks({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(task.status).toBe('error');
      expect(task.reviewReason).toBeUndefined();
      expect(task.executionProgress?.phase).toBe('failed');
      expect(task.subtasks[0]?.status).toBe('failed');
      const rawPlan = readFileSync(join(specDir, 'implementation_plan.md'), 'utf8');
      expect(rawPlan).toContain('Status: error');
      expect(rawPlan).toContain('Execution Phase: failed');
      expect(rawPlan).toContain('"outcome":"failed"');
      expect(rawPlan).toContain('- [!] direct. Direct execution');
      expect(rawPlan).toContain('  - [!] direct-cr-20260701074920826 Direct Request Changes');
      expect(rawPlan).toContain('Direct validation failed.');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
