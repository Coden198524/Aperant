export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_LENGTH = 30_000;
export const BASH_MAX_OUTPUT_LINE_LENGTH = 1000;
export const AGGRESSIVE_BASH_MAX_OUTPUT_LENGTH = 8_000;
export const AGGRESSIVE_BASH_MAX_STDERR_LENGTH = 6_000;
export const BASH_REPEATED_LINE_THRESHOLD = 4;
const BASH_OUTPUT_TRUNCATION_HEAD_RATIO = 0.65;
const BASH_LINE_OMISSION_MARKER = ' ... [line middle omitted] ... ';
// biome-ignore lint/complexity/useRegexLiterals: Literal form triggers noControlCharactersInRegex.
const NON_ASCII_PATTERN = new RegExp('[^\\u0000-\\u007F]');

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
  const condensedOutput = collapseRepeatedBashOutputLines(output);
  const compactOutput = compactBashOutputLines(condensedOutput, BASH_MAX_OUTPUT_LINE_LENGTH);
  if (compactOutput.length <= maxLength) {
    return compactOutput;
  }
  return truncateHeadTailText(
    compactOutput,
    maxLength,
    `\n\n[Output truncated - ${output.length} characters total; showing head and tail]\n\n`,
  );
}

export function truncateCompilerOutput(output: string, maxLength: number): string {
  const condensedOutput = collapseRepeatedBashOutputLines(output);
  if (condensedOutput.length <= maxLength) {
    return condensedOutput;
  }

  const lines = condensedOutput.split(/\r?\n/);
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
    ? selectHeadTailLines(diagnosticLines, 20).join('\n')
    : selectHeadTailLines(lines, 80).join('\n');

  return appendTruncationNotice(
    compactBashOutputLines(compact, BASH_MAX_OUTPUT_LINE_LENGTH),
    maxLength,
    `\n\n[Compiler output truncated - ${condensedOutput.length} characters after folding repeated lines; showing diagnostic head and tail. Re-run with a narrower command if more detail is needed.]`,
  );
}

export function collapseRepeatedBashOutputLines(
  output: string,
  repeatedLineThreshold: number = BASH_REPEATED_LINE_THRESHOLD,
): string {
  if (output.length === 0 || repeatedLineThreshold <= 1) {
    return output;
  }

  const lines = output.split(/\r?\n/);
  const folded: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    let runLength = 1;
    while (index + runLength < lines.length && lines[index + runLength] === line) {
      runLength += 1;
    }

    if (runLength >= repeatedLineThreshold) {
      folded.push(line, `[... ${runLength - 1} repeated line(s) omitted ...]`);
    } else {
      folded.push(...lines.slice(index, index + runLength));
    }
    index += runLength;
  }

  return folded.join('\n');
}

function compactBashOutputLines(output: string, maxLineLength: number): string {
  return output
    .split('\n')
    .map((line) => compactBashOutputLine(line, maxLineLength))
    .join('\n');
}

function compactBashOutputLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }
  if (maxLength <= BASH_LINE_OMISSION_MARKER.length + 2) {
    return line.slice(0, maxLength);
  }

  const budget = maxLength - BASH_LINE_OMISSION_MARKER.length;
  const headLength = Math.ceil(budget * BASH_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    line.slice(0, headLength).trimEnd(),
    BASH_LINE_OMISSION_MARKER,
    tailLength > 0 ? line.slice(-tailLength).trimStart() : '',
  ].join('');
}

function selectHeadTailLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const budget = Math.max(1, maxLines - 1);
  const headCount = Math.ceil(budget * BASH_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailCount = Math.max(0, budget - headCount);
  return [
    ...lines.slice(0, headCount),
    `[... ${lines.length - headCount - tailCount} line(s) omitted ...]`,
    ...(tailCount > 0 ? lines.slice(-tailCount) : []),
  ];
}

function truncateHeadTailText(value: string, maxLength: number, marker: string): string {
  if (maxLength <= 0) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  if (marker.length >= maxLength - 2) {
    return value.slice(0, maxLength);
  }

  const budget = maxLength - marker.length;
  const headLength = Math.ceil(budget * BASH_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    value.slice(0, headLength).trimEnd(),
    marker,
    tailLength > 0 ? value.slice(-tailLength).trimStart() : '',
  ].join('');
}

function appendTruncationNotice(value: string, maxLength: number, notice: string): string {
  if (maxLength <= 0) {
    return '';
  }
  if (notice.length >= maxLength - 2) {
    return notice.slice(0, maxLength);
  }

  const contentBudget = maxLength - notice.length;
  const content = value.length <= contentBudget
    ? value
    : truncateHeadTailText(value, contentBudget, '\n[Diagnostic middle omitted]\n');
  return `${content.trimEnd()}${notice}`;
}

export function isCompilerCommand(command: string): boolean {
  return /(^|[^\w.-])(g\+\+|gcc|clang\+\+|clang|cl)(\.exe)?([^\w.-]|$)/i.test(command);
}

export function hasNonAscii(text: string): boolean {
  return NON_ASCII_PATTERN.test(text);
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
