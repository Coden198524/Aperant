import type { OpenSpecArtifactProgress } from '../openspec/index.js';

export type AutocodeOpenSpecLifecycleStatus = 'starting' | 'updating' | 'completed' | 'updated' | 'failed';

export function formatAutocodeOpenSpecGenerationLifecycleMessage(
  status: AutocodeOpenSpecLifecycleStatus,
  language?: string,
  detail?: string,
): string {
  if (isAutocodeChineseLanguageName(language)) {
    switch (status) {
      case 'starting':
        return '\u6b63\u5728\u751f\u6210 OpenSpec \u6587\u6863...';
      case 'updating':
        return '\u6b63\u5728\u6839\u636e\u5ba1\u6838\u53cd\u9988\u66f4\u65b0 OpenSpec \u6587\u6863...';
      case 'completed':
        return 'OpenSpec \u6587\u6863\u5df2\u751f\u6210\uff0c\u7ee7\u7eed\u751f\u6210\u4e0b\u6e38\u5b9e\u73b0\u8ba1\u5212\u3002';
      case 'updated':
        return 'OpenSpec \u6587\u6863\u5df2\u6839\u636e\u5ba1\u6838\u53cd\u9988\u66f4\u65b0\uff0c\u7ee7\u7eed\u91cd\u65b0\u751f\u6210\u4e0b\u6e38\u8ba1\u5212\u3002';
      case 'failed':
        return `OpenSpec \u6587\u6863\u751f\u6210\u5931\u8d25\uff1a${detail ?? '\u672a\u77e5\u9519\u8bef'}`;
    }
  }

  switch (status) {
    case 'starting':
      return 'Generating OpenSpec artifacts...';
    case 'updating':
      return 'Updating OpenSpec artifacts from review feedback...';
    case 'completed':
      return 'OpenSpec artifacts generated. Continuing downstream implementation planning.';
    case 'updated':
      return 'OpenSpec artifacts updated from review feedback. Regenerating downstream plan.';
    case 'failed':
      return `OpenSpec artifact generation failed: ${detail ?? 'Unknown error'}`;
  }
}

export function formatAutocodeOpenSpecArtifactProgressMessage(
  event: OpenSpecArtifactProgress,
  language?: string,
): string {
  const artifact = formatAutocodeOpenSpecArtifactName(event);
  const position = formatAutocodeOpenSpecArtifactPosition(event);
  const elapsed = formatAutocodeDuration(event.elapsedMs);
  const chars = event.generatedChars ?? 0;
  const model = event.modelId ? ` ${event.modelId}` : '';

  if (isAutocodeChineseLanguageName(language)) {
    switch (event.stage) {
      case 'artifact_start':
        return `[OpenSpec] \u5f00\u59cb\u751f\u6210 ${artifact}${position}\u3002`;
      case 'artifact_model_start':
        return `[OpenSpec] \u5df2\u8bf7\u6c42\u6a21\u578b${model}\u751f\u6210 ${artifact}${position}\u3002`;
      case 'artifact_model_delta':
        return `[OpenSpec] ${artifact} \u6b63\u5728\u8f93\u51fa\uff0c\u8017\u65f6 ${elapsed}\u3002`;
      case 'artifact_heartbeat':
        return chars > 0
          ? `[OpenSpec] ${artifact} \u4ecd\u5728\u751f\u6210\uff0c\u8017\u65f6 ${elapsed}\u3002`
          : `[OpenSpec] ${artifact} \u751f\u6210\u4e2d\uff0c\u6a21\u578b\u4ecd\u5728\u601d\u8003\uff0c\u8017\u65f6 ${elapsed}\u3002`;
      case 'artifact_model_complete':
        return `[OpenSpec] ${artifact} \u6a21\u578b\u8f93\u51fa\u5b8c\u6210\uff0c\u6b63\u5728\u6821\u9a8c\u5e76\u5199\u5165\u6587\u4ef6\u3002`;
      case 'artifact_complete':
        return `[OpenSpec] ${artifact} \u5df2\u5199\u5165 ${event.outputPath}\uff0c\u8017\u65f6 ${elapsed}\u3002`;
      case 'artifact_retry':
        return `[OpenSpec] ${artifact} \u6821\u9a8c\u672a\u901a\u8fc7\uff0c\u6b63\u5728\u91cd\u8bd5\uff1a${event.error ?? '\u672a\u77e5\u9519\u8bef'}`;
      case 'artifact_failed':
        return `[OpenSpec] ${artifact} \u751f\u6210\u5931\u8d25\uff1a${event.error ?? '\u672a\u77e5\u9519\u8bef'}`;
    }
  }

  switch (event.stage) {
    case 'artifact_start':
      return `[OpenSpec] Generating ${artifact}${position}.`;
    case 'artifact_model_start':
      return `[OpenSpec] Requested model${model} for ${artifact}${position}.`;
    case 'artifact_model_delta':
      return `[OpenSpec] ${artifact} is streaming, elapsed ${elapsed}.`;
    case 'artifact_heartbeat':
      return chars > 0
        ? `[OpenSpec] ${artifact} is still generating, elapsed ${elapsed}.`
        : `[OpenSpec] ${artifact} is still generating; waiting for model output, elapsed ${elapsed}.`;
    case 'artifact_model_complete':
      return `[OpenSpec] ${artifact} model output finished. Validating and writing the file.`;
    case 'artifact_complete':
      return `[OpenSpec] Wrote ${artifact} to ${event.outputPath}, elapsed ${elapsed}.`;
    case 'artifact_retry':
      return `[OpenSpec] ${artifact} failed validation; retrying: ${event.error ?? 'Unknown error'}`;
    case 'artifact_failed':
      return `[OpenSpec] ${artifact} failed: ${event.error ?? 'Unknown error'}`;
  }
}

export function estimateAutocodeOpenSpecGenerationProgress(event: OpenSpecArtifactProgress): number {
  const total = Math.max(1, event.totalArtifacts ?? 4);
  const artifactIndex = Math.min(Math.max(event.artifactIndex ?? 1, 1), total);
  const stageWeight = getAutocodeOpenSpecStageWeight(event.stage);

  return Math.round(5 + ((artifactIndex - 1 + stageWeight) / total) * 30);
}

export function estimateAutocodeOpenSpecOverallProgress(phaseProgress: number): number {
  const normalized = Math.max(5, Math.min(35, phaseProgress));
  return Math.round(5 + ((normalized - 5) / 30) * 10);
}

export function formatAutocodeOpenSpecArtifactName(event: OpenSpecArtifactProgress): string {
  if (event.artifactId === 'proposal') return 'proposal.md';
  if (event.artifactId === 'design') return 'design.md';
  if (event.artifactId === 'tasks') return 'tasks.md';
  if (event.artifactId === 'specs') return event.outputPath || `specs/${event.capability}/spec.md`;
  return event.outputPath || event.artifactId;
}

export function formatAutocodeOpenSpecArtifactPosition(event: OpenSpecArtifactProgress): string {
  if (!event.artifactIndex || !event.totalArtifacts) {
    return '';
  }
  return ` (${event.artifactIndex}/${event.totalArtifacts})`;
}

export function formatAutocodeDuration(elapsedMs: number | undefined): string {
  if (!elapsedMs || elapsedMs <= 0) {
    return '0s';
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function isAutocodeChineseLanguageName(language: unknown): boolean {
  const normalized = typeof language === 'string' ? language.toLowerCase().replace(/_/g, '-') : '';
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('chinese');
}

function getAutocodeOpenSpecStageWeight(stage: OpenSpecArtifactProgress['stage']): number {
  switch (stage) {
    case 'artifact_start':
      return 0.05;
    case 'artifact_model_start':
      return 0.15;
    case 'artifact_model_delta':
    case 'artifact_heartbeat':
      return 0.55;
    case 'artifact_model_complete':
      return 0.85;
    case 'artifact_complete':
      return 1;
    case 'artifact_retry':
    case 'artifact_failed':
      return 0.3;
  }
}
