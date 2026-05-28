export const SUPPORTED_AUTOCODE_CLIS = [
  'claude-code',
  'gemini',
  'opencode',
  'kilocode',
  'codex',
  'deepseek',
  'custom',
] as const;

export type AutocodeCli = (typeof SUPPORTED_AUTOCODE_CLIS)[number];

export const DEFAULT_AUTOCODE_CLI: AutocodeCli = 'claude-code';

export const AUTOCODE_CLI_COMMANDS: Readonly<Record<Exclude<AutocodeCli, 'custom'>, string>> = {
  'claude-code': 'claude',
  gemini: 'gemini',
  opencode: 'opencode',
  kilocode: 'kilocode',
  codex: 'codex',
  deepseek: 'deepseek',
};

export function isAutocodeCli(value: unknown): value is AutocodeCli {
  return typeof value === 'string' && SUPPORTED_AUTOCODE_CLIS.includes(value as AutocodeCli);
}

export function resolveAutocodeCli(value: string, fallback?: AutocodeCli): AutocodeCli {
  if (isAutocodeCli(value)) {
    return value;
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`Unsupported CLI "${value}". Supported values: ${SUPPORTED_AUTOCODE_CLIS.join(', ')}.`);
}

export function getAutocodeCliCommandName(cli: AutocodeCli, customCommand?: string): string {
  if (cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return parts[0];
  }
  return AUTOCODE_CLI_COMMANDS[cli];
}

export function resolveAutocodeCliInvocation(
  cli: AutocodeCli,
  customCommand: string | undefined,
): { command: string; args: string[] } {
  if (cli === 'custom') {
    const parts = splitAutocodeCliCommandLine(customCommand?.trim() ?? '');
    if (parts.length === 0) {
      throw new Error('customCommand is required when cli is custom.');
    }
    return { command: parts[0], args: parts.slice(1) };
  }

  return { command: AUTOCODE_CLI_COMMANDS[cli], args: [] };
}

export function getAutocodeCliPermissionArgs(cli: AutocodeCli, bypassPermissions: boolean): string[] {
  if (!bypassPermissions) {
    return [];
  }
  if (cli === 'claude-code') {
    return ['--dangerously-skip-permissions'];
  }
  if (cli === 'codex') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }
  return [];
}

export function getAutocodeCliPermissionBypassFlag(cli: AutocodeCli, bypassPermissions: boolean): string {
  const args = getAutocodeCliPermissionArgs(cli, bypassPermissions);
  return args.length > 0 ? ` ${args.join(' ')}` : '';
}

export function buildAutocodeCliCommand(input: {
  cli: AutocodeCli;
  customCommand?: string;
  bypassPermissions?: boolean;
}): string {
  const invocation = resolveAutocodeCliInvocation(input.cli, input.customCommand);
  const permissionArgs = getAutocodeCliPermissionArgs(input.cli, input.bypassPermissions === true);
  return [invocation.command, ...invocation.args, ...permissionArgs].map(quoteShellArg).join(' ');
}

export function splitAutocodeCliCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
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
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (quote) {
    throw new Error('customCommand has an unterminated quote.');
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}
