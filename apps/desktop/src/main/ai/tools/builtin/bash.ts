/**
 * Bash Command Tool
 * =================
 *
 * Executes bash commands with security validation.
 * Integrates with bashSecurityHook() for pre-execution command allowlisting.
 * Supports timeouts, background execution, and descriptive metadata.
 */

import { execFile } from 'node:child_process';
import { z } from 'zod/v3';

import { findExecutable, isWindows, killProcessGracefully } from '../../../platform/index';
import { bashSecurityHook } from '../../security/bash-validator';
import { Tool } from '../define';
import { ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_LENGTH = 30_000;
const AGGRESSIVE_MAX_OUTPUT_LENGTH = 8_000;
const AGGRESSIVE_MAX_STDERR_LENGTH = 6_000;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated — ${output.length} characters total]`;
}

function truncateOutputTo(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }
  return `${output.slice(0, maxLength)}\n\n[Output truncated - ${output.length} characters total]`;
}

function truncateCompilerError(output: string, maxLength: number): string {
  if (output.length <= maxLength) {
    return output;
  }

  const lines = output.split(/\r?\n/);
  const diagnosticLines = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes('error:') ||
      lower.includes('fatal error:') ||
      lower.includes('warning:') ||
      lower.includes('undefined reference') ||
      lower.includes('cannot find') ||
      lower.includes('not recognized') ||
      lower.includes('is not recognized')
    );
  });
  const compact = diagnosticLines.length > 0
    ? diagnosticLines.slice(0, 20).join('\n')
    : lines.slice(0, 80).join('\n');

  return `${compact.slice(0, maxLength)}\n\n[Compiler output truncated - ${output.length} characters total. Re-run with a narrower command if more detail is needed.]`;
}

function isCompilerCommand(command: string): boolean {
  return /(^|[^\w.-])(g\+\+|gcc|clang\+\+|clang|cl)(\.exe)?([^\w.-]|$)/i.test(command);
}

function hasNonAscii(text: string): boolean {
  return /[^\u0000-\u007F]/.test(text);
}

function detectFastCommandFailure(command: string): string | null {
  if (!isWindows()) {
    return null;
  }

  const hasPythonHereDoc = /\bpython(?:\d+(?:\.\d+)?)?\b[^\n\r]*(?:<<\s*['"]?\w+['"]?)/i.test(command);
  if (hasPythonHereDoc) {
    return 'Error: Unsupported Windows shell syntax. Bash here-documents such as `python - <<EOF` are not portable here. Use a simple file read or one short command instead of retrying with equivalent shell quoting.';
  }

  const hasComplexPythonOneLiner = /\bpython(?:\d+(?:\.\d+)?)?\b[^\n\r]*\s-c\s*["'][\s\S]*["']/i.test(command);
  if (hasComplexPythonOneLiner && hasNonAscii(command)) {
    return 'Error: Risky Windows verification command. Python -c with nested quotes and non-ASCII text often fails because of shell encoding/quoting. Use Read, Test-Path, Get-Content -Raw, or record the manual check instead of retrying equivalent commands.';
  }

  return null;
}

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

    // Ensure the child process is killed on abort
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        killProcessGracefully(child);
      });
    }
  });
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
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowBackground: true,
    },
  },
  inputSchema,
  execute: async (input, context) => {
    const { command, timeout, run_in_background } = input;

    // Security: validate command against security profile via bashSecurityHook
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
      return `Error: Command not allowed — ${reason}`;
    }

    const fastFailure = detectFastCommandFailure(command);
    if (fastFailure) {
      return fastFailure;
    }

    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    if (run_in_background) {
      // Fire-and-forget for background commands
      executeCommand(command, context.cwd, timeoutMs, context.abortSignal);
      return `Command started in background: ${command}`;
    }

    const { stdout, stderr, exitCode } = await executeCommand(
      command,
      context.cwd,
      timeoutMs,
      context.abortSignal,
    );

    const parts: string[] = [];
    const aggressiveMode = context.workflowMode === 'aggressive';
    const compilerCommand = isCompilerCommand(command);
    const maxOutputLength = aggressiveMode ? AGGRESSIVE_MAX_OUTPUT_LENGTH : MAX_OUTPUT_LENGTH;
    const maxStderrLength = aggressiveMode ? AGGRESSIVE_MAX_STDERR_LENGTH : MAX_OUTPUT_LENGTH;

    if (stdout) {
      parts.push(aggressiveMode ? truncateOutputTo(stdout, maxOutputLength) : truncateOutput(stdout));
    }

    if (stderr) {
      const stderrOutput = aggressiveMode && compilerCommand
        ? truncateCompilerError(stderr, maxStderrLength)
        : aggressiveMode
          ? truncateOutputTo(stderr, maxStderrLength)
          : truncateOutput(stderr);
      parts.push(`STDERR:\n${stderrOutput}`);
    }

    if (exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`);
    }

    return parts.length > 0 ? parts.join('\n') : '(no output)';
  },
});
