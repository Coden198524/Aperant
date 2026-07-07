import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadAutocodeImplementationPlanSync,
  saveAutocodeImplementationPlanSync,
} from '@autocode/core';

vi.mock('../../../project-store', () => ({
  projectStore: {
    invalidateTasksCache: vi.fn(),
  },
}));

import { persistDirectFallbackPlanStateSync, persistPlanTokenUsageSync, syncPlanPhasesToMainSync } from '../plan-file-utils';
import { projectStore } from '../../../project-store';

describe('plan-file-utils token usage persistence', () => {
  let tempDir: string;
  let planPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'autocode-plan-token-'));
    planPath = path.join(tempDir, 'implementation_plan.md');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('does not double-count cumulative resumed-session request totals', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      phases: [],
      tokenUsage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        stepsExecuted: 10,
        sessionId: 'old-session',
      },
    });

    const success = persistPlanTokenUsageSync(planPath, {
      promptTokens: 125,
      completionTokens: 65,
      totalTokens: 190,
      stepsExecuted: 12,
      sessionId: 'new-session',
    }, 'project-1');

    const plan = loadAutocodeImplementationPlanSync(planPath)!;

    expect(success).toBe(true);
    expect(plan.tokenUsage).toEqual({
      promptTokens: 125,
      completionTokens: 65,
      totalTokens: 190,
      stepsExecuted: 12,
      sessionId: 'new-session',
    });
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-1');
  });

  it('does not overwrite an executable plan with stale empty watcher phases', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      phases: [
        {
          phase: 1,
          name: 'Implementation',
          subtasks: [
            { id: '1.1', title: 'Implement', description: 'Do work', status: 'pending' },
          ],
        },
      ],
    });

    const success = syncPlanPhasesToMainSync(planPath, [], 'project-1');
    const plan = loadAutocodeImplementationPlanSync(planPath)!;

    expect(success).toBe(false);
    expect(plan.phases?.[0].subtasks).toHaveLength(1);
    expect(projectStore.invalidateTasksCache).not.toHaveBeenCalled();
  });

  it('persists Direct fallback status metadata without replacing phases', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      workflow_type: 'direct',
      status: 'coding',
      planStatus: 'coding',
      xstateState: 'coding',
      executionPhase: 'coding',
      direct_execution: {
        enabled: true,
        outcome: 'running',
        current_subtask_id: 'direct-cr-1',
      },
      phases: [
        {
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            { id: 'direct-cr-1', title: 'Direct Request Changes', description: 'Do work', status: 'in_progress' },
          ],
        },
      ],
    });

    const success = persistDirectFallbackPlanStateSync(planPath, {
      status: 'error',
      planStatus: 'pending',
      reviewReason: 'errors',
      xstateState: 'error',
      executionPhase: 'failed',
      direct_execution: {
        enabled: true,
        outcome: 'error',
        summary_file: 'direct_summary.md',
        ai_coding_quality: { fallback: 'clean-exit' },
      },
    }, 'project-1');

    const plan = loadAutocodeImplementationPlanSync(planPath)!;

    expect(success).toBe(true);
    expect(plan.status).toBe('error');
    expect(plan.reviewReason).toBe('errors');
    expect(plan.xstateState).toBe('error');
    expect(plan.executionPhase).toBe('failed');
    expect(plan.direct_execution).toMatchObject({
      enabled: true,
      outcome: 'error',
      current_subtask_id: 'direct-cr-1',
      summary_file: 'direct_summary.md',
      ai_coding_quality: { fallback: 'clean-exit' },
    });
    expect(plan.phases?.[0]?.subtasks?.[0]).toMatchObject({
      id: 'direct-cr-1',
      status: 'in_progress',
    });
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-1');
  });
  it('persists Direct fallback current subtask failure without replacing phases', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      workflow_type: 'direct',
      status: 'coding',
      direct_execution: {
        enabled: true,
        outcome: 'running',
        current_subtask_id: 'direct-cr-1',
        completed_at: '2026-01-01T00:00:05.000Z',
      },
      phases: [
        {
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            {
              id: 'direct-cr-1',
              title: 'Direct Request Changes',
              description: 'Do work',
              status: 'in_progress',
              started_at: '2026-01-01T00:00:00.000Z',
              completed_at: '2026-01-01T00:00:05.000Z',
            },
            { id: 'unrelated', title: 'Other', description: 'Keep me', status: 'pending' },
          ],
        },
      ],
    });

    const success = persistDirectFallbackPlanStateSync(planPath, {
      status: 'error',
      direct_execution: {
        enabled: true,
        outcome: 'error',
        current_subtask_id: 'direct-cr-1',
      },
      directSubtask: {
        id: 'direct-cr-1',
        status: 'failed',
        timestamp: '2026-01-01T00:01:00.000Z',
        summary: 'Direct clean-exit fallback failed.',
      },
    }, 'project-1');

    const plan = loadAutocodeImplementationPlanSync(planPath)!;
    const directSubtask = plan.phases?.[0]?.subtasks?.[0];
    const unrelatedSubtask = plan.phases?.[0]?.subtasks?.[1];

    expect(success).toBe(true);
    expect(plan.phases?.[0]?.subtasks).toHaveLength(2);
    expect(directSubtask).toMatchObject({
      id: 'direct-cr-1',
      status: 'failed',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      notes: 'Direct clean-exit fallback failed.',
    });
    expect(directSubtask?.completed_at).toBeUndefined();
    expect((plan.direct_execution as Record<string, unknown> | undefined)?.completed_at).toBeUndefined();
    expect(unrelatedSubtask).toMatchObject({
      id: 'unrelated',
      status: 'pending',
    });
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-1');
  });

  it('persists Direct fallback current subtask as resumable without replacing phases', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      workflow_type: 'direct',
      status: 'error',
      planStatus: 'pending',
      reviewReason: 'errors',
      xstateState: 'error',
      executionPhase: 'failed',
      direct_execution: {
        enabled: true,
        outcome: 'max_steps',
        current_subtask_id: 'direct-cr-1',
        completed_at: '2026-01-01T00:00:05.000Z',
      },
      phases: [
        {
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            {
              id: 'direct-cr-1',
              title: 'Direct Request Changes',
              description: 'Do work',
              status: 'failed',
              started_at: '2026-01-01T00:00:00.000Z',
              completed_at: '2026-01-01T00:00:05.000Z',
              completion_summary: 'Old completion summary',
              notes: 'Old failure note',
            },
            { id: 'unrelated', title: 'Other', description: 'Keep me', status: 'pending' },
          ],
        },
      ],
    });

    const success = persistDirectFallbackPlanStateSync(planPath, {
      status: 'in_progress',
      planStatus: 'coding',
      xstateState: 'coding',
      executionPhase: 'coding',
      direct_execution: {
        enabled: true,
        outcome: 'max_steps',
        current_subtask_id: 'direct-cr-1',
        summary_file: 'direct_summary.md',
        ai_coding_quality: { fallbackReason: 'resumable-plan-outcome' },
      },
      directSubtask: {
        id: 'direct-cr-1',
        status: 'in_progress',
        timestamp: '2026-01-01T00:01:00.000Z',
        summary: 'Direct plan outcome is max_steps.',
      },
    }, 'project-1');

    const plan = loadAutocodeImplementationPlanSync(planPath)!;
    const directSubtask = plan.phases?.[0]?.subtasks?.[0];
    const unrelatedSubtask = plan.phases?.[0]?.subtasks?.[1];

    expect(success).toBe(true);
    expect(plan.status).toBe('in_progress');
    expect(plan.planStatus).toBe('coding');
    expect(plan.reviewReason).toBeUndefined();
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.direct_execution).toMatchObject({
      enabled: true,
      outcome: 'max_steps',
      current_subtask_id: 'direct-cr-1',
      summary_file: 'direct_summary.md',
      ai_coding_quality: { fallbackReason: 'resumable-plan-outcome' },
    });
    expect((plan.direct_execution as Record<string, unknown> | undefined)?.completed_at).toBeUndefined();
    expect(directSubtask).toMatchObject({
      id: 'direct-cr-1',
      status: 'in_progress',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      notes: 'Direct plan outcome is max_steps.',
    });
    expect(directSubtask?.completed_at).toBeUndefined();
    expect(directSubtask?.completion_summary).toBeUndefined();
    expect(unrelatedSubtask).toMatchObject({
      id: 'unrelated',
      status: 'pending',
    });
    expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith('project-1');
  });
  it('persists Direct fallback current subtask completion without replacing phases', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      workflow_type: 'direct',
      direct_execution: {
        enabled: true,
        outcome: 'running',
        current_subtask_id: 'direct-cr-1',
      },
      phases: [
        {
          phase: 1,
          name: 'Direct execution',
          type: 'direct',
          subtasks: [
            { id: 'direct-cr-1', title: 'Direct Request Changes', description: 'Do work', status: 'in_progress' },
          ],
        },
      ],
    });

    const success = persistDirectFallbackPlanStateSync(planPath, {
      status: 'human_review',
      reviewReason: 'completed',
      direct_execution: {
        enabled: true,
        outcome: 'completed',
        current_subtask_id: 'direct-cr-1',
        completed_at: '2026-01-01T00:02:00.000Z',
      },
      directSubtask: {
        id: 'direct-cr-1',
        status: 'completed',
        timestamp: '2026-01-01T00:02:00.000Z',
        summary: 'Completed by Direct fallback.',
      },
    }, 'project-1');

    const plan = loadAutocodeImplementationPlanSync(planPath)!;
    const directSubtask = plan.phases?.[0]?.subtasks?.[0];

    expect(success).toBe(true);
    expect(directSubtask).toMatchObject({
      id: 'direct-cr-1',
      status: 'completed',
      started_at: '2026-01-01T00:02:00.000Z',
      completed_at: '2026-01-01T00:02:00.000Z',
      completion_summary: 'Completed by Direct fallback.',
      notes: 'Completed by Direct fallback.',
    });
  });
  it('round-trips subtask execution timing metadata through markdown plans', () => {
    saveAutocodeImplementationPlanSync(planPath, {
      phases: [
        {
          phase: 1,
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: 'Implement',
              description: 'Do work',
              status: 'completed',
              started_at: '2026-01-01T00:00:00.000Z',
              completed_at: '2026-01-01T00:00:03.000Z',
            },
          ],
        },
      ],
    });

    const plan = loadAutocodeImplementationPlanSync(planPath)!;
    const subtask = plan.phases?.[0]?.subtasks?.[0];

    expect(subtask?.started_at).toBe('2026-01-01T00:00:00.000Z');
    expect(subtask?.completed_at).toBe('2026-01-01T00:00:03.000Z');
  });
});
