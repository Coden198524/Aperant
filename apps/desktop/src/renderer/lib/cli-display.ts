import type { SupportedCLI } from '../../shared/types/settings';

export const CLI_LABELS: Record<SupportedCLI, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  kilocode: 'Kilo Code',
  custom: 'Custom CLI',
};

export const QUICK_CLI_OPTIONS: SupportedCLI[] = ['claude-code', 'codex'];

export function getCliLabel(cli: SupportedCLI | undefined): string {
  return CLI_LABELS[cli || 'claude-code'];
}
