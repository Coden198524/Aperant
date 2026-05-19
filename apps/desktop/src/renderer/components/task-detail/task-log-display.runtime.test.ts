import { describe, expect, it } from 'vitest';
import { buildDisplayRuntimeLogs } from './task-log-display';

describe('runtime log display', () => {
  it('splits compact direct task output into readable runtime blocks', () => {
    const displayLogs = buildDisplayRuntimeLogs([
      [
        'Worker thread online: worker.js',
        'Starting agent session: type=direct_task, model=gpt-5.5',
        '| Item | Details | | --- | --- | | What changed | Answered the question directly. | | Verification | No file changes required. | | Review notes | No issues noted. |',
        'Session complete: outcome=completed, steps=1, tools=0, duration=7730ms',
      ].join(''),
    ]);

    expect(displayLogs.map(log => log.content)).toEqual([
      'Worker thread online: worker.js',
      'Starting agent session: type=direct_task, model=gpt-5.5',
      [
        '| Item | Details |',
        '| --- | --- |',
        '| What changed | Answered the question directly. |',
        '| Verification | No file changes required. |',
        '| Review notes | No issues noted. |',
      ].join('\n'),
      'Session complete: outcome=completed, steps=1, tools=0, duration=7730ms',
    ]);
  });

  it('splits compact spec orchestrator runtime events into readable blocks', () => {
    const displayLogs = buildDisplayRuntimeLogs([
      [
        'Starting SpecOrchestrator pipeline (complexity-first phase routing)',
        'Generating project index...',
        'Project index generated (1.3KB)',
        'Spec phase 1/1: complexity_assessment',
        'No project instructions found (checked AGENTS.md, CLAUDE.md)',
        'Running mmo_system_designer session (spec phase=complexity_assessment, session=1)',
        'Applied MMO routing hints: engine/rendering, build/tooling',
        'Complexity fallback: standard (AI assessment failed)',
        'Running standard workflow: discovery -> requirements -> research',
      ].join(''),
    ]);

    expect(displayLogs.map(log => log.content)).toEqual([
      'Starting SpecOrchestrator pipeline (complexity-first phase routing)',
      'Generating project index...',
      'Project index generated (1.3KB)',
      'Spec phase 1/1: complexity_assessment',
      'No project instructions found (checked AGENTS.md, CLAUDE.md)',
      'Running mmo_system_designer session (spec phase=complexity_assessment, session=1)',
      'Applied MMO routing hints: engine/rendering, build/tooling',
      'Complexity fallback: standard (AI assessment failed)',
      'Running standard workflow: discovery -> requirements -> research',
    ]);
  });
});
