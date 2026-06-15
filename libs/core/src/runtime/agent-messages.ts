import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAutocodeProjectDocsReferencePrompt } from '../project/project-docs.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { loadAutocodeTaskRequirementsSync } from '../tasks/requirements-store.js';
import {
  type AutocodeDirectSessionState,
  compactAutocodeDirectSessionLatestSummary,
} from './direct-session-state.js';
import { foldRepeatedAutocodePromptLines } from './prompt-context.js';

export type AutocodeAgentMessageRole = 'user' | 'assistant';

export interface AutocodeAgentMessage {
  role: AutocodeAgentMessageRole;
  content: string;
}

export type AutocodeAgentLanguage = 'zh-CN' | 'fr' | string | undefined;

export interface BuildAutocodeAgentPromptInput {
  specId: string;
  projectRoot: string;
  projectType?: string;
}

export interface BuildAutocodeSpecPromptInput {
  taskDescription: string;
  specDir?: string;
  projectType?: string;
}

export interface BuildAutocodeRuntimeMessagesInput {
  specDir: string;
  specId: string;
  projectRoot: string;
  dataDirName?: string;
  language?: AutocodeAgentLanguage;
  forcePlanning?: boolean;
  directSessionState?: AutocodeDirectSessionState | null;
  directContinuationMode?: 'provider' | 'summary';
}

const DIRECT_TASK_TEXT_LIMIT = 6000;
const DIRECT_TASK_REFERENCE_LIMIT = 25;
const DIRECT_TASK_ATTACHMENT_LIMIT = 10;
export const AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS = 4_000;
export const DIRECT_CHANGE_REQUEST_LIMIT = 6000;
export const RUNTIME_SPEC_CONTEXT_MAX_CHARS = 7_000;
export const RUNTIME_PLAN_CONTEXT_MAX_CHARS = 10_000;
export const QA_SPEC_CONTEXT_MAX_CHARS = 5_000;
export const QA_PLAN_CONTEXT_MAX_CHARS = 8_000;
export const CHANGE_REQUEST_AUDIT_MAX_CHARS = 4_000;
const ARTIFACT_OPENING_EXCERPT_MAX_CHARS = 1_400;
const ARTIFACT_LINE_MAX_CHARS = 220;
const ARTIFACT_HEADING_LIMIT = 14;
const ARTIFACT_BULLET_LIMIT = 18;
const ARTIFACT_STATUS_LIMIT = 60;
const ARTIFACT_EVIDENCE_LIMIT = 20;
const CHANGE_REQUEST_AUDIT_ENTRY_LIMIT = 3;
const CHANGE_REQUEST_FEEDBACK_MAX_CHARS = 700;
const CHANGE_REQUEST_LIST_ITEM_MAX_CHARS = 220;
const CHANGE_REQUEST_FIELD_COMPACTION_NOTICE =
  ' ... [change request field middle omitted] ... ';
const ARTIFACT_OPENING_COMPACTION_NOTICE =
  '\n...[artifact opening middle omitted; read the file directly if needed]...\n';
const ARTIFACT_SUMMARY_COMPACTION_NOTICE =
  '\n...[compact artifact middle omitted; read the file directly if needed]...\n';
const DEFAULT_SPEC_TASK_DESCRIPTION_COMPACTION_NOTICE =
  '\n\n...[task description middle omitted for prompt budget; read the source task if exact omitted detail is required]...\n\n';
const DIRECT_TASK_SECTION_COMPACTION_NOTICE =
  '\n\n...[direct task section middle omitted for prompt budget; read requirements.md or implementation_plan.md for exact omitted detail]...\n\n';
const HUMAN_INPUT_COMPACTION_NOTICE =
  '\n...[HUMAN_INPUT.md middle omitted for prompt budget; read the file directly if exact omitted feedback is required]...\n';

export function buildAutocodeDefaultSpecPrompt(input: BuildAutocodeSpecPromptInput): string {
  const taskDescription = compactAutocodeDefaultSpecTaskDescription(input.taskDescription);
  if (input.projectType === 'game-mmo') {
    return `Create an MMO-ready spec for this task, covering only affected domains: engine, authority, networking, content/tools, performance, liveops, security, QA, and rollout.\n\nTask:\n${taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`;
  }
  return `Create a focused specification and implementation plan.\n\nTask:\n${taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks.`;
}

function compactAutocodeDefaultSpecTaskDescription(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }

  const folded = foldRepeatedAutocodePromptLines(normalized);
  if (folded.length <= AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS) {
    return folded;
  }

  const budget = Math.max(
    0,
    AUTOCODE_DEFAULT_SPEC_TASK_DESCRIPTION_MAX_CHARS - DEFAULT_SPEC_TASK_DESCRIPTION_COMPACTION_NOTICE.length,
  );
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    folded.slice(0, headBudget).trimEnd(),
    DEFAULT_SPEC_TASK_DESCRIPTION_COMPACTION_NOTICE,
    folded.slice(-tailBudget).trimStart(),
  ].join('');
}

function compactAutocodeDirectTaskSectionText(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= DIRECT_TASK_TEXT_LIMIT) {
    return normalized;
  }

  const folded = foldRepeatedAutocodePromptLines(normalized);
  if (folded.length <= DIRECT_TASK_TEXT_LIMIT) {
    return folded;
  }

  const budget = Math.max(0, DIRECT_TASK_TEXT_LIMIT - DIRECT_TASK_SECTION_COMPACTION_NOTICE.length);
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    folded.slice(0, headBudget).trimEnd(),
    DIRECT_TASK_SECTION_COMPACTION_NOTICE,
    folded.slice(-tailBudget).trimStart(),
  ].join('');
}

export function buildAutocodeDefaultPlannerPrompt(input: BuildAutocodeAgentPromptInput): string {
  const parallelGuidance = [
    'Every executable subtask must include exactly one _Depends on: ..._ line.',
    'Use _Depends on: none_ only for work that can run without prior output; otherwise list prerequisite subtask IDs only.',
    'File metadata is write intent, not context. List only files the subtask will create or modify, and use _Files to modify: none_ for read-only validation.',
    'If two subtasks must modify the same file, merge them or add a real dependency.',
    'Do not mark final verification as modifying all files unless it truly edits them.',
  ].join(' ');
  if (input.projectType === 'game-mmo') {
    return `Plan MMO spec ${input.specId} in ${input.projectRoot}. Write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with concrete subtasks for only affected domains: engine, rendering, animation, assets, streaming, server authority, networking, tools, release, performance, and QA. ${parallelGuidance}`;
  }
  return `Plan spec ${input.specId} in ${input.projectRoot}. Read ${AUTOCODE_TASK_ARTIFACTS.specFile}, ${AUTOCODE_TASK_ARTIFACTS.requirements}, ${AUTOCODE_TASK_ARTIFACTS.context}, and project evidence when available; write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as a Markdown checklist with phases and subtasks. Each requirement, design choice, task, and verification step must trace to source files, project docs, existing patterns, or verified official/industry references. Put unverified details in assumptions or validation tasks instead of guessing. ${parallelGuidance}`;
}

export function buildAutocodeDefaultQAPrompt(input: BuildAutocodeAgentPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `Review MMO spec ${input.specId} in ${input.projectRoot}. Validate implementation plus affected authority/sync/performance/content/tools/data/security/release risks. Write ${AUTOCODE_TASK_ARTIFACTS.qaReport} with Status: PASSED or Status: FAILED.`;
  }
  return `Review implementation of spec ${input.specId} in ${input.projectRoot}. Check requirements in ${AUTOCODE_TASK_ARTIFACTS.specFile} and write ${AUTOCODE_TASK_ARTIFACTS.qaReport} with Status: PASSED or Status: FAILED.`;
}

export function buildAutocodeDefaultDirectTaskPrompt(input: Omit<BuildAutocodeAgentPromptInput, 'projectType'>): string {
  return [
    `Complete task ${input.specId} in ${input.projectRoot}.`,
    'Use one concise coding session. No spec, plan, QA, or subagents.',
    'For pure Q&A or no-file-change tasks, answer directly without tools.',
    'Use the first user message as the task source. Read metadata or prior specs only if the request is ambiguous.',
    'Inspect only relevant files, make focused edits, run one useful validation, and end with a short markdown table: What changed, Verification, Review notes.',
  ].join('\n');
}

export function buildAutocodeCompletionSummaryRequirement(language?: AutocodeAgentLanguage): string {
  if (language === 'zh-CN') {
    return 'Final answer must be a concise markdown table in Simplified Chinese with localized rows for changes, verification, and review notes.';
  }
  if (language === 'fr') {
    return 'Final answer must be a concise markdown table in French, with localized row labels for changes, verification, and review notes.';
  }
  return 'Final answer must be a concise markdown table with rows: What changed, Verification, Review notes.';
}

export function buildAutocodeDirectTaskExecutionMessages(
  input: BuildAutocodeRuntimeMessagesInput,
): AutocodeAgentMessage[] {
  if (input.directSessionState && input.directContinuationMode) {
    return buildAutocodeDirectTaskContinuationMessages(input);
  }

  const parts: string[] = [];
  const planPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
  const metadataPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata);
  let planDescription = '';
  let requestDescriptionFound = false;

  const appendLimited = (heading: string, value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    parts.push(`## ${heading}\n${compactAutocodeDirectTaskSectionText(trimmed)}`);
    parts.push('');
  };

  parts.push(`Implement task ${input.specId} directly in project: ${input.projectRoot}`);
  parts.push(`Task data: ${input.specDir}`);
  parts.push('Workflow off: one coding session only. No staged spec, plan, QA, or subagents.');
  parts.push('For Q&A or no-file-change tasks, answer directly without tools.');
  parts.push('Read metadata, plans, previous specs, or broad listings only if the request is ambiguous.');
  parts.push('For obvious single-file/documentation tasks, edit directly and run at most one useful check.');
  parts.push('');
  appendProjectDocsReference(parts, input.projectRoot, input.dataDirName);

  const plan = readJson<{
    feature?: string;
    title?: string;
    description?: string;
  }>(planPath);
  if (plan?.feature || plan?.title) {
    appendLimited('Title', plan.feature ?? plan.title ?? '');
  }
  if (plan?.description) {
    planDescription = plan.description;
  }

  const requirements = loadAutocodeTaskRequirementsSync(input.specDir);
  if (requirements?.task_description) {
    requestDescriptionFound = true;
    appendLimited('Request', requirements.task_description);
  }
  if (Array.isArray(requirements?.attached_images) && requirements.attached_images.length > 0) {
    parts.push('## Attached Reference Images');
    for (const image of requirements.attached_images.slice(0, DIRECT_TASK_ATTACHMENT_LIMIT)) {
      parts.push(`- ${image.filename ?? 'image'}${image.path ? `: ${join(input.specDir, image.path)}` : ''}`);
    }
    if (requirements.attached_images.length > DIRECT_TASK_ATTACHMENT_LIMIT) {
      parts.push(`- ...${requirements.attached_images.length - DIRECT_TASK_ATTACHMENT_LIMIT} more omitted`);
    }
    parts.push('');
  }

  if (!requestDescriptionFound && planDescription) {
    appendLimited('Request', planDescription);
  }

  const metadata = readJson<{
    referencedFiles?: Array<{ path?: string; isDirectory?: boolean }>;
  }>(metadataPath);
  if (Array.isArray(metadata?.referencedFiles) && metadata.referencedFiles.length > 0) {
    parts.push('## User-Referenced Files');
    for (const file of metadata.referencedFiles.slice(0, DIRECT_TASK_REFERENCE_LIMIT)) {
      if (file.path) {
        parts.push(`- ${file.isDirectory ? 'Directory' : 'File'}: ${file.path}`);
      }
    }
    if (metadata.referencedFiles.length > DIRECT_TASK_REFERENCE_LIMIT) {
      parts.push(`- ...${metadata.referencedFiles.length - DIRECT_TASK_REFERENCE_LIMIT} more omitted`);
    }
    parts.push('');
  }

  parts.push('## Completion Summary Requirement');
  parts.push(buildAutocodeCompletionSummaryRequirement(input.language));

  return [{ role: 'user', content: parts.join('\n') }];
}

function buildAutocodeDirectTaskContinuationMessages(
  input: BuildAutocodeRuntimeMessagesInput,
): AutocodeAgentMessage[] {
  const state = input.directSessionState;
  const parts: string[] = [];

  parts.push(`Continue Direct task ${input.specId} in project: ${input.projectRoot}`);
  parts.push(`Task data: ${input.specDir}`);
  if (input.directContinuationMode === 'provider' && state?.providerResponseId) {
    parts.push(`Provider continuation: use previous response ${state.providerResponseId}. Do not request or restate prior task context unless the latest change request is ambiguous.`);
  } else {
    parts.push('Provider continuation is unavailable. Use the compact prior-session summary below as the only carried context, then inspect files only as needed.');
  }
  parts.push('Apply only the latest requested changes. Keep edits focused and run one relevant validation when practical.');
  if (input.language === 'zh-CN') {
    parts.push('Language: write all progress notes and final review notes in Simplified Chinese.');
  } else if (input.language === 'fr') {
    parts.push('Language: write all progress notes and final review notes in French.');
  }
  parts.push('');

  appendLatestDirectFeedback(parts, input.specDir);

  if (input.directContinuationMode === 'summary' && state) {
    if (state.latestSummary) {
      parts.push('## Prior Direct Session Summary');
      parts.push('');
      parts.push(compactAutocodeDirectSessionLatestSummary(state.latestSummary) ?? '');
      parts.push('');
    }
    if (Array.isArray(state.changedFiles) && state.changedFiles.length > 0) {
      parts.push('## Files Changed Previously');
      for (const filePath of state.changedFiles.slice(0, DIRECT_TASK_REFERENCE_LIMIT)) {
        parts.push(`- ${filePath}`);
      }
      if (state.changedFiles.length > DIRECT_TASK_REFERENCE_LIMIT) {
        parts.push(`- ...${state.changedFiles.length - DIRECT_TASK_REFERENCE_LIMIT} more omitted`);
      }
      parts.push('');
    }
  }

  parts.push('## Completion Summary Requirement');
  parts.push(buildAutocodeCompletionSummaryRequirement(input.language));

  return [{ role: 'user', content: parts.join('\n') }];
}

export function buildAutocodeTaskExecutionMessages(
  input: BuildAutocodeRuntimeMessagesInput,
): AutocodeAgentMessage[] {
  const parts: string[] = [];

  parts.push(`Implement spec ${input.specId} in project: ${input.projectRoot}`);
  parts.push(`Spec directory: ${input.specDir}`);
  if (input.language === 'zh-CN') {
    parts.push('Language: write all non-code prose, progress updates, summaries, task titles, and review notes in Simplified Chinese.');
  } else if (input.language === 'fr') {
    parts.push('Language: write all non-code prose, progress updates, summaries, task titles, and review notes in French.');
  }
  parts.push('');
  appendProjectDocsReference(parts, input.projectRoot, input.dataDirName);

  const humanInputPath = join(input.specDir, 'HUMAN_INPUT.md');
  const humanInputContent = readText(humanInputPath);
  if (humanInputContent !== null) {
    parts.push('## Human Review Input (HUMAN_INPUT.md)');
    parts.push('');
    parts.push('Compact excerpt; read HUMAN_INPUT.md directly only if exact omitted feedback is required.');
    parts.push('');
    parts.push('```markdown');
    parts.push(compactHumanInputForPrompt(humanInputContent));
    parts.push('```');
    parts.push('');
  }
  appendChangeRequestAuditTrail(parts, input.specDir);

  const specPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
  const specContent = readText(specPath);
  if (specContent !== null) {
    parts.push(`## Specification (${AUTOCODE_TASK_ARTIFACTS.specFile})`);
    parts.push('');
    parts.push(compactMarkdownArtifactForPrompt(
      AUTOCODE_TASK_ARTIFACTS.specFile,
      specContent,
      RUNTIME_SPEC_CONTEXT_MAX_CHARS,
      'spec',
    ));
    parts.push('');
  }

  const planPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
  const planContent = readText(planPath);
  if (planContent !== null) {
    parts.push(input.forcePlanning
      ? `## Previous Implementation Plan (${AUTOCODE_TASK_ARTIFACTS.implementationPlan})`
      : `## Implementation Plan (${AUTOCODE_TASK_ARTIFACTS.implementationPlan})`);
    parts.push('');
    parts.push('```markdown');
    parts.push(compactMarkdownArtifactForPrompt(
      AUTOCODE_TASK_ARTIFACTS.implementationPlan,
      planContent,
      RUNTIME_PLAN_CONTEXT_MAX_CHARS,
      'plan',
    ));
    parts.push('```');
    parts.push('');
    if (input.forcePlanning) {
      parts.push(`Regenerate ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}. Address Human Review Input and overwrite the plan with an updated Autocode Markdown checklist. For Standard tasks, update spec.md and tasks.md before regenerating runtime work; use the Autocode Standard flow: proposal -> requirements -> design -> tasks -> implementation plan. Revise task lists incrementally: preserve completed work that remains valid, reset affected work to pending with needs_revision notes, add new work, and mark obsolete checklist items explicitly. Do not code in this planning pass.`);
      parts.push('For same-task iterations, follow the Standard Iteration Protocol in HUMAN_INPUT.md or the latest change_requests.jsonl entry: update the required flow documents first, refresh verification metadata, and leave the task ready for the next coding/test/commit pass.');
    } else {
      parts.push(`Resume pending or in-progress runtime work items. Leave completed work items alone. Mark each finished work item completed in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`);
      parts.push('If the latest change request includes an iteration contract, run the requested validation and keep the result commit-ready using the normal task commit flow when commits are enabled.');
    }
  } else {
    parts.push(input.forcePlanning
      ? `Create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and runtime work items, addressing Human Review Input if present. For Standard tasks, update spec.md and tasks.md first using the Autocode Standard flow: proposal -> requirements -> design -> tasks -> implementation plan. Follow the Standard Iteration Protocol when present. Do not code in this planning pass.`
      : `No implementation plan exists yet. Start by updating spec.md and tasks.md using Standard planning, then create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and runtime work items before implementing each item.`);
  }

  return [{ role: 'user', content: parts.join('\n') }];
}

export function buildAutocodeQAInitialMessages(
  input: Omit<BuildAutocodeRuntimeMessagesInput, 'language'>,
): AutocodeAgentMessage[] {
  const parts: string[] = [];

  parts.push(`Review implementation of spec ${input.specId} in project: ${input.projectRoot}`);
  parts.push(`Spec directory: ${input.specDir}`);
  parts.push('');

  const specPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
  const specContent = readText(specPath);
  if (specContent !== null) {
    parts.push(`## Specification (${AUTOCODE_TASK_ARTIFACTS.specFile})`);
    parts.push('');
    parts.push(compactMarkdownArtifactForPrompt(
      AUTOCODE_TASK_ARTIFACTS.specFile,
      specContent,
      QA_SPEC_CONTEXT_MAX_CHARS,
      'spec',
    ));
    parts.push('');
  }

  const planPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
  const planContent = readText(planPath);
  if (planContent !== null) {
    parts.push(`## Implementation Plan (${AUTOCODE_TASK_ARTIFACTS.implementationPlan})`);
    parts.push('');
    parts.push('```markdown');
    parts.push(compactMarkdownArtifactForPrompt(
      AUTOCODE_TASK_ARTIFACTS.implementationPlan,
      planContent,
      QA_PLAN_CONTEXT_MAX_CHARS,
      'plan',
    ));
    parts.push('```');
    parts.push('');
  }

  parts.push(`Review against the spec, run relevant checks, and write ${AUTOCODE_TASK_ARTIFACTS.qaReport} with "Status: PASSED" or "Status: FAILED" plus any findings.`);

  return [{ role: 'user', content: parts.join('\n') }];
}

function compactMarkdownArtifactForPrompt(
  fileName: string,
  content: string,
  maxLength: number,
  mode: 'spec' | 'plan',
): string {
  const normalized = normalizeMarkdownContent(content);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const headings: string[] = [];
  const bullets: string[] = [];
  const statuses: string[] = [];
  const evidenceLines: string[] = [];
  let inFence = false;

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (/^#{1,4}\s+\S/.test(line)) {
      pushPromptLine(headings, line.replace(/^#{1,4}\s+/, ''), ARTIFACT_HEADING_LIMIT);
      continue;
    }

    if (mode === 'plan' && /(?:\[[ xX/!-]\]|\b(?:pending|in_progress|failed|blocked|completed)\b|Status\s*:)/i.test(line)) {
      pushPromptLine(statuses, line, ARTIFACT_STATUS_LIMIT);
      continue;
    }

    if (/(?:Evidence|证据|Verification|验证|Depends on|依赖|Files? to|文件)/i.test(line)) {
      pushPromptLine(evidenceLines, line, ARTIFACT_EVIDENCE_LIMIT);
      continue;
    }

    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      pushPromptLine(bullets, line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''), ARTIFACT_BULLET_LIMIT);
    }
  }

  const lines = [
    `> Compact excerpt of ${fileName}; the full artifact is available on disk. Read exact sections only if this summary lacks detail.`,
    '',
    'Opening excerpt:',
    limitHeadTailText(normalized, ARTIFACT_OPENING_EXCERPT_MAX_CHARS, ARTIFACT_OPENING_COMPACTION_NOTICE),
    '',
  ];

  appendPromptLineSection(lines, 'Key headings', headings);
  appendPromptLineSection(lines, mode === 'plan' ? 'Work item/status lines' : 'Selected bullets', mode === 'plan' ? statuses : bullets);
  if (mode === 'plan' && bullets.length > 0) {
    appendPromptLineSection(lines, 'Selected bullets', bullets);
  }
  appendPromptLineSection(lines, 'Evidence and verification lines', evidenceLines);

  return limitHeadTailText(
    lines.join('\n').trimEnd(),
    maxLength,
    ARTIFACT_SUMMARY_COMPACTION_NOTICE,
  );
}

function normalizeMarkdownContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendPromptLineSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(title);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push('');
}

function pushPromptLine(items: string[], value: string, limit: number): void {
  if (items.length >= limit) {
    return;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || items.includes(normalized)) {
    return;
  }
  items.push(limitText(normalized, ARTIFACT_LINE_MAX_CHARS, '...'));
}

function readText(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
  } catch {
    return null;
  }
}

function appendChangeRequestAuditTrail(parts: string[], specDir: string): void {
  const jsonl = readText(join(specDir, 'change_requests.jsonl'));
  if (jsonl === null) {
    return;
  }

  parts.push('## Change Request Audit Trail');
  parts.push('');
  parts.push('Treat these entries as iteration history for the same task. Do not create a new task unless the user explicitly requested a separate follow-up task.');
  parts.push('');
  parts.push('### change_requests.jsonl');
  parts.push('');
  parts.push('Each line is one RequestChanges event with scope, impact analysis, feedback, and attachments.');
  parts.push('Use the latest entry as the active same-task iteration contract. Its iteration.flowDocuments, requiredActions, validation, and commitPolicy fields define what to update, test, and keep ready for commit. Read the JSONL file directly only if older omitted history is required.');
  parts.push('');
  parts.push('```text');
  parts.push(compactChangeRequestJsonlForPrompt(jsonl, {
    maxEntries: CHANGE_REQUEST_AUDIT_ENTRY_LIMIT,
    maxChars: CHANGE_REQUEST_AUDIT_MAX_CHARS,
  }));
  parts.push('```');
  parts.push('');
}

function appendLatestDirectFeedback(parts: string[], specDir: string): void {
  const humanInput = readText(join(specDir, 'HUMAN_INPUT.md'));
  if (humanInput !== null) {
    parts.push('## Latest Human Input');
    parts.push('');
    parts.push('```markdown');
    parts.push(compactHumanInputForPrompt(humanInput));
    parts.push('```');
    parts.push('');
  }

  const jsonl = readText(join(specDir, 'change_requests.jsonl'));
  const latestEntry = jsonl
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (latestEntry) {
    parts.push('## Latest Change Request Entry');
    parts.push('');
    parts.push('```text');
    parts.push(compactChangeRequestJsonlForPrompt(latestEntry, {
      maxEntries: 1,
      maxChars: DIRECT_CHANGE_REQUEST_LIMIT,
    }));
    parts.push('```');
    parts.push('');
  }

  if (humanInput === null && !latestEntry) {
    parts.push('## Latest Human Input');
    parts.push('');
    parts.push('No HUMAN_INPUT.md or change_requests.jsonl entry was found. Continue only from the active user request and prior provider session.');
    parts.push('');
  }
}

function readJson<T>(filePath: string): T | null {
  const content = readText(filePath);
  if (content === null) {
    return null;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

interface CompactChangeRequestEntry {
  id?: unknown;
  createdAt?: unknown;
  scope?: unknown;
  impacts?: unknown;
  feedback?: unknown;
  attachmentsMarkdown?: unknown;
  iteration?: {
    mode?: unknown;
    flowDocuments?: unknown;
    requiredActions?: unknown;
    validation?: unknown;
    commitPolicy?: unknown;
  };
}

export function compactChangeRequestJsonlForPrompt(
  jsonl: string,
  options: { maxEntries?: number; maxChars?: number } = {},
): string {
  const allLines = jsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const maxEntries = Math.max(1, options.maxEntries ?? CHANGE_REQUEST_AUDIT_ENTRY_LIMIT);
  const maxChars = Math.max(1, options.maxChars ?? CHANGE_REQUEST_AUDIT_MAX_CHARS);
  const latestLines = allLines.slice(-maxEntries);
  const omitted = Math.max(0, allLines.length - latestLines.length);
  const lines: string[] = [];

  lines.push(`Showing latest ${latestLines.length} of ${allLines.length} change request entr${allLines.length === 1 ? 'y' : 'ies'}.`);
  if (omitted > 0) {
    lines.push(`${omitted} older entr${omitted === 1 ? 'y was' : 'ies were'} omitted from the prompt; keep the audit file intact.`);
  }
  lines.push('');

  latestLines.forEach((line, index) => {
    const parsed = parseCompactChangeRequestEntry(line);
    const isLatest = index === latestLines.length - 1;
    if (!parsed) {
      lines.push(`### ${isLatest ? 'Latest raw entry' : `Raw entry ${index + 1}`}`);
      lines.push(limitHeadTailText(
        line,
        CHANGE_REQUEST_FEEDBACK_MAX_CHARS,
        CHANGE_REQUEST_FIELD_COMPACTION_NOTICE,
      ));
      lines.push('');
      return;
    }

    lines.push(formatCompactChangeRequestEntry(parsed, isLatest, index + 1));
  });

  return limitText(
    lines.join('\n').trimEnd(),
    maxChars,
    '\n...[compact change request audit truncated; read change_requests.jsonl directly if needed]',
  );
}

function parseCompactChangeRequestEntry(line: string): CompactChangeRequestEntry | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? value as CompactChangeRequestEntry : null;
  } catch {
    return null;
  }
}

function formatCompactChangeRequestEntry(
  entry: CompactChangeRequestEntry,
  isLatest: boolean,
  fallbackIndex: number,
): string {
  const id = textValue(entry.id) || `entry-${fallbackIndex}`;
  const lines = [`### ${isLatest ? 'Latest' : 'Recent'} change request: ${id}`];
  appendCompactField(lines, 'Created', entry.createdAt);
  appendCompactField(lines, 'Scope', entry.scope);
  appendCompactListField(lines, 'Impacts', entry.impacts);
  if (entry.iteration && typeof entry.iteration === 'object') {
    appendCompactField(lines, 'Mode', entry.iteration.mode);
    appendCompactListField(lines, 'Flow documents', entry.iteration.flowDocuments);
    appendCompactListField(lines, 'Required actions', entry.iteration.requiredActions, 6);
    appendCompactListField(lines, 'Validation', entry.iteration.validation, 4);
    appendCompactField(lines, 'Commit policy', entry.iteration.commitPolicy);
  }
  appendCompactField(lines, 'Feedback', entry.feedback, CHANGE_REQUEST_FEEDBACK_MAX_CHARS, { preserveTail: true });
  appendCompactField(lines, 'Attachments', entry.attachmentsMarkdown, CHANGE_REQUEST_FEEDBACK_MAX_CHARS, { preserveTail: true });
  lines.push('');
  return lines.join('\n');
}

function appendCompactField(
  lines: string[],
  label: string,
  value: unknown,
  maxChars = CHANGE_REQUEST_LIST_ITEM_MAX_CHARS,
  options: { preserveTail?: boolean } = {},
): void {
  const text = textValue(value);
  if (!text) {
    return;
  }
  const compact = options.preserveTail
    ? limitHeadTailText(text, maxChars, CHANGE_REQUEST_FIELD_COMPACTION_NOTICE)
    : limitText(text, maxChars, '...');
  lines.push(`- ${label}: ${compact}`);
}

function appendCompactListField(
  lines: string[],
  label: string,
  value: unknown,
  maxItems = 8,
): void {
  const items = Array.isArray(value)
    ? value.map(textValue).filter(Boolean)
    : textValue(value) ? [textValue(value)] : [];
  if (items.length === 0) {
    return;
  }
  const visible = items.slice(0, maxItems)
    .map((item) => limitText(item, CHANGE_REQUEST_LIST_ITEM_MAX_CHARS, '...'));
  const suffix = items.length > visible.length ? `; ...${items.length - visible.length} more` : '';
  lines.push(`- ${label}: ${visible.join('; ')}${suffix}`);
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function compactHumanInputForPrompt(value: string): string {
  return limitHeadTailText(value, DIRECT_CHANGE_REQUEST_LIMIT, HUMAN_INPUT_COMPACTION_NOTICE);
}

function limitHeadTailText(value: string, maxLength: number, marker: string): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const folded = foldRepeatedAutocodePromptLines(normalized);
  if (folded.length <= maxLength) {
    return folded;
  }

  const budget = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    folded.slice(0, headLength).trimEnd(),
    marker,
    folded.slice(-tailLength).trimStart(),
  ].join('');
}

function limitText(value: string, maxLength: number, suffix = '\n...[truncated]'): string {
  if (maxLength <= 0) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

function appendProjectDocsReference(parts: string[], projectRoot: string, dataDirName?: string): void {
  const reference = buildAutocodeProjectDocsReferencePrompt({ projectRoot, dataDirName });
  if (!reference) {
    return;
  }
  parts.push(reference);
  parts.push('');
}
