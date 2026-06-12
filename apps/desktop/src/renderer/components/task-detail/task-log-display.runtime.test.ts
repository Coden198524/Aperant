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

  it('renders internal quick_spec phase names as Standard light planning', () => {
    const displayLogs = buildDisplayRuntimeLogs([
      [
        'Spec phase 2/3: quick_spec',
        'Running spec_writer session (spec phase=quick_spec, session=1)',
        'Standard planning: quick_spec (2/3)',
        'Running simple workflow: quick_spec -> validation',
      ].join(''),
    ]);

    expect(displayLogs.map(log => log.content)).toEqual([
      'Spec phase 2/3: Standard light planning',
      'Running spec_writer session (spec phase=Standard light planning, session=1)',
      'Standard planning: Standard light planning (2/3)',
      'Running simple workflow: Standard light planning -> validation',
    ]);
  });

  it('removes noisy Codex diagnostics from runtime blocks', () => {
    const displayLogs = buildDisplayRuntimeLogs([
      [
        '2026-06-11T03:43:24.644758Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell\n',
        '2026-06-11T03:43:24.729548Z  WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt[0]: prompt must be at most 128 characters path=C:\\Users\\LS\\.codex\\.tmp\\plugins\\plugins\\ngs-analysis\\.codex-plugin/plugin.json\n',
        "2026-06-11T03:43:24.801820Z  WARN codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/\n",
        'Actual runtime output.',
      ].join(''),
    ]);

    expect(displayLogs.map(log => log.content)).toEqual(['Actual runtime output.']);
  });
});
