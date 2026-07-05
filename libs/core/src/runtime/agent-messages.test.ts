import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { saveAutocodeTaskRequirementsSync } from '../tasks/requirements-store.js';
import {
  AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS,
  buildAutocodeDefaultQAPrompt,
  buildAutocodeDefaultSpecPrompt,
  buildAutocodeDirectTaskExecutionMessages,
  buildAutocodeQAInitialMessages,
  buildAutocodeTaskExecutionMessages,
  CHANGE_REQUEST_AUDIT_MAX_CHARS,
  compactChangeRequestJsonlForPrompt,
  DIRECT_CHANGE_REQUEST_LIMIT,
  QA_PLAN_CONTEXT_MAX_CHARS,
  QA_SPEC_CONTEXT_MAX_CHARS,
  RUNTIME_PLAN_CONTEXT_MAX_CHARS,
  RUNTIME_SPEC_CONTEXT_MAX_CHARS,
} from './agent-messages.js';
import {
  AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS,
  AUTOCODE_DIRECT_SESSION_STATE_VERSION,
} from './direct-session-state.js';

describe('Autocode runtime agent messages', () => {
  let tempRoot: string;
  let specDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'autocode-agent-messages-'));
    specDir = join(tempRoot, '.autocode', 'specs', '001-task');
    mkdirSync(specDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('compacts oversized task descriptions in default spec prompts', () => {
    const longTaskDescription = [
      'Opening task rule: keep parsed configuration tables as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large pasted context ${index}: ${'repeated diagnostic text '.repeat(5)}`,
      ),
      'Closing task rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    const prompt = buildAutocodeDefaultSpecPrompt({
      taskDescription: longTaskDescription,
      specDir,
    });

    expect(prompt).toContain('Opening task rule: keep parsed configuration tables as JSON.');
    expect(prompt).toContain('task description middle omitted for prompt budget');
    expect(prompt).toContain('Closing task rule: convert only model-readable prose references to Markdown.');
    expect(prompt).not.toContain('Large pasted context 160');
    expect(prompt.length).toBeLessThan(AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS + 700);
  });

  it('compacts oversized task descriptions in MMO default spec prompts', () => {
    const longTaskDescription = [
      'Opening MMO rule: preserve server authority acceptance criteria.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large MMO context ${index}: ${'world simulation notes '.repeat(5)}`,
      ),
      'Closing MMO rule: keep rollout and QA risks visible.',
    ].join('\n');

    const prompt = buildAutocodeDefaultSpecPrompt({
      taskDescription: longTaskDescription,
      projectType: 'game-mmo',
      specDir,
    });

    expect(prompt).toContain('Opening MMO rule: preserve server authority acceptance criteria.');
    expect(prompt).toContain('task description middle omitted for prompt budget');
    expect(prompt).toContain('Closing MMO rule: keep rollout and QA risks visible.');
    expect(prompt).not.toContain('Large MMO context 160');
    expect(prompt.length).toBeLessThan(AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS + 800);
  });

  it('adds product-grade QA report requirements to default QA prompts', () => {
    const generic = buildAutocodeDefaultQAPrompt({
      specId: '001-task',
      projectRoot: tempRoot,
    });
    const mmo = buildAutocodeDefaultQAPrompt({
      specId: '001-task',
      projectRoot: tempRoot,
      projectType: 'game-mmo',
    });

    expect(generic).toContain('Changed Files And Contracts');
    expect(generic).toContain('Acceptance Matrix');
    expect(generic).toContain('APIs/schemas/config/data flow/error behavior');
    expect(mmo).toContain('MMO Domain Matrix');
    expect(mmo).toContain('server authority');
    expect(mmo).toContain('network sync/protocol');
    expect(mmo).toContain('liveops/release');
  });

  it('compacts oversized spec and implementation plan for task execution messages', () => {
    writeLargeSpecAndPlan(specDir);

    const [message] = buildAutocodeTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
    });

    expect(message.content).toContain('Compact excerpt of spec.md');
    expect(message.content).toContain('Compact excerpt of implementation_plan.md');
    expect(message.content).toContain('[ ] 1.1 Implement focused runtime context');
    expect(message.content).toContain('Evidence: src/runtime/agent-messages.ts');
    expect(message.content).toContain('artifact opening middle omitted');
    expect(message.content).toContain('Spec tail detail 199');
    expect(message.content).toContain('Plan tail detail 199');
    expect(message.content.length).toBeLessThan(
      RUNTIME_SPEC_CONTEXT_MAX_CHARS + RUNTIME_PLAN_CONTEXT_MAX_CHARS + 6_000,
    );
  });

  it('does not inject needs_revision instructions for force planning without human review input', () => {
    writeFileSync(
      join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan),
      [
        '# Implementation Plan',
        '',
        '- [ ] 1.1 Repair broad task split',
        '  - Evidence: tasks.md validation feedback',
        '',
      ].join('\n'),
      'utf-8',
    );

    const [message] = buildAutocodeTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
      forcePlanning: true,
    });

    expect(message.content).toContain('internal planning artifact repair');
    expect(message.content).toContain('ordinary pending checklist items');
    expect(message.content).not.toContain('needs_revision');
    expect(message.content).not.toContain('latest Human Review Input');
  });

  it('compacts oversized spec and implementation plan for QA initial messages', () => {
    writeLargeSpecAndPlan(specDir);

    const [message] = buildAutocodeQAInitialMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
    });

    expect(message.content).toContain('Compact excerpt of spec.md');
    expect(message.content).toContain('Compact excerpt of implementation_plan.md');
    expect(message.content).toContain('[ ] 1.1 Implement focused runtime context');
    expect(message.content).toContain('Verification: npm test -- agent-messages.test.ts');
    expect(message.content).toContain('Changed Files And Contracts');
    expect(message.content).toContain('Acceptance Matrix');
    expect(message.content).toContain('impacted requirement/contract');
    expect(message.content).toContain('artifact opening middle omitted');
    expect(message.content).toContain('Spec tail detail 199');
    expect(message.content).toContain('Plan tail detail 199');
    expect(message.content.length).toBeLessThan(
      QA_SPEC_CONTEXT_MAX_CHARS + QA_PLAN_CONTEXT_MAX_CHARS + 2_500,
    );
  });

  it('limits direct continuation summaries injected from prior sessions', () => {
    const longSummary = `Prior summary start ${'expensive repeated direct context '.repeat(120)} Prior summary tail`;

    const [message] = buildAutocodeDirectTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
      directContinuationMode: 'summary',
      directSessionState: {
        version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
        sessionId: 'direct-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        iteration: 1,
        latestSummary: longSummary,
      },
    });

    expect(message.content).toContain('Prior Direct Session Summary');
    expect(message.content).toContain('Prior summary start');
    expect(message.content).toContain('direct session summary middle omitted for continuation budget');
    expect(message.content).toContain('Prior summary tail');
    expect(message.content.length).toBeLessThan(AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS + 2_000);
  });

  it('keeps the latest tail constraints when compacting direct task requests', () => {
    const longRequest = [
      'Opening direct request: update only model-readable context artifacts.',
      ...Array.from(
        { length: 320 },
        (_, index) => `Large direct request detail ${index}: ${'diagnostic setup '.repeat(6)}`,
      ),
      'Closing direct request: keep configuration tables and app-parsed state as JSON.',
    ].join('\n');

    saveAutocodeTaskRequirementsSync(specDir, {
      task_description: longRequest,
      workflow_type: 'direct',
    });

    const [message] = buildAutocodeDirectTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
    });

    expect(message.content).toContain('Opening direct request: update only model-readable context artifacts.');
    expect(message.content).toContain('direct task section middle omitted for prompt budget');
    expect(message.content).toContain('Closing direct request: keep configuration tables and app-parsed state as JSON.');
    expect(message.content).not.toContain('Large direct request detail 200');
    expect(message.content.length).toBeLessThan(9_000);
  });

  it('keeps project docs reference compact in direct task messages', () => {
    const docsDir = join(tempRoot, '.autocode', 'project-docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, 'index.md'),
      '# Project Docs\n\n- Architecture: architecture.md\n- Technical: technical.md\n',
      'utf-8',
    );
    writeFileSync(
      join(docsDir, 'architecture.md'),
      [
        '# Architecture',
        '',
        '## Boundaries',
        '',
        '- Renderer owns UI state.',
        '- Main process owns provider credentials.',
        ...Array.from(
          { length: 180 },
          (_, index) => `- Architecture deep detail ${index}: ${'runtime boundary evidence '.repeat(8)}`,
        ),
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(docsDir, 'technical.md'),
      [
        '# Technical',
        '',
        '## Commands',
        '',
        '- Run npm run build for release verification.',
        ...Array.from(
          { length: 180 },
          (_, index) => `- Technical deep detail ${index}: ${'toolchain command evidence '.repeat(8)}`,
        ),
      ].join('\n'),
      'utf-8',
    );

    saveAutocodeTaskRequirementsSync(specDir, {
      task_description: 'Make a focused Direct-mode change that should use project conventions only as needed.',
      workflow_type: 'direct',
    });

    const [message] = buildAutocodeDirectTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
      dataDirName: '.autocode',
    });

    expect(message.content).toContain('Project Documentation Reference');
    expect(message.content).toContain('Available documents:');
    expect(message.content).toContain('Renderer owns UI state');
    expect(message.content).not.toContain('Architecture deep detail 90');
    expect(Buffer.byteLength(message.content, 'utf8')).toBeLessThan(5_500);
  });

  it('folds repeated direct task request lines before prompt compaction', () => {
    const repeatedLine = 'REPEATED_DIRECT_LOG: renderer printed the same warning without new evidence.';
    const longRequest = [
      'Opening direct request: preserve the newest functional instruction.',
      ...Array.from({ length: 420 }, () => repeatedLine),
      'Closing direct request: continue feature optimization before release verification.',
    ].join('\n');

    saveAutocodeTaskRequirementsSync(specDir, {
      task_description: longRequest,
      workflow_type: 'direct',
    });

    const [message] = buildAutocodeDirectTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
    });

    expect(message.content).toContain('Opening direct request: preserve the newest functional instruction.');
    expect(message.content).toContain('Closing direct request: continue feature optimization before release verification.');
    expect(message.content).toContain('419 repeated line(s) omitted for prompt budget');
    expect((message.content.match(/REPEATED_DIRECT_LOG/g) ?? [])).toHaveLength(1);
    expect(message.content.length).toBeLessThan(longRequest.length / 4);
  });

  it('preserves tail constraints while limiting human review input in runtime task messages', () => {
    writeFileSync(
      join(specDir, 'HUMAN_INPUT.md'),
      [
        'Important review instruction at the top.',
        'x'.repeat(DIRECT_CHANGE_REQUEST_LIMIT * 2),
        'Final review instruction at the tail: do not run release verification.',
      ].join('\n'),
      'utf-8',
    );

    const [message] = buildAutocodeTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
    });

    expect(message.content).toContain('Important review instruction at the top.');
    expect(message.content).toContain('HUMAN_INPUT.md middle omitted for prompt budget');
    expect(message.content).toContain('Final review instruction at the tail: do not run release verification.');
    expect(message.content.length).toBeLessThan(DIRECT_CHANGE_REQUEST_LIMIT + 4_000);
  });

  it('preserves tail constraints from latest human input in direct continuations', () => {
    writeFileSync(
      join(specDir, 'HUMAN_INPUT.md'),
      [
        'Direct continuation review starts here.',
        'middle feedback noise '.repeat(600),
        'Direct continuation tail constraint: only fix the focused regression.',
      ].join('\n'),
      'utf-8',
    );

    const [message] = buildAutocodeDirectTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
      directContinuationMode: 'summary',
      directSessionState: {
        version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
        sessionId: 'direct-2',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        iteration: 2,
      },
    });

    expect(message.content).toContain('Latest Human Input');
    expect(message.content).toContain('Direct continuation review starts here.');
    expect(message.content).toContain('HUMAN_INPUT.md middle omitted for prompt budget');
    expect(message.content).toContain('Direct continuation tail constraint: only fix the focused regression.');
  });

  it('compacts change request audit history to the latest actionable entries', () => {
    const entries = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      id: `CR-${index + 1}`,
      createdAt: `2026-06-14T0${index}:00:00.000Z`,
      scope: 'implementation',
      impacts: index === 4 ? ['requirements', 'tasks', 'validation'] : ['implementation'],
      feedback: index === 0
        ? `OLD_FEEDBACK_SHOULD_NOT_BE_IN_PROMPT ${'old context '.repeat(100)}`
        : index === 4
          ? `LATEST_REQUIRED_FEEDBACK ${'latest details '.repeat(100)} FINAL_CHANGE_REQUEST_TAIL_CONSTRAINT`
          : `Recent feedback ${index}`,
      iteration: {
        mode: 'standard-implementation',
        flowDocuments: ['HUMAN_INPUT.md', 'change_requests.jsonl', 'tasks.md', 'implementation_plan.md'],
        requiredActions: [
          'Keep this as the same Standard task iteration.',
          'Update changed flow documents before coding.',
          'Add focused verification metadata.',
        ],
        validation: ['Run targeted tests.', 'Keep changes ready for commit.'],
        commitPolicy: 'Use the normal task commit flow after validation if commits are enabled.',
      },
    })).join('\n');

    writeFileSync(join(specDir, 'change_requests.jsonl'), `${entries}\n`, 'utf-8');

    const [message] = buildAutocodeTaskExecutionMessages({
      specDir,
      specId: '001-task',
      projectRoot: tempRoot,
      forcePlanning: true,
    });

    expect(message.content).toContain('Showing latest 3 of 5 change request entries.');
    expect(message.content).toContain('2 older entries were omitted');
    expect(message.content).toContain('Latest change request: CR-5');
    expect(message.content).toContain('LATEST_REQUIRED_FEEDBACK');
    expect(message.content).toContain('FINAL_CHANGE_REQUEST_TAIL_CONSTRAINT');
    expect(message.content).toContain('Flow documents: HUMAN_INPUT.md; change_requests.jsonl; tasks.md; implementation_plan.md');
    expect(message.content).toContain('do not write implementation_plan.md directly');
    expect(message.content).toContain('Keep one canonical checklist item');
    expect(message.content).not.toContain('preserve completed work that remains valid, reset affected work to pending with needs_revision notes, add new work');
    expect(message.content).not.toContain('OLD_FEEDBACK_SHOULD_NOT_BE_IN_PROMPT');
  });

  it('compacts raw change request entries when JSONL contains malformed lines', () => {
    const compacted = compactChangeRequestJsonlForPrompt(
      [
        '{"id":"CR-1","feedback":"older"}',
        `not-json ${'raw details '.repeat(200)} RAW_TAIL_SHOULD_BE_PRESERVED`,
      ].join('\n'),
      { maxEntries: 1, maxChars: CHANGE_REQUEST_AUDIT_MAX_CHARS },
    );

    expect(compacted).toContain('Latest raw entry');
    expect(compacted).toContain('not-json');
    expect(compacted).toContain('change request field middle omitted');
    expect(compacted).toContain('RAW_TAIL_SHOULD_BE_PRESERVED');
  });

  it('folds repeated change request field lines before compacting audit entries', () => {
    const repeatedLine = 'REPEATED_CHANGE_REQUEST_LOG: renderer printed the same warning without new evidence.';
    const feedback = [
      'Opening feedback: keep the latest user constraint visible.',
      ...Array.from({ length: 120 }, () => repeatedLine),
      'Closing feedback: continue feature optimization before release checks.',
    ].join('\n');

    const compacted = compactChangeRequestJsonlForPrompt(
      JSON.stringify({
        id: 'CR-repeat',
        createdAt: '2026-06-16T00:00:00.000Z',
        scope: 'implementation',
        feedback,
      }),
      { maxEntries: 1, maxChars: CHANGE_REQUEST_AUDIT_MAX_CHARS },
    );

    expect(compacted).toContain('Latest change request: CR-repeat');
    expect(compacted).toContain('Opening feedback: keep the latest user constraint visible.');
    expect(compacted).toContain('119 repeated line(s) omitted for prompt budget');
    expect(compacted).toContain('Closing feedback: continue feature optimization before release checks.');
    expect((compacted.match(/REPEATED_CHANGE_REQUEST_LOG/g) ?? [])).toHaveLength(1);
    expect(compacted.length).toBeLessThan(feedback.length / 4);
  });
});

function writeLargeSpecAndPlan(specDir: string): void {
  const spec = [
    '# Runtime Context Optimization',
    '',
    '## Requirements',
    '',
    '- Preserve quality while reducing repeated prompt context.',
    '- Evidence: src/runtime/agent-messages.ts',
    '',
    ...Array.from(
      { length: 200 },
      (_, index) => `- Spec tail detail ${index}: ${'requirements and design evidence '.repeat(6)}`,
    ),
  ].join('\n');

  const plan = [
    '# Implementation Plan',
    '',
    '## Phase 1',
    '',
    '- [ ] 1.1 Implement focused runtime context',
    '  - Evidence: src/runtime/agent-messages.ts',
    '  - Verification: npm test -- agent-messages.test.ts',
    '- [x] 1.0 Existing work',
    '  - Completion: Earlier optimization completed.',
    '',
    ...Array.from(
      { length: 200 },
      (_, index) => `- Plan tail detail ${index}: ${'large completed work package summary '.repeat(6)}`,
    ),
  ].join('\n');

  writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile), `${spec}\n`, 'utf-8');
  writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan), `${plan}\n`, 'utf-8');
}
