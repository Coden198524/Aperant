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

export function extractBashWriteFileTargets(command: string): string[] {
  const tokens = tokenizeBashCommand(command);
  const targets = new Set<string>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (isBashWriteRedirectionOperator(token)) {
      addBashWriteTarget(targets, tokens[index + 1]);
      index++;
      continue;
    }

    const attachedRedirection = parseAttachedWriteRedirection(token);
    if (attachedRedirection) {
      addBashWriteTarget(targets, attachedRedirection);
      continue;
    }

    if (isBashTeeCommandToken(token)) {
      index = collectBashTeeTargets(tokens, index + 1, targets);
    }
  }

  return [...targets].sort((a, b) => a.localeCompare(b));
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

function tokenizeBashCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && next) {
        current += next;
        index++;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === '\\' && next) {
      current += next;
      index++;
      continue;
    }

    if (char === '>' || (char === '&' && next === '>')) {
      const fdPrefix = /^\d+$/.test(current) || current === '&' ? current : '';
      if (fdPrefix) {
        current = '';
      } else {
        pushCurrent();
      }
      const append = next === '>' || (char === '&' && command[index + 2] === '>');
      tokens.push(`${fdPrefix || (char === '&' ? '&' : '')}${append ? '>>' : '>'}`);
      index += append ? (char === '&' ? 2 : 1) : (char === '&' ? 1 : 0);
      continue;
    }

    if (char === '|' || char === ';' || char === '(' || char === ')') {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    if (char === '&') {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function parseAttachedWriteRedirection(token: string): string | null {
  const match = /^(?:\d*|&)>>?(.+)$/.exec(token);
  return match?.[1]?.trim() || null;
}

function isBashWriteRedirectionOperator(token: string): boolean {
  return /^(?:\d*|&)>>?$/.test(token);
}

function isBashTeeCommandToken(token: string): boolean {
  const normalized = token.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return normalized === 'tee' || normalized === 'tee.exe';
}

function collectBashTeeTargets(tokens: string[], startIndex: number, targets: Set<string>): number {
  let index = startIndex;
  let endIndex = startIndex - 1;

  for (; index < tokens.length; index++) {
    const token = tokens[index];
    endIndex = index;

    if (isBashCommandSeparator(token)) {
      break;
    }

    if (isBashWriteRedirectionOperator(token)) {
      index++;
      endIndex = index;
      continue;
    }

    if (token === '--') {
      continue;
    }

    if (token.startsWith('-')) {
      continue;
    }

    addBashWriteTarget(targets, token);
  }

  return endIndex;
}

function isBashCommandSeparator(token: string): boolean {
  return token === '|' || token === ';' || token === '&' || token === '(' || token === ')';
}

function addBashWriteTarget(targets: Set<string>, target: string | null | undefined): void {
  const normalized = target?.trim();
  if (!normalized || shouldIgnoreBashWriteTarget(normalized)) {
    return;
  }
  targets.add(normalized);
}

function shouldIgnoreBashWriteTarget(target: string): boolean {
  const lower = target.toLowerCase();
  return (
    lower === '-' ||
    lower === 'nul' ||
    lower === '/dev/null' ||
    lower === '&1' ||
    lower === '&2' ||
    target.startsWith('$') ||
    target.startsWith('`') ||
    target.startsWith('(')
  );
}
