/**
 * Bash Command Tool
 * =================
 *
 * Executes bash commands with security validation.
 * Integrates with bashSecurityHook() for pre-execution command allowlisting.
 * Supports timeouts, background execution, and descriptive metadata.
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_BASH_TIMEOUT_MS,
  acquireAutocodeRuntimeFileWriteLock,
  clampBashTimeout,
  detectFastCommandFailure,
  extractBashWriteFileTargets,
  formatBackgroundCommandStarted,
  formatBashCommandDenied,
  formatBashExecutionResult,
  normalizeAutocodeRuntimeFileIntent,
  releaseAutocodeRuntimeFileWriteLock,
  type AutocodeRuntimeFileWriteLock,
} from '@autocode/core';
import { z } from 'zod/v3';

import { findExecutable, isWindows, killProcessGracefully } from '../../../platform/index';
import { bashSecurityHook } from '../../security/bash-validator';
import { Tool } from '../define';
import { ToolPermission } from '../types';
import type { ToolContext } from '../types';

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z
    .number()
    .optional()
    .describe('Optional timeout in milliseconds (max 600000)'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Set to true to run this command in the background'),
  description: z
    .string()
    .optional()
    .describe('Clear, concise description of what this command does'),
});

function resolveShell(): string {
  if (isWindows()) {
    // Prefer Git Bash on Windows; fall back to cmd.exe
    return findExecutable('bash') ?? (process.env.ComSpec || 'cmd.exe');
  }
  return '/bin/bash';
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const shell = resolveShell();
  const args = isWindows() && shell.toLowerCase().endsWith('cmd.exe')
    ? ['/c', command]
    : ['-c', command];

  return new Promise((resolve) => {
    const child = execFile(
      shell,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? ('code' in error && typeof error.code === 'number'
              ? error.code
              : 1)
          : 0;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode,
        });
      },
    );

    // Ensure the child process is killed on abort.
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        killProcessGracefully(child);
      });
    }
  });
}

async function acquireBashWriteLocks(
  targets: string[],
  context: ToolContext,
): Promise<AutocodeRuntimeFileWriteLock[]> {
  if (context.fileWriteLock?.enabled !== true) {
    return [];
  }

  const projectRoot = context.fileWriteLock.projectRoot ?? context.projectDir;
  const sortedTargets = [...targets]
    .map((target) => isAbsolute(target) ? target : resolve(context.cwd, target))
    .sort((left, right) => {
      const leftKey = normalizeAutocodeRuntimeFileIntent(left, projectRoot) ?? left;
      const rightKey = normalizeAutocodeRuntimeFileIntent(right, projectRoot) ?? right;
      return leftKey.localeCompare(rightKey);
    });
  const locks: AutocodeRuntimeFileWriteLock[] = [];
  try {
    for (const target of sortedTargets) {
      locks.push(await acquireAutocodeRuntimeFileWriteLock({
        ...context.fileWriteLock,
        projectRoot,
        filePath: target,
        ownerId: context.fileWriteLock.ownerId ?? `Bash:${Date.now()}`,
      }));
    }
    return locks;
  } catch (error) {
    releaseBashWriteLocks(locks);
    throw error;
  }
}

function releaseBashWriteLocks(locks: AutocodeRuntimeFileWriteLock[]): void {
  for (const lock of locks.reverse()) {
    releaseAutocodeRuntimeFileWriteLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const bashTool = Tool.define({
  metadata: {
    name: 'Bash',
    description:
      'Executes a given bash command with optional timeout. Use for git operations, command execution, and other terminal tasks.',
    permission: ToolPermission.RequiresApproval,
    executionOptions: {
      timeoutMs: DEFAULT_BASH_TIMEOUT_MS,
      allowBackground: true,
    },
  },
  inputSchema,
  execute: async (input, context) => {
    const { command, timeout, run_in_background } = input;

    // Security: validate command against security profile via bashSecurityHook.
    const hookResult = bashSecurityHook(
      {
        toolName: 'Bash',
        toolInput: { command },
        cwd: context.cwd,
      },
      context.securityProfile,
    );

    if ('hookSpecificOutput' in hookResult) {
      const reason = hookResult.hookSpecificOutput.permissionDecisionReason;
      return formatBashCommandDenied(reason);
    }

    const fastFailure = detectFastCommandFailure(command, { isWindows: isWindows() });
    if (fastFailure) {
      return fastFailure;
    }

    const timeoutMs = clampBashTimeout(timeout);
    const fileWriteTargets = context.fileWriteLock?.enabled === true
      ? extractBashWriteFileTargets(command)
      : [];

    if (run_in_background && fileWriteTargets.length > 0) {
      return 'Error: Background Bash commands with detected file writes are disabled. Run the command in the foreground so file write locks can be held until completion.';
    }

    const fileWriteLocks = await acquireBashWriteLocks(fileWriteTargets, context);

    try {
      if (run_in_background) {
        executeCommand(command, context.cwd, timeoutMs, context.abortSignal);
        return formatBackgroundCommandStarted(command);
      }

      const { stdout, stderr, exitCode } = await executeCommand(
        command,
        context.cwd,
        timeoutMs,
        context.abortSignal,
      );

      return formatBashExecutionResult({
        command,
        stdout,
        stderr,
        exitCode,
        workflowMode: context.workflowMode,
      });
    } finally {
      releaseBashWriteLocks(fileWriteLocks);
    }
  },
});
