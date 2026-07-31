import { spawn, type ChildProcess } from 'node:child_process';

import { OPEN_SPEC_VERSION, type OpenSpecRootKind } from '../../shared/types';
import { assertPinnedOpenSpecPackage } from './openspec-package';

const DEFAULT_TIMEOUT_MS = 45_000;
const MUTATION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface OpenSpecCliScope {
  cwd: string;
  rootKind?: OpenSpecRootKind;
  storeId?: string;
}

export interface OpenSpecCliExecution {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface OpenSpecCliRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowNonZeroJson?: boolean;
}

export interface OpenSpecCliAdapterOptions {
  /** Test/embedded runtime overrides such as isolated XDG Store registries. */
  environment?: NodeJS.ProcessEnv;
}

export class OpenSpecCliError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    input: {
      args: string[];
      exitCode: number | null;
      stdout?: string;
      stderr?: string;
    },
  ) {
    super(message);
    this.name = 'OpenSpecCliError';
    this.args = input.args;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout ?? '';
    this.stderr = input.stderr ?? '';
  }
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new Error(`${label} must be a kebab-case OpenSpec identifier.`);
  }
  return normalized;
}

function rootArgs(scope: OpenSpecCliScope): string[] {
  if (scope.rootKind !== 'store') {
    return [];
  }
  if (!scope.storeId) {
    throw new Error('A registered OpenSpec store ID is required for Store mode.');
  }
  return ['--store', assertIdentifier(scope.storeId, 'Store ID')];
}

function minimalEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'SystemRoot',
    'ComSpec',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  env.OPENSPEC_TELEMETRY = '0';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return {
    ...env,
    ...overrides,
    ELECTRON_RUN_AS_NODE: '1',
    OPENSPEC_TELEMETRY: '0',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
}

function parseJsonStrict<T>(execution: OpenSpecCliExecution): T {
  const value = execution.stdout.trim();
  if (!value) {
    throw new OpenSpecCliError('OpenSpec returned an empty JSON response.', execution);
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new OpenSpecCliError('OpenSpec returned malformed JSON.', execution);
  }
}

export class OpenSpecCliAdapter {
  constructor(private readonly adapterOptions: OpenSpecCliAdapterOptions = {}) {}

  async execute(
    scope: OpenSpecCliScope,
    args: string[],
    options: OpenSpecCliRunOptions = {},
  ): Promise<OpenSpecCliExecution> {
    const location = assertPinnedOpenSpecPackage();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    return await new Promise<OpenSpecCliExecution>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timedOut = false;

      const child = spawn(process.execPath, [location.cliEntry, ...args], {
        cwd: scope.cwd,
        shell: false,
        windowsHide: true,
        env: minimalEnvironment(this.adapterOptions.environment),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };

      const onData = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          terminateChild(child);
          finishReject(new OpenSpecCliError(
            `OpenSpec output exceeded ${MAX_OUTPUT_BYTES} bytes.`,
            { args, exitCode: child.exitCode, stdout, stderr },
          ));
          return;
        }
        if (target === 'stdout') {
          stdout += chunk.toString('utf8');
        } else {
          stderr += chunk.toString('utf8');
        }
      };

      const onAbort = (): void => {
        terminateChild(child);
        finishReject(new DOMException('OpenSpec command was cancelled.', 'AbortError'));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child);
      }, timeoutMs);

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => onData('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => onData('stderr', chunk));
      child.on('error', (error) => finishReject(error));
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const execution: OpenSpecCliExecution = {
          args: [...args],
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
          durationMs: Date.now() - startedAt,
        };
        if (timedOut) {
          reject(new OpenSpecCliError(
            `OpenSpec command timed out after ${timeoutMs}ms.`,
            execution,
          ));
          return;
        }
        if (execution.exitCode !== 0 && !options.allowNonZeroJson) {
          reject(new OpenSpecCliError(
            stderr.trim() || stdout.trim() || `OpenSpec exited with code ${execution.exitCode}.`,
            execution,
          ));
          return;
        }
        resolve(execution);
      });
    });
  }

  async version(scope: OpenSpecCliScope): Promise<string> {
    const result = await this.execute(scope, ['--version']);
    const version = result.stdout.trim();
    if (version !== OPEN_SPEC_VERSION) {
      throw new Error(`OpenSpec version mismatch: expected ${OPEN_SPEC_VERSION}, found ${version || 'unknown'}.`);
    }
    return version;
  }

  async init(scope: OpenSpecCliScope, signal?: AbortSignal): Promise<void> {
    if (scope.rootKind === 'store') {
      return;
    }
    await this.execute(scope, ['init', '.', '--tools', 'none'], {
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal,
    });
  }

  async newChange<T>(
    scope: OpenSpecCliScope,
    input: { changeName: string; schemaName?: string; description?: string; signal?: AbortSignal },
  ): Promise<T> {
    const args = ['new', 'change', assertIdentifier(input.changeName, 'Change name')];
    if (input.schemaName) args.push('--schema', assertIdentifier(input.schemaName, 'Schema name'));
    if (input.description) args.push('--description', input.description.slice(0, 4_000));
    args.push('--json', ...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, {
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal: input.signal,
    }));
  }

  async status<T>(
    scope: OpenSpecCliScope,
    input: { changeName: string; schemaName?: string; signal?: AbortSignal },
  ): Promise<T> {
    const args = ['status', '--change', assertIdentifier(input.changeName, 'Change name')];
    if (input.schemaName) args.push('--schema', assertIdentifier(input.schemaName, 'Schema name'));
    args.push('--json', ...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, { signal: input.signal }));
  }

  async instructions<T>(
    scope: OpenSpecCliScope,
    input: { artifactId: string; changeName: string; schemaName?: string; signal?: AbortSignal },
  ): Promise<T> {
    const args = [
      'instructions',
      assertIdentifier(input.artifactId, 'Artifact ID'),
      '--change',
      assertIdentifier(input.changeName, 'Change name'),
    ];
    if (input.schemaName) args.push('--schema', assertIdentifier(input.schemaName, 'Schema name'));
    args.push('--json', ...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, { signal: input.signal }));
  }

  async show<T>(
    scope: OpenSpecCliScope,
    input: { itemName: string; type?: 'change' | 'spec'; signal?: AbortSignal },
  ): Promise<T> {
    const args = ['show', assertIdentifier(input.itemName, 'Item name'), '--json', '--no-interactive'];
    if (input.type) args.push('--type', input.type);
    args.push(...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, { signal: input.signal }));
  }

  async list<T>(
    scope: OpenSpecCliScope,
    input: { specs?: boolean; sort?: 'recent' | 'name'; signal?: AbortSignal } = {},
  ): Promise<T> {
    const args = ['list', input.specs ? '--specs' : '--changes', '--sort', input.sort ?? 'recent', '--json'];
    args.push(...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, { signal: input.signal }));
  }

  async validate<T>(
    scope: OpenSpecCliScope,
    input: { itemName?: string; strict?: boolean; all?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const args = ['validate'];
    if (input.itemName) args.push(assertIdentifier(input.itemName, 'Item name'));
    if (input.all) args.push('--all');
    if (input.strict !== false) args.push('--strict');
    args.push('--json', '--no-interactive', ...rootArgs(scope));
    const execution = await this.execute(scope, args, {
      signal: input.signal,
      allowNonZeroJson: true,
    });
    return parseJsonStrict<T>(execution);
  }

  async archive<T>(
    scope: OpenSpecCliScope,
    input: { changeName: string; skipSpecs?: boolean; confirmed: boolean; signal?: AbortSignal },
  ): Promise<T> {
    if (!input.confirmed) {
      throw new Error('Archive requires explicit confirmation.');
    }
    const args = ['archive', assertIdentifier(input.changeName, 'Change name'), '--yes', '--json'];
    if (input.skipSpecs) args.push('--skip-specs');
    args.push(...rootArgs(scope));
    return parseJsonStrict<T>(await this.execute(scope, args, {
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal: input.signal,
    }));
  }

  async schemas<T>(scope: OpenSpecCliScope, signal?: AbortSignal): Promise<T> {
    return parseJsonStrict<T>(await this.execute(scope, ['schemas', '--json'], { signal }));
  }

  async schemaWhich<T>(
    scope: Pick<OpenSpecCliScope, 'cwd'>,
    schemaName: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return parseJsonStrict<T>(await this.execute(
      { cwd: scope.cwd },
      ['schema', 'which', assertIdentifier(schemaName, 'Schema name'), '--json'],
      { signal },
    ));
  }

  async templates<T>(
    scope: OpenSpecCliScope,
    schemaName: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return parseJsonStrict<T>(await this.execute(
      scope,
      ['templates', '--schema', assertIdentifier(schemaName, 'Schema name'), '--json'],
      { signal },
    ));
  }

  async context<T>(scope: OpenSpecCliScope, signal?: AbortSignal): Promise<T> {
    return parseJsonStrict<T>(await this.execute(
      scope,
      ['context', '--json', ...rootArgs(scope)],
      { signal },
    ));
  }

  async storeList<T>(scope: Pick<OpenSpecCliScope, 'cwd'>, signal?: AbortSignal): Promise<T> {
    return parseJsonStrict<T>(await this.execute(
      { cwd: scope.cwd },
      ['store', 'list', '--json'],
      { signal },
    ));
  }
}

export const __openSpecCliTestUtils = {
  assertIdentifier,
  rootArgs,
  parseJsonStrict,
};
