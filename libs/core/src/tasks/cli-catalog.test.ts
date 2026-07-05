import { describe, expect, it } from 'vitest';

import {
  getAutocodeCliContinuationStrategy,
  getAutocodeCliJsonEventParsers,
  getAutocodeCliRuntimeRoutes,
  parseAutocodeCliRuntimeRoutes,
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

  it('extends CLI runtime routes from external configuration without provider-specific branches', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'deepseek-direct-cli',
        displayName: 'DeepSeek CLI',
        cli: 'deepseek',
        condition: {
          provider: 'deepseek',
          modelIdPrefix: 'deepseek-',
        },
      },
      {
        id: 'bad-cli-route',
        displayName: 'Bad CLI',
        cli: 'not-a-cli',
        condition: { provider: 'bad' },
      },
    ]);

    expect(routes).toEqual([
      {
        id: 'deepseek-direct-cli',
        displayName: 'DeepSeek CLI',
        cli: 'deepseek',
        condition: {
          provider: 'deepseek',
          modelIdPrefix: 'deepseek-',
        },
      },
    ]);
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'deepseek',
      authSource: 'api-key',
      modelId: 'deepseek-v4-flash',
      routes,
    })).toMatchObject({
      id: 'deepseek-direct-cli',
      cli: 'deepseek',
    });
    expect(getAutocodeCliRuntimeRoutes({ routes })[0].id).toBe('deepseek-direct-cli');
  });

  it('parses custom-command CLI runtime routes for future providers', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'future-custom-cli',
        displayName: 'Future Custom CLI',
        cli: 'custom',
        customCommand: 'future-code --model {modelId} run',
        continuationStrategy: {
          displayName: 'Future Custom CLI',
          type: 'append-continuation-flag',
          commandNames: ['future-code'],
          continuationFlag: '--continue',
          sessionIdSource: 'latest',
        },
        condition: {
          provider: 'future-ai',
          modelIdPrefix: 'future-',
        },
      },
      {
        id: 'missing-custom-command',
        displayName: 'Missing Custom Command',
        cli: 'custom',
        condition: { provider: 'future-ai' },
      },
    ]);

    expect(routes).toEqual([
      {
        id: 'future-custom-cli',
        displayName: 'Future Custom CLI',
        cli: 'custom',
        customCommand: 'future-code --model {modelId} run',
        continuationStrategy: {
          displayName: 'Future Custom CLI',
          type: 'append-continuation-flag',
          commandNames: ['future-code'],
          continuationFlag: '--continue',
          sessionIdSource: 'latest',
        },
        condition: {
          provider: 'future-ai',
          modelIdPrefix: 'future-',
        },
      },
    ]);
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai',
      modelId: 'future-large',
      routes,
    })).toMatchObject({
      id: 'future-custom-cli',
      cli: 'custom',
      customCommand: 'future-code --model {modelId} run',
      continuationStrategy: {
        displayName: 'Future Custom CLI',
        type: 'append-continuation-flag',
        commandNames: ['future-code'],
        continuationFlag: '--continue',
        sessionIdSource: 'latest',
      },
    });
  });
  it('lets external CLI runtime routes override built-in routes', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'custom-openai-cli',
        displayName: 'OpenAI Custom CLI',
        cli: 'opencode',
        condition: {
          provider: 'openai',
          authSource: 'codex-oauth',
        },
      },
    ]);

    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'openai',
      authSource: 'codex-oauth',
      modelId: 'gpt-test',
      routes,
    })).toMatchObject({
      id: 'custom-openai-cli',
      cli: 'opencode',
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