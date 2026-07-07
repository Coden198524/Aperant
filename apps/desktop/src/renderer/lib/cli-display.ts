import {
  AUTOCODE_CLI_LABELS,
  AUTOCODE_QUICK_CLI_OPTIONS,
  getAutocodeBuiltinCliOptionLabels,
  getAutocodeCliLabel,
  getAutocodeConfiguredCliOptionLabels,
} from '@autocode/core/frontend/cli-display';
import { DEFAULT_AUTOCODE_CLI } from '@autocode/core/tasks/cli-catalog';
import type { SupportedCLI } from '../../shared/types/settings';

export const CLI_LABELS = AUTOCODE_CLI_LABELS;
export const QUICK_CLI_OPTIONS = AUTOCODE_QUICK_CLI_OPTIONS as SupportedCLI[];
export const DEFAULT_CLI = DEFAULT_AUTOCODE_CLI as SupportedCLI;

export interface CliOptionLabel {
  value: SupportedCLI;
  label: string;
}

export function getCliLabel(cli: SupportedCLI | undefined): string {
  return getAutocodeCliLabel(cli);
}

export function getBuiltinCliOptionLabels(): CliOptionLabel[] {
  return getAutocodeBuiltinCliOptionLabels().map((option) => ({
    value: option.value as SupportedCLI,
    label: option.label,
  }));
}

export function getConfiguredCliOptionLabels(routes: unknown): CliOptionLabel[] {
  return getAutocodeConfiguredCliOptionLabels(routes).map((option) => ({
    value: option.value as SupportedCLI,
    label: option.label,
  }));
}

export function getQuickCliOptionLabels(
  routes: unknown,
  extraClis: Array<SupportedCLI | undefined> = [],
): CliOptionLabel[] {
  const labels = new Map<string, CliOptionLabel>();
  const add = (option: CliOptionLabel) => {
    if (!labels.has(option.value)) {
      labels.set(option.value, option);
    }
  };

  for (const cli of QUICK_CLI_OPTIONS) {
    add({ value: cli, label: getCliLabel(cli) });
  }
  for (const option of getConfiguredCliOptionLabels(routes)) {
    if (option.value !== 'custom') {
      add(option);
    }
  }
  for (const cli of extraClis) {
    if (cli && !labels.has(cli)) {
      add({ value: cli, label: getCliLabel(cli) });
    }
  }

  return [...labels.values()];
}
