import { describe, expect, it } from 'vitest';

import {
  getAutocodeCliContinuationStrategy,
  getAutocodeCliJsonEventParsers,
  getAutocodeCliRuntimeRoutes,
  resolveAutocodeCliRuntimeRoute,
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

  it('resolves CLI runtime routes from catalog configuration', () => {
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'openai.responses',
      authSource: 'codex-oauth',
      modelId: 'gpt-test',
    })).toMatchObject({
      id: 'openai-codex-oauth',
      cli: 'codex',
    });
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'openai',
      authSource: 'profile-api-key',
      modelId: 'gpt-test',
    })).toBeNull();
    expect(getAutocodeCliRuntimeRoutes()[0].condition.provider).toEqual([
      'openai',
      'openai.responses',
      'openai-responses',
    ]);
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