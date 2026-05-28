export type AutocodeCommandOptionValue = string | boolean | string[];

export interface ParsedAutocodeCommandArgs {
  command: string;
  positionals: string[];
  options: Record<string, AutocodeCommandOptionValue>;
}

export function parseAutocodeCommandArgs(rawArgs: string[]): ParsedAutocodeCommandArgs {
  const first = rawArgs[0];
  const command = !first || first === '--help' || first === '-h'
    ? 'help'
    : first.startsWith('-')
      ? 'help'
      : first;
  const args = command === 'help' && first?.startsWith('-') ? rawArgs : rawArgs.slice(1);
  const options: Record<string, AutocodeCommandOptionValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    const equalsIndex = option.indexOf('=');
    if (equalsIndex >= 0) {
      setAutocodeCommandOption(options, option.slice(0, equalsIndex), option.slice(equalsIndex + 1));
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith('-')) {
      setAutocodeCommandOption(options, option, next);
      index += 1;
      continue;
    }

    setAutocodeCommandOption(options, option, true);
  }

  return { command, positionals, options };
}

export function setAutocodeCommandOption(
  options: Record<string, AutocodeCommandOptionValue>,
  key: string,
  value: string | boolean,
): void {
  const normalizedKey = key.trim();
  const existing = options[normalizedKey];
  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }
  if (existing !== undefined) {
    options[normalizedKey] = [String(existing), String(value)];
    return;
  }
  options[normalizedKey] = value;
}

export function getAutocodeStringOption(
  parsed: Pick<ParsedAutocodeCommandArgs, 'options'>,
  key: string,
): string | undefined {
  const value = parsed.options[key];
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return typeof value === 'string' ? value : undefined;
}

export function getAutocodeBooleanOption(
  parsed: Pick<ParsedAutocodeCommandArgs, 'options'>,
  key: string,
): boolean {
  const value = parsed.options[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === 'true' || value === '1' || value === 'yes';
  }
  return false;
}

export function hasAutocodeJsonOption(parsed: Pick<ParsedAutocodeCommandArgs, 'options'>): boolean {
  return getAutocodeBooleanOption(parsed, 'json');
}
