import {
  ALL_AVAILABLE_MODELS,
  PROVIDER_PRESET_DEFINITIONS,
  type ModelCatalogProvider,
  type ModelOption,
} from './models';
import { PROVIDER_REGISTRY } from './providers';
import type { BuiltinProvider, ProviderInfo } from '../types/provider-account';

export const PROVIDER_MODEL_SUPPORT_POLICY_VERSION = '2026-06-14';

export type ProviderModelSupportLevel =
  | 'built-in-catalog'
  | 'custom-endpoint'
  | 'local-runtime'
  | 'provider-config-only';

export interface ProviderModelSupportModel {
  value: string;
  label: string;
  contextWindow: number | null;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  apiKeyOnly: boolean;
}

export interface ProviderModelSupportEntry {
  provider: BuiltinProvider;
  name: string;
  supportLevel: ProviderModelSupportLevel;
  authMethods: string[];
  envVars: string[];
  configFields: string[];
  presetIds: string[];
  catalogModels: ProviderModelSupportModel[];
  notes: string[];
}

export function buildProviderModelSupportMatrix(
  providers: readonly ProviderInfo[] = PROVIDER_REGISTRY,
  models: readonly ModelOption[] = ALL_AVAILABLE_MODELS,
): ProviderModelSupportEntry[] {
  return providers.map((provider) => {
    const providerId = provider.id as ModelCatalogProvider;
    const catalogModels = models
      .filter((model) => model.provider === providerId)
      .map(toSupportModel);
    const presetIds = Object.keys(PROVIDER_PRESET_DEFINITIONS[providerId] ?? {});
    const supportLevel = resolveProviderSupportLevel(provider.id, catalogModels);

    return {
      provider: provider.id,
      name: provider.name,
      supportLevel,
      authMethods: [...provider.authMethods],
      envVars: [...provider.envVars],
      configFields: [...provider.configFields],
      presetIds,
      catalogModels,
      notes: buildProviderSupportNotes(provider, supportLevel, catalogModels.length),
    };
  });
}

export function stringifyProviderModelSupportMatrixMarkdown(
  entries: readonly ProviderModelSupportEntry[] = buildProviderModelSupportMatrix(),
  version = PROVIDER_MODEL_SUPPORT_POLICY_VERSION,
): string {
  const lines = [
    '# Provider Model Support Matrix',
    '',
    `Version: ${version}`,
    '',
    'This matrix is derived from the desktop provider registry and built-in model catalog. It documents product support posture only; provider availability, prices, rate limits, and model retirement dates remain controlled by each upstream provider.',
    '',
    '## Support Levels',
    '',
    '- `built-in-catalog`: Autocode ships named model choices and provider presets for this provider.',
    '- `custom-endpoint`: Autocode supports user-defined models from a configured OpenAI-compatible endpoint.',
    '- `local-runtime`: Autocode connects to a local runtime and discovers or accepts locally installed models.',
    '- `provider-config-only`: Account or endpoint configuration is supported, but the commercial model catalog is not enumerated by Autocode yet.',
    '',
    '## Provider Summary',
    '',
    '| Provider | Support level | Auth | Built-in models | Presets | Notes |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...entries.map((entry) => [
      escapeMarkdownCell(entry.name),
      `\`${entry.supportLevel}\``,
      escapeMarkdownCell(entry.authMethods.join(', ') || 'none'),
      String(entry.catalogModels.length),
      escapeMarkdownCell(entry.presetIds.join(', ') || 'none'),
      escapeMarkdownCell(entry.notes.join(' ')),
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
    '## Built-In Catalog Models',
    '',
  ];

  for (const entry of entries) {
    lines.push(`### ${entry.name}`, '');
    if (entry.catalogModels.length === 0) {
      lines.push('- No built-in model rows. See provider notes above.', '');
      continue;
    }

    lines.push('| Model value | Label | Context | Thinking | Tools | Vision | Auth note |');
    lines.push('| --- | --- | ---: | --- | --- | --- | --- |');
    for (const model of entry.catalogModels) {
      const row = [
        `\`${escapeMarkdownCell(model.value)}\``,
        escapeMarkdownCell(model.label),
        model.contextWindow === null ? 'unknown' : String(model.contextWindow),
        model.supportsThinking ? 'yes' : 'no',
        model.supportsTools ? 'yes' : 'no',
        model.supportsVision ? 'yes' : 'no',
        model.apiKeyOnly ? 'API key only' : 'standard',
      ].join(' | ');
      lines.push(`| ${row} |`);
    }
    lines.push('');
  }

  lines.push(
    '## Cost Display Policy',
    '',
    'Autocode v1 displays token counts and whether usage is provider-reported or locally estimated. Monetary cost estimates remain unconfigured until a versioned pricing policy and provider-billing reconciliation workflow are approved.',
    '',
  );

  return `${lines.join('\n').trimEnd()}\n`;
}

function toSupportModel(model: ModelOption): ProviderModelSupportModel {
  return {
    value: model.value,
    label: model.label,
    contextWindow: model.capabilities?.contextWindow ?? null,
    supportsThinking: model.capabilities?.thinking === true,
    supportsTools: model.capabilities?.tools === true,
    supportsVision: model.capabilities?.vision === true,
    apiKeyOnly: model.apiKeyOnly === true,
  };
}

function resolveProviderSupportLevel(
  provider: BuiltinProvider,
  catalogModels: readonly ProviderModelSupportModel[],
): ProviderModelSupportLevel {
  if (catalogModels.length > 0) {
    return 'built-in-catalog';
  }
  if (provider === 'openai-compatible') {
    return 'custom-endpoint';
  }
  if (provider === 'ollama') {
    return 'local-runtime';
  }
  return 'provider-config-only';
}

function buildProviderSupportNotes(
  provider: ProviderInfo,
  supportLevel: ProviderModelSupportLevel,
  modelCount: number,
): string[] {
  if (supportLevel === 'built-in-catalog') {
    return [`${modelCount} built-in model choices are listed in the model catalog.`];
  }
  if (provider.id === 'openai-compatible') {
    return ['Models are supplied by the configured endpoint or account custom model list.'];
  }
  if (provider.id === 'ollama') {
    return ['Models are local to the user machine and are not bundled with the app.'];
  }
  if (provider.id === 'azure') {
    return ['Model availability depends on the configured Azure deployment.'];
  }
  if (provider.id === 'amazon-bedrock') {
    return ['Model availability depends on AWS region, account access, and Bedrock model enablement.'];
  }
  if (provider.id === 'openrouter') {
    return ['OpenRouter account configuration is supported; the upstream model catalog is not enumerated here.'];
  }
  return ['Provider account configuration is supported; explicit built-in model rows are not published yet.'];
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
