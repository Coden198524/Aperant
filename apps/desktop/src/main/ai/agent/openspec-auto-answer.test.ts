import { describe, expect, it } from 'vitest';

import {
  appendOpenSpecAutomaticDecisionRequirement,
  createOpenSpecAutomaticInputResponder,
  OPEN_SPEC_AUTOMATIC_DECISION_HEADING,
  OPEN_SPEC_AUTONOMOUS_ANSWER,
  resolveOpenSpecAutomaticAnswer,
} from './openspec-auto-answer';

describe('OpenSpec automatic decision requirement', () => {
  it('appends an English unattended-decision requirement to the user message', () => {
    const original = '/opsx:apply compatible-storage';
    const result = appendOpenSpecAutomaticDecisionRequirement(original, 'en');

    expect(result.startsWith(`${original}\n\n`)).toBe(true);
    expect(result).toContain(OPEN_SPEC_AUTOMATIC_DECISION_HEADING);
    expect(result).toContain('do not pause or wait for human input');
    expect(result).toContain('first feasible non-Other/non-Custom option');
    expect(result).toContain('do not ask again');
  });

  it('appends a Simplified Chinese unattended-decision requirement', () => {
    const original = '/opsx:proposal compatible-storage';
    const result = appendOpenSpecAutomaticDecisionRequirement(
      original,
      'zh-CN',
    );

    expect(result.startsWith(`${original}\n\n`)).toBe(true);
    expect(result).toContain(OPEN_SPEC_AUTOMATIC_DECISION_HEADING);
    expect(result).toContain('不要暂停或等待人工输入');
    expect(result).toContain('非“其他/自定义”');
    expect(result).toContain('不要再次询问用户');
  });

  it('is idempotent when the automatic requirement is appended again', () => {
    const once = appendOpenSpecAutomaticDecisionRequirement(
      '/opsx:apply compatible-storage',
      'en',
    );
    const twice = appendOpenSpecAutomaticDecisionRequirement(once, 'zh-CN');

    expect(twice).toBe(once);
    expect(twice.split(OPEN_SPEC_AUTOMATIC_DECISION_HEADING)).toHaveLength(2);
  });
});

describe('OpenSpec automatic answers', () => {
  it('selects the explicitly recommended option instead of the first option', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Which implementation should be used?',
      options: [
        { label: 'Legacy implementation' },
        { label: 'Incremental migration (Recommended)' },
      ],
    }])).toBe('Incremental migration (Recommended)');
  });

  it('recognizes recommendations in Chinese descriptions', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: '请选择迁移策略',
      options: [
        { label: '一次性迁移' },
        { label: '渐进式迁移', description: '推荐，风险最低' },
      ],
    }])).toBe('渐进式迁移');
  });

  it('uses the first option when no recommendation is provided', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Choose a compatible default.',
      options: [
        { label: 'Keep compatibility' },
        { label: 'Break compatibility' },
      ],
    }])).toBe('Keep compatibility');
  });

  it('selects all recommended options for a multi-select question', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Select safeguards.',
      multiSelect: true,
      options: [
        { label: 'Input validation (Recommended)' },
        { label: 'Audit logging', description: 'Preferred for production' },
        { label: 'Disable validation' },
      ],
    }])).toBe('Input validation (Recommended), Audit logging');
  });

  it('does not select an explicitly discouraged option', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Select a release strategy.',
      options: [
        { label: 'Staged rollout' },
        { label: 'Immediate rollout', description: 'Not recommended' },
      ],
    }])).toBe('Staged rollout');
  });

  it('does not select Other or Custom pseudo-options as the fallback', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Choose a storage policy.',
      options: [
        { label: 'Other' },
        { label: 'Custom' },
        { label: 'Keep the existing storage policy' },
      ],
    }])).toBe('Keep the existing storage policy');

    expect(resolveOpenSpecAutomaticAnswer([{
      question: '请选择存储策略。',
      options: [
        { label: '其他' },
        { label: '自定义' },
        { label: '保持现有存储策略' },
      ],
    }], 'zh-CN')).toBe('保持现有存储策略');
  });

  it('does not treat "avoids downtime" as a negative recommendation', () => {
    expect(resolveOpenSpecAutomaticAnswer([{
      question: 'Choose a rollout strategy.',
      options: [
        { label: 'Immediate replacement' },
        {
          label: 'Staged rollout',
          description: 'Recommended because it avoids downtime',
        },
      ],
    }])).toBe('Staged rollout');
  });

  it('authorizes contextual best judgment in English for an open-ended question', () => {
    const answer = resolveOpenSpecAutomaticAnswer([{
      question: 'What should the compatibility policy be?',
    }]);

    expect(answer).toBe(OPEN_SPEC_AUTONOMOUS_ANSWER);
    expect(answer).toContain('continue without asking the user again');
  });

  it('answers open-ended questions in Simplified Chinese', () => {
    const answer = resolveOpenSpecAutomaticAnswer([{
      question: '兼容策略应该是什么？',
    }], 'zh-CN');

    expect(answer).toContain('已授权自动决策');
    expect(answer).toContain('风险最低、改动最小且保持兼容');
    expect(answer).toContain('不要再次询问用户');
    expect(answer).not.toContain('Automatic decision authorized');
  });

  it('answers open-ended questions in French', () => {
    const answer = resolveOpenSpecAutomaticAnswer([{
      question: 'Quelle politique de compatibilité faut-il adopter ?',
    }], 'fr');

    expect(answer).toContain('Décision automatique autorisée');
    expect(answer).toContain('la moins risquée');
    expect(answer).toContain('sans interroger de nouveau l’utilisateur');
    expect(answer).not.toContain('Automatic decision authorized');
  });

  it('serializes automatic answers for multiple questions', () => {
    const answer = resolveOpenSpecAutomaticAnswer([
      {
        header: 'Storage',
        question: 'Choose storage.',
        options: [
          { label: 'SQLite (Recommended)' },
          { label: 'Remote database' },
        ],
      },
      {
        header: 'Compatibility',
        question: 'Define the compatibility policy.',
      },
    ]);

    expect(answer).toContain(
      'Question 1 (Storage): Choose storage.\nAnswer: SQLite (Recommended)',
    );
    expect(answer).toContain(
      `Question 2 (Compatibility): Define the compatibility policy.\nAnswer: ${OPEN_SPEC_AUTONOMOUS_ANSWER}`,
    );
  });

  it('returns the autonomous instruction for an empty defensive input', () => {
    expect(resolveOpenSpecAutomaticAnswer([])).toBe(
      OPEN_SPEC_AUTONOMOUS_ANSWER,
    );
  });
});

describe('OpenSpec automatic input responder', () => {
  it('is enabled only for an OpenSpec session with a run id', () => {
    const abortSignal = new AbortController().signal;

    expect(createOpenSpecAutomaticInputResponder({
      agentType: 'coder',
      openSpecRunId: 'run-1',
      language: 'en',
      abortSignal,
    })).toBeUndefined();
    expect(createOpenSpecAutomaticInputResponder({
      agentType: 'openspec',
      language: 'en',
      abortSignal,
    })).toBeUndefined();
    expect(createOpenSpecAutomaticInputResponder({
      agentType: 'openspec',
      openSpecRunId: '   ',
      language: 'en',
      abortSignal,
    })).toBeUndefined();
    expect(createOpenSpecAutomaticInputResponder({
      agentType: 'openspec',
      openSpecRunId: 'run-1',
      language: 'en',
      abortSignal,
    })).toBeTypeOf('function');
  });

  it('rejects with AbortError when the OpenSpec action is cancelled', async () => {
    const abortController = new AbortController();
    const responder = createOpenSpecAutomaticInputResponder({
      agentType: 'openspec',
      openSpecRunId: 'run-1',
      language: 'en',
      abortSignal: abortController.signal,
    });
    expect(responder).toBeTypeOf('function');
    if (!responder) {
      throw new Error('Expected an automatic responder for the OpenSpec run.');
    }

    abortController.abort();

    await expect(responder({
      questions: [{
        question: 'Choose a strategy.',
        options: [{ label: 'Safe default' }],
      }],
    })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
