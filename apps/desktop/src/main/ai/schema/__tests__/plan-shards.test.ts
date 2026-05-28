import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImplementationPlanSchema } from '../implementation-plan';
import {
  loadImplementationPlanFromFiles,
  saveImplementationPlanToFiles,
  writeImplementationPlanFiles,
} from '../plan-shards';

let tempDirs: string[] = [];

function makeSpecDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-shards-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('implementation plan files', () => {
  it('writes large implementation plans as one Markdown file and hydrates them', async () => {
    const specDir = makeSpecDir();
    const plan = {
      feature: 'Large refactor',
      workflow_type: 'refactor',
      phases: Array.from({ length: 5 }, (_, phaseIndex) => ({
        id: String(phaseIndex + 1),
        name: `Phase ${phaseIndex + 1}`,
        subtasks: Array.from({ length: 10 }, (_, subtaskIndex) => ({
          id: `${phaseIndex + 1}.${subtaskIndex + 1}`,
          title: `Task ${phaseIndex + 1}.${subtaskIndex + 1}`,
          description: 'Concise implementation step',
          status: 'pending',
          files_to_create: [],
          files_to_modify: ['src/app.ts'],
        })),
      })),
    };

    const result = await writeImplementationPlanFiles(specDir, plan);

    expect(result?.split).toBe(false);
    expect(result?.totalSubtasks).toBe(50);
    const indexPath = join(specDir, 'implementation_plan.md');
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(join(specDir, ['implementation_plan', 'phase-phase-1', 'json'].join('.')))).toBe(false);

    const markdown = readFileSync(indexPath, 'utf-8');
    expect(markdown).toContain('# Implementation Plan');
    expect(markdown).toContain('- [ ] 1.1 Task 1.1');

    const hydrated = await loadImplementationPlanFromFiles(specDir);
    expect(ImplementationPlanSchema.safeParse(hydrated).success).toBe(true);
    expect(hydrated?.phases?.[0].subtasks).toHaveLength(10);
    expect(hydrated?.phases?.[4].subtasks?.[9].id).toBe('5.10');
  });

  it('persists subtask status updates back to the Markdown plan', async () => {
    const specDir = makeSpecDir();
    await writeImplementationPlanFiles(specDir, {
      feature: 'Large refactor',
      workflow_type: 'refactor',
      phases: [{
        id: '1',
        name: 'Phase 1',
        subtasks: Array.from({ length: 45 }, (_, index) => ({
          id: `1.${index + 1}`,
          title: `Task ${index + 1}`,
          description: 'Concise implementation step',
          status: 'pending',
          files_to_create: [],
          files_to_modify: [],
        })),
      }],
    });

    const plan = await loadImplementationPlanFromFiles(specDir);
    const target = plan?.phases?.[0].subtasks?.[0];
    expect(target).toBeTruthy();
    if (!plan || !target) {
      throw new Error('Expected hydrated split plan');
    }

    target.status = 'completed';
    await saveImplementationPlanToFiles(specDir, plan);

    const markdown = readFileSync(join(specDir, 'implementation_plan.md'), 'utf-8');
    expect(markdown).toContain('- [x] 1.1 Task 1');
    expect(existsSync(join(specDir, ['implementation_plan', 'phase-phase-1', 'json'].join('.')))).toBe(false);
  });
});
