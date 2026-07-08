import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS,
  buildAutocodeAgentKickoffMessage,
  buildAutocodeAgenticSpecOrchestratorKickoffMessage,
  buildAutocodeSpecKickoffMessage,
} from './agent-kickoff.js';

describe('buildAutocodeSpecKickoffMessage', () => {
  it('compacts oversized task descriptions while preserving head and tail requirements', () => {
    const longTaskDescription = [
      'Opening requirement: keep configuration tables as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Noisy pasted log line ${index}: ${'irrelevant terminal output '.repeat(5)}`,
      ),
      'Closing requirement: pure model-only reference artifacts should use Markdown.',
    ].join('\n');

    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'spec_discovery',
      specPhase: 'discovery',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: longTaskDescription,
    });

    expect(message).toContain('Opening requirement: keep configuration tables as JSON.');
    expect(message).toContain('task description middle omitted for prompt budget');
    expect(message).toContain('Closing requirement: pure model-only reference artifacts should use Markdown.');
    expect(message).not.toContain('Noisy pasted log line 160');
    expect(message.length).toBeLessThan(AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS + 3_500);
  });

  it('folds repeated task description lines before spec kickoff prompts', () => {
    const repeatedLine = 'KICKOFF TASK REPEAT: same pasted diagnostic line without new signal.';
    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'spec_discovery',
      specPhase: 'discovery',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: [
        'KICKOFF TASK HEAD',
        ...Array.from({ length: 120 }, () => repeatedLine),
        'KICKOFF TASK TAIL',
      ].join('\n'),
    });

    expect(message).toContain('KICKOFF TASK HEAD');
    expect(message).toContain('KICKOFF TASK TAIL');
    expect(message).toContain('119 repeated line(s) omitted for prompt budget');
    expect((message.match(/KICKOFF TASK REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('compacts large prior phase outputs before injecting kickoff context', () => {
    const contextMarkdown = [
      '# Project Context',
      '',
      '## Architecture',
      '',
      '- Renderer owns UI state.',
      '- Main process owns IPC.',
      ...Array.from(
        { length: 200 },
        (_, index) => `- Tail detail ${index}: ${'implementation evidence '.repeat(5)}`,
      ),
    ].join('\n');
    const researchMarkdown = [
      '# Research',
      '',
      '## Findings',
      '',
      ...Array.from(
        { length: 160 },
        (_, index) => `Long paragraph ${index} ${'external API constraint '.repeat(8)}`,
      ),
    ].join('\n');
    const largeJson = JSON.stringify({
      items: Array.from({ length: 60 }, (_, index) => ({
        id: index,
        description: 'long structured model output '.repeat(8),
      })),
    }, null, 2);

    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'planner',
      specPhase: 'planning',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: 'Plan a change.',
      priorPhaseOutputs: {
        'context.md': contextMarkdown,
        'research.md': researchMarkdown,
        'large.json': largeJson,
      },
    });

    expect(message).toContain('## CONTEXT FROM PRIOR PHASES');
    expect(message).toContain('### context.md');
    expect(message).toContain('Compact excerpt of context.md');
    expect(message).toContain('Architecture');
    expect(message).toContain('Renderer owns UI state');
    expect(message).toContain('prior output middle omitted');
    expect(message).toContain('Tail detail 199');
    expect(message).toContain('Compact JSON summary');
    expect(message.length).toBeLessThan(14_000);
  });

  it('keeps Standard planner kickoff focused on tasks.md by default', () => {
    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'planner',
      specPhase: 'planning',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: 'Plan a bounded Standard change.',
    });

    expect(message).toContain('Create E:/Work/App/.autocode/specs/001-task/tasks.md');
    expect(message).toContain('Default output is tasks.md only');
    expect(message).toContain('required by RequestChanges');
    expect(message).toContain('Do not write implementation_plan.md');
    expect(message).not.toContain('Use Autocode Standard planning: update E:/Work/App/.autocode/specs/001-task/spec.md');
  });
  it('folds repeated prior phase output lines before kickoff context injection', () => {
    const repeatedLine = 'KICKOFF PRIOR REPEAT: same evidence line without new signal.';
    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'planner',
      specPhase: 'planning',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: 'Plan a change.',
      priorPhaseOutputs: {
        'context.md': [
          '# Project Context',
          'KICKOFF PRIOR HEAD',
          ...Array.from({ length: 120 }, () => repeatedLine),
          'KICKOFF PRIOR TAIL',
        ].join('\n'),
      },
    });

    expect(message).toContain('## CONTEXT FROM PRIOR PHASES');
    expect(message).toContain('KICKOFF PRIOR HEAD');
    expect(message).toContain('KICKOFF PRIOR TAIL');
    expect(message).toContain('119 repeated line(s) omitted for prompt budget');
    expect((message.match(/KICKOFF PRIOR REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('caps oversized project documentation references in spec phase kickoff', () => {
    const projectDocsReference = [
      '## Project Documentation Reference',
      '',
      'Use these generated docs as source of truth.',
      '',
      '### Architecture (.autocode/project-docs/architecture.md)',
      '- Renderer owns UI state.',
      '- Main process owns filesystem and IPC.',
      ...Array.from(
        { length: 240 },
        (_, index) => `- Architecture detail ${index}: ${'project documentation evidence '.repeat(6)}`,
      ),
    ].join('\n');

    const message = buildAutocodeSpecKickoffMessage({
      agentType: 'spec_writer',
      specPhase: 'spec_writing',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      taskDescription: 'Write a spec.',
      projectDocsReference,
    });

    expect(message).toContain('## Project Documentation Reference');
    expect(message).toContain('Compact excerpt');
    expect(message).toContain('Renderer owns UI state');
    expect(message).toContain('project docs reference middle omitted');
    expect(message).toContain('Architecture detail 239');
    expect(message.length).toBeLessThan(8_500);
  });

  it('caps oversized project documentation references in agentic orchestrator kickoff', () => {
    const projectDocsReference = [
      '## Project Documentation Reference',
      '',
      ...Array.from(
        { length: 220 },
        (_, index) => `- Product detail ${index}: ${'workflow and architecture note '.repeat(6)}`,
      ),
    ].join('\n');

    const message = buildAutocodeAgenticSpecOrchestratorKickoffMessage({
      taskDescription: 'Create a complete spec.',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      projectDocsReference,
    });

    expect(message).toContain('## Project Documentation Reference');
    expect(message).toContain('Compact excerpt');
    expect(message).toContain('project docs reference middle omitted');
    expect(message).toContain('Product detail 219');
    expect(message.length).toBeLessThan(7_000);
  });

  it('includes product-grade QA report requirements in QA kickoff messages', () => {
    const qaReviewer = buildAutocodeAgentKickoffMessage({
      agentType: 'qa_reviewer',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
    });
    const qaFixer = buildAutocodeAgentKickoffMessage({
      agentType: 'qa_fixer',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
    });
    const mmoReviewer = buildAutocodeAgentKickoffMessage({
      agentType: 'mmo_qa_reviewer',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
    });

    expect(qaReviewer).toContain('Changed Files And Contracts');
    expect(qaReviewer).toContain('Acceptance Matrix');
    expect(qaReviewer).toContain('APIs, schemas, IPC/protocols');
    expect(qaReviewer).toContain('actual launch/open/use-path smoke verification');
    expect(qaReviewer).toContain('reject static-only verification');
    expect(qaFixer).toContain('Do not edit the QA verdict');
    expect(qaFixer).toContain('public APIs/schemas/IPC/config/data/error contracts');
    expect(qaFixer).toContain('rerun the exact launch/open/use-path smoke check');
    expect(mmoReviewer).toContain('MMO Domain Matrix');
    expect(mmoReviewer).toContain('server authority');
    expect(mmoReviewer).toContain('sync/protocol');
    expect(mmoReviewer).toContain('liveops/release');
    expect(mmoReviewer).toContain('reject static-only verification');
  });

  it('keeps Standard planner agent kickoff focused on tasks.md by default', () => {
    const message = buildAutocodeAgentKickoffMessage({
      agentType: 'planner',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
    });

    expect(message).toContain('Create or repair E:/Work/App/.autocode/specs/001-task/tasks.md as the primary output');
    expect(message).toContain('required by RequestChanges');
    expect(message).toContain('Do not write E:/Work/App/.autocode/specs/001-task/implementation_plan.md');
    expect(message).not.toContain('First update E:/Work/App/.autocode/specs/001-task/spec.md');
    expect(message).not.toContain('Update E:/Work/App/.autocode/specs/001-task/spec.md with Proposal/Goal');
  });
  it('keeps Request Changes replanning on Standard artifacts instead of runtime plan edits', () => {
    const message = buildAutocodeAgentKickoffMessage({
      agentType: 'planner',
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
      forcePlanning: true,
    });

    expect(message).toContain('STANDARD ITERATION PLANNING');
    expect(message).toContain('Do not edit E:/Work/App/.autocode/specs/001-task/implementation_plan.md directly');
    expect(message).toContain('Autocode Standard iteration flow incrementally');
    expect(message).toContain('Do not regenerate the entire task plan');
    expect(message).toContain('editing affected checklist items in place');
    expect(message).toContain('keep one canonical checklist item');
    expect(message).toContain('Do not append a second task');
    expect(message).toContain('cannot start, open, run, or play');
    expect(message).not.toContain('preserve completed work that remains valid');
  });

  it('compacts oversized task descriptions in agentic orchestrator kickoff', () => {
    const longTaskDescription = [
      'First business rule: keep app-owned structured outputs as JSON.',
      ...Array.from(
        { length: 260 },
        (_, index) => `Large middle detail ${index}: ${'duplicated diagnostic text '.repeat(5)}`,
      ),
      'Final business rule: convert only model-readable prose references to Markdown.',
    ].join('\n');

    const message = buildAutocodeAgenticSpecOrchestratorKickoffMessage({
      taskDescription: longTaskDescription,
      specDir: 'E:/Work/App/.autocode/specs/001-task',
      projectDir: 'E:/Work/App',
    });

    expect(message).toContain('First business rule: keep app-owned structured outputs as JSON.');
    expect(message).toContain('task description middle omitted for prompt budget');
    expect(message).toContain('Final business rule: convert only model-readable prose references to Markdown.');
    expect(message).not.toContain('Large middle detail 160');
    expect(message.length).toBeLessThan(AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS + 800);
  });
});
