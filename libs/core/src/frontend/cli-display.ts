import {
  DEFAULT_AUTOCODE_CLI,
  SUPPORTED_AUTOCODE_CLIS,
  parseAutocodeCliRuntimeRoutes,
  type AutocodeCli,
  type KnownAutocodeCli,
} from '../tasks/cli-catalog.js';

export const AUTOCODE_CLI_LABELS: Record<KnownAutocodeCli, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  kilocode: 'Kilo Code',
  custom: 'Custom CLI',
  deepseek: 'DeepSeek',
};

const AUTOCODE_CLI_OPTION_LABELS: Partial<Record<KnownAutocodeCli, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  kilocode: 'Kilo Code CLI',
};

export const AUTOCODE_QUICK_CLI_OPTIONS: KnownAutocodeCli[] = ['claude-code', 'codex', 'deepseek'];

export interface AutocodeCliOptionLabel {
  value: AutocodeCli;
  label: string;
}

export function getAutocodeCliLabel(cli: AutocodeCli | undefined): string {
  const normalized = cli || DEFAULT_AUTOCODE_CLI;
  return AUTOCODE_CLI_LABELS[normalized as KnownAutocodeCli] ?? normalized;
}

export function getAutocodeBuiltinCliOptionLabels(): AutocodeCliOptionLabel[] {
  return SUPPORTED_AUTOCODE_CLIS
    .filter((cli) => cli !== 'custom')
    .map((cli) => ({
      value: cli,
      label: AUTOCODE_CLI_OPTION_LABELS[cli] ?? AUTOCODE_CLI_LABELS[cli],
    }));
}

export function getAutocodeConfiguredCliOptionLabels(routes: unknown): AutocodeCliOptionLabel[] {
  const labels = new Map<string, AutocodeCliOptionLabel>();
  for (const route of parseAutocodeCliRuntimeRoutes(routes)) {
    if (route.cli === 'custom' || labels.has(route.cli)) {
      continue;
    }
    labels.set(route.cli, {
      value: route.cli,
      label: route.displayName || getAutocodeCliLabel(route.cli),
    });
  }
  return [...labels.values()];
}
