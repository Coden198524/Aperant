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

import { persistPlanTokenUsageSync, syncPlanPhasesToMainSync } from '../plan-file-utils';
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
