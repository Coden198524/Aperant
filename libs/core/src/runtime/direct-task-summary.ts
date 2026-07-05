import { basename } from 'node:path';
import type { AutocodeSessionResult } from './agent-session-types.js';
import { foldRepeatedAutocodePromptLines } from './prompt-context.js';

export type AutocodeDirectSummaryLanguage = 'zh-CN' | 'fr' | string | undefined;
export const AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS = 4_000;
export const AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS = 2_000;
const DIRECT_FINAL_TEXT_TRUNCATION_MARKER =
  '\n\n...[direct final response middle omitted for summary budget; inspect runtime logs if exact omitted detail is required]...\n\n';
const DIRECT_TASK_DESCRIPTION_TRUNCATION_MARKER =
  '\n...[direct task middle omitted for summary budget; inspect task metadata if exact omitted detail is required]...\n';

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

export interface AutocodeDirectQualityGateOptions {
  requireValidation?: boolean;
}

export interface BuildAutocodeDirectCompletionSummaryInput {
  specDir: string;
  language?: AutocodeDirectSummaryLanguage;
  result?: AutocodeSessionResult;
  streamedText: string;
  quality?: AutocodeDirectCodingQualityMetrics;
}

export interface BuildAutocodeDirectExecutionMetadataInput {
  existing?: Record<string, unknown> | null;
  outcome: string;
  completedAt: string;
  summaryFile?: string;
  currentSubtaskId: string;
  quality?: AutocodeDirectCodingQualityMetrics;
}

export function buildAutocodeDirectExecutionMetadata(
  input: BuildAutocodeDirectExecutionMetadataInput,
): Record<string, unknown> {
  return {
    ...(input.existing ?? {}),
    enabled: true,
    outcome: input.outcome,
    completed_at: input.completedAt,
    summary_file: input.summaryFile ?? 'direct_summary.md',
    current_subtask_id: input.currentSubtaskId,
    ai_coding_quality: input.quality,
  };
}


export function isAutocodeSuccessfulDirectOutcome(
  result: AutocodeSessionResult | undefined,
): boolean {
  return result?.outcome === 'completed' || result?.outcome === 'max_steps';
}

export function getAutocodeDirectQualityGateFailureReason(
  quality: AutocodeDirectCodingQualityMetrics | undefined,
  options: AutocodeDirectQualityGateOptions = {},
): string | null {
  if (!quality) {
    return null;
  }

  if (quality.selfCritique?.status === 'failed') {
    const improvements = quality.selfCritique.improvements
      .slice(0, 3)
      .map((item) => item.trim())
      .filter(Boolean)
      .join('; ');
    return `Direct self-critique failed${improvements ? `: ${improvements}` : ': quality score below threshold'}`;
  }

  if (quality.validation.status === 'reported_failed' || quality.validation.status === 'reported_mixed') {
    return `Direct validation ${quality.validation.status}: ${quality.validation.reason}`;
  }

  if (options.requireValidation === true && !isAutocodeDirectValidationPassed(quality.validation.status)) {
    return `Direct validation ${quality.validation.status}: ${quality.validation.reason}`;
  }

  return null;
}

function isAutocodeDirectValidationPassed(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === 'reported_passed' ||
    normalized === 'passed' ||
    normalized === 'pass' ||
    normalized === 'success' ||
    normalized === 'succeeded';
}

export function isAutocodeDirectQualityGatePassed(
  quality: AutocodeDirectCodingQualityMetrics | undefined,
  options: AutocodeDirectQualityGateOptions = {},
): boolean {
  return getAutocodeDirectQualityGateFailureReason(quality, options) === null;
}

export function inferAutocodeDirectValidationEvidence(
  result: AutocodeSessionResult | undefined,
  streamedText = '',
): AutocodeDirectCodingQualityMetrics['validation'] {
  const validationText = extractAutocodeDirectValidationText(
    getAutocodeFinalAssistantText(result, streamedText),
  );

  if (!validationText) {
    return {
      status: 'not_run',
      reason: 'No validation command or result was reported in the Direct final response.',
    };
  }

  const hasPass = /\b(?:passed|pass|succeeded|success|green|ok)\b/i.test(validationText)
    || /(?:通过|成功|正常|无异常)/u.test(validationText);
  const hasFail = /\b(?:failed|failing|failure|error|errors|exception|red)\b/i.test(validationText)
    || /(?:失败|未通过|报错|错误|异常)/u.test(validationText);
  const hasSkip = /\b(?:not run|not executed|skipped|manual only|not required|n\/a)\b/i.test(validationText)
    || /(?:未运行|未执行|跳过|未验证|无需验证|手动验证)/u.test(validationText);
  const reason = compactAutocodeDirectValidationReason(validationText);
  if (hasPass && hasFail) {
    return { status: 'reported_mixed', reason };
  }
  if (hasFail) {
    return { status: 'reported_failed', reason };
  }
  if (hasPass) {
    return { status: 'reported_passed', reason };
  }
  if (hasSkip) {
    return { status: 'not_run', reason };
  }
  return { status: 'reported', reason };
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
  result?: AutocodeSessionResult,
): string {
  const labels = getAutocodeDirectSummaryLabels(language);
  return [
    `| ${labels.item} | ${labels.details} |`,
    '| --- | --- |',
    `| ${labels.changedFiles} | ${escapeAutocodeMarkdownTableCell(formatAutocodeChangedFilesForSummary(quality?.changedFiles ?? []))} |`,
    `| ${labels.verification} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectSessionEvidenceLine(language, result))} |`,
    `| ${labels.quality} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(language, quality))} |`,
    `| ${labels.reviewNotes} | ${escapeAutocodeMarkdownTableCell(localizeAutocodeDirectSummaryText(language, 'Direct mode has no staged QA pass; review the git diff before approval.', 'Direct 模式没有阶段化 QA 通过结论；批准前请检查 Git diff。', 'Le mode direct n a pas de validation QA par etapes ; relisez le diff Git avant approbation.'))} |`,
  ].join('\n');
}

export function buildAutocodeDirectCompletionSummary(
  input: BuildAutocodeDirectCompletionSummaryInput,
): string {
  const finalText = getAutocodeFinalAssistantText(input.result, input.streamedText);
  const qualityAppendix = formatAutocodeDirectQualityAppendix(input.language, input.quality, input.result);
  if (finalText) {
    return `${limitAutocodeDirectFinalText(finalText)}\n\n${qualityAppendix}`.trim();
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
    `| ${labels.verification} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectSessionEvidenceLine(input.language, input.result))} |`,
    `| ${labels.quality} | ${escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(input.language, input.quality))} |`,
    `| ${labels.reviewNotes} | ${escapeAutocodeMarkdownTableCell(reviewNote)} |`,
  ].join('\n');
}

export function buildAutocodeDirectCompletionSummaryV2(
  input: BuildAutocodeDirectCompletionSummaryInput,
): string {
  return buildAutocodeDirectCompletionSummary(input);
}

function limitAutocodeDirectFinalText(value: string): string {
  const normalized = normalizeAutocodeDirectSummaryText(value);
  if (normalized.length <= AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS) {
    return normalized;
  }
  const budget = Math.max(0, AUTOCODE_DIRECT_FINAL_TEXT_MAX_CHARS - DIRECT_FINAL_TEXT_TRUNCATION_MARKER.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    DIRECT_FINAL_TEXT_TRUNCATION_MARKER,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}

function formatAutocodeDirectSessionEvidenceLine(
  language: AutocodeDirectSummaryLanguage,
  result?: AutocodeSessionResult,
): string {
  if (!result) {
    return localizeAutocodeDirectSummaryText(
      language,
      'Session outcome unavailable. Tokens: unavailable.',
      'Session outcome unavailable. Tokens: unavailable.',
      'Resultat de session indisponible. Tokens : indisponibles.',
    );
  }

  const base = localizeAutocodeDirectSummaryText(
    language,
    `Session outcome: ${result.outcome}. Steps: ${result.stepsExecuted ?? 0}. Tools: ${result.toolCallCount ?? 0}.`,
    `Session outcome: ${result.outcome}. Steps: ${result.stepsExecuted ?? 0}. Tools: ${result.toolCallCount ?? 0}.`,
    `Resultat de session : ${result.outcome}. Etapes : ${result.stepsExecuted ?? 0}. Outils : ${result.toolCallCount ?? 0}.`,
  );
  const usage = formatAutocodeDirectTokenUsage(result.usage);
  return usage ? `${base} ${usage}` : `${base} Tokens: unavailable.`;
}

function formatAutocodeDirectTokenUsage(usage: AutocodeSessionResult['usage'] | undefined): string | null {
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const estimated = usage.estimated ? ', estimated' : '';
  return `Tokens: ${usage.totalTokens} total (${usage.promptTokens} prompt, ${usage.completionTokens} completion${estimated}).`;
}

export function extractAutocodeDirectTaskDescription(input: {
  initialMessages?: Array<{ content?: string }>;
  specDir: string;
}): string {
  const initialMessage = input.initialMessages?.[0]?.content
    ?.replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (initialMessage) {
    return limitAutocodeDirectTaskDescription(initialMessage);
  }
  return `Direct model execution for ${basename(input.specDir)}`;
}

function limitAutocodeDirectTaskDescription(value: string): string {
  const normalized = normalizeAutocodeDirectSummaryText(value);
  if (normalized.length <= AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }
  const budget = Math.max(0, AUTOCODE_DIRECT_TASK_DESCRIPTION_MAX_CHARS - DIRECT_TASK_DESCRIPTION_TRUNCATION_MARKER.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    DIRECT_TASK_DESCRIPTION_TRUNCATION_MARKER,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}

function normalizeAutocodeDirectSummaryText(value: string): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return foldRepeatedAutocodePromptLines(normalized).trim();
}

function extractAutocodeDirectValidationText(value: string): string {
  const normalized = normalizeAutocodeDirectSummaryText(value);
  if (!normalized) {
    return '';
  }

  const relevantLines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && isAutocodeDirectValidationLine(line));

  if (relevantLines.length === 0) {
    return '';
  }

  return relevantLines.slice(-4).join('\n');
}

function isAutocodeDirectValidationLine(line: string): boolean {
  return /\b(?:verification|validation|verified|test(?:ed|s)?|build|typecheck|tsc|lint|compile|check|pytest|vitest|jest|npm|pnpm|yarn|dotnet|cargo|go test)\b/i.test(line)
    || /(?:验证|测试|构建|编译|检查|通过|失败|未运行|未执行|未验证)/u.test(line);
}

function compactAutocodeDirectValidationReason(value: string): string {
  const compact = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
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
