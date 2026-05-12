import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    planPath = path.join(tempDir, 'implementation_plan.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('does not double-count cumulative resumed-session request totals', () => {
    writeFileSync(
      planPath,
      JSON.stringify({
        phases: [],
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          stepsExecuted: 10,
          sessionId: 'old-session',
        },
      }),
      'utf-8'
    );

    const success = persistPlanTokenUsageSync(planPath, {
      promptTokens: 125,
      completionTokens: 65,
      totalTokens: 190,
      stepsExecuted: 12,
      sessionId: 'new-session',
    }, 'project-1');

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

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
    writeFileSync(
      planPath,
      JSON.stringify({
        phases: [
          {
            phase: 1,
            name: 'Implementation',
            subtasks: [
              { id: '1.1', title: 'Implement', description: 'Do work', status: 'pending' },
            ],
          },
        ],
      }),
      'utf-8'
    );

    const success = syncPlanPhasesToMainSync(planPath, [], 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(success).toBe(false);
    expect(plan.phases[0].subtasks).toHaveLength(1);
    expect(projectStore.invalidateTasksCache).not.toHaveBeenCalled();
  });
});
