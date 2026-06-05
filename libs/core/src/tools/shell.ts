export type AutocodeWindowsShellType = 'powershell' | 'cmd';

export interface BuildAutocodeCdCommandOptions {
  isWindows?: boolean;
  shellType?: AutocodeWindowsShellType;
}

export function escapeAutocodeShellArg(arg: string): string {
  const escaped = arg.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

export function escapeAutocodeShellPath(path: string): string {
  return escapeAutocodeShellArg(path);
}

export function escapeAutocodeShellArgWindows(arg: string): string {
  return arg
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/\^/g, '^^')
    .replace(/"/g, '^"')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%');
}

export function escapeAutocodeForWindowsDoubleQuote(arg: string): string {
  return arg
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/%/g, '%%')
    .replace(/"/g, '""');
}

export function buildAutocodeCdCommand(
  targetPath: string | undefined,
  options: BuildAutocodeCdCommandOptions = {},
): string {
  if (!targetPath) {
    return '';
  }

  if (options.isWindows ?? process.platform === 'win32') {
    const escaped = escapeAutocodeForWindowsDoubleQuote(targetPath);
    const separator = options.shellType === 'powershell' ? '; ' : ' && ';
    return `cd /d "${escaped}"${separator}`;
  }

  return `cd ${escapeAutocodeShellPath(targetPath)} && `;
}

export function isAutocodePathShellSafe(path: string): boolean {
  const suspiciousPatterns = [
    /\$\(/,
    /`/,
    /\|/,
    /;/,
    /&&/,
    /\|\|/,
    />/,
    /</,
    /\n/,
    /\r/,
  ];

  return !suspiciousPatterns.some(pattern => pattern.test(path));
}
