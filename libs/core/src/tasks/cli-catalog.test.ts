import { describe, expect, it } from 'vitest';

import {
  getAutocodeCliContinuationStrategy,
  getAutocodeCliJsonEventParsers,
  resolveAutocodeCliTaskRunInvocation,
} from './cli-catalog.js';

describe('Autocode CLI catalog', () => {
  it('resolves Codex task-run invocation from catalog configuration', () => {
    expect(resolveAutocodeCliTaskRunInvocation({
      cli: 'codex',
      model: 'gpt-test',
      bypassPermissions: true,
    })).toEqual({
      command: 'codex',
      args: ['exec', '--json', '-m', 'gpt-test', '--dangerously-bypass-approvals-and-sandbox', '-'],
    });
  });

  it('describes Direct continuation and JSON parsing capabilities outside the runner', () => {
    expect(getAutocodeCliContinuationStrategy('codex')).toMatchObject({
      type: 'exec-resume-session',
      jsonEventParser: 'codex-json',
      execCommand: 'exec',
      resumeArgs: ['exec', 'resume'],
      requiredArgs: ['--json'],
      promptStdinArg: '-',
    });
    expect(getAutocodeCliContinuationStrategy('claude-code')).toMatchObject({
      type: 'append-continuation-flag',
      continuationFlag: '--continue',
    });
    expect(getAutocodeCliJsonEventParsers()).toContainEqual({
      type: 'codex-json',
      displayName: 'Codex',
      commandNames: ['codex'],
      requiredArgs: ['--json'],
    });
  });
});