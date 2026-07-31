import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';

import {
  classifyAutocodeSessionError,
  resolveAutocodeCliTaskRunInvocation,
} from '@autocode/core';

import type { OpenSpecAction } from '../../../shared/types';
import type {
  SessionError,
  SessionEventCallback,
  SessionResult,
  TokenUsage,
} from '../session/types';
import {
  canUseOpenSpecCodexCliFallback,
  hasValidOpenSpecCodexCliAccessMode,
} from './openspec-codex-cli-capability';

const CODEX_CLI_COMPLETION_EXIT_GRACE_MS = 5_000;
const CODEX_CLI_ABORT_EXIT_GRACE_MS = 2_000;
const CODEX_CLI_DIAGNOSTIC_LIMIT = 32_000;
const CODEX_CLI_EXECUTION_TIMEOUT_MS = 60 * 60 * 1_000;
const CODEX_CLI_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const CODEX_CLI_RAW_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CODEX_CLI_RAW_LINE_LIMIT = 1024 * 1024;
const CODEX_CLI_PERMISSION_PROFILE = 'autocode-openspec';

const CODEX_CLI_COMPLETION_EVENTS = new Set([
  'turn_completed',
]);

const CODEX_CLI_FAILURE_EVENTS = new Set([
  'error',
  'turn_failed',
]);

const CODEX_CLI_IGNORED_ITEM_TYPES = new Set([
  'analysis',
  'reasoning',
  'reasoning_message',
]);

const CODEX_CLI_TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'file_change',
  'function_call',
  'mcp_tool_call',
  'tool_call',
  'web_search',
]);

export interface OpenSpecCodexCliFallbackOptions {
  action: OpenSpecAction;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  allowedPathRoots: string[];
  trustedRuntimeReadPaths: string[];
  allowedWritePaths: string[];
  modelId?: string;
  thinkingLevel?: string;
  readOnly: boolean;
  commandEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  onEvent?: SessionEventCallback;
  previousError: SessionError;
  command?: string;
  commandArgsPrefix?: string[];
  tempRoot?: string;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  executionTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  maxRawOutputBytes?: number;
  maxRawLineBytes?: number;
  completionExitGraceMs?: number;
  terminationExitGraceMs?: number;
}

export interface OpenSpecCodexCliSpawnPlan {
  command: string;
  args: string[];
  options: {
    shell: false;
    windowsVerbatimArguments?: boolean;
  };
}

interface CodexCliRunState {
  assistantText: string[];
  completionSeen: boolean;
  diagnostics: string;
  failure?: string;
  sessionId?: string;
  stepsExecuted: number;
  toolCallCount: number;
  toolCalls: Map<string, {
    name: string;
    startedAt: number;
  }>;
  usage: TokenUsage;
}

interface CodexCliProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

interface OpenSpecCodexCliPathPolicy {
  allowedPathRoots: string[];
  trustedRuntimeReadPaths: string[];
  allowedWritePaths: string[];
  cwd: string;
}

type CodexCliStopReason =
  | { kind: 'abort' }
  | { kind: 'completion-timeout' }
  | {
      kind:
        | 'cli-failure'
        | 'execution-timeout'
        | 'inactivity-timeout'
        | 'line-output-limit'
        | 'output-limit';
      message: string;
    };

export async function runOpenSpecCodexCliFallback(
  options: OpenSpecCodexCliFallbackOptions,
): Promise<SessionResult | null> {
  const startedAt = Date.now();
  if (options.abortSignal?.aborted) {
    return buildCancelledResult(startedAt);
  }

  if (!canUseOpenSpecCodexCliFallback(options.action)) {
    return null;
  }
  if (!hasValidOpenSpecCodexCliAccessMode(
    options.action,
    options.readOnly,
    options.allowedWritePaths,
  )) {
    return null;
  }

  let pathPolicy: OpenSpecCodexCliPathPolicy;
  try {
    pathPolicy = normalizeOpenSpecCodexCliPathPolicy(options);
  } catch (error) {
    return buildFallbackFailureResult(
      error instanceof Error ? error.message : String(error),
      options.previousError,
      startedAt,
      createCodexCliRunState(),
      [options.systemPrompt, options.userMessage],
    );
  }

  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(
      join(options.tempRoot ?? tmpdir(), 'autocode-openspec-codex-'),
    );
    const instructionsPath = join(temporaryDirectory, 'model-instructions.md');
    await writeFile(instructionsPath, options.systemPrompt, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await chmod(instructionsPath, 0o600);
    } catch {
      // Windows ACLs provide the effective boundary when POSIX modes are unavailable.
    }

    return await runCodexCliProcess(
      options,
      pathPolicy,
      instructionsPath,
      startedAt,
    );
  } catch (error) {
    return buildFallbackFailureResult(
      error instanceof Error ? error.message : String(error),
      options.previousError,
      startedAt,
      createCodexCliRunState(),
      [options.systemPrompt, options.userMessage],
    );
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runCodexCliProcess(
  options: OpenSpecCodexCliFallbackOptions,
  pathPolicy: OpenSpecCodexCliPathPolicy,
  instructionsPath: string,
  startedAt: number,
): Promise<SessionResult> {
  if (options.abortSignal?.aborted) {
    return buildCancelledResult(startedAt);
  }

  const invocation = resolveAutocodeCliTaskRunInvocation({
    cli: 'codex',
    model: options.modelId,
    thinkingLevel: options.thinkingLevel,
    bypassPermissions: false,
  });
  const args = buildOpenSpecCodexCliArgs({
    baseArgs: invocation.args,
    pathPolicy,
    instructionsPath,
    prefix: options.commandArgsPrefix,
  });
  const processEnv: NodeJS.ProcessEnv = {
    ...(options.processEnv ?? process.env),
    ...options.commandEnv,
  };
  const platform = options.platform ?? process.platform;
  const executionTimeoutMs = resolvePositiveInteger(
    options.executionTimeoutMs,
    CODEX_CLI_EXECUTION_TIMEOUT_MS,
    'Codex CLI execution timeout',
  );
  const inactivityTimeoutMs = resolvePositiveInteger(
    options.inactivityTimeoutMs,
    CODEX_CLI_INACTIVITY_TIMEOUT_MS,
    'Codex CLI inactivity timeout',
  );
  const maxRawOutputBytes = resolvePositiveInteger(
    options.maxRawOutputBytes,
    CODEX_CLI_RAW_OUTPUT_LIMIT,
    'Codex CLI raw output limit',
  );
  const maxRawLineBytes = resolvePositiveInteger(
    options.maxRawLineBytes,
    CODEX_CLI_RAW_LINE_LIMIT,
    'Codex CLI raw line limit',
  );
  const completionExitGraceMs = resolvePositiveInteger(
    options.completionExitGraceMs,
    CODEX_CLI_COMPLETION_EXIT_GRACE_MS,
    'Codex CLI completion exit grace period',
  );
  const terminationExitGraceMs = resolvePositiveInteger(
    options.terminationExitGraceMs,
    CODEX_CLI_ABORT_EXIT_GRACE_MS,
    'Codex CLI termination exit grace period',
  );
  const spawnPlan = buildOpenSpecCodexCliSpawnPlan(
    options.command ?? invocation.command,
    args,
    {
      cwd: pathPolicy.cwd,
      env: processEnv,
      platform,
    },
  );
  const child = spawn(spawnPlan.command, spawnPlan.args, {
    cwd: pathPolicy.cwd,
    env: processEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
    ...spawnPlan.options,
  }) as ChildProcessWithoutNullStreams;
  const state = createCodexCliRunState();
  const sensitiveDiagnosticValues = [
    options.systemPrompt,
    options.userMessage,
  ];
  let stopReason: CodexCliStopReason | undefined;
  let resolveStopRequest: ((reason: CodexCliStopReason) => void) | undefined;
  const stopRequest = new Promise<CodexCliStopReason>((resolveStop) => {
    resolveStopRequest = resolveStop;
  });
  const requestStop = (reason: CodexCliStopReason): void => {
    if (stopReason) return;
    stopReason = reason;
    if ('message' in reason) {
      state.failure = reason.message;
      appendDiagnostic(state, reason.message);
    }
    resolveStopRequest?.(reason);
  };
  let completionExitTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let rawOutputBytes = 0;

  emitEvent(options.onEvent, {
    type: 'text-delta',
    text:
      `[Provider] API request failed. ` +
      `Switching to Codex CLI fallback${options.modelId ? ` (${options.modelId})` : ''}.\n`,
  });

  const resetInactivityTimer = (): void => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (stopReason || state.completionSeen) return;
    inactivityTimer = setTimeout(() => {
      requestStop({
        kind: 'inactivity-timeout',
        message:
          `Codex CLI produced no output for ${inactivityTimeoutMs}ms; ` +
          'the fallback process was terminated.',
      });
    }, inactivityTimeoutMs);
    inactivityTimer.unref?.();
  };
  const handleRawOutput = (byteLength: number): boolean => {
    resetInactivityTimer();
    rawOutputBytes += byteLength;
    if (rawOutputBytes <= maxRawOutputBytes) return true;
    requestStop({
      kind: 'output-limit',
      message:
        `Codex CLI raw output exceeded ${maxRawOutputBytes} bytes; ` +
        'the fallback process was terminated.',
    });
    return false;
  };
  const handleOversizedLine = (): void => {
    requestStop({
      kind: 'line-output-limit',
      message:
        `Codex CLI emitted a line exceeding ${maxRawLineBytes} bytes; ` +
        'the fallback process was terminated before forwarding the line.',
    });
  };
  const stdoutGuard = createCodexCliRawOutputGuard(
    handleRawOutput,
    maxRawLineBytes,
    handleOversizedLine,
  );
  const stderrGuard = createCodexCliRawOutputGuard(
    handleRawOutput,
    maxRawLineBytes,
    handleOversizedLine,
  );
  child.stdout.pipe(stdoutGuard);
  child.stderr.pipe(stderrGuard);

  const stdoutLines = createInterface({
    input: stdoutGuard,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const stderrLines = createInterface({
    input: stderrGuard,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  stdoutLines.on('line', (line) => {
    handleCodexCliStdoutLine(
      line,
      state,
      options.onEvent,
      sensitiveDiagnosticValues,
    );
    if (state.failure) {
      requestStop({
        kind: 'cli-failure',
        message: state.failure,
      });
      return;
    }
    if (state.completionSeen && !completionExitTimer) {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      completionExitTimer = setTimeout(() => {
        requestStop({ kind: 'completion-timeout' });
      }, completionExitGraceMs);
      completionExitTimer.unref?.();
    }
  });
  stderrLines.on('line', (line) => {
    const sanitized = sanitizeCodexCliDiagnostic(
      line,
      sensitiveDiagnosticValues,
    );
    appendDiagnostic(state, sanitized);
    if (sanitized) {
      emitEvent(options.onEvent, {
        type: 'text-delta',
        text: `[Codex CLI] ${sanitized}\n`,
      });
    }
  });

  const exitPromise = waitForCodexCliExit(child);
  const handleAbort = () => {
    requestStop({ kind: 'abort' });
  };
  options.abortSignal?.addEventListener('abort', handleAbort, { once: true });
  if (options.abortSignal?.aborted) {
    handleAbort();
  }
  const executionTimer = setTimeout(() => {
    requestStop({
      kind: 'execution-timeout',
      message:
        `Codex CLI exceeded the ${executionTimeoutMs}ms execution limit; ` +
        'the fallback process was terminated.',
    });
  }, executionTimeoutMs);
  executionTimer.unref?.();
  resetInactivityTimer();

  child.stdin.on('error', (error) => {
    if (stopReason?.kind !== 'abort') {
      appendDiagnostic(
        state,
        sanitizeCodexCliDiagnostic(error.message, sensitiveDiagnosticValues),
      );
    }
  });
  child.stdin.end(options.userMessage, 'utf8');

  const firstOutcome = await Promise.race([
    exitPromise.then((exit) => ({
      kind: 'exit' as const,
      exit,
    })),
    stopRequest.then((reason) => ({
      kind: 'stop' as const,
      reason,
    })),
  ]);
  const terminatedAfterCompletion =
    firstOutcome.kind === 'stop' &&
    firstOutcome.reason.kind === 'completion-timeout';
  const exit = firstOutcome.kind === 'exit'
    ? firstOutcome.exit
    : await terminateCodexCliProcessAndWait(
        child,
        platform,
        exitPromise,
        terminationExitGraceMs,
        options.onEvent,
      );

  options.abortSignal?.removeEventListener('abort', handleAbort);
  if (completionExitTimer) clearTimeout(completionExitTimer);
  clearTimeout(executionTimer);
  if (inactivityTimer) clearTimeout(inactivityTimer);
  stdoutLines.close();
  stderrLines.close();
  child.stdout.unpipe(stdoutGuard);
  child.stderr.unpipe(stderrGuard);
  stdoutGuard.destroy();
  stderrGuard.destroy();

  if (stopReason?.kind === 'abort' || options.abortSignal?.aborted) {
    return buildCancelledResult(startedAt, state);
  }
  if (exit.spawnError) {
    return buildFallbackFailureResult(
      `Codex CLI could not be started: ${exit.spawnError.message}`,
      options.previousError,
      startedAt,
      state,
      sensitiveDiagnosticValues,
    );
  }
  if (state.failure) {
    return buildFallbackFailureResult(
      state.failure,
      options.previousError,
      startedAt,
      state,
      sensitiveDiagnosticValues,
    );
  }
  if (
    exit.code !== 0 &&
    !(state.completionSeen && terminatedAfterCompletion)
  ) {
    const detail = state.diagnostics.trim() || `Codex CLI exited with code ${exit.code ?? 'unknown'}.`;
    return buildFallbackFailureResult(
      detail,
      options.previousError,
      startedAt,
      state,
      sensitiveDiagnosticValues,
    );
  }
  if (!state.completionSeen) {
    return buildFallbackFailureResult(
      'Codex CLI exited without a terminal completion event.',
      options.previousError,
      startedAt,
      state,
      sensitiveDiagnosticValues,
    );
  }

  const stepsExecuted = Math.max(state.stepsExecuted, 1);
  return {
    outcome: 'completed',
    stepsExecuted,
    usage: {
      ...state.usage,
      stepsExecuted,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    },
    messages: buildAssistantMessages(state),
    durationMs: Date.now() - startedAt,
    toolCallCount: state.toolCallCount,
  };
}

function normalizeOpenSpecCodexCliPathPolicy(
  options: Pick<
    OpenSpecCodexCliFallbackOptions,
    | 'allowedPathRoots'
    | 'allowedWritePaths'
    | 'cwd'
    | 'readOnly'
    | 'trustedRuntimeReadPaths'
  >,
): OpenSpecCodexCliPathPolicy {
  const cwd = normalizeAbsolutePath(options.cwd, 'Codex CLI working directory');
  const allowedPathRoots = normalizeAbsolutePaths(
    options.allowedPathRoots,
    'Codex CLI allowed read root',
  );
  const allowedWritePaths = normalizeAbsolutePaths(
    options.allowedWritePaths,
    'Codex CLI allowed write root',
  );
  const trustedRuntimeReadPaths = normalizeAbsolutePaths(
    options.trustedRuntimeReadPaths,
    'Codex CLI trusted runtime read path',
  );

  if (allowedPathRoots.length === 0) {
    throw new Error(
      'Codex CLI fallback was refused because no allowed read roots were provided.',
    );
  }
  if (trustedRuntimeReadPaths.length === 0) {
    throw new Error(
      'Codex CLI fallback was refused because no trusted runtime read paths were provided.',
    );
  }
  if (!allowedPathRoots.some((root) => isPathWithin(cwd, root))) {
    throw new Error(
      'Codex CLI fallback was refused because its working directory is outside the allowed read roots.',
    );
  }
  if (options.readOnly && allowedWritePaths.length > 0) {
    throw new Error(
      'Codex CLI fallback was refused because a read-only Action received write roots.',
    );
  }
  if (!options.readOnly && allowedWritePaths.length === 0) {
    throw new Error(
      'Codex CLI fallback was refused because a mutating Action received no write roots.',
    );
  }

  for (const writePath of allowedWritePaths) {
    if (!allowedPathRoots.some((root) => isPathWithin(writePath, root))) {
      throw new Error(
        `Codex CLI fallback write root is outside the allowed read roots: ${writePath}`,
      );
    }
    for (const readRoot of allowedPathRoots) {
      for (const protectedName of ['.git', '.codex', '.agents']) {
        if (isPathWithin(writePath, join(readRoot, protectedName))) {
          throw new Error(
            `Codex CLI fallback cannot grant write access below protected path "${protectedName}".`,
          );
        }
      }
    }
    if (
      trustedRuntimeReadPaths.some(
        (runtimePath) =>
          isPathWithin(writePath, runtimePath) ||
          isPathWithin(runtimePath, writePath),
      )
    ) {
      throw new Error(
        'Codex CLI fallback cannot overlap a write root with a trusted runtime read path.',
      );
    }
  }

  return {
    allowedPathRoots,
    trustedRuntimeReadPaths,
    allowedWritePaths,
    cwd,
  };
}

function normalizeAbsolutePaths(paths: string[], label: string): string[] {
  const normalizedPaths = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalizeAbsolutePath(path, label);
    const key = process.platform === 'win32'
      ? normalized.toLocaleLowerCase('en-US')
      : normalized;
    normalizedPaths.set(key, normalized);
  }
  return [...normalizedPaths.values()];
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(path);
}

function isPathWithin(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (
      !isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith('../') &&
      !relativePath.startsWith('..\\')
    )
  );
}

function buildOpenSpecCodexCliArgs(input: {
  baseArgs: string[];
  pathPolicy: OpenSpecCodexCliPathPolicy;
  instructionsPath: string;
  prefix?: string[];
}): string[] {
  const promptIndex = input.baseArgs.lastIndexOf('-');
  const insertionIndex = promptIndex >= 0 ? promptIndex : input.baseArgs.length;
  const configOverrides = buildOpenSpecCodexCliConfigOverrides(
    input.pathPolicy,
    input.instructionsPath,
  );
  const isolationArgs = [
    '--ephemeral',
    '--ignore-user-config',
    '--strict-config',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    input.pathPolicy.cwd,
    ...configOverrides.flatMap((override) => ['-c', override]),
  ];
  return [
    ...(input.prefix ?? []),
    ...input.baseArgs.slice(0, insertionIndex),
    ...isolationArgs,
    ...input.baseArgs.slice(insertionIndex),
  ];
}

function buildOpenSpecCodexCliConfigOverrides(
  pathPolicy: OpenSpecCodexCliPathPolicy,
  instructionsPath: string,
): string[] {
  const profileKey = `permissions.${CODEX_CLI_PERMISSION_PROFILE}`;
  const filesystemAccess = new Map<string, 'read' | 'write'>();
  filesystemAccess.set(':minimal', 'read');
  for (const path of pathPolicy.allowedPathRoots) {
    filesystemAccess.set(path, 'read');
  }
  for (const path of pathPolicy.trustedRuntimeReadPaths) {
    filesystemAccess.set(path, 'read');
  }
  filesystemAccess.set(instructionsPath, 'read');
  for (const path of pathPolicy.allowedWritePaths) {
    filesystemAccess.set(path, 'write');
  }
  for (const path of pathPolicy.allowedPathRoots) {
    filesystemAccess.set(join(path, '.git'), 'read');
    filesystemAccess.set(join(path, '.codex'), 'read');
    filesystemAccess.set(join(path, '.agents'), 'read');
  }

  const untrustedRoots = normalizeAbsolutePaths(
    [pathPolicy.cwd, ...pathPolicy.allowedPathRoots],
    'Codex CLI untrusted project root',
  );
  // Codex CLI override parsing and the Windows `codex.cmd` forwarding chain
  // cannot safely round-trip quoted dynamic key segments containing dots.
  // Keep Windows paths on the value side inside complete inline tables so
  // `.autocode`, `.git`, and similar components remain filesystem paths.
  return [
    `default_permissions=${tomlString(CODEX_CLI_PERMISSION_PROFILE)}`,
    `${profileKey}.network.enabled=false`,
    `${profileKey}.filesystem=${tomlInlineStringMap([...filesystemAccess])}`,
    `projects=${tomlInlineUntrustedProjects(untrustedRoots)}`,
    'approval_policy="never"',
    'allow_login_shell=false',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    'shell_environment_policy.inherit="core"',
    'shell_environment_policy.ignore_default_excludes=false',
    'shell_environment_policy.experimental_use_profile=false',
    'shell_environment_policy.set.OPENSPEC_TELEMETRY="0"',
    `model_instructions_file=${tomlString(instructionsPath)}`,
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineStringMap(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return `{${entries
    .map(([key, value]) => `${tomlKey(key)}=${tomlString(value)}`)
    .join(',')}}`;
}

function tomlInlineUntrustedProjects(paths: ReadonlyArray<string>): string {
  return `{${paths
    .map((path) => `${tomlKey(path)}={trust_level="untrusted"}`)
    .join(',')}}`;
}

export function buildOpenSpecCodexCliSpawnPlan(
  commandValue: string,
  args: string[],
  context: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): OpenSpecCodexCliSpawnPlan {
  const platform = context.platform ?? process.platform;
  if (platform !== 'win32') {
    const resolvedCommand = resolvePosixCliCommand(
      commandValue,
      context.cwd,
      context.env,
    );
    if (!resolvedCommand) {
      throw new Error(
        `Codex CLI executable could not be resolved from an absolute PATH entry: ${commandValue}`,
      );
    }
    return {
      command: resolvedCommand,
      args,
      options: { shell: false },
    };
  }

  if (
    (commandValue.includes('\\') || commandValue.includes('/')) &&
    !isAbsolute(commandValue)
  ) {
    throw new Error(
      'Codex CLI fallback refused a relative Windows executable path.',
    );
  }
  const resolvedCommand = resolveWindowsCliCommand(
    commandValue,
    context.cwd,
    context.env,
  );
  if (!resolvedCommand) {
    throw new Error(
      `Codex CLI executable could not be resolved from an absolute PATH entry: ${commandValue}`,
    );
  }
  if (!isWindowsCommandScript(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      options: { shell: false },
    };
  }

  const cmdExe = context.env.ComSpec
    || join(context.env.SystemRoot || context.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
  return {
    command: cmdExe,
    args: ['/d', '/s', '/c', buildWindowsCmdLine(resolvedCommand, args)],
    options: {
      shell: false,
      windowsVerbatimArguments: true,
    },
  };
}

function resolveWindowsCliCommand(
  commandValue: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const command = commandValue.trim();
  if (!command) return '';
  if (command.includes('\\') || command.includes('/')) {
    const candidate = findWindowsExecutableCandidate(
      isAbsolute(command) ? command : resolve(cwd, command),
      env,
    );
    return candidate && !isPathWithin(candidate, cwd) ? candidate : '';
  }

  const pathDirectories = String(env.PATH || env.Path || '')
    .split(';')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  // Do not resolve a bare command from the task workspace. A repository could
  // contain a hostile codex.cmd that would otherwise run outside the Codex
  // sandbox as soon as the automatic fallback starts.
  for (const directory of pathDirectories) {
    if (!isAbsolute(directory)) continue;
    const candidate = findWindowsExecutableCandidate(join(directory, command), env);
    if (candidate && !isPathWithin(candidate, cwd)) return candidate;
  }
  return '';
}

function resolvePosixCliCommand(
  commandValue: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  const command = commandValue.trim();
  if (!command) return '';
  if (command.includes('/')) {
    if (!posix.isAbsolute(command)) return '';
    return isExecutableFile(command) && !isPathWithin(command, cwd)
      ? command
      : '';
  }

  const pathDirectories = String(env.PATH || '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const directory of pathDirectories) {
    // Empty/relative entries (including ".") would let a task repository
    // replace the automatic fallback executable before Codex's sandbox exists.
    if (!posix.isAbsolute(directory)) continue;
    const candidate = posix.join(directory, command);
    if (isExecutableFile(candidate) && !isPathWithin(candidate, cwd)) {
      return candidate;
    }
  }
  return '';
}

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findWindowsExecutableCandidate(
  basePath: string,
  env: NodeJS.ProcessEnv,
): string {
  const extensions = getWindowsPathExtensions(env);
  const lower = basePath.toLowerCase();
  const candidates = extensions.some((extension) => lower.endsWith(extension))
    ? [basePath]
    : [...extensions.map((extension) => `${basePath}${extension}`), basePath];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Continue through PATH candidates.
    }
  }
  return '';
}

function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  return String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.startsWith('.'));
}

function isWindowsCommandScript(commandPath: string): boolean {
  const lower = commandPath.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function buildWindowsCmdLine(commandPath: string, args: string[]): string {
  return `"${[commandPath, ...args].map(quoteWindowsCmdArg).join(' ')}"`;
}

function quoteWindowsCmdArg(value: string): string {
  const text = String(value ?? '');
  if (!text) return '""';

  let escaped = '';
  let backslashes = 0;
  for (const character of text) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      escaped += `${'\\'.repeat((backslashes * 2) + 1)}"`;
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      escaped += '\\'.repeat(backslashes);
      backslashes = 0;
    }
    escaped += character === '%' ? '%%' : character;
  }
  if (backslashes > 0) {
    escaped += '\\'.repeat(backslashes * 2);
  }
  return `"${escaped}"`;
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolvedValue = value ?? fallback;
  if (
    !Number.isSafeInteger(resolvedValue) ||
    resolvedValue <= 0
  ) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return resolvedValue;
}

function createCodexCliRawOutputGuard(
  onChunk: (byteLength: number) => boolean,
  maxLineBytes: number,
  onLineExceeded: () => void,
): Transform {
  let forwarding = true;
  let pendingLineChunks: Buffer[] = [];
  let pendingLineBytes = 0;
  return new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      if (!forwarding) {
        callback();
        return;
      }
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding as BufferEncoding);
      forwarding = onChunk(buffer.length);
      if (!forwarding) {
        pendingLineChunks = [];
        pendingLineBytes = 0;
        callback();
        return;
      }

      let offset = 0;
      while (offset < buffer.length) {
        const newlineIndex = buffer.indexOf(0x0a, offset);
        const segmentEnd = newlineIndex >= 0
          ? newlineIndex + 1
          : buffer.length;
        const segment = buffer.subarray(offset, segmentEnd);
        if (pendingLineBytes + segment.length > maxLineBytes) {
          forwarding = false;
          pendingLineChunks = [];
          pendingLineBytes = 0;
          onLineExceeded();
          callback();
          return;
        }
        pendingLineChunks.push(segment);
        pendingLineBytes += segment.length;
        if (newlineIndex >= 0) {
          this.push(Buffer.concat(pendingLineChunks, pendingLineBytes));
          pendingLineChunks = [];
          pendingLineBytes = 0;
        }
        offset = segmentEnd;
      }
      callback();
    },
    flush(callback) {
      if (forwarding && pendingLineBytes > 0) {
        this.push(Buffer.concat(pendingLineChunks, pendingLineBytes));
      }
      pendingLineChunks = [];
      pendingLineBytes = 0;
      callback();
    },
  });
}

function waitForCodexCliExit(
  child: ChildProcessWithoutNullStreams,
): Promise<CodexCliProcessExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exit: CodexCliProcessExit) => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.once('error', (error) => finish({ code: null, signal: null, spawnError: error }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

async function terminateCodexCliProcessAndWait(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  exitPromise: Promise<CodexCliProcessExit>,
  graceMs: number,
  onEvent?: SessionEventCallback,
): Promise<CodexCliProcessExit> {
  await terminateProcessTree(child, platform);
  let exit = await waitForProcessExitWithin(exitPromise, graceMs);
  if (exit) return exit;

  await terminateProcessTree(child, platform, true);
  exit = await waitForProcessExitWithin(exitPromise, graceMs);
  if (exit) return exit;

  emitEvent(onEvent, {
    type: 'text-delta',
    text:
      '[Codex CLI] Waiting for process-tree termination to be confirmed; ' +
      'the fallback will not release its workspace or prompt file while the process is alive.\n',
  });

  // Never return ownership of a child that may still be mutating the workspace.
  // Re-issue the forced tree kill until the close/error event confirms exit.
  while (!exit) {
    await terminateProcessTree(child, platform, true);
    exit = await waitForProcessExitWithin(exitPromise, graceMs);
  }
  return exit;
}

function waitForProcessExitWithin(
  exitPromise: Promise<CodexCliProcessExit>,
  timeoutMs: number,
): Promise<CodexCliProcessExit | null> {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    timer.unref?.();
    exitPromise.then((exit) => {
      clearTimeout(timer);
      resolveExit(exit);
    });
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  force = false,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (platform === 'win32' && child.pid) {
    try {
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const killer = spawn(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        {
          stdio: 'ignore',
          windowsHide: true,
          detached: true,
          shell: false,
        },
      );
      const taskkillSucceeded = await new Promise<boolean>((resolveTermination) => {
        let settled = false;
        const finish = (succeeded: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveTermination(succeeded);
        };
        const timer = setTimeout(() => {
          killer.kill();
          finish(false);
        }, CODEX_CLI_ABORT_EXIT_GRACE_MS);
        timer.unref?.();
        killer.once('error', () => finish(false));
        killer.once('close', (code) => finish(code === 0));
      });
      if (
        !taskkillSucceeded &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      // The process may not own a group; fall back to the direct child.
    }
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

function createCodexCliRunState(): CodexCliRunState {
  return {
    assistantText: [],
    completionSeen: false,
    diagnostics: '',
    stepsExecuted: 0,
    toolCallCount: 0,
    toolCalls: new Map(),
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

function handleCodexCliStdoutLine(
  line: string,
  state: CodexCliRunState,
  onEvent?: SessionEventCallback,
  sensitiveValues: string[] = [],
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const sanitized = sanitizeCodexCliDiagnostic(trimmed, sensitiveValues);
    appendDiagnostic(state, sanitized);
    emitEvent(onEvent, {
      type: 'text-delta',
      text: `[Codex CLI] ${sanitized}\n`,
    });
    return;
  }
  if (!isRecord(parsed)) return;

  const eventType = normalizeEventType(readString(parsed, [
    'type',
    'event_type',
    'kind',
  ]));
  const payload = readRecord(parsed, ['item', 'payload', 'msg', 'response_item']) ?? parsed;
  const payloadType = normalizeEventType(readString(payload, ['type', 'event_type', 'kind']));
  state.sessionId = readString(parsed, [
    'thread_id',
    'session_id',
    'sessionId',
    'conversation_id',
  ]) ?? readString(payload, [
    'thread_id',
    'session_id',
    'sessionId',
    'conversation_id',
  ]) ?? state.sessionId;

  const usage = extractCodexCliUsage(parsed, payload, state.sessionId);
  if (usage) {
    state.usage = usage;
    emitEvent(onEvent, { type: 'usage-update', usage });
  }

  if (CODEX_CLI_FAILURE_EVENTS.has(eventType)) {
    state.failure = extractCodexCliError(parsed, payload, sensitiveValues);
    appendDiagnostic(state, state.failure);
    return;
  }
  if (CODEX_CLI_COMPLETION_EVENTS.has(eventType)) {
    state.completionSeen = true;
    state.stepsExecuted += 1;
    emitEvent(onEvent, {
      type: 'step-finish',
      stepNumber: state.stepsExecuted,
      usage: state.usage,
    });
    return;
  }

  if (isAgentMessage(payload, eventType, payloadType)) {
    const text = extractCodexCliText(
      readFirstValue(payload, ['text', 'message', 'content', 'output_text']),
    ) || extractCodexCliText(
      readFirstValue(parsed, ['text', 'message', 'content', 'output_text']),
    );
    if (text) {
      const chunk = text.endsWith('\n') ? text : `${text}\n`;
      state.assistantText.push(chunk);
      emitEvent(onEvent, { type: 'text-delta', text: chunk });
    }
    return;
  }

  if (CODEX_CLI_IGNORED_ITEM_TYPES.has(payloadType)) {
    return;
  }
  if (CODEX_CLI_TOOL_ITEM_TYPES.has(payloadType)) {
    handleCodexCliToolEvent(eventType, payloadType, payload, state, onEvent);
  }
}

function isAgentMessage(
  payload: Record<string, unknown>,
  eventType: string,
  payloadType: string,
): boolean {
  if (eventType === 'agent_message' || payloadType === 'agent_message') {
    return true;
  }
  if (payloadType !== 'message') return false;
  const role = readString(payload, ['role']);
  return !role || role.toLowerCase() === 'assistant';
}

function handleCodexCliToolEvent(
  eventType: string,
  payloadType: string,
  payload: Record<string, unknown>,
  state: CodexCliRunState,
  onEvent?: SessionEventCallback,
): void {
  const toolCallId = readString(payload, ['call_id', 'callId', 'id'])
    ?? `${payloadType}-${state.toolCallCount + 1}`;
  const toolName = readString(payload, ['name', 'tool_name', 'toolName'])
    ?? mapCodexCliToolName(payloadType);
  const isStart = eventType === 'item_started'
    || eventType === 'function_call'
    || eventType === 'tool_call';
  const existing = state.toolCalls.get(toolCallId);

  if (isStart || !existing) {
    state.toolCallCount += existing ? 0 : 1;
    state.toolCalls.set(toolCallId, {
      name: toolName,
      startedAt: Date.now(),
    });
    emitEvent(onEvent, {
      type: 'tool-call',
      toolName,
      toolCallId,
      args: extractCodexCliToolArgs(payload),
    });
  }
  if (isStart) return;

  const active = state.toolCalls.get(toolCallId);
  const exitCode = readNumber(payload, ['exit_code', 'exitCode']);
  const status = readString(payload, ['status'])?.toLowerCase();
  emitEvent(onEvent, {
    type: 'tool-result',
    toolName: active?.name ?? toolName,
    toolCallId,
    result: readFirstValue(payload, [
      'aggregated_output',
      'output',
      'result',
      'content',
      'changes',
    ]) ?? '',
    durationMs: active ? Math.max(0, Date.now() - active.startedAt) : 0,
    isError: (exitCode !== undefined && exitCode !== 0)
      || status === 'failed'
      || status === 'error',
  });
  state.toolCalls.delete(toolCallId);
}

function mapCodexCliToolName(payloadType: string): string {
  switch (payloadType) {
    case 'command_execution':
      return 'Bash';
    case 'file_change':
      return 'ApplyPatch';
    case 'mcp_tool_call':
      return 'MCP';
    case 'web_search':
      return 'WebSearch';
    default:
      return payloadType || 'Tool';
  }
}

function extractCodexCliToolArgs(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const value = readFirstValue(payload, ['arguments', 'input', 'args']);
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      return { input: value };
    }
  }

  const command = readFirstValue(payload, ['command', 'cmd']);
  return command === undefined ? {} : { command };
}

function extractCodexCliUsage(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  sessionId?: string,
): TokenUsage | undefined {
  const usage = readRecord(envelope, ['usage'])
    ?? readRecord(payload, ['usage'])
    ?? (normalizeEventType(readString(envelope, ['type'])) === 'usage' ? envelope : undefined);
  if (!usage) return undefined;

  const promptTokens = readNumber(usage, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
  ]) ?? 0;
  const completionTokens = readNumber(usage, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ]) ?? 0;
  const totalTokens = readNumber(usage, ['total_tokens', 'totalTokens'])
    ?? promptTokens + completionTokens;
  const cacheReadTokens = readNumber(usage, [
    'cached_input_tokens',
    'cache_read_tokens',
    'cacheReadTokens',
  ]);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function extractCodexCliError(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  sensitiveValues: string[] = [],
): string {
  const error = readFirstValue(envelope, ['error'])
    ?? readFirstValue(payload, ['error'])
    ?? payload;
  if (typeof error === 'string') {
    return sanitizeCodexCliDiagnostic(error, sensitiveValues);
  }
  if (isRecord(error)) {
    const message = readString(error, ['message', 'detail', 'code', 'type']);
    if (message) {
      return sanitizeCodexCliDiagnostic(message, sensitiveValues);
    }
    try {
      return sanitizeCodexCliDiagnostic(JSON.stringify(error), sensitiveValues);
    } catch {
      return 'Codex CLI reported a provider error.';
    }
  }
  return 'Codex CLI reported a provider error.';
}

function buildCancelledResult(
  startedAt: number,
  state: CodexCliRunState = createCodexCliRunState(),
): SessionResult {
  return {
    outcome: 'cancelled',
    stepsExecuted: state.stepsExecuted,
    usage: state.usage,
    error: {
      code: 'aborted',
      message: 'Session was cancelled',
      retryable: false,
    },
    messages: buildAssistantMessages(state),
    durationMs: Date.now() - startedAt,
    toolCallCount: state.toolCallCount,
  };
}

function buildFallbackFailureResult(
  cliFailure: string,
  previousError: SessionError,
  startedAt: number,
  state: CodexCliRunState,
  sensitiveValues: string[] = [],
): SessionResult {
  const classified = classifyAutocodeSessionError(
    sanitizeCodexCliDiagnostic(cliFailure, sensitiveValues),
  );
  const sanitizedPreviousError = sanitizeCodexCliDiagnostic(
    previousError.message,
    sensitiveValues,
  );
  return {
    outcome: classified.outcome,
    stepsExecuted: state.stepsExecuted,
    usage: state.usage,
    error: {
      ...classified.sessionError,
      message:
        `Codex CLI fallback failed: ${classified.sessionError.message}. ` +
        `Initial API failure: ${sanitizedPreviousError}`,
    },
    messages: buildAssistantMessages(state),
    durationMs: Date.now() - startedAt,
    toolCallCount: state.toolCallCount,
  };
}

function buildAssistantMessages(
  state: CodexCliRunState,
): SessionResult['messages'] {
  return state.assistantText.map((content) => ({
    role: 'assistant',
    content,
  }));
}

function emitEvent(
  onEvent: SessionEventCallback | undefined,
  event: Parameters<SessionEventCallback>[0],
): void {
  try {
    onEvent?.(event);
  } catch {
    // UI/log observers must not be able to terminate the fallback process.
  }
}

function appendDiagnostic(state: CodexCliRunState, value: string): void {
  const normalized = value.trim();
  if (!normalized || state.diagnostics.length >= CODEX_CLI_DIAGNOSTIC_LIMIT) return;
  state.diagnostics = `${state.diagnostics}${state.diagnostics ? '\n' : ''}${normalized}`
    .slice(0, CODEX_CLI_DIAGNOSTIC_LIMIT);
}

function sanitizeCodexCliDiagnostic(
  value: string,
  sensitiveValues: string[] = [],
): string {
  let sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-[REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      '[JWT REDACTED]',
    );
  for (const sensitive of sensitiveValues) {
    if (sensitive) {
      sanitized = sanitized.split(sensitive).join('[PROMPT REDACTED]');
    }
    const lineCandidates = sensitive
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const candidate of lineCandidates) {
      if (candidate.length < 12) continue;
      sanitized = sanitized.split(candidate).join('[PROMPT REDACTED]');
    }
  }
  return sanitized.trim();
}

function normalizeEventType(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[.\-\s]+/g, '_') ?? '';
}

function readFirstValue(
  record: Record<string, unknown>,
  fields: string[],
): unknown {
  for (const field of fields) {
    if (record[field] !== undefined) return record[field];
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  fields: string[],
): string | undefined {
  const value = readFirstValue(record, fields);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  fields: string[],
): number | undefined {
  const value = readFirstValue(record, fields);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> | undefined {
  const value = readFirstValue(record, fields);
  return isRecord(value) ? value : undefined;
}

function extractCodexCliText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!isRecord(item)) return '';
      return extractCodexCliText(item.text ?? item.content);
    })
    .filter(Boolean)
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
