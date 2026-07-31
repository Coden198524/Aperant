import { describe, expect, it } from 'vitest';

import enTasks from './locales/en/tasks.json';
import frTasks from './locales/fr/tasks.json';
import zhCnTasks from './locales/zh-CN/tasks.json';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  );
}

describe('OpenSpec localization resources', () => {
  it('keeps the OpenSpec resource structure aligned across supported languages', () => {
    const englishKeys = leafKeys(enTasks.openSpec).sort();

    expect(leafKeys(frTasks.openSpec).sort()).toEqual(englishKeys);
    expect(leafKeys(zhCnTasks.openSpec).sort()).toEqual(englishKeys);
  });

  it('provides Chinese labels for the Spec workspace and creation controls', () => {
    expect(zhCnTasks.openSpec.header.title).toBe('OpenSpec 工作流');
    expect(zhCnTasks.openSpec.board.title).toBe('工作流');
    expect(zhCnTasks.openSpec.console.title).toBe('操作控制台');
    expect(zhCnTasks.openSpec.actions.apply).toBe('实施');
    expect(zhCnTasks.openSpec.runStates.running).toBe('运行中');
    expect(zhCnTasks.openSpec.timing.title).toBe('AI 累计耗时');
    expect(zhCnTasks.openSpec.phase.verification).toBe('验证');
    expect(zhCnTasks.openSpec.planIteration.dialog.titleRefine)
      .toBe('完善当前规划');
    expect(zhCnTasks.openSpec.planIteration.dialog.titleContinue)
      .toBe('规划下一次迭代');
    expect(zhCnTasks.openSpec.planIteration.review.title)
      .toBe('本次规划变更');
    expect(zhCnTasks.form.improveDescription.button).toBe('使用 AI 优化');
    expect(zhCnTasks.referenceImages.title).toBe('参考图片（可选）');
    expect(zhCnTasks.wizard.gitOptions.stateOn).toBe('开启');
    expect(zhCnTasks.wizard.gitOptions.stateOff).toBe('关闭');
  });

  it('localizes system-owned next steps instead of exposing English CLI defaults', () => {
    expect(zhCnTasks.openSpec.board.archivedNext)
      .toBe('所选变更已归档。请选择一个活动变更，或新建一项变更/提案。');
    expect(zhCnTasks.openSpec.board.initializeNext)
      .toBe('请先初始化 OpenSpec 以创建工作流。');
    expect(zhCnTasks.openSpec.board.selectChangeNext)
      .toBe('请选择一个活动变更，或新建一项变更/提案。');
    expect(zhCnTasks.openSpec.notice.selectionExpired)
      .toBe('所选 OpenSpec 变更已不存在。请选择一项有效变更以重新加载工作流。');
  });
});
