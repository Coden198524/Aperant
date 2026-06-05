import { basename } from 'node:path';
import type { AutocodeSessionResult } from './agent-session-types.js';

export type AutocodeDirectSummaryLanguage = 'zh-CN' | 'fr' | string | undefined;

export interface AutocodeDirectCodingQualityMetrics {
  mode: 'direct';
  outcome: string;
  changedFiles: string[];
  filesChanged: number;
  stepsExecuted: number;
  toolCallCount: number;
  durationMs: number;
  recordedAt: string;
  selfCritique?: {
    status: 'passed' | 'failed' | 'skipped';
    score?: number;
    filesReviewed: number;
    improvements: string[];
  };
  validation: {
    status: 'not_run' | string;
    reason: string;
  };
}

export interface BuildAutocodeDirectCompletionSummaryInput {
  specDir: string;
  language?: AutocodeDirectSummaryLanguage;
  result?: AutocodeSessionResult;
  streamedText: string;
  quality?: AutocodeDirectCodingQualityMetrics;
}

export function isAutocodeSuccessfulDirectOutcome(
  result: AutocodeSessionResult | undefined,
): boolean {
  return result?.outcome === 'completed' || result?.outcome === 'max_steps';
}

export function getAutocodeFinalAssistantText(
  result: AutocodeSessionResult | undefined,
  streamedText: string,
): string {
  const finalAssistant = result?.messages
    ?.slice()
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim());
  return (finalAssistant?.content ?? streamedText).trim();
}

export function escapeAutocodeMarkdownTableCell(value: string): string {
  return value
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

export function localizeAutocodeDirectSummaryText(
  language: AutocodeDirectSummaryLanguage,
  en: string,
  zh: string,
  fr: string,
): string {
  if (language === 'zh-CN') return zh;
  if (language === 'fr') return fr;
  return en;
}

export function getAutocodeDirectSummaryLabels(language: AutocodeDirectSummaryLanguage): {
  item: string;
  details: string;
  whatChanged: string;
  verification: string;
  reviewNotes: string;
  changedFiles: string;
  quality: string;
} {
  if (language === 'zh-CN') {
    return {
      item: '项目',
      details: '内容',
      whatChanged: '修改内容',
      verification: '验证结果',
      reviewNotes: '审核要点',
      changedFiles: '变更文件',
      quality: 'AI 编码质量',
    };
  }
  if (language === 'fr') {
    return {
      item: 'Element',
      details: 'Details',
      whatChanged: 'Changements',
      verification: 'Verification',
      reviewNotes: 'Notes de revue',
      changedFiles: 'Fichiers modifies',
      quality: 'Qualite du codage IA',
    };
  }
  return {
    item: 'Item',
    details: 'Details',
    whatChanged: 'What changed',
    verification: 'Verification',
    reviewNotes: 'Review notes',
    changedFiles: 'Changed files',
    quality: 'AI coding quality',
  };
}

export function formatAutocodeChangedFilesForSummary(files: string[]): string {
  if (files.length === 0) {
    return 'No changed files detected.';
  }
  const preview = files.slice(0, 12).join('<br>');
  return files.length > 12 ? `${preview}<br>...and ${files.length - 12} more` : preview;
}

export function formatAutocodeDirectQualityLine(
  language: AutocodeDirectSummaryLanguage,
  quality?: AutocodeDirectCodingQualityMetrics,
): string {
  if (!quality) {
    return localizeAutocodeDirectSummaryText(
      language,
      'Quality metrics unavailable.',
      '质量指标不可用。',
      'Metriques qualite indisponibles.',
    );
  }
  const selfCritique = quality.selfCritique
    ? `${quality.selfCritique.status}${typeof quality.selfCritique.score === 'number' ? ` (${Math.round(quality.selfCritique.score * 100)}%)` : ''}, files reviewed: ${quality.selfCritique.filesReviewed}`
    : 'not run';
  return localizeAutocodeDirectSummaryText(
    language,
    `Files changed: ${quality.filesChanged}. Self-critique: ${selfCritique}. Validation: ${quality.validation.status} (${quality.validation.reason}).`,
    `变更文件：${quality.filesChanged}。自检：${selfCritique}。验证：${quality.validation.status}（${quality.validation.reason}）。`,
    `Fichiers modifies : ${quality.filesChanged}. Auto-critique : ${selfCritique}. Validation : ${quality.validation.status} (${quality.validation.reason}).`,
  );
}

export function formatAutocodeDirectQualityAppendix(
  language: AutocodeDirectSummaryLanguage,
  quality?: AutocodeDirectCodingQualityMetrics,
): string {
  const labels = getAutocodeDirectSummaryLabels(language);
  return [
    `| ${labels.item} | ${labels.details} |`,
    '| --- | --- |',
    `| ${labels.changedFiles} | ${escapeAutocodeMarkdownTableCell(formatAutocodeChangedFilesForSummary(quality?.changedFiles ?? []))} |`,
    `| ${labels.quality} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(language, quality))} |`,
    `| ${labels.reviewNotes} | ${escapeAutocodeMarkdownTableCell(localizeAutocodeDirectSummaryText(language, 'Direct mode has no staged QA pass; review the git diff before approval.', 'Direct 模式没有阶段化 QA 通过结论；批准前请检查 Git diff。', 'Le mode direct n a pas de validation QA par etapes ; relisez le diff Git avant approbation.'))} |`,
  ].join('\n');
}

export function buildAutocodeDirectCompletionSummary(
  input: BuildAutocodeDirectCompletionSummaryInput,
): string {
  const finalText = getAutocodeFinalAssistantText(input.result, input.streamedText);
  const qualityAppendix = formatAutocodeDirectQualityAppendix(input.language, input.quality);
  if (finalText) {
    return `${finalText}\n\n${qualityAppendix}`.trim();
  }

  const outcome = input.result?.outcome ?? 'unknown';
  const error = input.result?.error?.message;
  const labels = getAutocodeDirectSummaryLabels(input.language);
  const reviewNote = isAutocodeSuccessfulDirectOutcome(input.result)
    ? localizeAutocodeDirectSummaryText(
        input.language,
        'Direct mode skipped staged spec, implementation planning, and QA. Review the completion summary, runtime log, and git changes manually before approval.',
        'Direct 模式跳过了阶段化规格、实现计划和 QA。人工确认前请检查完成总结、运行日志和 Git 变更。',
        'Le mode direct a ignore la specification par etapes, le plan de mise en oeuvre et la QA. Relisez le resume, les journaux et les changements Git avant approbation.',
      )
    : localizeAutocodeDirectSummaryText(
        input.language,
        `Direct mode ended with outcome "${outcome}".${error ? ` Error: ${error}` : ''}`,
        `Direct 模式结束，结果为 "${outcome}"。${error ? ` 错误：${error}` : ''}`,
        `Le mode direct s'est termine avec le resultat "${outcome}".${error ? ` Erreur : ${error}` : ''}`,
      );

  return [
    `| ${labels.item} | ${labels.details} |`,
    '| --- | --- |',
    `| ${labels.whatChanged} | ${escapeAutocodeMarkdownTableCell(localizeAutocodeDirectSummaryText(input.language, `Direct model session finished for ${basename(input.specDir)}.`, `Direct 模式已完成：${basename(input.specDir)}。`, `Session en mode direct terminee pour ${basename(input.specDir)}.`))} |`,
    `| ${labels.changedFiles} | ${escapeAutocodeMarkdownTableCell(formatAutocodeChangedFilesForSummary(input.quality?.changedFiles ?? []))} |`,
    `| ${labels.verification} | ${escapeAutocodeMarkdownTableCell(localizeAutocodeDirectSummaryText(input.language, `Session outcome: ${outcome}. Steps: ${input.result?.stepsExecuted ?? 0}. Tools: ${input.result?.toolCallCount ?? 0}.`, `会话结果：${outcome}。步骤：${input.result?.stepsExecuted ?? 0}。工具调用：${input.result?.toolCallCount ?? 0}。`, `Resultat de session : ${outcome}. Etapes : ${input.result?.stepsExecuted ?? 0}. Outils : ${input.result?.toolCallCount ?? 0}.`))} |`,
    `| ${labels.quality} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(input.language, input.quality))} |`,
    `| ${labels.reviewNotes} | ${escapeAutocodeMarkdownTableCell(reviewNote)} |`,
  ].join('\n');
}

export function buildAutocodeDirectCompletionSummaryV2(
  input: BuildAutocodeDirectCompletionSummaryInput,
): string {
  return buildAutocodeDirectCompletionSummary(input);
}

export function extractAutocodeDirectTaskDescription(input: {
  initialMessages?: Array<{ content?: string }>;
  specDir: string;
}): string {
  const initialMessage = input.initialMessages?.[0]?.content?.trim();
  if (initialMessage) {
    return initialMessage.length > 2000 ? `${initialMessage.slice(0, 2000)}...` : initialMessage;
  }
  return `Direct model execution for ${basename(input.specDir)}`;
}

export function extractAutocodeDirectFilePathFromToolArgs(
  args: Record<string, unknown>,
): string | null {
  const candidates = [
    args.file_path,
    args.filePath,
    args.path,
    args.target_file,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function shouldTrackAutocodeDirectModifiedFile(toolName: string): boolean {
  return ['Edit', 'Write', 'MultiEdit', 'create_file', 'replace_file', 'write_file'].includes(toolName);
}
