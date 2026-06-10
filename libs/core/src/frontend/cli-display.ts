import type { AutocodeCli } from '../tasks/cli-catalog.js';

export const AUTOCODE_CLI_LABELS: Record<AutocodeCli, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  kilocode: 'Kilo Code',
  custom: 'Custom CLI',
  deepseek: 'DeepSeek',
};

export const AUTOCODE_QUICK_CLI_OPTIONS: AutocodeCli[] = ['claude-code', 'codex', 'deepseek'];

export function getAutocodeCliLabel(cli: AutocodeCli | undefined): string {
  return AUTOCODE_CLI_LABELS[cli || 'claude-code'];
}
