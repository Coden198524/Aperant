export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_LENGTH = 30_000;
export const AGGRESSIVE_BASH_MAX_OUTPUT_LENGTH = 8_000;
export const AGGRESSIVE_BASH_MAX_STDERR_LENGTH = 6_000;

export interface BashExecutionResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  workflowMode?: string;
}

export interface FastCommandFailureOptions {
  isWindows?: boolean;
}

export function clampBashTimeout(timeout?: number): number {
  return Math.min(timeout ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
}

export function truncateBashOutput(
  output: string,
  maxLength: number = BASH_MAX_OUTPUT_LENGTH,
): string {
  if (output.length <= maxLength) {
    return output;
  }
  return `${output.slice(0, maxLength)}\n\n[Output truncated - ${output.length} characters total]`;
}

export function truncateCompilerOutput(output: string, maxLength: number): string {
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

export function isCompilerCommand(command: string): boolean {
  return /(^|[^\w.-])(g\+\+|gcc|clang\+\+|clang|cl)(\.exe)?([^\w.-]|$)/i.test(command);
}

export function hasNonAscii(text: string): boolean {
  return /[^\u0000-\u007F]/.test(text);
}

export function detectFastCommandFailure(
  command: string,
  options: FastCommandFailureOptions = {},
): string | null {
  if (!options.isWindows) {
    return null;
  }

  const normalized = command.replace(/\r?\n/g, ' ');
  const hasShellSearch =
    /(^|[&|;(]\s*|\s)(grep|egrep|fgrep|findstr)(\.exe)?\b/i.test(normalized) ||
    /\bSelect-String\b/i.test(normalized) ||
    /\bdir\s+\/s\b/i.test(normalized) ||
    /(^|[&|;(]\s*|\s)(head|tail|sed|awk|lsof)(\.exe)?\b/i.test(normalized);
  if (hasShellSearch) {
    return 'Error: Inefficient Windows search command. Use the Grep tool for content search, Glob for filename search, or Read with a line range for known files. Do not retry the same search through grep/findstr/Select-String/dir/head/sed/awk.';
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

export function formatBashCommandDenied(reason: string): string {
  return `Error: Command not allowed - ${reason}`;
}

export function formatBackgroundCommandStarted(command: string): string {
  return `Command started in background: ${command}`;
}

export function formatBashExecutionResult(result: BashExecutionResult): string {
  const parts: string[] = [];
  const aggressiveMode = result.workflowMode === 'aggressive';
  const compilerCommand = isCompilerCommand(result.command);
  const maxOutputLength = aggressiveMode
    ? AGGRESSIVE_BASH_MAX_OUTPUT_LENGTH
    : BASH_MAX_OUTPUT_LENGTH;
  const maxStderrLength = aggressiveMode
    ? AGGRESSIVE_BASH_MAX_STDERR_LENGTH
    : BASH_MAX_OUTPUT_LENGTH;

  if (result.stdout) {
    parts.push(truncateBashOutput(result.stdout, maxOutputLength));
  }

  if (result.stderr) {
    const stderrOutput = aggressiveMode && compilerCommand
      ? truncateCompilerOutput(result.stderr, maxStderrLength)
      : truncateBashOutput(result.stderr, maxStderrLength);
    parts.push(`STDERR:\n${stderrOutput}`);
  }

  if (result.exitCode !== 0) {
    parts.push(`Exit code: ${result.exitCode}`);
  }

  return parts.length > 0 ? parts.join('\n') : '(no output)';
}
