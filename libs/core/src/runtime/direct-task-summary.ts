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
  requireSelfCritique?: boolean;
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
  completedAt?: string;
  summaryFile?: string;
  currentSubtaskId: string;
  quality?: AutocodeDirectCodingQualityMetrics;
}

export interface AutocodeDirectPlanLifecycleState {
  status: 'human_review' | 'error';
  planStatus: 'review' | 'error';
  reviewReason: 'completed' | 'errors';
  xstateState: 'human_review' | 'error';
  executionPhase: 'complete' | 'failed';
}

export function buildAutocodeDirectPlanLifecycleState(success: boolean): AutocodeDirectPlanLifecycleState {
  return success
    ? {
        status: 'human_review',
        planStatus: 'review',
        reviewReason: 'completed',
        xstateState: 'human_review',
        executionPhase: 'complete',
      }
    : {
        status: 'error',
        planStatus: 'error',
        reviewReason: 'errors',
        xstateState: 'error',
        executionPhase: 'failed',
      };
}

export function buildAutocodeDirectExecutionMetadata(
  input: BuildAutocodeDirectExecutionMetadataInput,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...(input.existing ?? {}),
    enabled: true,
    outcome: input.outcome,
    summary_file: input.summaryFile ?? 'direct_summary.md',
    current_subtask_id: input.currentSubtaskId,
    ai_coding_quality: input.quality,
  };
  if (input.completedAt) {
    metadata.completed_at = input.completedAt;
  } else {
    delete metadata.completed_at;
  }
  return metadata;
}

export function isAutocodeSuccessfulDirectOutcome(
  result: AutocodeSessionResult | undefined,
): boolean {
  return result?.outcome === 'completed';
}

export function getAutocodeDirectQualityGateFailureReason(
  quality: AutocodeDirectCodingQualityMetrics | undefined,
  options: AutocodeDirectQualityGateOptions = {},
): string | null {
  if (!quality) {
    return null;
  }

  if (options.requireSelfCritique !== false && quality.selfCritique?.status === 'failed') {
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

export interface AutocodeDirectValidationRequirementInput {
  plan?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  description?: string;
}

export function shouldRequireAutocodeDirectValidation(
  input: AutocodeDirectValidationRequirementInput,
): boolean {
  return !isAutocodeNonImplementationDirectContext(input);
}

export function isAutocodeNonImplementationDirectContext(
  input: AutocodeDirectValidationRequirementInput,
): boolean {
  const plan = directSummaryRecordValue(input.plan);
  const metadata = directSummaryRecordValue(input.metadata);
  const currentRequestText = [
    input.description,
    directSummaryStringValue(metadata.task_description),
    directSummaryStringValue(metadata.description),
    directSummaryStringValue(metadata.title),
    directSummaryStringValue(metadata.taskTitle),
    directSummaryStringValue(metadata.task_title),
  ].filter(Boolean).join('\n');
  const planRequestText = [
    directSummaryStringValue(plan.title),
    directSummaryStringValue(plan.feature),
  ].filter(Boolean).join('\n');
  const requestText = [currentRequestText, planRequestText].filter(Boolean).join('\n');
  if (hasAutocodeDirectImplementationRequestSignal(currentRequestText)) {
    return false;
  }
  const workflowType = directSummaryNormalizedString(plan.workflow_type) ||
    directSummaryNormalizedString(metadata.workflow_type) ||
    directSummaryNormalizedString(metadata.workflowType);
  const metadataCategory = directSummaryNormalizedString(metadata.category);
  const metadataSource = directSummaryNormalizedString(metadata.sourceType) || directSummaryNormalizedString(metadata.source_type);
  const metadataIdeaType = directSummaryNormalizedString(metadata.ideationType) || directSummaryNormalizedString(metadata.ideation_type);
  const metadataTaskType = directSummaryNormalizedString(metadata.taskType) || directSummaryNormalizedString(metadata.task_type) || directSummaryNormalizedString(metadata.type);
  const hasProjectDocumentationMetadata = (
    directSummaryStringValue(metadata.projectDocumentType) ||
    directSummaryStringValue(metadata.project_document_type) ||
    directSummaryStringValue(metadata.projectDocumentOutputDir) ||
    directSummaryStringValue(metadata.project_document_output_dir) ||
    Array.isArray(metadata.projectDocumentOutputs) ||
    Array.isArray(metadata.project_document_outputs)
  );
  const hasProjectDocumentationPlan = (
    directSummaryStringValue(plan.documentation_depth) ||
    directSummaryStringValue(plan.documentation_profile) ||
    Array.isArray(plan.documentation_focus) ||
    Object.keys(directSummaryRecordValue(plan.project_documentation)).length > 0
  );
  const hasExplicitNonImplementationClassification =
    ['documentation', 'investigation', 'analysis', 'research'].includes(workflowType) ||
    metadataCategory === 'documentation' ||
    metadataSource === 'project_docs' ||
    ['documentation_gaps', 'documentation', 'analysis', 'investigation', 'research'].includes(metadataIdeaType) ||
    ['documentation', 'analysis', 'investigation', 'research'].includes(metadataTaskType) ||
    Boolean(hasProjectDocumentationMetadata) ||
    Boolean(hasProjectDocumentationPlan);
  const hasExistingDesignContract = hasAutocodeExistingDesignContract(plan);
  const currentNonImplementationRequest = isAutocodeNonImplementationDirectRequestText(
    currentRequestText,
  );
  if (
    currentNonImplementationRequest &&
    !(hasExistingDesignContract && isAutocodeAmbiguousReviewOnlyRequestText(currentRequestText))
  ) {
    return true;
  }
  if (hasExplicitNonImplementationClassification && currentRequestText.trim()) {
    return true;
  }
  if (hasAutocodeDirectImplementationRequestSignal(planRequestText)) {
    return false;
  }
  if (hasExplicitNonImplementationClassification) {
    return true;
  }

  const nonImplementationRequest = isAutocodeNonImplementationDirectRequestText(requestText);
  if (
    nonImplementationRequest &&
    hasExistingDesignContract &&
    isAutocodeAmbiguousReviewOnlyRequestText(requestText)
  ) {
    return false;
  }
  return nonImplementationRequest;
}

function isAutocodeNonImplementationDirectRequestText(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  if (hasAutocodeDirectImplementationRequestSignal(text)) {
    return false;
  }

  const classificationText = stripAutocodeDirectNegatedRequestClauses(text);
  const englishPattern = /\b(?:analy[sz]e|analysis|investigate|investigation|research|audit|review|explain|summari[sz]e|summary|report|write[-\s]?up|documentation|docs?|document)\b/iu;
  const chinesePattern = /(?:\u5206\u6790|\u8c03\u67e5|\u8c03\u7814|\u7814\u7a76|\u5ba1\u8ba1|\u590d\u6838|\u89e3\u91ca|\u8bf4\u660e|\u603b\u7ed3|\u62a5\u544a|\u6587\u6863|\u68b3\u7406|\u5b9a\u4f4d\u539f\u56e0|\u539f\u56e0\u5206\u6790|\u4e3a\u4ec0\u4e48|\u4e3a\u5565)/u;
  return englishPattern.test(classificationText) || chinesePattern.test(classificationText);
}

function hasAutocodeDirectImplementationRequestSignal(text: string): boolean {
  // Code/implementation nouns are common in analysis and documentation requests. Only an
  // affirmative implementation action overrides an explicit non-implementation classification.
  const actionText = stripAutocodeDirectNegatedRequestClauses(text);
  return /\b(?:fix(?:es|ed|ing)?|repair(?:s|ed|ing)?|resolve(?:s|d|ing)?|implement(?:s|ing)?|patch(?:es|ed|ing)?|refactor(?:s|ed|ing)?|bugfix)\b/iu.test(actionText) ||
    /\b(?:must|should|needs?\s+to|has\s+to|required\s+to)\s+(?:be\s+)?implemented\b/iu.test(actionText) ||
    /\b(?:write|change|modify|edit|update)\s+(?:(?:the|this|that|product|application|source|production)\s+){0,3}(?:code|source files?|implementation)\b/iu.test(actionText) ||
    /\b(?:code|coding)\s+(?:this|that|the|a|an|it|feature|fix|change|solution|implementation|task)\b/iu.test(actionText) ||
    /\b(?:write|add|create|build|develop|change|modify|edit|update|rewrite|remove|delete|replace|generate)\s+(?:(?:a|an|the|this|that|new)\s+)?(?:[\p{L}\p{N}_-]+\s+){0,2}(?:feature|functionality|dashboard|generator|upload|component|module|class|method|function|endpoint|api|service|handler|workflow|pipeline|integration|command|cli|ipc|route|schema|migration|site|tests?)\b(?=\s*(?:$|[.,!?:;]|\b(?:in|for|using|with|to|from|under|inside|that|which)\b))/iu.test(actionText) ||
    /\b(?:change|modify|edit|update|rewrite|remove|delete|replace)\s+(?:(?:the|this|that|a|an)\s+)?[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|swift|php|rb|vue|svelte)\b/iu.test(actionText) ||
    /(?:\u4fee\u590d|\u91cd\u6784|\u6539\u4ee3\u7801|\u4ee3\u7801\u4fee\u6539|(?:\u4fee\u6539|\u66f4\u65b0|\u7f16\u8f91|\u6539\u52a8)(?:\u4ea7\u54c1|\u5e94\u7528|\u9879\u76ee)?(?:\u6e90\u4ee3\u7801|\u6e90\u7801|\u4ee3\u7801|\u7a0b\u5e8f|\u6e90\u6587\u4ef6)|\u7f16\u5199\u4ee3\u7801|\u8fdb\u884c\u7f16\u7801|\u5f00\u59cb\u7f16\u7801|\u7ee7\u7eed\u7f16\u7801|\u7f16\u7801\u5b9e\u73b0|(?:\u6dfb\u52a0|\u65b0\u589e|\u521b\u5efa|\u6784\u5efa|\u5f00\u53d1|\u91cd\u5199|\u5220\u9664|\u79fb\u9664|\u66ff\u6362|\u751f\u6210)[\u4e00-\u9fffA-Za-z0-9_-]{0,12}(?:\u529f\u80fd|\u7ec4\u4ef6|\u6a21\u5757|\u7c7b|\u65b9\u6cd5|\u51fd\u6570|\u63a5\u53e3|\u670d\u52a1|\u5904\u7406\u5668|\u5de5\u4f5c\u6d41|\u6d41\u6c34\u7ebf|\u96c6\u6210|\u547d\u4ee4|\u811a\u672c|CLI|IPC|\u8def\u7531|\u6a21\u5f0f|\u6570\u636e\u5e93|\u67b6\u6784|\u8fc1\u79fb|\u7ad9\u70b9|\u7f51\u7ad9|\u9875\u9762|\u754c\u9762|\u6309\u94ae|\u5b57\u6bb5|\u6d4b\u8bd5|\u751f\u6210\u5668|\u63d2\u4ef6)(?=$|[\s\uff0c\u3002\uff01\uff1f\uff1b\uff1a,!?;:]|\u5e76|\u7136\u540e|\u540c\u65f6|\u5e76\u4e14|\u4ee5\u53ca|\u4ee5\u4fbf|\u7528\u4e8e|\u6765|\u5230|\u5728|\u4e3a)|(?:\u8bf7|\u9700\u8981|\u5fc5\u987b|\u5e94\u5f53|\u7136\u540e|\u5e76|\u540c\u65f6|\u5f00\u59cb|\u7ee7\u7eed)\u5b9e\u73b0(?!\u65b9\u6848(?:\u6587\u6863)?|\u7ec6\u8282|\u539f\u7406|\u5206\u6790|\u8bf4\u660e|\u6587\u6863)|(?:^|[\n\u3002\uff01\uff1f\uff1b;])\s*\u5b9e\u73b0(?!\u65b9\u6848(?:\u6587\u6863)?|\u7ec6\u8282|\u539f\u7406|\u5206\u6790|\u8bf4\u660e|\u6587\u6863))/u.test(actionText);
}

function stripAutocodeDirectNegatedRequestClauses(text: string): string {
  return text
    .replace(
      /\b(?:do not|don't|does not|doesn't|should not|shouldn't|must not|mustn't|need not|not required to|no need to|without)\b[^\n.!?:;,\uff0c]{0,160}/giu,
      ' ',
    )
    .replace(/(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u9700\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\n\u3002\uff01\uff1f\uff1a\uff1b:;,\uff0c]{0,160}/gu, ' ');
}

function hasAutocodeExistingDesignContract(plan: Record<string, unknown>): boolean {
  const sourceTask = directSummaryRecordValue(plan.source_task);
  return Object.keys(directSummaryRecordValue(sourceTask.design_contract)).length > 0 ||
    Object.keys(directSummaryRecordValue(plan.design_contract)).length > 0;
}

function isAutocodeAmbiguousReviewOnlyRequestText(text: string): boolean {
  const classificationText = stripAutocodeDirectNegatedRequestClauses(text);
  const hasReviewSignal = /\breview\b/iu.test(classificationText) || /\u590d\u6838/u.test(classificationText);
  const hasOtherNonImplementationSignal = /\b(?:analy[sz]e|analysis|investigate|investigation|research|audit|explain|summari[sz]e|summary|report|write[-\s]?up|documentation|docs?|document)\b/iu.test(classificationText) ||
    /(?:\u5206\u6790|\u8c03\u67e5|\u8c03\u7814|\u7814\u7a76|\u5ba1\u8ba1|\u89e3\u91ca|\u8bf4\u660e|\u603b\u7ed3|\u62a5\u544a|\u6587\u6863|\u68b3\u7406|\u5b9a\u4f4d\u539f\u56e0|\u539f\u56e0\u5206\u6790|\u4e3a\u4ec0\u4e48|\u4e3a\u5565)/u.test(classificationText);
  return hasReviewSignal && !hasOtherNonImplementationSignal;
}

function directSummaryRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function directSummaryStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function directSummaryNormalizedString(value: unknown): string {
  return directSummaryStringValue(value).toLowerCase();
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

  const hasPass = hasAutocodeDirectValidationPassSignal(validationText);
  const hasFail = hasAutocodeDirectValidationFailSignal(validationText);
  const hasSkip = /\b(?:not run|not executed|skipped|manual only|not required|n\/a)\b/i.test(validationText) ||
    /(?:\u672a\u8fd0\u884c|\u672a\u6267\u884c|\u8df3\u8fc7|\u672a\u9a8c\u8bc1|\u65e0\u9700\u9a8c\u8bc1|\u624b\u52a8\u9a8c\u8bc1)/u.test(validationText);
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
      item: '\u9879\u76ee',
      details: '\u5185\u5bb9',
      whatChanged: '\u4fee\u6539\u5185\u5bb9',
      verification: '\u9a8c\u8bc1\u7ed3\u679c',
      reviewNotes: '\u5ba1\u6838\u8981\u70b9',
      changedFiles: '\u53d8\u66f4\u6587\u4ef6',
      quality: 'AI \u7f16\u7801\u8d28\u91cf',
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
      '\u8d28\u91cf\u6307\u6807\u4e0d\u53ef\u7528\u3002',
      'Metriques qualite indisponibles.',
    );
  }
  const selfCritique = quality.selfCritique
    ? quality.selfCritique.status +
      (typeof quality.selfCritique.score === 'number' ? ' (' + Math.round(quality.selfCritique.score * 100) + '%)' : '') +
      ', files reviewed: ' + quality.selfCritique.filesReviewed
    : 'not run';
  const line = 'Files changed: ' + quality.filesChanged +
    '. Self-critique: ' + selfCritique +
    '. Validation: ' + quality.validation.status + ' (' + quality.validation.reason + ').';
  const zhLine = '\u53d8\u66f4\u6587\u4ef6\uff1a' + quality.filesChanged +
    '\u3002\u81ea\u68c0\uff1a' + selfCritique +
    '\u3002\u9a8c\u8bc1\uff1a' + quality.validation.status + ' (' + quality.validation.reason + ')\u3002';
  return localizeAutocodeDirectSummaryText(
    language,
    line,
    zhLine,
    'Fichiers modifies : ' + quality.filesChanged + '. Auto-critique : ' + selfCritique + '. Validation : ' + quality.validation.status + ' (' + quality.validation.reason + ').',
  );
}

export function formatAutocodeDirectQualityAppendix(
  language: AutocodeDirectSummaryLanguage,
  quality?: AutocodeDirectCodingQualityMetrics,
  result?: AutocodeSessionResult,
): string {
  const labels = getAutocodeDirectSummaryLabels(language);
  return [
    '| ' + labels.item + ' | ' + labels.details + ' |',
    '| --- | --- |',
    '| ' + labels.changedFiles + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeChangedFilesForSummary(quality?.changedFiles ?? [])) + ' |',
    '| ' + labels.verification + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeDirectSessionEvidenceLine(language, result)) + ' |',
    '| ' + labels.quality + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(language, quality)) + ' |',
    '| ' + labels.reviewNotes + ' | ' + escapeAutocodeMarkdownTableCell(localizeAutocodeDirectSummaryText(
      language,
      'Direct mode has no staged QA pass; review the git diff before approval.',
      'Direct \u6a21\u5f0f\u6ca1\u6709\u9636\u6bb5\u5316 QA \u901a\u8fc7\u7ed3\u8bba\uff1b\u6279\u51c6\u524d\u8bf7\u68c0\u67e5 Git diff\u3002',
      'Le mode direct n a pas de validation QA par etapes ; relisez le diff Git avant approbation.',
    )) + ' |',
  ].join('\n');
}

export function buildAutocodeDirectCompletionSummary(
  input: BuildAutocodeDirectCompletionSummaryInput,
): string {
  const finalText = getAutocodeFinalAssistantText(input.result, input.streamedText);
  const qualityAppendix = formatAutocodeDirectQualityAppendix(input.language, input.quality, input.result);
  if (finalText) {
    return (limitAutocodeDirectFinalText(finalText) + '\n\n' + qualityAppendix).trim();
  }

  const outcome = input.result?.outcome ?? 'unknown';
  const error = input.result?.error?.message;
  const labels = getAutocodeDirectSummaryLabels(input.language);
  const reviewNote = isAutocodeSuccessfulDirectOutcome(input.result)
    ? localizeAutocodeDirectSummaryText(
        input.language,
        'Direct mode skipped staged spec, implementation planning, and QA. Review the completion summary, runtime log, and git changes manually before approval.',
        'Direct \u6a21\u5f0f\u8df3\u8fc7\u4e86\u9636\u6bb5\u5316\u89c4\u683c\u3001\u5b9e\u73b0\u8ba1\u5212\u548c QA\u3002\u4eba\u5de5\u786e\u8ba4\u524d\u8bf7\u68c0\u67e5\u5b8c\u6210\u603b\u7ed3\u3001\u8fd0\u884c\u65e5\u5fd7\u548c Git \u53d8\u66f4\u3002',
        'Le mode direct a ignore la specification par etapes, le plan de mise en oeuvre et la QA. Relisez le resume, les journaux et les changements Git avant approbation.',
      )
    : localizeAutocodeDirectSummaryText(
        input.language,
        'Direct mode ended with outcome "' + outcome + '".' + (error ? ' Error: ' + error : ''),
        'Direct \u6a21\u5f0f\u7ed3\u675f\uff0c\u7ed3\u679c\u4e3a "' + outcome + '"\u3002' + (error ? ' \u9519\u8bef\uff1a' + error : ''),
        'Le mode direct est termine avec le resultat "' + outcome + '".' + (error ? ' Erreur : ' + error : ''),
      );

  const specName = basename(input.specDir);
  const successful = isAutocodeSuccessfulDirectOutcome(input.result);
  const whatChanged = successful
    ? localizeAutocodeDirectSummaryText(
        input.language,
        'Direct model session completed for ' + specName + '.',
        'Direct \u6a21\u5f0f\u5df2\u5b8c\u6210\uff1a' + specName + '\u3002',
        'Session en mode direct terminee pour ' + specName + '.',
      )
    : localizeAutocodeDirectSummaryText(
        input.language,
        'Direct model session ended with outcome "' + outcome + '" for ' + specName + '.',
        'Direct \u6a21\u5f0f\u7ed3\u675f\uff0c\u7ed3\u679c\u4e3a "' + outcome + '"\uff1a' + specName + '\u3002',
        'Session en mode direct terminee avec le resultat "' + outcome + '" pour ' + specName + '.',
      );
  return [
    '| ' + labels.item + ' | ' + labels.details + ' |',
    '| --- | --- |',
    '| ' + labels.whatChanged + ' | ' + escapeAutocodeMarkdownTableCell(whatChanged) + ' |',
    '| ' + labels.changedFiles + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeChangedFilesForSummary(input.quality?.changedFiles ?? [])) + ' |',
    '| ' + labels.verification + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeDirectSessionEvidenceLine(input.language, input.result)) + ' |',
    '| ' + labels.quality + ' | ' + escapeAutocodeMarkdownTableCell(formatAutocodeDirectQualityLine(input.language, input.quality)) + ' |',
    '| ' + labels.reviewNotes + ' | ' + escapeAutocodeMarkdownTableCell(reviewNote) + ' |',
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
      '\u4f1a\u8bdd\u7ed3\u679c\u4e0d\u53ef\u7528\u3002Token\uff1a\u4e0d\u53ef\u7528\u3002',
      'Resultat de session indisponible. Tokens : indisponibles.',
    );
  }

  const base = localizeAutocodeDirectSummaryText(
    language,
    'Session outcome: ' + result.outcome + '. Steps: ' + (result.stepsExecuted ?? 0) + '. Tools: ' + (result.toolCallCount ?? 0) + '.',
    '\u4f1a\u8bdd\u7ed3\u679c\uff1a' + result.outcome + '\u3002\u6b65\u6570\uff1a' + (result.stepsExecuted ?? 0) + '\u3002\u5de5\u5177\uff1a' + (result.toolCallCount ?? 0) + '\u3002',
    'Resultat de session : ' + result.outcome + '. Etapes : ' + (result.stepsExecuted ?? 0) + '. Outils : ' + (result.toolCallCount ?? 0) + '.',
  );
  const usage = formatAutocodeDirectTokenUsage(language, result.usage);
  const unavailable = localizeAutocodeDirectSummaryText(
    language,
    'Tokens: unavailable.',
    'Token\uff1a\u4e0d\u53ef\u7528\u3002',
    'Tokens : indisponibles.',
  );
  return usage ? base + ' ' + usage : base + ' ' + unavailable;
}

function formatAutocodeDirectTokenUsage(
  language: AutocodeDirectSummaryLanguage,
  usage: AutocodeSessionResult['usage'] | undefined,
): string | null {
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const estimated = usage.estimated ? ', estimated' : '';
  const en = 'Tokens: ' + usage.totalTokens + ' total (' + usage.promptTokens + ' prompt, ' + usage.completionTokens + ' completion' + estimated + ').';
  const zhEstimated = usage.estimated ? '\uff0c\u4f30\u7b97' : '';
  const zh = 'Token\uff1a' + usage.totalTokens + ' \u603b\u8ba1\uff08' + usage.promptTokens + ' prompt\uff0c' + usage.completionTokens + ' completion' + zhEstimated + '\uff09\u3002';
  const fr = 'Tokens : ' + usage.totalTokens + ' au total (' + usage.promptTokens + ' prompt, ' + usage.completionTokens + ' completion' + estimated + ').';
  return localizeAutocodeDirectSummaryText(language, en, zh, fr);
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
  return /\b(?:verification|validation|verified|test(?:ed|s)?|build|typecheck|tsc|lint|compile|check|pytest|vitest|jest|npm|pnpm|yarn|dotnet|cargo|go test)\b/i.test(line) ||
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u6784\u5efa|\u7f16\u8bd1|\u68c0\u67e5|\u901a\u8fc7|\u5931\u8d25|\u672a\u8fd0\u884c|\u672a\u6267\u884c|\u672a\u9a8c\u8bc1)/u.test(line);
}

function hasAutocodeDirectValidationPassSignal(text: string): boolean {
  return /\b(?:passed|pass|succeeded|success|green|ok|error[-\s]?free|failure[-\s]?free)\b/i.test(text) ||
    /\b(?:no|zero|0)\s+(?:failed|failures?|errors?|exceptions?)\b/i.test(text) ||
    /\b(?:without|with no)\s+(?:failed|failures?|errors?|exceptions?)\b/i.test(text) ||
    /\bnot\s+(?:failing|failed)\b/i.test(text) ||
    /\b(?:failed|failures?|errors?|exceptions?)\s*[:=]\s*0\b/i.test(text) ||
    /\bexit\s+code\s*[:=]?\s*0\b/i.test(text) ||
    /(?:\u901a\u8fc7|\u6210\u529f|\u6b63\u5e38|\u65e0\u5f02\u5e38|\u65e0\u9519\u8bef|\u672a\u53d1\u73b0\u9519\u8bef|\u6ca1\u6709\u9519\u8bef|\u6ca1\u6709\u5f02\u5e38)/u.test(text) ||
    hasAutocodeDirectRenderValidationPassSignal(text);
}

function hasAutocodeDirectValidationFailSignal(text: string): boolean {
  const failureText = stripAutocodeDirectNegatedFailureSignals(text);
  return /\b(?:failed|failing|failure|error|errors|exception|red|non[-\s]?zero)\b/i.test(failureText) ||
    /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s*)?[1-9]\d*\b/i.test(failureText) ||
    /(?:\u5931\u8d25|\u672a\u901a\u8fc7|\u62a5\u9519|\u9519\u8bef|\u5f02\u5e38)/u.test(failureText) ||
    /(?:\u9875\u9762|\u754c\u9762|\u5e94\u7528).{0,30}(?:\u65e0\u6cd5\u52a0\u8f7d|\u4e0d\u53ef\u52a0\u8f7d|\u4e0d\u80fd\u52a0\u8f7d|\u52a0\u8f7d\u5931\u8d25)/u.test(failureText);
}

function hasAutocodeDirectRenderValidationPassSignal(text: string): boolean {
  return /(?:\u622a\u56fe|\u6e32\u67d3|Chrome|headless|canvas|file:\/\/).{0,100}(?:\u786e\u8ba4|\u9a8c\u8bc1).{0,50}(?:\u9875\u9762|\u754c\u9762|\u5e94\u7528).{0,40}(?:\u53ef\u52a0\u8f7d|\u80fd\u52a0\u8f7d|\u53ef\u4ee5\u52a0\u8f7d|\u6b63\u5e38\u52a0\u8f7d|\u6210\u529f\u52a0\u8f7d|\u53ef\u6253\u5f00|\u80fd\u6253\u5f00|\u6b63\u786e\u6e32\u67d3|\u6210\u529f\u6e32\u67d3)/iu.test(text) ||
    /(?:Chrome|node --check|UTF-8).{0,140}\u7ead\uE1BF\uE17B.{0,50}\u9359\uE21A\u59DE\u675E/iu.test(text);
}

function stripAutocodeDirectNegatedFailureSignals(text: string): string {
  return text
    .replace(/\berror[-\s]?free\b/gi, ' ')
    .replace(/\bfailure[-\s]?free\b/gi, ' ')
    .replace(/\b(?:no|zero|0)\s+(?:failed|failures?|errors?|exceptions?)\b/gi, ' ')
    .replace(/\b(?:without|with no)\s+(?:failed|failures?|errors?|exceptions?)\b/gi, ' ')
    .replace(/\bnot\s+(?:failing|failed)\b/gi, ' ')
    .replace(/\b(?:failed|failures?|errors?|exceptions?)\s*[:=]\s*0\b/gi, ' ')
    .replace(/\bexit\s+code\s*[:=]?\s*0\b/gi, ' ')
    .replace(/(?:\u65e0\u5f02\u5e38|\u65e0\u9519\u8bef|\u672a\u53d1\u73b0\u9519\u8bef|\u6ca1\u6709\u9519\u8bef|\u6ca1\u6709\u5f02\u5e38|0\s*(?:\u4e2a)?\s*\u9519\u8bef)/gu, ' ');
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
