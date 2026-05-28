import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadAutocodeImplementationPlan,
  saveAutocodeImplementationPlan,
} from '@autocode/core';

import { restampExecutionPhase } from '../subtask-iterator';

// =============================================================================
// restampExecutionPhase
// =============================================================================

describe('restampExecutionPhase', () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'restamp-test-'));
    planPath = join(tmpDir, 'implementation_plan.md');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('updates a stale executionPhase and writes the file back', async () => {
    const plan = {
      feature: 'test',
      executionPhase: 'planning',
      phases: [],
    };
    await saveAutocodeImplementationPlan(tmpDir, plan);

    await restampExecutionPhase(tmpDir, 'coding');

    const written = await loadAutocodeImplementationPlan(tmpDir) as Record<string, unknown>;
    expect(written.executionPhase).toBe('coding');
  });

  it('does not rewrite the file when executionPhase is already correct', async () => {
    const plan = {
      feature: 'test',
      executionPhase: 'coding',
      phases: [],
    };
    await saveAutocodeImplementationPlan(tmpDir, plan);

    // Snapshot content before calling the function
    const contentBefore = await readFile(planPath, 'utf-8');

    await restampExecutionPhase(tmpDir, 'coding');

    // Verify file was not modified 鈥?content should be byte-identical
    const contentAfter = await readFile(planPath, 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    const written = await loadAutocodeImplementationPlan(tmpDir) as Record<string, unknown>;
    expect(written.executionPhase).toBe('coding');
  });

  it('handles a missing file gracefully without throwing', async () => {
    // planPath does NOT exist 鈥?the function should swallow the error
    await expect(restampExecutionPhase(tmpDir, 'coding')).resolves.toBeUndefined();
  });

  it('handles malformed Markdown gracefully without throwing', async () => {
    await writeFile(planPath, '{ this is not a valid plan }{{{');

    await expect(restampExecutionPhase(tmpDir, 'coding')).resolves.toBeUndefined();
  });
});
