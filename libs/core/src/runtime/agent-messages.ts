import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAutocodeProjectDocsReferencePrompt } from '../project/project-docs.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { loadAutocodeTaskRequirementsSync } from '../tasks/requirements-store.js';

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
}

const DIRECT_TASK_TEXT_LIMIT = 6000;
const DIRECT_TASK_REFERENCE_LIMIT = 25;
const DIRECT_TASK_ATTACHMENT_LIMIT = 10;
const OPENSPEC_ARTIFACT_TEXT_LIMIT = 12000;

interface OpenSpecRuntimeMetadata {
  sourceType?: string;
  openSpecChangeId?: string;
  openSpecChangeDir?: string;
  openSpecProposalPath?: string;
  openSpecDesignPath?: string;
  openSpecTasksPath?: string;
  openSpecSpecDeltaPaths?: string[];
}

export function buildAutocodeDefaultSpecPrompt(input: BuildAutocodeSpecPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `Create an MMO-ready spec for this task, covering only affected domains: engine, authority, networking, content/tools, performance, liveops, security, QA, and rollout.\n\nTask:\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`;
  }
  return `Create a focused specification and implementation plan.\n\nTask:\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks.`;
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
  return `Plan spec ${input.specId} in ${input.projectRoot}. Read ${AUTOCODE_TASK_ARTIFACTS.specFile} and write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as a Markdown checklist with phases and subtasks. ${parallelGuidance}`;
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
    const limited = trimmed.length > DIRECT_TASK_TEXT_LIMIT
      ? `${trimmed.slice(0, DIRECT_TASK_TEXT_LIMIT)}\n...[truncated]`
      : trimmed;
    parts.push(`## ${heading}\n${limited}`);
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
    parts.push('```markdown');
    parts.push(humanInputContent);
    parts.push('```');
    parts.push('');
  }
  appendChangeRequestAuditTrail(parts, input.specDir);

  appendOpenSpecUpstreamPlanningContext(parts, input, humanInputContent);

  const specPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.specFile);
  const specContent = readText(specPath);
  if (specContent !== null) {
    parts.push(`## Specification (${AUTOCODE_TASK_ARTIFACTS.specFile})`);
    parts.push('');
    parts.push(specContent);
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
    parts.push(planContent);
    parts.push('```');
    parts.push('');
    if (input.forcePlanning) {
      parts.push(`Regenerate ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}. Address Human Review Input and overwrite the plan with an updated Autocode Markdown checklist. For OpenSpec-backed tasks, update upstream OpenSpec artifacts first and derive this runtime plan from those updated artifacts. For Standard tasks, update spec.md and tasks.md before regenerating runtime work. Revise task lists incrementally: preserve completed work that remains valid, reset affected work to pending with needs_revision notes, add new pending work, and mark obsolete upstream checklist items explicitly. Do not code in this planning pass.`);
    } else {
      parts.push(`Resume pending or in-progress runtime work items. Leave completed work items alone. Mark each finished work item completed in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`);
    }
  } else {
    parts.push(input.forcePlanning
      ? `Create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and runtime work items, addressing Human Review Input if present. For OpenSpec-backed tasks, update upstream OpenSpec artifacts first and derive this runtime plan from those updated artifacts. For Standard tasks, update spec.md and tasks.md first. Do not code in this planning pass.`
      : `No implementation plan exists yet. Start by creating ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and runtime work items, then implement each item.`);
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
    parts.push(specContent);
    parts.push('');
  }

  const planPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan);
  const planContent = readText(planPath);
  if (planContent !== null) {
    parts.push(`## Implementation Plan (${AUTOCODE_TASK_ARTIFACTS.implementationPlan})`);
    parts.push('');
    parts.push('```markdown');
    parts.push(planContent);
    parts.push('```');
    parts.push('');
  }

  parts.push(`Review against the spec, run relevant checks, and write ${AUTOCODE_TASK_ARTIFACTS.qaReport} with "Status: PASSED" or "Status: FAILED" plus any findings.`);

  return [{ role: 'user', content: parts.join('\n') }];
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
  parts.push('');
  parts.push('```jsonl');
  parts.push(limitText(jsonl, 8000));
  parts.push('```');
  parts.push('');
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

function appendOpenSpecUpstreamPlanningContext(
  parts: string[],
  input: BuildAutocodeRuntimeMessagesInput,
  humanInputContent: string | null,
): void {
  const metadata = readJson<OpenSpecRuntimeMetadata>(join(input.specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata));
  if (metadata?.sourceType !== 'openspec') {
    return;
  }

  const artifacts = collectOpenSpecRuntimeArtifactPaths(metadata);
  const compactContextPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.openSpecContext);
  const compactContext = readText(compactContextPath);
  parts.push('## OpenSpec Upstream');
  parts.push('');
  parts.push('OpenSpec is the upstream specification layer. Autocode files are downstream runtime state.');
  if (metadata.openSpecChangeId) {
    parts.push(`Change ID: ${metadata.openSpecChangeId}`);
  }
  if (metadata.openSpecChangeDir) {
    parts.push(`Change directory: ${metadata.openSpecChangeDir}`);
  }
  parts.push(`Compact context: ${compactContextPath}`);
  parts.push('');

  if (input.forcePlanning) {
    parts.push('Request Changes rule:');
    parts.push('- Apply the reviewer feedback to the relevant OpenSpec upstream Markdown files first: proposal.md, design.md, tasks.md, and/or specs/<capability>/spec.md.');
    parts.push('- Use change_requests.jsonl as the same-task iteration audit trail when present.');
    parts.push(`- Then regenerate ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} from the updated OpenSpec artifacts.`);
    parts.push(`- Do not make ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} the only changed planning artifact when the feedback changes product behavior, requirements, design, or task scope.`);
    parts.push('- Revise tasks incrementally: preserve valid completed work, add new pending work, reset invalidated work to pending with needs_revision notes, and mark obsolete upstream tasks explicitly.');
    parts.push('- Do not implement code in this planning pass.');
    if (humanInputContent) {
      parts.push('- Treat HUMAN_INPUT.md as required OpenSpec change feedback, not just runtime-plan feedback.');
    }
  } else {
    parts.push(`Use ${AUTOCODE_TASK_ARTIFACTS.openSpecContext} as the compact source context before changing ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`);
    parts.push('Open full OpenSpec artifacts only when exact wording is needed.');
  }
  parts.push('');

  parts.push('OpenSpec artifact paths:');
  for (const artifact of artifacts) {
    parts.push(`- ${artifact.label}: ${artifact.displayPath}`);
  }
  parts.push('');

  if (compactContext !== null) {
    parts.push(`### Compact Context (${AUTOCODE_TASK_ARTIFACTS.openSpecContext})`);
    parts.push('');
    parts.push('```markdown');
    parts.push(limitText(compactContext, OPENSPEC_ARTIFACT_TEXT_LIMIT));
    parts.push('```');
    parts.push('');
  } else {
    parts.push(`Compact context is missing; read the listed OpenSpec artifacts only as needed and regenerate ${AUTOCODE_TASK_ARTIFACTS.openSpecContext} during planning when possible.`);
    parts.push('');
  }
}

function collectOpenSpecRuntimeArtifactPaths(
  metadata: OpenSpecRuntimeMetadata,
): Array<{ label: string; displayPath: string }> {
  const entries: Array<{ label: string; relativePath?: string }> = [
    { label: 'proposal.md', relativePath: metadata.openSpecProposalPath },
    { label: 'design.md', relativePath: metadata.openSpecDesignPath },
    { label: 'tasks.md', relativePath: metadata.openSpecTasksPath },
    ...(metadata.openSpecSpecDeltaPaths ?? []).map((relativePath, index) => ({
      label: index === 0 ? 'spec delta' : `spec delta ${index + 1}`,
      relativePath,
    })),
  ];

  return entries
    .filter((entry): entry is { label: string; relativePath: string } => Boolean(entry.relativePath?.trim()))
    .map((entry) => ({
      label: entry.label,
      displayPath: entry.relativePath,
    }));
}

function limitText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function appendProjectDocsReference(parts: string[], projectRoot: string, dataDirName?: string): void {
  const reference = buildAutocodeProjectDocsReferencePrompt({ projectRoot, dataDirName });
  if (!reference) {
    return;
  }
  parts.push(reference);
  parts.push('');
}
