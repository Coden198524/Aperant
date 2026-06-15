import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAutocodeImplementationPlan,
  saveAutocodeImplementationPlan,
} from '@autocode/core';

import type { ToolContext } from '../../types';
import { getBuildProgressTool } from '../get-build-progress';
import { getSessionContextTool } from '../get-session-context';
import { updateSubtaskStatusTool } from '../update-subtask-status';
import { updateQaStatusTool } from '../update-qa-status';

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

describe('Autocode plan update tools', () => {
  let specDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    specDir = await mkdtemp(join(tmpdir(), 'autocode-plan-update-'));
    context = { ...baseContext, specDir };
  });

  afterEach(async () => {
    await rm(specDir, { recursive: true, force: true });
  });

  it('updates subtask status through the locked plan updater', async () => {
    await saveAutocodeImplementationPlan(specDir, {
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: 'subtask-1', title: 'First', status: 'pending' },
            { id: 'subtask-2', title: 'Second', status: 'in_progress' },
          ],
        },
      ],
    });

    const result = await updateSubtaskStatusTool.config.execute(
      { subtask_id: 'subtask-1', status: 'completed' },
      context,
    );
    const planState = await loadAutocodeImplementationPlan(specDir);

    expect(result).toContain("Successfully updated subtask 'subtask-1' to status 'completed'");
    expect(planState?.phases?.[0].subtasks?.map((subtask) => subtask.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('updates QA status through the locked plan updater without clobbering the whole file', async () => {
    await saveAutocodeImplementationPlan(specDir, {
      feature: 'Test feature',
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: 'subtask-1', title: 'First', status: 'completed' },
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
    });

    const result = await updateQaStatusTool.config.execute(
      {
        status: 'rejected',
        issues: '[{"description":"Fix the failing test"}]',
        tests_passed: '{"unit":"pass"}',
      },
      context,
    );
    const planState = await loadAutocodeImplementationPlan(specDir);
    const qaSignoff = planState?.qa_signoff as { qa_session?: number; status?: string } | undefined;

    expect(result).toContain("Updated QA status to 'rejected' (session 2)");
    expect(planState?.feature).toBe('Test feature');
    expect(planState?.phases?.[0].subtasks?.[0].status).toBe('completed');
    expect(qaSignoff?.qa_session).toBe(2);
    expect(qaSignoff?.status).toBe('rejected');
  });

  it('returns compact build progress for large plans', async () => {
    await saveAutocodeImplementationPlan(specDir, {
      phases: Array.from({ length: 18 }, (_, phaseIndex) => ({
        id: `phase-${phaseIndex}`,
        name: `Phase ${phaseIndex}`,
        subtasks: [
          {
            id: `task-${phaseIndex}`,
            title: `Task ${phaseIndex}`,
            status: phaseIndex < 5 ? 'completed' : 'pending',
            description: phaseIndex === 5
              ? `NEXT_HEAD ${'implementation detail '.repeat(80)} NEXT_TAIL`
              : `Description ${phaseIndex}`,
          },
        ],
      })),
    });

    const result = await getBuildProgressTool.config.execute({}, context);

    expect(result).toContain('Build Progress: 5/18 subtasks');
    expect(result).toContain('Phase 0: 1/1');
    expect(result).toContain('Phase 17: 0/1');
    expect(result).toContain('phase(s) omitted');
    expect(result).not.toContain('Phase 10: 0/1');
    expect(result).toContain('ID: task-5');
    expect(result).toContain('NEXT_HEAD');
    expect(result).toContain('NEXT_TAIL');
    expect(result).toContain('[middle omitted]');
    expect(result.length).toBeLessThan(1400);
  });

  it('returns recent session memory entries instead of full old markdown history', async () => {
    const memoryDir = join(specDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, 'gotchas.md'),
      [
        '# Gotchas',
        'Things to watch.',
        ...Array.from(
          { length: 9 },
          (_, index) => `## [2026-01-0${index + 1}]\nGOTCHA_${index} ${'detail '.repeat(8)}`,
        ),
      ].join('\n\n'),
      'utf-8',
    );

    const result = await getSessionContextTool.config.execute({}, context);

    expect(result).toContain('## Gotchas');
    expect(result).toContain('3 older session memory entries omitted');
    expect(result).toContain('GOTCHA_3');
    expect(result).toContain('GOTCHA_8');
    expect(result).not.toContain('GOTCHA_0');
  });
});
