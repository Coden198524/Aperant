import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveAutocodeImplementationPlan,
  type MutableAutocodePlan,
} from '@autocode/core';
import { iterateSubtasks } from '../subtask-iterator';
import type { SessionResult } from '../../session/types';

const mockExtractSessionInsights = vi.hoisted(() => vi.fn());

vi.mock('../../runners/insight-extractor', () => ({
  extractSessionInsights: (...args: unknown[]) => mockExtractSessionInsights(...args),
}));

function makeResult(): SessionResult {
  return {
    outcome: 'completed',
    stepsExecuted: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    messages: [],
    durationMs: 1,
    toolCallCount: 0,
  };
}

describe('subtask iterator insights', () => {
  let specDir: string;

  beforeEach(async () => {
    mockExtractSessionInsights.mockReset();
    specDir = await mkdtemp(join(tmpdir(), 'subtask-iter-insights-'));
  });

  afterEach(async () => {
    await rm(specDir, { recursive: true, force: true });
  });

  it('passes collected changed files to opt-in insight extraction', async () => {
    const plan: MutableAutocodePlan = {
      phases: [
        {
          name: 'phase-1',
          subtasks: [
            {
              id: 's1',
              title: 't',
              description: 'd',
              status: 'pending',
              files_to_modify: ['src/generated.ts'],
            },
          ],
        },
      ],
    };
    await saveAutocodeImplementationPlan(specDir, plan);
    mockExtractSessionInsights.mockResolvedValue({
      file_insights: [],
      patterns_discovered: [],
      gotchas_discovered: [],
      approach_outcome: {
        success: true,
        approach_used: 'implemented',
        why_it_worked: null,
        why_it_failed: null,
        alternatives_tried: [],
      },
      recommendations: [],
      subtask_id: 's1',
      session_num: 1,
      success: true,
      changed_files: ['src/generated.ts'],
    });

    await iterateSubtasks({
      specDir,
      projectDir: specDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      extractInsights: true,
      runSubtaskSession: async () => makeResult(),
    });

    expect(mockExtractSessionInsights).toHaveBeenCalledWith(expect.objectContaining({
      changedFiles: ['src/generated.ts'],
    }));
  });
});
