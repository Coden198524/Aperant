import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS,
  AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS,
  buildAutocodeDirectCompletionSummary,
  buildAutocodeDirectExecutionMetadata,
  buildAutocodeDirectPlanLifecycleState,
  extractAutocodeDirectTaskDescription,
  getAutocodeDirectQualityGateFailureReason,
  inferAutocodeDirectValidationEvidence,
  isAutocodeDirectQualityGatePassed,
  isAutocodeSuccessfulDirectOutcome,
  shouldRequireAutocodeDirectValidation,
} from './direct-task-summary.js';

describe('direct task summary helpers', () => {
  it('does not treat context window or step exhaustion as Direct completion', () => {
    expect(isAutocodeSuccessfulDirectOutcome({
      outcome: 'context_window',
      stepsExecuted: 12,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      durationMs: 1,
      toolCallCount: 0,
    })).toBe(false);
    expect(isAutocodeSuccessfulDirectOutcome({
      outcome: 'max_steps',
      stepsExecuted: 12,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      durationMs: 1,
      toolCallCount: 0,
    })).toBe(false);
    expect(isAutocodeSuccessfulDirectOutcome({
      outcome: 'completed',
      stepsExecuted: 12,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [],
      durationMs: 1,
      toolCallCount: 0,
    })).toBe(true);
  });

  it('infers reported Direct validation results from the final response', () => {
    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: '| Verification | npm test -- direct-task-summary.test.ts passed |' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: npm test passed.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: npm test failed with 2 assertion errors.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_failed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: npm test passed with 0 failed tests and no errors.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: typecheck completed without errors; not failing.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: '\u9a8c\u8bc1\u901a\u8fc7\uff0c\u65e0\u9519\u8bef\u3002' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });
    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: '\u9a8c\u8bc1\u5df2\u8fd0\u884c `node --check game.js`\uff0c\u5e76\u7528 Chrome \u65e0\u5934\u6a21\u5f0f\u751f\u6210\u6e32\u67d3\u622a\u56fe\u786e\u8ba4\u9875\u9762\u53ef\u52a0\u8f7d\u3002' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'node --check game.js Chrome \u7ead\uE1BF\uE17B\u6924\u7538\u6F70\u9359\uE21A\u59DE\u675E' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });


    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: '验证：npm test 通过，无异常。' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_passed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Verification: typecheck passed but smoke test failed.' }],
      durationMs: 1,
      toolCallCount: 1,
    })).toMatchObject({ status: 'reported_mixed' });

    expect(inferAutocodeDirectValidationEvidence({
      outcome: 'completed',
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'What changed: answered the question directly.' }],
      durationMs: 1,
      toolCallCount: 0,
    })).toMatchObject({ status: 'not_run' });
  });

  it('preserves Direct change request metadata when completing an iteration', () => {
    const metadata = buildAutocodeDirectExecutionMetadata({
      existing: {
        enabled: true,
        outcome: 'running',
        current_subtask_id: 'direct-cr-20260701074920826',
        change_request_id: 'cr-20260701074920826',
        summary_file: 'direct_summary.md',
      },
      outcome: 'completed',
      completedAt: '2026-07-01T07:50:11.417Z',
      currentSubtaskId: 'direct-cr-20260701074920826',
      quality: {
        mode: 'direct',
        outcome: 'completed',
        changedFiles: ['src/direct.ts'],
        filesChanged: 1,
        stepsExecuted: 2,
        toolCallCount: 1,
        durationMs: 10,
        recordedAt: '2026-07-01T07:50:11.417Z',
        validation: {
          status: 'reported_passed',
          reason: 'npm test passed',
        },
      },
    });

    expect(metadata).toMatchObject({
      enabled: true,
      outcome: 'completed',
      completed_at: '2026-07-01T07:50:11.417Z',
      current_subtask_id: 'direct-cr-20260701074920826',
      change_request_id: 'cr-20260701074920826',
      summary_file: 'direct_summary.md',
    });
    expect(metadata.ai_coding_quality).toMatchObject({
      mode: 'direct',
      filesChanged: 1,
    });
  });

  it('maps Direct completion and failure to consistent plan lifecycle states', () => {
    expect(buildAutocodeDirectPlanLifecycleState(true)).toEqual({
      status: 'human_review',
      planStatus: 'review',
      reviewReason: 'completed',
      xstateState: 'human_review',
      executionPhase: 'complete',
    });
    expect(buildAutocodeDirectPlanLifecycleState(false)).toEqual({
      status: 'error',
      planStatus: 'error',
      reviewReason: 'errors',
      xstateState: 'error',
      executionPhase: 'failed',
    });
  });

  it('removes Direct completion timestamps for failed iterations', () => {
    const metadata = buildAutocodeDirectExecutionMetadata({
      existing: {
        enabled: true,
        outcome: 'completed',
        completed_at: '2026-07-01T07:50:11.417Z',
        current_subtask_id: 'direct-cr-previous',
        summary_file: 'direct_summary.md',
      },
      outcome: 'error',
      currentSubtaskId: 'direct-cr-current',
      quality: {
        mode: 'direct',
        outcome: 'error',
        changedFiles: ['src/direct.ts'],
        filesChanged: 1,
        stepsExecuted: 2,
        toolCallCount: 1,
        durationMs: 10,
        recordedAt: '2026-07-01T07:50:11.417Z',
        validation: {
          status: 'reported_failed',
          reason: 'npm test failed',
        },
      },
    });

    expect(metadata).toMatchObject({
      enabled: true,
      outcome: 'error',
      current_subtask_id: 'direct-cr-current',
      summary_file: 'direct_summary.md',
    });
    expect(metadata).not.toHaveProperty('completed_at');
    expect(metadata.ai_coding_quality).toMatchObject({
      mode: 'direct',
      outcome: 'error',
    });
  });
  it('does not require validation for analysis or documentation-only Direct tasks', () => {
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis' },
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'documentation' },
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { sourceType: 'project_docs' },
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      description: '\u5206\u6790\u65e5\u5fd7\uff0c\u5b9a\u4f4d Direct \u6a21\u5f0f\u4e3a\u4ec0\u4e48\u6ca1\u6709\u7ee7\u7eed\u6267\u884c\u3002',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      description: 'Analyze the Direct validation error and explain why npm test failed.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      description: '\u5206\u6790\u6d4b\u8bd5\u5931\u8d25\u539f\u56e0\uff0c\u5b9a\u4f4d\u62a5\u9519\u6839\u56e0\u3002',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      description: 'Generate a reader-first architecture report from the existing source files.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'direct', title: 'Analyze Direct task logs and explain the pause reason' },
    })).toBe(false);
  });

  it('still requires validation for implementation Direct tasks', () => {
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Analyze the failure and fix the implementation in worker.ts.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'documentation' },
      description: '修复文档生成器中的源码错误并更新测试。',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis' },
      description: 'Review the current implementation, then code the fix.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis', taskTitle: 'Add a report dashboard' },
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { category: 'documentation' },
      description: 'Create a documentation generator for API modules.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'research' },
      description: 'Build document upload integration.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Do not only analyze; fix the bug in worker.ts.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Do not only analyze, fix the bug in worker.ts.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Analyze the current behavior. The worker fix must be implemented before release.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'documentation' },
      description: '不要只写分析；然后修复代码。',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis' },
      description: '不要只分析，修复代码。',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis' },
      description: '分析现状，然后修改产品源码。',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'documentation' },
      description: '创建 API 文档生成器并补充测试。',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'analysis' },
      description: 'Review the failure, then modify worker.ts and update tests.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { developmentMode: 'direct', workflowMode: 'off' },
      description: 'Fix the Direct retry bug in worker.ts and update tests.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'direct', feature: 'Implement Direct retry state handling' },
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { developmentMode: 'direct' },
      description: 'Direct CLI should retry implementation runs that do not report validation.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'direct', title: 'Fix Direct retry state handling' },
    })).toBe(true);
  });

  it('does not treat implementation nouns or negated source edits as implementation work', () => {
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { category: 'documentation' },
      description: 'Document the current code and implementation. Do not modify product source code.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Analyze the implementation and explain why code validation failed.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'documentation' },
      description: '为后续编码上下文生成文档，不要修改产品源码。',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'documentation' },
      description: 'Generate API documentation and create class documentation.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis' },
      description: 'Analyze the current behavior. The requested change is implemented according to the task description.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'documentation' },
      description: '生成实现方案文档并总结实现细节。',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      metadata: { taskType: 'documentation' },
      description: '生成 API 接口文档和单元测试报告，不要修改源码。',
    })).toBe(false);
  });

  it('keeps an ambiguous review on an existing implementation plan bound to its design contract', () => {
    const existingPlan = {
      workflow_type: 'feature',
      source_task: { design_contract: { version: 5, fingerprint: 'existing' } },
    };

    expect(shouldRequireAutocodeDirectValidation({
      plan: existingPlan,
      description: 'Review the completed implementation; no coding remains.',
    })).toBe(true);
    expect(shouldRequireAutocodeDirectValidation({
      description: 'Review the current architecture; no coding is requested.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: existingPlan,
      description: 'Analyze the completed implementation and write a findings report.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: existingPlan,
      metadata: { taskType: 'analysis' },
      description: 'Review the completed implementation; no coding remains.',
    })).toBe(false);
  });

  it('lets a current non-implementation request supersede stale implementation plan wording', () => {
    const stalePlan = {
      feature: 'Implement the legacy dashboard',
      workflow_type: 'feature',
      source_task: { design_contract: { version: 5, fingerprint: 'stale' } },
    };

    expect(shouldRequireAutocodeDirectValidation({
      plan: stalePlan,
      metadata: { taskType: 'documentation' },
      description: 'Generate the current project handbook from repository evidence.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: stalePlan,
      description: 'Analyze the current runtime logs and write a findings report.',
    })).toBe(false);
    expect(shouldRequireAutocodeDirectValidation({
      plan: { workflow_type: 'analysis', feature: 'Implement the new dashboard' },
    })).toBe(true);
  });
  it('fails the Direct quality gate for failed validation or self-critique', () => {
    const baseQuality = {
      mode: 'direct' as const,
      outcome: 'completed',
      changedFiles: ['src/direct.ts'],
      filesChanged: 1,
      stepsExecuted: 2,
      toolCallCount: 1,
      durationMs: 10,
      recordedAt: '2026-01-01T00:00:00.000Z',
      validation: {
        status: 'reported_passed',
        reason: 'npm test passed',
      },
    };

    expect(isAutocodeDirectQualityGatePassed({
      ...baseQuality,
      selfCritique: {
        status: 'passed',
        score: 0.9,
        filesReviewed: 1,
        improvements: [],
      },
    })).toBe(true);

    const missingValidationQuality = {
      ...baseQuality,
      validation: {
        status: 'not_run',
        reason: 'No validation command was reported.',
      },
    };
    expect(getAutocodeDirectQualityGateFailureReason(missingValidationQuality)).toBeNull();
    expect(getAutocodeDirectQualityGateFailureReason(missingValidationQuality, {
      requireValidation: true,
    })).toContain('Direct validation not_run');
    expect(isAutocodeDirectQualityGatePassed(missingValidationQuality, {
      requireValidation: true,
    })).toBe(false);

    const ambiguousValidationQuality = {
      ...baseQuality,
      validation: {
        status: 'reported',
        reason: 'Validation: npm test was mentioned without a pass/fail result.',
      },
    };
    expect(getAutocodeDirectQualityGateFailureReason(ambiguousValidationQuality)).toBeNull();
    expect(getAutocodeDirectQualityGateFailureReason(ambiguousValidationQuality, {
      requireValidation: true,
    })).toContain('Direct validation reported');

    const failedCritiqueReason = getAutocodeDirectQualityGateFailureReason({
      ...baseQuality,
      selfCritique: {
        status: 'failed',
        score: 0.5,
        filesReviewed: 1,
        improvements: ['Handle null input', 'Add regression test'],
      },
    });
    expect(failedCritiqueReason).toContain('Direct self-critique failed');
    expect(failedCritiqueReason).toContain('Handle null input');

    expect(getAutocodeDirectQualityGateFailureReason({
      ...baseQuality,
      selfCritique: {
        status: 'failed',
        score: 0.5,
        filesReviewed: 1,
        improvements: ['Documentation structure needs one more pass'],
      },
    }, { requireSelfCritique: false })).toBeNull();

    expect(getAutocodeDirectQualityGateFailureReason({
      ...baseQuality,
      validation: {
        status: 'reported_failed',
        reason: 'npm test failed with 1 assertion error',
      },
    })).toContain('reported_failed');

    expect(isAutocodeDirectQualityGatePassed({
      ...baseQuality,
      validation: {
        status: 'reported_mixed',
        reason: 'typecheck passed but smoke test failed',
      },
    })).toBe(false);
  });

  it('keeps both ends of oversized direct task descriptions', () => {
    const longTask = [
      'Opening direct rule: keep configuration tables as JSON.',
      ...Array.from(
        { length: 180 },
        (_, index) => `Large direct task context ${index}: ${'diagnostic noise '.repeat(8)}`,
      ),
      'Closing direct rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    const description = extractAutocodeDirectTaskDescription({
      initialMessages: [{ content: longTask }],
      specDir: 'E:/repo/.autocode/specs/001-task',
    });

    expect(description).toContain('Opening direct rule: keep configuration tables as JSON.');
    expect(description).toContain('direct task middle omitted for summary budget');
    expect(description).toContain('Closing direct rule: convert only model-readable prose references to Markdown.');
    expect(description).not.toContain('Large direct task context 120');
    expect(description.length).toBeLessThanOrEqual(AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS);
  });

  it('folds repeated direct task description lines before storing summaries', () => {
    const repeatedLine = 'DIRECT TASK REPEAT: same setup instruction without new signal.';
    const description = extractAutocodeDirectTaskDescription({
      initialMessages: [{
        content: [
          'DIRECT TASK HEAD',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'DIRECT TASK TAIL',
        ].join('\n'),
      }],
      specDir: 'E:/repo/.autocode/specs/001-task',
    });

    expect(description).toContain('DIRECT TASK HEAD');
    expect(description).toContain('DIRECT TASK TAIL');
    expect(description).toContain('119 repeated line(s) omitted for prompt budget');
    expect((description.match(/DIRECT TASK REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('falls back to the spec directory name when no initial task message exists', () => {
    expect(extractAutocodeDirectTaskDescription({
      initialMessages: [],
      specDir: 'E:/repo/.autocode/specs/001-task',
    })).toBe('Direct model execution for 001-task');
  });

  it('keeps both ends of oversized direct completion summaries', () => {
    const longFinal = [
      'Opening final summary: implemented focused direct change.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large final response context ${index}: ${'verbose verification log '.repeat(6)}`,
      ),
      'Closing final summary: verification passed and review notes remain visible.',
    ].join('\n');

    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'completed',
        stepsExecuted: 1,
        toolCallCount: 1,
        durationMs: 1,
        messages: [{ role: 'assistant', content: longFinal }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(summary).toContain('Opening final summary: implemented focused direct change.');
    expect(summary).toContain('direct final response middle omitted for summary budget');
    expect(summary).toContain('Closing final summary: verification passed and review notes remain visible.');
    expect(summary).not.toContain('Large final response context 160');
    expect(summary).toContain('| Item | Details |');
    expect(summary).toContain('Tokens: 2 total (1 prompt, 1 completion)');
    expect(summary.length).toBeLessThan(AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS + 1_000);
  });

  it('folds repeated direct completion summary lines before appending quality details', () => {
    const repeatedLine = 'DIRECT FINAL REPEAT: same verification detail without new signal.';
    const finalText = [
      'DIRECT FINAL HEAD',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'DIRECT FINAL TAIL',
    ].join('\n');

    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'completed',
        stepsExecuted: 1,
        toolCallCount: 1,
        durationMs: 1,
        messages: [{ role: 'assistant', content: finalText }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(summary).toContain('DIRECT FINAL HEAD');
    expect(summary).toContain('DIRECT FINAL TAIL');
    expect(summary).toContain('119 repeated line(s) omitted for prompt budget');
    expect((summary.match(/DIRECT FINAL REPEAT/g) ?? [])).toHaveLength(1);
    expect(summary).toContain('| Item | Details |');
  });

  it('localizes zh-CN fallback direct summaries without mojibake', () => {
    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      language: 'zh-CN',
      streamedText: '',
      result: {
        outcome: 'completed',
        stepsExecuted: 2,
        toolCallCount: 3,
        durationMs: 1,
        messages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: true },
      },
      quality: {
        mode: 'direct',
        outcome: 'completed',
        changedFiles: ['src/direct.ts'],
        filesChanged: 1,
        stepsExecuted: 2,
        toolCallCount: 3,
        durationMs: 1,
        recordedAt: '2026-01-01T00:00:00.000Z',
        validation: {
          status: 'reported_passed',
          reason: 'npm test passed',
        },
      },
    });

    expect(summary).toContain('\u9879\u76ee');
    expect(summary).toContain('\u53d8\u66f4\u6587\u4ef6');
    expect(summary).toContain('\u9a8c\u8bc1\u7ed3\u679c');
    expect(summary).toContain('Direct \u6a21\u5f0f');
    expect(summary).not.toMatch(/[\u95b8\u599e\u59a4\u940e\u7f02\u5a23\u6d60\u9429\u935b\u695e]/u);
  });

  it('includes compact token usage in fallback direct completion summaries', () => {
    const summary = buildAutocodeDirectCompletionSummary({
      specDir: 'E:/repo/.autocode/specs/001-task',
      streamedText: '',
      result: {
        outcome: 'error',
        stepsExecuted: 2,
        toolCallCount: 3,
        durationMs: 1,
        messages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: true },
        error: { code: 'generic_error', message: 'failed', retryable: false },
      },
    });

    expect(summary).toContain('| Verification |');
    expect(summary).toContain('Direct model session ended with outcome "error" for 001-task.');
    expect(summary).not.toContain('Direct model session completed for 001-task.');
    expect(summary).toContain('Session outcome: error. Steps: 2. Tools: 3.');
    expect(summary).toContain('Tokens: 15 total (10 prompt, 5 completion, estimated).');
  });
});
