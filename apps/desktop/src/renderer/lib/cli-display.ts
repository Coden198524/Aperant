import {
  AUTOCODE_CLI_LABELS,
  AUTOCODE_QUICK_CLI_OPTIONS,
  getAutocodeCliLabel,
} from '@autocode/core/frontend/cli-display';
import type { SupportedCLI } from '../../shared/types/settings';

export const CLI_LABELS = AUTOCODE_CLI_LABELS as Record<SupportedCLI, string>;
export const QUICK_CLI_OPTIONS = AUTOCODE_QUICK_CLI_OPTIONS as SupportedCLI[];

export function getCliLabel(cli: SupportedCLI | undefined): string {
  return getAutocodeCliLabel(cli);
}
