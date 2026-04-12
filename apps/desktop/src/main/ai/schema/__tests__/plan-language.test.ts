import { describe, expect, it } from 'vitest';

import type { ValidatedImplementationPlan } from '../implementation-plan';
import { validateImplementationPlanLanguage } from '../plan-language';

function makePlan(overrides: Partial<ValidatedImplementationPlan> = {}): ValidatedImplementationPlan {
  return {
    feature: '世界等级调整',
    workflow_type: 'feature',
    phases: [
      {
        id: 'phase-1',
        name: '服务端实现',
        subtasks: [
          {
            id: '1-1',
            title: '实现世界等级计算',
            description: '在 LevelService 中加入世界等级计算逻辑，并补充必要的验证。',
            status: 'pending',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('validateImplementationPlanLanguage', () => {
  it('passes Chinese planning content for zh-CN', () => {
    const errors = validateImplementationPlanLanguage(makePlan(), 'zh-CN');
    expect(errors).toEqual([]);
  });

  it('reports English-only planning fields for zh-CN', () => {
    const errors = validateImplementationPlanLanguage(makePlan({
      feature: 'World Level Balance',
      phases: [
        {
          id: 'phase-1',
          name: 'Backend API',
          subtasks: [
            {
              id: '1-1',
              title: 'Implement world level rules',
              description: 'Add world level calculation to LevelService and wire related progression checks.',
              status: 'pending',
            },
          ],
        },
      ],
    }), 'zh-CN');

    expect(errors).toEqual([
      'At "feature": must be written in Simplified Chinese (zh-CN), not English.',
      'At "phases.0.name": must be written in Simplified Chinese (zh-CN), not English.',
      'At "phases.0.subtasks.0.title": must be written in Simplified Chinese (zh-CN), not English.',
      'At "phases.0.subtasks.0.description": must be written in Simplified Chinese (zh-CN), not English.',
    ]);
  });

  it('allows mixed Chinese text with code identifiers', () => {
    const errors = validateImplementationPlanLanguage(makePlan({
      phases: [
        {
          id: 'phase-1',
          name: '服务端实现',
          subtasks: [
            {
              id: '1-1',
              title: '接入 LevelService 计算',
              description: '在 LevelService 中接入 WorldLevelCalculator，并补充中文说明与验证步骤。',
              status: 'pending',
            },
          ],
        },
      ],
    }), 'zh-CN');

    expect(errors).toEqual([]);
  });

  it('does not enforce Chinese when app language is English', () => {
    const errors = validateImplementationPlanLanguage(makePlan({
      feature: 'World Level Balance',
      phases: [
        {
          id: 'phase-1',
          name: 'Backend API',
          subtasks: [
            {
              id: '1-1',
              title: 'Implement world level rules',
              description: 'Add world level calculation to LevelService and wire related progression checks.',
              status: 'pending',
            },
          ],
        },
      ],
    }), 'en');

    expect(errors).toEqual([]);
  });
});
