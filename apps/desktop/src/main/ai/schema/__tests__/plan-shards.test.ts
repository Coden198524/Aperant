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

describe('plan shards', () => {
  it('splits large implementation plans into phase files and hydrates them', async () => {
    const specDir = makeSpecDir();
    const plan = {
      feature: 'Large refactor',
      workflow_type: 'refactor',
      phases: Array.from({ length: 5 }, (_, phaseIndex) => ({
        id: `phase-${phaseIndex + 1}`,
        name: `Phase ${phaseIndex + 1}`,
        subtasks: Array.from({ length: 10 }, (_, subtaskIndex) => ({
          id: `${phaseIndex + 1}-${subtaskIndex + 1}`,
          title: `Task ${phaseIndex + 1}-${subtaskIndex + 1}`,
          description: 'Concise implementation step',
          status: 'pending',
          files_to_create: [],
          files_to_modify: ['src/app.ts'],
        })),
      })),
    };

    const result = await writeImplementationPlanFiles(specDir, plan);

    expect(result?.split).toBe(true);
    expect(result?.totalSubtasks).toBe(50);
    const indexPath = join(specDir, 'implementation_plan.json');
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(join(specDir, 'implementation_plan.phase-phase-1.json'))).toBe(true);

    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(index.split_plan).toBe(true);
    expect(index.phases[0].subtasks).toEqual([]);
    expect(index.phases[0].subtasks_file).toBe('implementation_plan.phase-phase-1.json');
    expect(ImplementationPlanSchema.safeParse(index).success).toBe(true);

    const hydrated = await loadImplementationPlanFromFiles(specDir);
    expect(hydrated?.phases?.[0].subtasks).toHaveLength(10);
    expect(hydrated?.phases?.[4].subtasks?.[9].id).toBe('5-10');
  });

  it('persists subtask status updates back to phase files', async () => {
    const specDir = makeSpecDir();
    await writeImplementationPlanFiles(specDir, {
      feature: 'Large refactor',
      workflow_type: 'refactor',
      phases: [{
        id: 'phase-1',
        name: 'Phase 1',
        subtasks: Array.from({ length: 45 }, (_, index) => ({
          id: `1-${index + 1}`,
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

    const shard = JSON.parse(readFileSync(join(specDir, 'implementation_plan.phase-phase-1.json'), 'utf-8'));
    expect(shard.phase.subtasks[0].status).toBe('completed');

    const index = JSON.parse(readFileSync(join(specDir, 'implementation_plan.json'), 'utf-8'));
    expect(index.phases[0].status_counts.completed).toBe(1);
  });
});
