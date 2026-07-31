import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { listAutocodeTasks, updateAutocodeTaskPlanStatus } from './spec-store.js';
import { createManualAutocodeTask } from './workspace-state.js';

describe('manual Standard task seed', () => {
  it('seeds canonical requirements without pre-writing spec behavior', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-workspace-state-'));
    try {
      const task = createManualAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        title: 'Fix settings label',
        description: 'Fix the settings label text.',
        now: '2026-07-01T00:00:00.000Z',
      });

      const requirements = readFileSync(
        join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.requirements),
        'utf8',
      );
      const runtimeLedger = readFileSync(
        join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.implementationPlan),
        'utf8',
      );

      expect(task.metadata?.developmentMode).toBe('standard');
      expect(task.metadata?.workflowMode).toBe('balanced');
      expect(requirements).toContain('Requirements-Contract: 1');
      expect(requirements).toContain('Fix the settings label text.');
      expect(requirements).toContain('E1: User task description');
      expect(requirements).not.toContain('SCN-');
      expect(requirements).not.toContain('Implementation Notes');
      expect(runtimeLedger).toContain('# Runtime Execution Ledger');
      expect(runtimeLedger).not.toContain('Feature:');
      expect(runtimeLedger).not.toContain('## Description');
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.specFile))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves localized input without creating a mixed seed spec', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-workspace-state-zh-'));
    try {
      const description = '\u4fee\u590d\u8bbe\u7f6e\u6309\u94ae\u6587\u6848\u3002';
      const task = createManualAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        title: '\u4fee\u590d\u8bbe\u7f6e\u6587\u6848',
        description,
        metadata: { language: 'zh-CN' },
        now: '2026-07-01T00:00:00.000Z',
      });

      const requirements = readFileSync(
        join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.requirements),
        'utf8',
      );

      expect(requirements).toContain(description);
      expect(requirements).toContain('Requirements-Contract: 1');
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.specFile))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('manual Spec task seed', () => {
  it('stores only link/runtime metadata and no Autocode planning documents', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-workspace-state-spec-'));
    try {
      const task = createManualAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        title: 'Add OpenSpec mode',
        description: 'Implement the official OpenSpec workflow.',
        metadata: {
          developmentMode: 'spec',
          openSpec: {
            startAction: 'new',
            schemaName: 'spec-driven',
          },
        },
        now: '2026-07-28T00:00:00.000Z',
      });

      expect(task.metadata?.developmentMode).toBe('spec');
      expect(task.metadata?.runtimeConcurrency).toMatchObject({ mode: 'serial', workers: 1 });
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.implementationPlan))).toBe(false);
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.requirements))).toBe(false);
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.openSpecRuntime))).toBe(true);

      const [reloaded] = listAutocodeTasks({ projectRoot, dataDirName: '.autocode' });
      expect(reloaded).toMatchObject({
        title: 'Add OpenSpec mode',
        description: 'Implement the official OpenSpec workflow.',
        status: 'backlog',
        createdAt: '2026-07-28T00:00:00.000Z',
      });

      const updated = updateAutocodeTaskPlanStatus({
        projectRoot,
        dataDirName: '.autocode',
        taskId: task.id,
        planStatus: 'in_progress',
        executionPhase: 'spec',
      });
      expect(updated.status).toBe('in_progress');
      expect(updated.executionPhase).toBe('spec');
      expect(existsSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.implementationPlan))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
