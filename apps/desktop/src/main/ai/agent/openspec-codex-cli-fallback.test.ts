import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  SessionError,
  SessionResult,
  StreamEvent,
} from '../session/types';
import { resolveOpenSpecCodexCliFallbackRegistration } from './openspec-codex-cli-capability';
import {
  buildOpenSpecCodexCliSpawnPlan,
  runOpenSpecCodexCliFallback,
} from './openspec-codex-cli-fallback';

const INITIAL_API_ERROR: SessionError = {
  code: 'temporarily_unavailable',
  message: 'Provider temporarily unavailable: server_is_overloaded',
  retryable: true,
};

describe('OpenSpec Codex CLI fallback', () => {
  let tempDirectory: string;
  let projectDirectory: string;
  let trustedRuntimeDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'autocode-openspec-cli-test-'));
    projectDirectory = join(
      tempDirectory,
      'project.with.dot',
      '.autocode',
      'worktree',
    );
    trustedRuntimeDirectory = dirname(process.execPath);
    mkdirSync(projectDirectory, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('passes prompts outside argv and maps Codex JSONL text, tools, usage, and completion', async () => {
    const capturePath = join(tempDirectory, 'capture.json');
    const fakeCliPath = writeFakeCli(tempDirectory, 'successful-cli.cjs', [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const argv = process.argv.slice(2);",
      "  const configValues = argv.flatMap((value, index) => value === '-c' ? [argv[index + 1]] : []);",
      "  const instructionsConfig = configValues.find(value => value && value.startsWith('model_instructions_file='));",
      "  const instructionsPath = JSON.parse(instructionsConfig.slice('model_instructions_file='.length));",
      "  writeFileSync(process.env.AUTOCODE_TEST_CAPTURE_PATH, JSON.stringify({",
      "    argv,",
      "    stdin,",
      "    instructionsPath,",
      "    instructions: readFileSync(instructionsPath, 'utf8'),",
      "  }));",
      "  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');",
      "  emit({ type: 'thread.started', thread_id: 'thread-test-123' });",
      "  emit({",
      "    type: 'item.started',",
      "    item: {",
      "      id: 'tool-1',",
      "      type: 'command_execution',",
      "      command: 'openspec status --json',",
      "      status: 'in_progress',",
      "    },",
      "  });",
      "  emit({",
      "    type: 'item.completed',",
      "    item: {",
      "      id: 'tool-1',",
      "      type: 'command_execution',",
      "      command: 'openspec status --json',",
      "      aggregated_output: '{\"ready\":true}',",
      "      exit_code: 0,",
      "      status: 'completed',",
      "    },",
      "  });",
      "  emit({",
      "    type: 'item.completed',",
      "    item: {",
      "      id: 'message-1',",
      "      type: 'agent_message',",
      "      text: 'Applied OpenSpec change.',",
      "    },",
      "  });",
      "  emit({",
      "    type: 'turn.completed',",
      "    usage: {",
      "      input_tokens: 21,",
      "      cached_input_tokens: 7,",
      "      output_tokens: 9,",
      "      total_tokens: 30,",
      "    },",
      "  });",
      "});",
    ]);
    const events: StreamEvent[] = [];
    const systemPrompt = 'SYSTEM_INSTRUCTIONS_SENTINEL: follow OpenSpec exactly.';
    const userMessage = [
      'USER_PROMPT_SENTINEL: implement change-a.',
      '',
      '## OPENSPEC AUTOMATIC DECISION REQUIREMENT',
      'When a choice or clarification is required, do not pause or wait for human input.',
      'Preserve option labels exactly, record necessary assumptions, and continue.',
    ].join('\r\n');
    const registration = resolveOpenSpecCodexCliFallbackRegistration({
      agentType: 'openspec',
      provider: 'openai',
      initialMessages: [{ role: 'user', content: userMessage }],
      action: 'explore',
      readOnly: true,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
    });
    expect(registration).not.toBeNull();
    if (!registration) {
      throw new Error('Expected the OpenSpec CLI fallback to register.');
    }

    const result = await runOpenSpecCodexCliFallback({
      action: registration.action,
      systemPrompt,
      userMessage: registration.userMessage,
      cwd: projectDirectory,
      allowedPathRoots: registration.allowedPathRoots,
      trustedRuntimeReadPaths: registration.trustedRuntimeReadPaths,
      allowedWritePaths: registration.allowedWritePaths,
      modelId: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      readOnly: registration.readOnly,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      commandEnv: {
        AUTOCODE_TEST_CAPTURE_PATH: capturePath,
      },
      tempRoot: tempDirectory,
      onEvent: (event) => events.push(event),
    });

    expectSessionResult(result);
    expect(result).toMatchObject({
      outcome: 'completed',
      stepsExecuted: 1,
      messages: [{
        role: 'assistant',
        content: 'Applied OpenSpec change.\n',
      }],
      toolCallCount: 1,
      usage: {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
        cacheReadTokens: 7,
        stepsExecuted: 1,
        sessionId: 'thread-test-123',
      },
    });

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      argv: string[];
      stdin: string;
      instructionsPath: string;
      instructions: string;
    };
    expect(capture.stdin).toBe(userMessage);
    expect(capture.stdin).toBe(registration.userMessage);
    expect(capture.stdin).toContain('## OPENSPEC AUTOMATIC DECISION REQUIREMENT');
    expect(capture.stdin).toContain('do not pause or wait for human input');
    expect(capture.instructions).toBe(systemPrompt);
    expect(existsSync(capture.instructionsPath)).toBe(false);
    expect(capture.argv).toEqual(expect.arrayContaining([
      'exec',
      '--json',
      '-m',
      'gpt-5.6-sol',
      '--ephemeral',
      '--ignore-user-config',
      '--strict-config',
      '--skip-git-repo-check',
      '-C',
      projectDirectory,
      'approval_policy="never"',
      'project_doc_max_bytes=0',
      'shell_environment_policy.inherit="core"',
      '-',
    ]));
    expect(capture.argv).not.toContain('--sandbox');
    expect(capture.argv).not.toContain('--ignore-rules');
    expect(capture.argv).toContain(
      'default_permissions="autocode-openspec"',
    );
    expect(capture.argv).not.toContain(
      'permissions.autocode-openspec.extends=":read-only"',
    );
    expect(capture.argv).toContain(
      'permissions.autocode-openspec.network.enabled=false',
    );
    const filesystemOverride = capture.argv.find((arg) =>
      arg.startsWith('permissions.autocode-openspec.filesystem={'));
    expect(filesystemOverride).toBeDefined();
    expect(filesystemOverride).toContain(
      `${JSON.stringify(':minimal')}="read"`,
    );
    expect(filesystemOverride).toContain(
      `${JSON.stringify(projectDirectory)}="read"`,
    );
    expect(filesystemOverride).not.toContain('="write"');
    expect(filesystemOverride).toContain(
      `${JSON.stringify(trustedRuntimeDirectory)}="read"`,
    );
    expect(filesystemOverride).toContain(
      `${JSON.stringify(capture.instructionsPath)}="read"`,
    );
    for (const protectedName of ['.git', '.codex', '.agents']) {
      expect(filesystemOverride).toContain(
        `${JSON.stringify(join(projectDirectory, protectedName))}="read"`,
      );
    }
    expect(capture.argv.some((arg) =>
      arg.startsWith('permissions.autocode-openspec.filesystem.'))).toBe(false);
    const projectsOverride = capture.argv.find((arg) =>
      arg.startsWith('projects={'));
    expect(projectsOverride).toContain(
      `${JSON.stringify(projectDirectory)}={trust_level="untrusted"}`,
    );
    expect(capture.argv.some((arg) => arg.startsWith('projects.'))).toBe(false);
    expect(capture.argv).toContain('web_search="disabled"');
    expect(capture.argv).toContain('allow_login_shell=false');
    expect(capture.argv).toContain(
      'shell_environment_policy.ignore_default_excludes=false',
    );
    expect(capture.argv).toContain(
      'shell_environment_policy.set.OPENSPEC_TELEMETRY="0"',
    );
    expect(capture.argv.at(-1)).toBe('-');
    const serializedArgv = JSON.stringify(capture.argv);
    expect(serializedArgv).not.toContain('SYSTEM_INSTRUCTIONS_SENTINEL');
    expect(serializedArgv).not.toContain('USER_PROMPT_SENTINEL');

    expect(events).toContainEqual({
      type: 'text-delta',
      text: '[Provider] API request failed. Switching to Codex CLI fallback (gpt-5.6-sol).\n',
    });
    expect(events).toContainEqual({
      type: 'tool-call',
      toolName: 'Bash',
      toolCallId: 'tool-1',
      args: { command: 'openspec status --json' },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      toolName: 'Bash',
      toolCallId: 'tool-1',
      result: '{"ready":true}',
      isError: false,
    }));
    expect(events).toContainEqual({
      type: 'text-delta',
      text: 'Applied OpenSpec change.\n',
    });
    expect(events).toContainEqual({
      type: 'usage-update',
      usage: {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
        cacheReadTokens: 7,
        sessionId: 'thread-test-123',
      },
    });
    expect(events).toContainEqual({
      type: 'step-finish',
      stepNumber: 1,
      usage: {
        promptTokens: 21,
        completionTokens: 9,
        totalTokens: 30,
        cacheReadTokens: 7,
        sessionId: 'thread-test-123',
      },
    });
  });

  it('runs a preselected Apply fallback with only the authorized write root', async () => {
    const capturePath = join(tempDirectory, 'apply-capture.json');
    const fakeCliPath = writeFakeCli(tempDirectory, 'apply-cli.cjs', [
      "const { writeFileSync } = require('node:fs');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  writeFileSync(process.env.AUTOCODE_TEST_CAPTURE_PATH, JSON.stringify({",
      "    argv: process.argv.slice(2),",
      "    stdin,",
      "  }));",
      "  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');",
      "  emit({ type: 'thread.started', thread_id: 'thread-apply-123' });",
      "  emit({",
      "    type: 'item.completed',",
      "    item: { type: 'agent_message', text: 'Apply completed.' },",
      "  });",
      "  emit({",
      "    type: 'turn.completed',",
      "    usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },",
      "  });",
      "});",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'apply',
      systemPrompt: 'Official OpenSpec Apply prompt',
      userMessage: 'change-a',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [projectDirectory],
      modelId: 'gpt-5.6-sol',
      readOnly: false,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      commandEnv: {
        AUTOCODE_TEST_CAPTURE_PATH: capturePath,
      },
      tempRoot: tempDirectory,
    });

    expectSessionResult(result);
    expect(result).toMatchObject({
      outcome: 'completed',
      messages: [{ role: 'assistant', content: 'Apply completed.\n' }],
    });
    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      argv: string[];
      stdin: string;
    };
    expect(capture.stdin).toBe('change-a');
    const filesystemOverride = capture.argv.find((arg) =>
      arg.startsWith('permissions.autocode-openspec.filesystem={'));
    expect(filesystemOverride).toContain(
      `${JSON.stringify(projectDirectory)}="write"`,
    );
    for (const protectedName of ['.git', '.codex', '.agents']) {
      expect(filesystemOverride).toContain(
        `${JSON.stringify(join(projectDirectory, protectedName))}="read"`,
      );
    }
  });

  it('keeps each agent message separate so the final message remains authoritative', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'multiple-messages-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');",
      "  emit({",
      "    type: 'item.completed',",
      "    item: {",
      "      id: 'message-early',",
      "      type: 'agent_message',",
      "      text: 'Please run `/opsx:continue` to proceed.',",
      "    },",
      "  });",
      "  emit({",
      "    type: 'item.completed',",
      "    item: {",
      "      id: 'message-final',",
      "      type: 'agent_message',",
      "      text: 'All artifacts are complete; no further action is required.',",
      "    },",
      "  });",
      "  emit({ type: 'turn.completed' });",
      "});",
    ]);
    const events: StreamEvent[] = [];

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'Official OpenSpec Explore prompt',
      userMessage: 'Inspect the current change.',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      onEvent: (event) => events.push(event),
    });

    expectSessionResult(result);
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: 'Please run `/opsx:continue` to proceed.\n',
      },
      {
        role: 'assistant',
        content: 'All artifacts are complete; no further action is required.\n',
      },
    ]);
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'All artifacts are complete; no further action is required.\n',
    });
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      {
        type: 'text-delta',
        text: '[Provider] API request failed. Switching to Codex CLI fallback.\n',
      },
      {
        type: 'text-delta',
        text: 'Please run `/opsx:continue` to proceed.\n',
      },
      {
        type: 'text-delta',
        text: 'All artifacts are complete; no further action is required.\n',
      },
    ]);
  });

  it('classifies CLI provider failures and redacts secrets from diagnostics', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'failing-cli.cjs', [
      "const bearer = 'Bearer cli-secret-token-123456789';",
      "const apiKey = 'sk-cliSecretToken123456789';",
      "const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlci0xMjM0NTY3ODkwIn0.signature1234567890';",
      "const promptLeak = 'OPEN_SPEC_PROMPT_MUST_NOT_BE_LOGGED';",
      "const shortPromptLeak = 'go!';",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stderr.write('request failed with ' + bearer + ' ' + apiKey + ' ' + jwt + ' ' + promptLeak + ' ' + shortPromptLeak + '\\n');",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'error',",
      "    error: {",
      "      type: 'service_unavailable_error',",
      "      code: 'server_is_overloaded',",
      "      message: 'Provider overloaded; ' + bearer + '; ' + apiKey + '; ' + jwt + '; ' + promptLeak + '; ' + shortPromptLeak,",
      "    },",
      "  }) + '\\n');",
      "  process.exitCode = 1;",
      "});",
    ]);
    const events: StreamEvent[] = [];

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OPEN_SPEC_PROMPT_MUST_NOT_BE_LOGGED',
      userMessage: 'go!',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: {
        ...INITIAL_API_ERROR,
        message:
          'API echoed OPEN_SPEC_PROMPT_MUST_NOT_BE_LOGGED and go! ' +
          'Bearer api-previous-secret-123456789',
      },
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      onEvent: (event) => events.push(event),
    });

    expectSessionResult(result);
    expect(result).toMatchObject({
      outcome: 'error',
      error: {
        code: 'temporarily_unavailable',
        retryable: true,
      },
    });
    expect(result.error?.message).toContain('Codex CLI fallback failed');
    expect(result.error?.message).toContain('Initial API failure');

    const diagnostics = JSON.stringify({ result, events });
    expect(diagnostics).toContain('[REDACTED]');
    expect(diagnostics).toContain('[JWT REDACTED]');
    expect(diagnostics).toContain('[PROMPT REDACTED]');
    expect(diagnostics).not.toContain('cli-secret-token-123456789');
    expect(diagnostics).not.toContain('sk-cliSecretToken123456789');
    expect(diagnostics).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(diagnostics).not.toContain('api-previous-secret-123456789');
    expect(diagnostics).not.toContain('OPEN_SPEC_PROMPT_MUST_NOT_BE_LOGGED');
    expect(diagnostics).not.toContain('go!');
  });

  it('returns a clear fallback failure when the temporary prompt directory cannot be created', async () => {
    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'Official OpenSpec Explore prompt',
      userMessage: 'Inspect the current change.',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      tempRoot: join(tempDirectory, 'missing-parent'),
    });

    expectSessionResult(result);
    expect(result).toMatchObject({
      outcome: 'error',
      error: {
        code: 'generic_error',
        retryable: false,
      },
    });
    expect(result.error?.message).toContain('Codex CLI fallback failed');
    expect(result.error?.message).toContain('Initial API failure');
  });

  it('fails closed when Codex exits without a terminal completion event', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'incomplete-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'item.completed',",
      "    item: {",
      "      id: 'message-without-turn',",
      "      type: 'agent_message',",
      "      text: 'This output is not a completed turn.',",
      "    },",
      "  }) + '\\n');",
      "});",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Apply the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(
      'Codex CLI exited without a terminal completion event',
    );
    expect(result.messages).toEqual([{
      role: 'assistant',
      content: 'This output is not a completed turn.\n',
    }]);
  });

  it('does not treat a low-level response.completed event as terminal', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'response-completed-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'response.completed',",
      "    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },",
      "  }) + '\\n');",
      "});",
    ]);
    const events: StreamEvent[] = [];

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      onEvent: (event) => events.push(event),
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.stepsExecuted).toBe(0);
    expect(result.error?.message).toContain(
      'Codex CLI exited without a terminal completion event',
    );
    expect(events.some((event) => event.type === 'step-finish')).toBe(false);
  });

  it.each(['archive', 'future-action'])(
    'returns the original API failure path for blocked Action %s without creating a prompt or process',
    async (action) => {
      const startedPath = join(tempDirectory, `${action}-unexpected-start.txt`);
      const fakeCliPath = writeFakeCli(tempDirectory, `${action}-blocked-cli.cjs`, [
        "require('node:fs').writeFileSync(process.env.AUTOCODE_TEST_STARTED_PATH, 'started');",
      ]);
      const promptDirectoriesBefore = listCodexPromptDirectories(tempDirectory);

      const result = await runOpenSpecCodexCliFallback({
        action: action as never,
        systemPrompt: 'OpenSpec system prompt',
        userMessage: 'Run the blocked Action',
        cwd: projectDirectory,
        allowedPathRoots: [projectDirectory],
        trustedRuntimeReadPaths: [trustedRuntimeDirectory],
        allowedWritePaths: [],
        readOnly: true,
        previousError: INITIAL_API_ERROR,
        command: process.execPath,
        commandArgsPrefix: [fakeCliPath],
        commandEnv: {
          AUTOCODE_TEST_STARTED_PATH: startedPath,
        },
        tempRoot: tempDirectory,
      });

      expect(result).toBeNull();
      expect(existsSync(startedPath)).toBe(false);
      expect(listCodexPromptDirectories(tempDirectory)).toEqual(
        promptDirectoriesBefore,
      );
    },
  );

  it('refuses a working directory outside the allowed read roots before spawning Codex', async () => {
    const startedPath = join(tempDirectory, 'unexpected-start.txt');
    const fakeCliPath = writeFakeCli(tempDirectory, 'must-not-start-cli.cjs', [
      "require('node:fs').writeFileSync(process.env.AUTOCODE_TEST_STARTED_PATH, 'started');",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [join(tempDirectory, 'different-read-root')],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      commandEnv: {
        AUTOCODE_TEST_STARTED_PATH: startedPath,
      },
      tempRoot: tempDirectory,
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(
      'working directory is outside the allowed read roots',
    );
    expect(existsSync(startedPath)).toBe(false);
  });

  it('refuses a forged write-capable Explore fallback before spawning Codex', async () => {
    const startedPath = join(tempDirectory, 'runtime-overlap-start.txt');
    const fakeCliPath = writeFakeCli(tempDirectory, 'runtime-overlap-cli.cjs', [
      "require('node:fs').writeFileSync(process.env.AUTOCODE_TEST_STARTED_PATH, 'started');",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Apply the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [join(projectDirectory, 'openspec')],
      readOnly: false,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      commandEnv: {
        AUTOCODE_TEST_STARTED_PATH: startedPath,
      },
      tempRoot: tempDirectory,
    });

    expect(result).toBeNull();
    expect(existsSync(startedPath)).toBe(false);
  });

  it.each(['stdout', 'stderr'] as const)(
    'terminates before forwarding oversized raw %s output',
    async (streamName) => {
      const fakeCliPath = writeFakeCli(
        tempDirectory,
        `oversized-${streamName}-cli.cjs`,
        [
          "process.stdin.resume();",
          "process.stdin.on('end', () => {",
          `  process.${streamName}.write('X'.repeat(4096));`,
          "  setInterval(() => {}, 1000);",
          "});",
        ],
      );
      const events: StreamEvent[] = [];

      const result = await runOpenSpecCodexCliFallback({
        action: 'explore',
        systemPrompt: 'OpenSpec system prompt',
        userMessage: 'Explore the change',
        cwd: projectDirectory,
        allowedPathRoots: [projectDirectory],
        trustedRuntimeReadPaths: [trustedRuntimeDirectory],
        allowedWritePaths: [],
        readOnly: true,
        previousError: INITIAL_API_ERROR,
        command: process.execPath,
        commandArgsPrefix: [fakeCliPath],
        tempRoot: tempDirectory,
        maxRawOutputBytes: 128,
        terminationExitGraceMs: 250,
        onEvent: (event) => events.push(event),
      });

      expectSessionResult(result);
      expect(result.outcome).toBe('error');
      expect(result.error?.message).toContain(
        'Codex CLI raw output exceeded 128 bytes',
      );
      expect(JSON.stringify(events)).not.toContain('X'.repeat(256));
    },
    10_000,
  );

  it('suppresses an oversized JSONL event before it reaches the UI', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'oversized-line-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'item.completed',",
      "    item: { type: 'agent_message', text: 'L'.repeat(512) },",
      "  }) + '\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
    ]);
    const events: StreamEvent[] = [];

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      maxRawOutputBytes: 4_096,
      maxRawLineBytes: 128,
      terminationExitGraceMs: 250,
      onEvent: (event) => events.push(event),
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(
      'Codex CLI emitted a line exceeding 128 bytes',
    );
    expect(JSON.stringify(events)).not.toContain('L'.repeat(128));
  }, 10_000);

  it('terminates a silent CLI after the inactivity watchdog expires', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'inactive-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => { setInterval(() => {}, 1000); });",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      executionTimeoutMs: 2_000,
      inactivityTimeoutMs: 75,
      terminationExitGraceMs: 250,
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(
      'Codex CLI produced no output for 75ms',
    );
  }, 10_000);

  it('enforces the absolute watchdog even while the CLI is producing output', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'heartbeat-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  setInterval(() => process.stdout.write('heartbeat\\n'), 20);",
      "});",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      executionTimeoutMs: 250,
      // Keep inactivity comfortably above the absolute deadline so heavy
      // parallel Vitest load cannot make this assertion race the two timers.
      inactivityTimeoutMs: 2_000,
      terminationExitGraceMs: 250,
    });

    expectSessionResult(result);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(
      'Codex CLI exceeded the 250ms execution limit',
    );
  }, 10_000);

  it('accepts a non-zero exit caused by the terminal-event completion watchdog', async () => {
    const fakeCliPath = writeFakeCli(tempDirectory, 'completed-hanging-cli.cjs', [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
    ]);

    const result = await runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Explore the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      tempRoot: tempDirectory,
      completionExitGraceMs: 50,
      terminationExitGraceMs: 250,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      stepsExecuted: 1,
    });
  }, 10_000);

  it('builds a shell-free Windows cmd.exe plan for a resolved .cmd shim', () => {
    const shimPath = join(tempDirectory, 'Codex Tools', 'codex.cmd');
    const untrustedWorkspaceShim = join(projectDirectory, 'codex.cmd');
    mkdirSync(dirname(shimPath), { recursive: true });
    writeFileSync(shimPath, '@echo off\r\n', 'utf8');
    writeFileSync(untrustedWorkspaceShim, '@echo untrusted\r\n', 'utf8');
    const comSpec = 'C:\\Windows\\System32\\cmd.exe';

    const plan = buildOpenSpecCodexCliSpawnPlan(
      'codex',
      ['exec', '--json', 'value with spaces', '100%'],
      {
        cwd: projectDirectory,
        env: {
          Path: `${projectDirectory};.;${dirname(shimPath)}`,
          PATHEXT: '.CMD;.EXE',
          ComSpec: comSpec,
        },
        platform: 'win32',
      },
    );

    expect(plan).toEqual({
      command: comSpec,
      args: [
        '/d',
        '/s',
        '/c',
        `""${shimPath}" "exec" "--json" "value with spaces" "100%%""`,
      ],
      options: {
        shell: false,
        windowsVerbatimArguments: true,
      },
    });
    expect(plan.args.join(' ')).not.toContain(untrustedWorkspaceShim);
    expect(() => buildOpenSpecCodexCliSpawnPlan(
      untrustedWorkspaceShim,
      ['exec', '--json', '-'],
      {
        cwd: projectDirectory,
        env: {
          PATHEXT: '.CMD;.EXE',
          ComSpec: comSpec,
        },
        platform: 'win32',
      },
    )).toThrow(/absolute PATH entry/);
    expect(() => buildOpenSpecCodexCliSpawnPlan(
      'codex',
      ['exec', '--json', '-'],
      {
        cwd: projectDirectory,
        env: {
          Path: '.',
          PATHEXT: '.CMD;.EXE',
          ComSpec: comSpec,
        },
        platform: 'win32',
      },
    )).toThrow(
      'Codex CLI executable could not be resolved from an absolute PATH entry',
    );
  });

  it('refuses relative POSIX command and PATH entries before spawning', () => {
    expect(() => buildOpenSpecCodexCliSpawnPlan(
      './codex',
      ['exec', '--json', '-'],
      {
        cwd: '/workspace',
        env: {
          PATH: '.:relative-bin',
        },
        platform: 'linux',
      },
    )).toThrow(
      'Codex CLI executable could not be resolved from an absolute PATH entry',
    );
  });

  it('terminates the CLI process and returns cancelled when aborted', async () => {
    const startedPath = join(tempDirectory, 'started.txt');
    const fakeCliPath = writeFakeCli(tempDirectory, 'hanging-cli.cjs', [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.AUTOCODE_TEST_STARTED_PATH, 'started');",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
    ]);
    const controller = new AbortController();

    const resultPromise = runOpenSpecCodexCliFallback({
      action: 'explore',
      systemPrompt: 'OpenSpec system prompt',
      userMessage: 'Apply the change',
      cwd: projectDirectory,
      allowedPathRoots: [projectDirectory],
      trustedRuntimeReadPaths: [trustedRuntimeDirectory],
      allowedWritePaths: [],
      readOnly: true,
      previousError: INITIAL_API_ERROR,
      command: process.execPath,
      commandArgsPrefix: [fakeCliPath],
      commandEnv: {
        AUTOCODE_TEST_STARTED_PATH: startedPath,
      },
      abortSignal: controller.signal,
      tempRoot: tempDirectory,
    });

    await waitForFile(startedPath);
    controller.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({
      outcome: 'cancelled',
      error: {
        code: 'aborted',
        retryable: false,
      },
      stepsExecuted: 0,
      toolCallCount: 0,
    });
  }, 10_000);
});

function writeFakeCli(
  root: string,
  fileName: string,
  sourceLines: string[],
): string {
  const filePath = join(root, fileName);
  writeFileSync(filePath, sourceLines.join('\n'), 'utf8');
  return filePath;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fake CLI marker: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listCodexPromptDirectories(root: string): string[] {
  return readdirSync(root)
    .filter((entry) => entry.startsWith('autocode-openspec-codex-'))
    .sort();
}

function expectSessionResult(
  result: SessionResult | null,
): asserts result is SessionResult {
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error('Expected the supported Codex CLI fallback to return a session result.');
  }
}
