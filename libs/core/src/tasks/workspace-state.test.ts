import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { createManualAutocodeTask } from './workspace-state.js';

describe('manual Standard task seed', () => {
  it('creates a compact task-first Standard seed spec', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-workspace-state-'));
    try {
      const task = createManualAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        title: 'Fix settings label',
        description: 'Fix the settings label text.',
        now: '2026-07-01T00:00:00.000Z',
      });

      const spec = readFileSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.specFile), 'utf8');

      expect(task.metadata?.developmentMode).toBe('standard');
      expect(task.metadata?.workflowMode).toBe('balanced');
      expect(spec).toContain('Standard mode task');
      expect(spec).toContain('Use compact Standard Autocode planning');
      expect(spec).toContain('Create or repair tasks.md as the executable checklist');
      expect(spec).not.toContain('Requirements To Clarify');
      expect(spec).not.toContain('Design Decisions To Record');
      expect(spec).not.toContain('Acceptance Criteria To Define');
      expect(spec).not.toContain('Risks / Assumptions To Review');
      expect(spec.length).toBeLessThan(900);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps the Chinese Standard seed readable and compact', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-workspace-state-zh-'));
    try {
      const task = createManualAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        title: '修复设置文案',
        description: '修复设置按钮文案。',
        metadata: { language: 'zh-CN' },
        now: '2026-07-01T00:00:00.000Z',
      });

      const spec = readFileSync(join(task.specsPath, AUTOCODE_TASK_ARTIFACTS.specFile), 'utf8');

      expect(spec).toContain('Standard 标准模式任务');
      expect(spec).toContain('使用紧凑的 Standard Autocode 规划');
      expect(spec).toContain('创建或修复 tasks.md 作为可执行清单');
      expect(spec).not.toContain('待澄清需求');
      expect(spec).not.toContain('待记录设计决策');
      expect(spec.length).toBeLessThan(650);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});