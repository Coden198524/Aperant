import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';

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
  language?: AutocodeAgentLanguage;
}

const DIRECT_TASK_TEXT_LIMIT = 6000;
const DIRECT_TASK_REFERENCE_LIMIT = 25;
const DIRECT_TASK_ATTACHMENT_LIMIT = 10;

export function buildAutocodeDefaultSpecPrompt(input: BuildAutocodeSpecPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `You are an MMO game specification orchestrator for a large online game project. Create a production-ready spec for this task with explicit coverage of engine architecture, server authority, networking, content pipeline, tools, performance budgets, live operations, security, QA, and rollout risks:\n\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nCreate ${AUTOCODE_TASK_ARTIFACTS.specFile} and ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with concrete phases and subtasks.`;
  }
  return `You are a spec creation agent. Your job is to create a detailed specification and implementation plan for the following task:\n\n${input.taskDescription}${input.specDir ? `\n\nSpec directory: ${input.specDir}` : ''}\n\nCreate a ${AUTOCODE_TASK_ARTIFACTS.specFile} with requirements and an ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks.`;
}

export function buildAutocodeDefaultPlannerPrompt(input: BuildAutocodeAgentPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `You are an MMO systems and engine planning agent. Review spec ${input.specId} in project ${input.projectRoot} and create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with subtasks that account for engine architecture, rendering, animation, asset pipeline, world streaming, authoritative server logic, networking, tooling, build/release, performance budgets, and QA gates.`;
  }
  return `You are a planning agent. Your job is to review the spec and create an implementation plan for spec ${input.specId} in project ${input.projectRoot}. Read the ${AUTOCODE_TASK_ARTIFACTS.specFile} and create ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks.`;
}

export function buildAutocodeDefaultQAPrompt(input: BuildAutocodeAgentPromptInput): string {
  if (input.projectType === 'game-mmo') {
    return `You are an MMO QA reviewer. Review spec ${input.specId} in project ${input.projectRoot}. Validate implementation correctness, deterministic server authority, client/server sync, performance budgets, streaming and asset pipeline behavior, tool workflows, data migration safety, security/anti-cheat boundaries, and build/release impact. Write ${AUTOCODE_TASK_ARTIFACTS.qaReport} with Status: PASSED or Status: FAILED.`;
  }
  return `You are a QA reviewer agent. Your job is to review the implementation of spec ${input.specId} in project ${input.projectRoot}. Check that all requirements in ${AUTOCODE_TASK_ARTIFACTS.specFile} are implemented correctly and write a ${AUTOCODE_TASK_ARTIFACTS.qaReport} with Status: PASSED or Status: FAILED.`;
}

export function buildAutocodeDefaultDirectTaskPrompt(input: Omit<BuildAutocodeAgentPromptInput, 'projectType'>): string {
  return [
    `Complete task ${input.specId} in ${input.projectRoot}.`,
    'Use one concise coding session. Do not create spec, planning, QA, or subagents.',
    'If the task is pure question-answer, explanation, translation, summarization, or does not require changing files, do not call tools. Answer directly in the final markdown table.',
    'Use the first user message as the task source. Do not read task metadata, requirements, implementation plans, previous specs, or broad directory listings unless the request is ambiguous.',
    'For simple documentation or question-answer tasks, do not probe candidate files like README*, package.json, *.html, or *.md. If creating an obvious file such as README.md, write it directly.',
    'Inspect only necessary files, edit directly, run one focused validation for simple tasks, and end with a short markdown table: What changed, Verification, Review notes.',
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
  const requirementsPath = join(input.specDir, AUTOCODE_TASK_ARTIFACTS.requirements);
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
  parts.push('If this is pure question-answer, explanation, translation, summarization, or does not require changing files, do not call tools; answer directly in the final markdown table.');
  parts.push('Do not read task metadata, requirements, implementation plans, previous specs, or broad directory listings unless this request is missing or ambiguous.');
  parts.push('For simple documentation or question-answer tasks, do not probe candidate files like README*, package.json, *.html, or *.md; write the obvious target file directly.');
  parts.push('For simple single-file/documentation tasks, edit first and use at most one verification command or read-back.');
  parts.push('');

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

  const requirements = readJson<{
    task_description?: string;
    attached_images?: Array<{ filename?: string; path?: string }>;
  }>(requirementsPath);
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

  parts.push(`You are implementing spec ${input.specId} in project: ${input.projectRoot}`);
  parts.push(`Spec directory: ${input.specDir}`);
  if (input.language === 'zh-CN') {
    parts.push('Language: write all non-code prose, progress updates, summaries, task titles, and review notes in Simplified Chinese.');
  } else if (input.language === 'fr') {
    parts.push('Language: write all non-code prose, progress updates, summaries, task titles, and review notes in French.');
  }
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
    parts.push('```json');
    parts.push(planContent);
    parts.push('```');
    parts.push('');
    parts.push(`Resume implementing the pending/in-progress subtasks. Do NOT redo completed subtasks. Update each subtask status to "completed" in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} after finishing it.`);
  } else {
    parts.push(`No implementation plan exists yet. Start by creating ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} with phases and subtasks, then implement each subtask.`);
  }

  return [{ role: 'user', content: parts.join('\n') }];
}

export function buildAutocodeQAInitialMessages(
  input: Omit<BuildAutocodeRuntimeMessagesInput, 'language'>,
): AutocodeAgentMessage[] {
  const parts: string[] = [];

  parts.push(`You are reviewing the implementation of spec ${input.specId} in project: ${input.projectRoot}`);
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
    parts.push('```json');
    parts.push(planContent);
    parts.push('```');
    parts.push('');
  }

  parts.push(`Review the implementation against the specification. Check that all requirements are met, the code is correct, and tests pass. Write your findings to ${AUTOCODE_TASK_ARTIFACTS.qaReport} with "Status: PASSED" or "Status: FAILED" and a list of any issues found.`);

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
