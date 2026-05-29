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

export function buildAutocodeDefaultSpecPrompt(input: BuildAutocodeSpecPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `Create an MMO-ready spec for this task, covering only affected domains: engine, authority, networking, content/tools, performance, liveops, security, QA, and rollout.\n\nTask:\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`;
  }
  return `Create a focused specification and implementation plan.\n\nTask:\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nWrite ${AUTOCODE_TASK_ARTIFACTS.specFile} and a single Markdown ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks.`;
}

export function buildAutocodeDefaultPlannerPrompt(input: BuildAutocodeAgentPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `Plan MMO spec ${input.specId} in ${input.projectRoot}. Write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with concrete subtasks for only affected domains: engine, rendering, animation, assets, streaming, server authority, networking, tools, release, performance, and QA.`;
  }
  return `Plan spec ${input.specId} in ${input.projectRoot}. Read ${AUTOCODE_TASK_ARTIFACTS.specFile} and write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} as a Markdown checklist with phases and subtasks.`;
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
      parts.push(`Regenerate ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}. Address Human Review Input and overwrite the plan with an updated OpenSpec-style Markdown checklist. Do not code in this planning pass.`);
    } else {
      parts.push(`Resume pending or in-progress subtasks. Leave completed subtasks alone. Mark each finished subtask completed in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`);
    }
  } else {
    parts.push(input.forcePlanning
      ? `Create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks, addressing Human Review Input if present. Do not code in this planning pass.`
      : `No implementation plan exists yet. Start by creating ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks, then implement each subtask.`);
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

function appendProjectDocsReference(parts: string[], projectRoot: string, dataDirName?: string): void {
  const reference = buildAutocodeProjectDocsReferencePrompt({ projectRoot, dataDirName });
  if (!reference) {
    return;
  }
  parts.push(reference);
  parts.push('');
}
