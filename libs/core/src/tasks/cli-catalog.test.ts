import { describe, expect, it } from 'vitest';

import {
  getAutocodeCliContinuationStrategy,
  getAutocodeCliJsonEventParsers,
  getAutocodeCliRuntimeRoutes,
  parseAutocodeCliRuntimeRoutes,
  resolveAutocodeCliRuntimeRoute,
  resolveAutocodeCliRuntimeStartOptions,
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


  it('resolves custom task-run invocation from route configuration', () => {
    expect(resolveAutocodeCliTaskRunInvocation({
      cli: 'custom',
      customCommand: 'future-code --profile team',
      model: 'future-large',
      bypassPermissions: true,
      permissionBypassArgs: ['--future-allow'],
      taskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
    })).toEqual({
      command: 'future-code',
      args: ['--profile', 'team', 'run', '--json', '--model', 'future-large', '--future-allow', '--stdin'],
    });
  });

  it('resolves configured CLI identifiers without source-code registration', () => {
    expect(resolveAutocodeCliTaskRunInvocation({
      cli: 'future-code',
      model: 'future-large',
      bypassPermissions: true,
      permissionBypassArgs: ['--future-allow'],
      taskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
    })).toEqual({
      command: 'future-code',
      args: ['run', '--json', '--model', 'future-large', '--future-allow', '--stdin'],
    });

    const routes = parseAutocodeCliRuntimeRoutes([{
      id: 'future-code-route',
      displayName: 'Future Code',
      cli: 'future-code',
      condition: {
        provider: 'future-ai',
        modelIdPrefix: 'future-',
      },
    }]);

    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai',
      modelId: 'future-large',
      routes,
    })).toMatchObject({
      id: 'future-code-route',
      cli: 'future-code',
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
        cli: 'bad cli',
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

  it('builds Direct CLI runtime start options from route configuration', () => {
    const routes = parseAutocodeCliRuntimeRoutes({
      id: 'future-direct-cli',
      displayName: 'Future Direct CLI',
      cli: 'future-code',
      customCommand: 'future-code --provider {provider} --model ${modelId} --auth {authSource}',
      permissionBypassArgs: ['--future-allow'],
      taskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '-',
      },
      jsonEventParser: {
        type: 'future-json',
        displayName: 'Future JSON',
        commandNames: ['future-code'],
      },
      continuationStrategy: {
        type: 'append-continuation-flag',
        displayName: 'Future Direct CLI',
        commandNames: ['future-code'],
        continuationFlag: '--continue',
      },
      preflightActions: [{
        type: 'strip-utf8-bom-from-rules',
        displayName: 'Future rules',
        commandNames: ['future-code'],
      }],
      condition: {
        provider: 'future-ai',
        modelIdPrefix: 'future-',
      },
    });

    expect(resolveAutocodeCliRuntimeStartOptions({
      cli: 'claude-code',
      customCommand: 'ignored-fallback',
      provider: 'future-ai',
      modelId: 'future-large',
      authSource: 'team-oauth',
      routes,
    })).toMatchObject({
      cli: 'future-code',
      customCommand: 'future-code --provider future-ai --model future-large --auth team-oauth',
      directCliRuntimeRouteId: 'future-direct-cli',
      directCliRuntimeRouteDisplayName: 'Future Direct CLI',
      directCliPermissionBypassArgs: ['--future-allow'],
      directCliTaskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '-',
      },
      directCliJsonEventParser: {
        type: 'future-json',
      },
      directCliContinuationStrategy: {
        type: 'append-continuation-flag',
        continuationFlag: '--continue',
      },
      directCliPreflightActions: [{
        type: 'strip-utf8-bom-from-rules',
        displayName: 'Future rules',
        commandNames: ['future-code'],
      }],
      route: {
        id: 'future-direct-cli',
      },
    });
  });

  it('keeps explicit CLI options when no runtime route matches', () => {
    expect(resolveAutocodeCliRuntimeStartOptions({
      cli: 'custom',
      customCommand: 'custom-ai run',
      provider: 'future-ai',
      modelId: 'future-large',
      routes: [],
    })).toEqual({
      cli: 'custom',
      customCommand: 'custom-ai run',
      route: null,
    });
  });
  it('rejects CLI runtime routes without explicit match conditions', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'empty-condition-route',
        displayName: 'Empty Condition Route',
        cli: 'future-code',
        condition: {},
      },
      {
        id: 'invalid-condition-route',
        displayName: 'Invalid Condition Route',
        cli: 'future-code',
        condition: { provider_prefix: '' },
      },
    ]);

    expect(routes).toEqual([]);
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'openai',
      modelId: 'gpt-test',
      routes,
      includeBuiltinRoutes: false,
    })).toBeNull();
  });
  it('accepts a single CLI runtime route object from external configuration', () => {
    const routes = parseAutocodeCliRuntimeRoutes({
      id: 'future-single-route',
      displayName: 'Future Single Route',
      cli: 'future-code',
      condition: {
        provider_prefix: 'future-',
        model_id_prefix: 'future-code-',
      },
    });

    expect(routes).toEqual([
      {
        id: 'future-single-route',
        displayName: 'Future Single Route',
        cli: 'future-code',
        condition: {
          providerPrefix: 'future-',
          modelIdPrefix: 'future-code-',
        },
      },
    ]);
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai',
      modelId: 'future-code-large',
      routes,
    })).toMatchObject({
      id: 'future-single-route',
      cli: 'future-code',
    });
  });
  it('parses extensible CLI runtime route conditions from external configuration', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'future-family-cli',
        displayName: 'Future Family CLI',
        cli: 'future-code',
        condition: {
          provider_prefix: 'future-',
          auth_source_includes: 'oauth',
          model_id_includes: ['-code-'],
        },
      },
      {
        id: 'compatible-provider-cli',
        displayName: 'Compatible Provider CLI',
        cli: 'compatible-code',
        condition: {
          providerIncludes: '.compatible',
          authSourcePrefix: 'team-',
          modelIdPrefix: 'compatible-',
        },
      },
    ]);

    expect(routes[0].condition).toEqual({
      providerPrefix: 'future-',
      authSourceIncludes: 'oauth',
      modelIdIncludes: ['-code-'],
    });
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai.enterprise',
      authSource: 'team-oauth-token',
      modelId: 'future-code-large',
      routes,
    })).toMatchObject({
      id: 'future-family-cli',
      cli: 'future-code',
    });
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'openai.compatible',
      authSource: 'team-api-key',
      modelId: 'compatible-fast',
      routes,
    })).toMatchObject({
      id: 'compatible-provider-cli',
      cli: 'compatible-code',
    });
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai.enterprise',
      authSource: 'team-api-key',
      modelId: 'future-chat-large',
      routes,
    })).toBeNull();
  });
  it('parses custom-command CLI runtime routes for future providers', () => {
    const routes = parseAutocodeCliRuntimeRoutes([
      {
        id: 'future-custom-cli',
        displayName: 'Future Custom CLI',
        cli: 'custom',
        customCommand: 'future-code --model {modelId} run',
        permissionBypassArgs: ['--future-allow'],
        taskRunStrategy: {
          args: ['run', '--json'],
          modelFlag: '--model',
          promptStdinArg: '--stdin',
        },
        jsonEventParser: {
          type: 'future-json',
          displayName: 'Future JSON',
          commandNames: ['future-code'],
          sessionIdFields: ['conversation_id'],
          messageFields: ['message'],
          eventTypeFields: ['kind'],
          completionEventTypes: ['done'],
        },
        continuationStrategy: {
          displayName: 'Future Custom CLI',
          type: 'append-continuation-flag',
          commandNames: ['future-code'],
          jsonEventParser: 'future-json',
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
        permissionBypassArgs: ['--future-allow'],
        taskRunStrategy: {
          args: ['run', '--json'],
          modelFlag: '--model',
          promptStdinArg: '--stdin',
        },
        jsonEventParser: {
          type: 'future-json',
          displayName: 'Future JSON',
          commandNames: ['future-code'],
          sessionIdFields: ['conversation_id'],
          messageFields: ['message'],
          eventTypeFields: ['kind'],
          completionEventTypes: ['done'],
        },
        continuationStrategy: {
          displayName: 'Future Custom CLI',
          type: 'append-continuation-flag',
          commandNames: ['future-code'],
          jsonEventParser: 'future-json',
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
      permissionBypassArgs: ['--future-allow'],
      taskRunStrategy: {
        args: ['run', '--json'],
        modelFlag: '--model',
        promptStdinArg: '--stdin',
      },
      jsonEventParser: {
        type: 'future-json',
        displayName: 'Future JSON',
        commandNames: ['future-code'],
        sessionIdFields: ['conversation_id'],
        messageFields: ['message'],
        eventTypeFields: ['kind'],
        completionEventTypes: ['done'],
      },
      continuationStrategy: {
        displayName: 'Future Custom CLI',
        type: 'append-continuation-flag',
        commandNames: ['future-code'],
        jsonEventParser: 'future-json',
        continuationFlag: '--continue',
        sessionIdSource: 'latest',
      },
    });
  });
  it('parses configurable JSON tool event fields for future Direct CLIs', () => {
    const routes = parseAutocodeCliRuntimeRoutes({
      id: 'future-tool-cli',
      displayName: 'Future Tool CLI',
      cli: 'future-code',
      condition: {
        provider: 'future-ai',
      },
      json_event_parser: {
        type: 'future-json',
        display_name: 'Future JSON',
        command_names: ['future-code'],
        event_type_fields: ['kind'],
        tool_start_event_types: ['tool_start'],
        tool_end_event_types: ['tool_finish'],
        tool_name_fields: ['tool'],
        tool_input_fields: ['input'],
        tool_output_fields: ['result'],
        tool_call_id_fields: ['call'],
        tool_success_fields: ['ok'],
        ignored_event_type_includes: ['heartbeat'],
      },
    });

    expect(routes[0].jsonEventParser).toMatchObject({
      type: 'future-json',
      displayName: 'Future JSON',
      commandNames: ['future-code'],
      eventTypeFields: ['kind'],
      toolStartEventTypes: ['tool_start'],
      toolEndEventTypes: ['tool_finish'],
      toolNameFields: ['tool'],
      toolInputFields: ['input'],
      toolOutputFields: ['result'],
      toolCallIdFields: ['call'],
      toolSuccessFields: ['ok'],
      ignoredEventTypeIncludes: ['heartbeat'],
    });
  });
  it('parses argument-template continuation strategies for future Direct CLIs', () => {
    const routes = parseAutocodeCliRuntimeRoutes({
      id: 'future-template-cli',
      displayName: 'Future Template CLI',
      cli: 'future-code',
      condition: {
        provider_prefix: 'future-',
        model_id_prefix: 'future-',
      },
      continuation_strategy: {
        display_name: 'Future Template CLI',
        type: 'argument-template',
        command_names: ['future-code'],
        session_id_source: 'json-event-session',
        args_template: ['resume', '--session', '{sessionId}', '--model', '{modelId}', '{promptStdinArg}'],
        prompt_stdin_arg: '-',
      },
    });

    expect(routes).toHaveLength(1);
    expect(routes[0].continuationStrategy).toEqual({
      displayName: 'Future Template CLI',
      type: 'argument-template',
      commandNames: ['future-code'],
      sessionIdSource: 'json-event-session',
      argsTemplate: ['resume', '--session', '{sessionId}', '--model', '{modelId}', '{promptStdinArg}'],
      promptStdinArg: '-',
    });
    expect(resolveAutocodeCliRuntimeRoute({
      provider: 'future-ai',
      modelId: 'future-large',
      routes,
    })).toMatchObject({
      id: 'future-template-cli',
      cli: 'future-code',
      continuationStrategy: {
        type: 'argument-template',
        argsTemplate: ['resume', '--session', '{sessionId}', '--model', '{modelId}', '{promptStdinArg}'],
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
    expect(getAutocodeCliContinuationStrategy('deepseek')).toMatchObject({
      type: 'argument-template',
      argsTemplate: ['{args}'],
      sessionIdSource: 'latest',
    });
    expect(getAutocodeCliJsonEventParsers()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'codex-json',
        displayName: 'Codex',
        commandNames: ['codex'],
        requiredArgs: ['--json'],
        toolEndEventTypes: expect.arrayContaining(['command_execution']),
      }),
    ]));
  });
});