import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { safeParseAutocodeJson } from './json-repair.js';
import {
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  withAutocodeRuntimeFileWriteLockSync,
} from '../runtime/workspace-claims.js';

export interface AutocodeTaskRequirements extends Record<string, unknown> {
  contract_version?: number;
  task_description?: string;
  workflow_type?: string;
  services_involved?: string[];
  user_requirements?: string[];
  acceptance_criteria?: string[];
  constraints?: string[];
  evidence_sources?: string[];
  standards_references?: string[];
  assumptions?: string[];
  open_questions?: string[];
  created_at?: string;
  attached_images?: Array<{
    filename?: string;
    path?: string;
    description?: string;
    [key: string]: unknown;
  }>;
}

const KNOWN_REQUIREMENT_KEYS = new Set([
  'contract_version',
  'task_description',
  'workflow_type',
  'services_involved',
  'user_requirements',
  'acceptance_criteria',
  'constraints',
  'evidence_sources',
  'standards_references',
  'assumptions',
  'open_questions',
  'created_at',
  'attached_images',
]);

export function getAutocodeTaskRequirementsPath(specDir: string): string {
  return join(specDir, AUTOCODE_TASK_ARTIFACTS.requirements);
}

export function resolveAutocodeRequirementsSpecDir(specDirOrRequirementsPath: string): string {
  return basename(specDirOrRequirementsPath) === AUTOCODE_TASK_ARTIFACTS.requirements
    ? dirname(specDirOrRequirementsPath)
    : specDirOrRequirementsPath;
}

export function loadAutocodeTaskRequirementsSync(
  specDirOrRequirementsPath: string,
): AutocodeTaskRequirements | null {
  const specDir = resolveAutocodeRequirementsSpecDir(specDirOrRequirementsPath);
  const requirementsPath = getAutocodeTaskRequirementsPath(specDir);
  if (!existsSync(requirementsPath)) {
    return null;
  }

  try {
    return parseAutocodeTaskRequirementsMarkdown(readFileSync(requirementsPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveAutocodeTaskRequirementsSync(
  specDirOrRequirementsPath: string,
  requirements: AutocodeTaskRequirements,
): void {
  const specDir = resolveAutocodeRequirementsSpecDir(specDirOrRequirementsPath);
  const requirementsPath = getAutocodeTaskRequirementsPath(specDir);
  withAutocodeRuntimeFileWriteLockSync(
    {
      ...inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(specDir),
      filePath: requirementsPath,
      ownerId: 'requirements-store:save',
    },
    () => {
      mkdirSync(specDir, { recursive: true });
      writeFileSync(
        requirementsPath,
        stringifyAutocodeTaskRequirementsMarkdown(requirements),
        'utf-8',
      );
    },
  );
}

export function parseAutocodeTaskRequirementsMarkdown(content: string): AutocodeTaskRequirements {
  const requirements: AutocodeTaskRequirements = {};
  const contractVersion = Number(/^(?:Requirements-Contract|Contract-Version):\s*(\d+)\s*$/im.exec(content)?.[1]);
  const taskDescription = sectionContent(content, 'Task Description');
  const workflowType = firstNonEmptyLine(sectionContent(content, 'Workflow Type'));
  const createdAt = firstNonEmptyLine(sectionContent(content, 'Created At'));
  const attachedImages = parseJsonSection(sectionContent(content, 'Attached Images'));
  const extraMetadata = parseJsonSection(sectionContent(content, 'Extra Metadata'));

  if (Number.isFinite(contractVersion) && contractVersion > 0) requirements.contract_version = contractVersion;
  if (taskDescription) requirements.task_description = taskDescription;
  if (workflowType) requirements.workflow_type = workflowType;
  const servicesSection = sectionContent(content, 'Services Involved');
  const services = parseMarkdownList(servicesSection);
  if (services.length > 0 || servicesSection) requirements.services_involved = services;
  const userRequirementsSection = sectionContent(content, 'User Requirements');
  const userRequirements = parseMarkdownList(userRequirementsSection);
  if (userRequirements.length > 0 || userRequirementsSection) requirements.user_requirements = userRequirements;
  const acceptanceCriteriaSection = sectionContent(content, 'Acceptance Criteria');
  const acceptanceCriteria = parseMarkdownList(acceptanceCriteriaSection);
  if (acceptanceCriteria.length > 0 || acceptanceCriteriaSection) requirements.acceptance_criteria = acceptanceCriteria;
  const constraintsSection = sectionContent(content, 'Constraints');
  const constraints = parseMarkdownList(constraintsSection);
  if (constraints.length > 0 || constraintsSection) requirements.constraints = constraints;
  const evidenceSourcesSection = sectionContent(content, 'Evidence Sources');
  const evidenceSources = parseMarkdownList(evidenceSourcesSection);
  if (evidenceSources.length > 0 || evidenceSourcesSection) requirements.evidence_sources = evidenceSources;
  const standardsReferencesSection = sectionContent(content, 'Standards References');
  const standardsReferences = parseMarkdownList(standardsReferencesSection);
  if (standardsReferences.length > 0 || standardsReferencesSection) requirements.standards_references = standardsReferences;
  const assumptionsSection = sectionContent(content, 'Assumptions');
  const assumptions = parseMarkdownList(assumptionsSection);
  if (assumptions.length > 0 || assumptionsSection) requirements.assumptions = assumptions;
  const openQuestionsSection = sectionContent(content, 'Open Questions');
  const openQuestions = parseMarkdownList(openQuestionsSection);
  if (openQuestions.length > 0 || openQuestionsSection) requirements.open_questions = openQuestions;
  if (createdAt) requirements.created_at = createdAt;
  if (Array.isArray(attachedImages)) {
    requirements.attached_images = attachedImages as AutocodeTaskRequirements['attached_images'];
  }
  if (extraMetadata && typeof extraMetadata === 'object' && !Array.isArray(extraMetadata)) {
    Object.assign(requirements, extraMetadata);
  }

  return requirements;
}

export function stringifyAutocodeTaskRequirementsMarkdown(
  requirements: AutocodeTaskRequirements,
): string {
  const normalizedRequirements = normalizeAutocodeTaskRequirements(requirements);
  const contractVersion = Number.isFinite(requirements.contract_version)
    ? Math.max(1, Math.floor(Number(requirements.contract_version)))
    : 1;
  const lines: string[] = ['# Requirements', '', `Requirements-Contract: ${contractVersion}`, ''];
  addTextSection(lines, 'Task Description', stringFrom(normalizedRequirements.task_description));
  addTextSection(lines, 'Workflow Type', stringFrom(normalizedRequirements.workflow_type));
  addListSection(lines, 'Services Involved', toStringArray(normalizedRequirements.services_involved));
  addListSection(lines, 'User Requirements', toStringArray(normalizedRequirements.user_requirements));
  addListSection(lines, 'Acceptance Criteria', toStringArray(normalizedRequirements.acceptance_criteria));
  addListSection(lines, 'Constraints', toStringArray(normalizedRequirements.constraints));
  addListSection(lines, 'Evidence Sources', toStringArray(normalizedRequirements.evidence_sources));
  addListSection(lines, 'Standards References', toStringArray(normalizedRequirements.standards_references));
  addListSection(lines, 'Assumptions', toStringArray(normalizedRequirements.assumptions));
  addListSection(lines, 'Open Questions', toStringArray(normalizedRequirements.open_questions));
  addTextSection(lines, 'Created At', stringFrom(normalizedRequirements.created_at));

  if (Array.isArray(normalizedRequirements.attached_images) && normalizedRequirements.attached_images.length > 0) {
    addJsonSection(lines, 'Attached Images', normalizedRequirements.attached_images);
  }

  const extraMetadata = Object.fromEntries(
    Object.entries(normalizedRequirements)
      .filter(([key, value]) => !KNOWN_REQUIREMENT_KEYS.has(key) && value !== undefined),
  );
  if (Object.keys(extraMetadata).length > 0) {
    addJsonSection(lines, 'Extra Metadata', extraMetadata);
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function normalizeAutocodeTaskRequirements(
  requirements: AutocodeTaskRequirements,
): AutocodeTaskRequirements {
  const normalized: AutocodeTaskRequirements = { ...requirements };
  const usedIds = collectStructuredRequirementIds(requirements);
  const nextByPrefix = new Map<string, number>();

  const normalizeSection = (key: keyof AutocodeTaskRequirements, prefix: string): void => {
    const values = toStringArray(requirements[key]);
    normalized[key] = values.map((value) => normalizeStructuredRequirementEntry(
      value,
      prefix,
      usedIds,
      nextByPrefix,
    )) as never;
  };

  normalizeSection('user_requirements', 'R');
  normalizeSection('acceptance_criteria', 'AC');
  normalizeSection('constraints', 'C');
  normalizeSection('evidence_sources', 'E');
  normalizeSection('standards_references', 'E');
  normalizeSection('assumptions', 'A');
  normalizeSection('open_questions', 'Q');
  normalized.contract_version = Number.isFinite(requirements.contract_version)
    ? Math.max(1, Math.floor(Number(requirements.contract_version)))
    : 1;
  return normalized;
}

function collectStructuredRequirementIds(requirements: AutocodeTaskRequirements): Set<string> {
  const ids = new Set<string>();
  for (const key of [
    'user_requirements',
    'acceptance_criteria',
    'constraints',
    'evidence_sources',
    'standards_references',
    'assumptions',
    'open_questions',
  ] as const) {
    for (const value of toStringArray(requirements[key])) {
      const entry = parseStructuredRequirementEntry(value);
      if (entry) {
        ids.add(entry.id);
      }
    }
  }
  return ids;
}

function normalizeStructuredRequirementEntry(
  value: string,
  prefix: string,
  usedIds: Set<string>,
  nextByPrefix: Map<string, number>,
): string {
  const existing = parseStructuredRequirementEntry(value);
  if (existing) {
    return `${existing.id}: ${existing.body}`;
  }

  let next = nextByPrefix.get(prefix) ?? 1;
  while (usedIds.has(`${prefix}${next}`)) {
    next += 1;
  }
  const id = `${prefix}${next}`;
  usedIds.add(id);
  nextByPrefix.set(prefix, next + 1);
  return `${id}: ${singleLine(value)}`;
}

function parseStructuredRequirementEntry(value: string): { id: string; body: string } | null {
  const match = value.match(
    /^\s*(?:\[)?((?:R|AC|C|A|Q|E)\d+)(?:\])?\s*(?::|\.|-|\u2013)\s*(.+?)\s*$/i,
  );
  return match
    ? { id: match[1].toUpperCase(), body: singleLine(match[2]) }
    : null;
}

function addTextSection(lines: string[], title: string, value: string): void {
  lines.push(`## ${title}`, '', value, '');
}

function addListSection(lines: string[], title: string, values: string[]): void {
  lines.push(`## ${title}`, '');
  if (values.length === 0) {
    lines.push('- None');
  } else {
    for (const value of values) {
      lines.push(`- ${singleLine(value)}`);
    }
  }
  lines.push('');
}

function addJsonSection(lines: string[], title: string, value: unknown): void {
  lines.push(`## ${title}`, '', '```json', JSON.stringify(value, null, 2), '```', '');
}

function sectionContent(content: string, title: string): string {
  const target = title.toLowerCase();
  const lines = content.split(/\r?\n/);
  const sectionLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (inSection) {
        break;
      }
      inSection = heading[1].trim().toLowerCase() === target;
      continue;
    }

    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join('\n').trim();
}

function firstNonEmptyLine(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

function parseMarkdownList(content: string): string[] {
  const values = content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.*?)\s*$/)?.[1]?.trim())
    .filter((item): item is string => Boolean(item && item !== 'None'));
  if (values.length > 0) {
    return values;
  }
  const fallback = content.trim();
  if (/^-\s+None$/i.test(fallback)) {
    return [];
  }
  return fallback && fallback !== 'None' ? [fallback] : [];
}

function parseJsonSection(content: string): unknown {
  if (!content) {
    return undefined;
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const jsonText = fence?.[1]?.trim() || content.trim();
  try {
    return safeParseAutocodeJson(jsonText);
  } catch {
    return undefined;
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => stringFrom(item)).filter(Boolean)
    : [];
}

function stringFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
