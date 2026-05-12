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
});
