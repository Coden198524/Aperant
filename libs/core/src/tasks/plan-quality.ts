import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { parseAutocodeImplementationPlanMarkdown } from './plan-store.js';
import { formatAutocodeRetryErrorLines } from '../text/compaction.js';

export type AutocodeEvidenceConfidence = 'low' | 'medium' | 'high';

export interface AutocodeContextEvidenceSource {
  path: string;
  symbol?: string;
  lines?: string;
  proves: string;
  confidence: AutocodeEvidenceConfidence;
}

export interface AutocodePlanArtifactLimit {
  maxLines: number;
  maxChars: number;
}

export interface AutocodePlanQualityLimits {
  context: AutocodePlanArtifactLimit;
  spec: AutocodePlanArtifactLimit;
  requirements: AutocodePlanArtifactLimit;
  tasks: AutocodePlanArtifactLimit;
}

export interface ValidateAutocodeStandardPlanArtifactsInput {
  specMarkdown?: string | null;
  requirementsMarkdown?: string | null;
  tasksMarkdown?: string | null;
  contextMarkdown?: string | null;
  limits?: Partial<AutocodePlanQualityLimits>;
  requireSpecEvidence?: boolean;
  requireRequirementsEvidence?: boolean;
  requireTaskEvidence?: boolean;
  requireContextEvidence?: boolean;
}

export interface AutocodePlanQualityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS: AutocodePlanQualityLimits = {
  context: { maxLines: 220, maxChars: 18_000 },
  spec: { maxLines: 150, maxChars: 16_000 },
  requirements: { maxLines: 160, maxChars: 14_000 },
  tasks: { maxLines: 450, maxChars: 32_000 },
};

const EMPTY_EVIDENCE_TOKENS = new Set([
  'none',
  'n/a',
  'na',
  'unknown',
  'todo',
  'tbd',
  'no evidence',
  'unspecified',
]);

const TRACEABLE_EVIDENCE_PATTERN =
  /\b(spec\.md|requirements\.md|context\.md|research\.md|agents\.md|readme|official|standard|docs?|source|project)\b|[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/i;

const GENERIC_TASK_TITLE_PATTERN =
  /^(?:implement|build|add|create|update|modify|wire|integrate|refactor|fix|improve|clean ?up|test)\s+(?:the\s+)?(?:feature|functionality|logic|code|implementation|changes?|updates?|module|components?|ui|backend|frontend|api|tests?|test coverage|docs?|documentation|files?|system|workflow|integration|support|structure|bug|issue)$/i;

const GENERIC_TASK_DESCRIPTION_PATTERN =
  /^(?:update|modify|implement|add|create|fix|refactor|test)\s+(?:the\s+)?(?:code|logic|feature|functionality|implementation|files?|tests?|changes?)\.?$/i;

const READ_ONLY_VALIDATION_TASK_PATTERN =
  /\b(?:validate|verify|verification|manual qa|qa|smoke|test|typecheck|lint|build)\b/i;

const TASK_DONE_SIGNAL_PATTERN =
  /\b(?:done when|complete when|finished when|ready when|completion criteria|acceptance criteria|success criteria|success criterion)\b|完成条件|完成标准|验收标准|验收条件|成功标准/iu;

const PROJECT_SPECIFIC_TASK_ANCHOR_PATTERN =
  /[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+|\b(?:package|tsconfig|vite|vitest|webpack|rollup|biome|eslint|cargo|go|pyproject)\.[A-Za-z0-9.]+|\b[A-Z][A-Za-z0-9]*(?:Service|Manager|Controller|Adapter|Provider|Store|Repository|Bridge|Machine|Orchestrator|Runner|Renderer|Handler|Client|Config|Panel|Dialog|View|Model|Schema)\b|\buse[A-Z][A-Za-z0-9]+\b|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/;

const PLAN_ARTIFACT_FILE_NAMES = new Set([
  AUTOCODE_TASK_ARTIFACTS.specFile.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.requirements.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.context.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.research.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.tasks.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.implementationPlan.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.qaReport.toLowerCase(),
  'build-progress.txt',
]);

export function validateAutocodeStandardPlanArtifacts(
  input: ValidateAutocodeStandardPlanArtifactsInput,
): AutocodePlanQualityResult {
  const limits = mergeAutocodePlanQualityLimits(input.limits);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.specMarkdown !== undefined && input.specMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.specFile, input.specMarkdown, limits.spec));
    if (input.requireSpecEvidence) {
      errors.push(...validateSpecEvidence(input.specMarkdown));
    }
  } else if (input.requireSpecEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} is missing.`);
  }

  if (input.requirementsMarkdown !== undefined && input.requirementsMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.requirements, input.requirementsMarkdown, limits.requirements));
    if (input.requireRequirementsEvidence) {
      errors.push(...validateRequirementsEvidence(input.requirementsMarkdown));
    }
  } else if (input.requireRequirementsEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.requirements} is missing.`);
  }

  if (input.tasksMarkdown !== undefined && input.tasksMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.tasks, input.tasksMarkdown, limits.tasks));
    if (input.requireTaskEvidence) {
      errors.push(...validateTasksEvidence(input.tasksMarkdown));
    }
  } else if (input.requireTaskEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} is missing.`);
  }

  if (input.contextMarkdown !== undefined && input.contextMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.context, input.contextMarkdown, limits.context));
    errors.push(...validateContextMarkdownEvidence(input.contextMarkdown, input.requireContextEvidence === true));
  } else if (input.requireContextEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} is missing.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function buildAutocodePlanQualityRetryPrompt(errors: string[]): string {
  return [
    'REWRITE STANDARD PLAN ARTIFACTS',
    '',
    'The previous Standard planning artifacts failed quality validation.',
    '',
    'Errors:',
    ...formatAutocodeRetryErrorLines(errors),
    '',
    'Repair only the affected artifacts with the Write/Edit tools.',
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.specFile} as a compact decision index, not a full analysis dump.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.requirements} focused on requirements, acceptance criteria, constraints, evidence sources, standards, and assumptions.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.tasks} concise and make every executable subtask traceable to requirements, evidence, done criteria, and verification.`,
    '- Replace generic task text with concrete behavior, affected project boundary, likely files/APIs, and the existing pattern to follow.',
    '- Every executable task must include _Requirements: ..._, _Evidence: ..._, a done signal such as _Done when: ..._, and _Verification: ..._.',
    '- Preserve requirement IDs and unaffected design/task content during Request Changes iterations.',
    '- Use Evidence references instead of copying source code or long research notes.',
    '- If evidence is missing, add an assumption/open question or validation task instead of inventing implementation work.',
  ].join('\n');
}

export function normalizeAutocodeContextEvidenceSources(value: unknown): AutocodeContextEvidenceSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeAutocodeContextEvidenceSource)
    .filter((item): item is AutocodeContextEvidenceSource => Boolean(item));
}

export function normalizeAutocodeContextEvidenceSource(value: unknown): AutocodeContextEvidenceSource | null {
  if (typeof value === 'string') {
    const [pathPart, ...rest] = value.split(/\s+-\s+/);
    const path = singleLine(pathPart);
    const proves = singleLine(rest.join(' - ')) || path;
    if (!path || !proves) {
      return null;
    }
    return {
      path,
      proves,
      confidence: 'medium',
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.source);
  const symbol = singleLine(record.symbol ?? record.name ?? record.function ?? record.class);
  const lines = singleLine(record.lines ?? record.line_range ?? record.range);
  const proves = singleLine(record.proves ?? record.reason ?? record.claim ?? record.description ?? record.pattern);
  const confidence = normalizeAutocodeEvidenceConfidence(record.confidence);
  if (!path || !proves) {
    return null;
  }

  return {
    path,
    ...(symbol ? { symbol } : {}),
    ...(lines ? { lines } : {}),
    proves,
    confidence,
  };
}

export function isMeaningfulAutocodeEvidence(value: unknown): boolean {
  const text = singleLine(value).toLowerCase();
  return text.length >= 6 && !EMPTY_EVIDENCE_TOKENS.has(text);
}

export function isTraceableAutocodeEvidence(value: unknown): boolean {
  const text = singleLine(value);
  return isMeaningfulAutocodeEvidence(text) && TRACEABLE_EVIDENCE_PATTERN.test(text);
}

function mergeAutocodePlanQualityLimits(
  overrides?: Partial<AutocodePlanQualityLimits>,
): AutocodePlanQualityLimits {
  return {
    context: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.context, ...overrides?.context },
    spec: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.spec, ...overrides?.spec },
    requirements: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.requirements, ...overrides?.requirements },
    tasks: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.tasks, ...overrides?.tasks },
  };
}

function validateMarkdownSize(fileName: string, content: string, limit: AutocodePlanArtifactLimit): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n').length;
  const chars = content.length;
  const errors: string[] = [];
  if (lines > limit.maxLines) {
    errors.push(`${fileName} is too large: ${lines} lines exceeds ${limit.maxLines}; compress it and keep detailed evidence in context/research/tasks references.`);
  }
  if (chars > limit.maxChars) {
    errors.push(`${fileName} is too large: ${chars} chars exceeds ${limit.maxChars}; remove copied source, long rationale, or duplicate analysis.`);
  }
  return errors;
}

function validateSpecEvidence(specMarkdown: string): string[] {
  const errors: string[] = [];
  if (!/^\s*##\s+Evidence\b/im.test(specMarkdown)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} missing "## Evidence" section.`);
  }
  if (hasSectionContent(specMarkdown, 'Requirements') && !sectionContainsEvidence(specMarkdown, 'Requirements')) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Requirements section must cite Evidence for requirements or acceptance criteria.`);
  }
  if (hasSectionContent(specMarkdown, 'Design Notes') && !sectionContainsEvidence(specMarkdown, 'Design Notes')) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Design Notes must cite Evidence or move unverified claims to Assumptions/Open Questions.`);
  }
  return errors;
}

function validateRequirementsEvidence(requirementsMarkdown: string): string[] {
  const evidenceSection = getMarkdownSection(requirementsMarkdown, 'Evidence Sources');
  if (!evidenceSection || !/-\s+\S/.test(evidenceSection)) {
    return [`${AUTOCODE_TASK_ARTIFACTS.requirements} missing non-empty "Evidence Sources" section.`];
  }
  return [];
}

function validateTasksEvidence(tasksMarkdown: string): string[] {
  let plan;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  } catch (error) {
    return [`${AUTOCODE_TASK_ARTIFACTS.tasks} could not be parsed: ${error instanceof Error ? error.message : String(error)}`];
  }

  const errors: string[] = [];
  const subtasks = getPlanSubtasks(plan);
  if (subtasks.length === 0) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} contains no executable subtasks.`);
  }

  for (const subtask of subtasks) {
    const record = subtask as Record<string, unknown>;
    const id = singleLine(record.id) || 'unknown';
    if (!hasMeaningfulTaskRequirements(record)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing _Requirements: ..._ metadata; cite requirement, scenario, acceptance criterion, or success criterion IDs.`);
    }
    if (!isMeaningfulAutocodeEvidence(record.evidence)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing _Evidence: ..._ metadata.`);
    } else if (!isTraceableAutocodeEvidence(record.evidence)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} has vague _Evidence_; cite spec.md, requirements.md, ${AUTOCODE_TASK_ARTIFACTS.context}, ${AUTOCODE_TASK_ARTIFACTS.research}, project source/docs, or official/industry references.`);
    }
    if (!hasTaskDoneSignal(record)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing a done signal; add _Done when: ..._ or explicit completion criteria.`);
    }
  }
  errors.push(...validateTaskProjectSpecificity(plan));
  return errors;
}

function validateTaskProjectSpecificity(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): string[] {
  const errors: string[] = [];
  let executableTaskCount = 0;
  let anchoredTaskCount = 0;

  for (const subtask of getPlanSubtasks(plan)) {
    executableTaskCount += 1;
    const record = subtask as Record<string, unknown>;
    const id = singleLine(record.id) || 'unknown';
    const title = singleLine(record.title);
    const description = singleLine(record.description);
    const hasAnchor = hasProjectSpecificTaskAnchor(record);
    if (hasAnchor) {
      anchoredTaskCount += 1;
    }

    if (isReadOnlyValidationTask(record, title, description)) {
      continue;
    }
    if (isGenericTaskTitle(title) && !hasAnchor) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} is too generic; name the concrete project boundary, behavior, and source/API pattern it follows.`);
    } else if (isGenericTaskDescription(title, description) && !hasAnchor) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} has boilerplate guidance; add project-specific files, APIs, module boundaries, or existing patterns.`);
    }
  }

  if (executableTaskCount > 0 && anchoredTaskCount === 0) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} has no project-specific task anchors; cite source files, project docs, APIs, commands, or explicit files to create/modify.`);
  }

  return errors;
}

function getPlanSubtasks(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): Record<string, unknown>[] {
  const subtasks: Record<string, unknown>[] = [];
  for (const phase of plan.phases ?? []) {
    const phaseSubtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const subtask of phaseSubtasks) {
      if (subtask && typeof subtask === 'object' && !Array.isArray(subtask)) {
        subtasks.push(subtask as Record<string, unknown>);
      }
    }
  }
  return subtasks;
}

function hasMeaningfulTaskRequirements(subtask: Record<string, unknown>): boolean {
  return stringArrayField(subtask.requirements).some(isMeaningfulTaskRequirement);
}

function isMeaningfulTaskRequirement(value: string): boolean {
  const text = singleLine(value).toLowerCase();
  return text.length > 0 && !EMPTY_EVIDENCE_TOKENS.has(text) && text !== 'no requirements';
}

function hasTaskDoneSignal(subtask: Record<string, unknown>): boolean {
  const explicitDoneFields = [
    subtask.done_when,
    subtask.doneWhen,
    subtask.completion_criteria,
    subtask.completionCriteria,
    subtask.acceptance_criteria,
    subtask.acceptanceCriteria,
    subtask.success_criteria,
    subtask.successCriteria,
  ];
  if (explicitDoneFields.some(isMeaningfulAutocodeEvidence)) {
    return true;
  }

  const taskText = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.completion_summary),
    stringifyTaskValue(subtask.notes),
  ].join(' ');
  return TASK_DONE_SIGNAL_PATTERN.test(taskText);
}

function isReadOnlyValidationTask(
  subtask: Record<string, unknown>,
  title: string,
  description: string,
): boolean {
  const writeIntent = [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ].filter((item) => !EMPTY_EVIDENCE_TOKENS.has(item.toLowerCase()));
  if (writeIntent.length > 0) {
    return false;
  }

  return READ_ONLY_VALIDATION_TASK_PATTERN.test([title, description].join(' '));
}

function hasProjectSpecificTaskAnchor(subtask: Record<string, unknown>): boolean {
  const fileAnchors = [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
    ...stringArrayField(subtask.pattern_files),
  ];
  if (fileAnchors.some(isProjectSpecificFileAnchor)) {
    return true;
  }

  const taskText = stripPlanArtifactMentions([
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.evidence),
    stringifyTaskValue(subtask.verification),
  ].join(' '));

  return PROJECT_SPECIFIC_TASK_ANCHOR_PATTERN.test(taskText);
}

function isGenericTaskTitle(title: string): boolean {
  return GENERIC_TASK_TITLE_PATTERN.test(normalizeTaskQualityText(title));
}

function isGenericTaskDescription(title: string, description: string): boolean {
  const normalizedDescription = normalizeTaskQualityText(description);
  if (!normalizedDescription || normalizedDescription === normalizeTaskQualityText(title)) {
    return true;
  }
  return GENERIC_TASK_DESCRIPTION_PATTERN.test(normalizedDescription);
}

function normalizeTaskQualityText(value: string): string {
  return value
    .replace(/[`*_()[\]{}:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isProjectSpecificFileAnchor(value: string): boolean {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
    .toLowerCase();
  if (!normalized || EMPTY_EVIDENCE_TOKENS.has(normalized)) {
    return false;
  }
  const fileName = normalized.split('/').pop() ?? normalized;
  return !PLAN_ARTIFACT_FILE_NAMES.has(fileName);
}

function stripPlanArtifactMentions(value: string): string {
  return value.replace(/\b(?:spec|requirements|context|research|tasks|implementation_plan|build-progress|qa_report|human_input|change_requests)\.(?:md|jsonl?)\b/gi, ' ');
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => singleLine(item)).filter(Boolean);
}

function stringifyTaskValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return singleLine(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyTaskValue).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(stringifyTaskValue).filter(Boolean).join(' ');
  }
  return '';
}

export function stringifyAutocodeContextMarkdown(contextData: unknown): string {
  const context = parseContextObject(contextData) ?? {};
  const lines: string[] = ['# Project Context', ''];
  const taskDescription = singleLine(context.task_description);
  if (taskDescription) {
    addSection(lines, 'Task', [taskDescription]);
  }

  addSection(lines, 'Scoped Services', toBulletItems(context.scoped_services));

  const architectureSummary = singleLine(context.architecture_summary);
  if (architectureSummary) {
    addSection(lines, 'Architecture Summary', [architectureSummary]);
  }

  addSection(lines, 'Files To Modify', formatFileModificationItems(context.files_to_modify));
  addSection(lines, 'Files To Reference', formatFileReferenceItems(context.files_to_reference));
  addSection(lines, 'Design Patterns', formatDesignPatternItems(context.design_patterns));
  addSection(lines, 'Implementation Notes', toBulletItems(context.implementation_notes));
  addSection(lines, 'Risks', toBulletItems(context.risks));
  addSection(lines, 'Verification Suggestions', toBulletItems(context.verification_suggestions));
  addSection(lines, 'Standards References', toBulletItems(context.standards_references));
  addSection(lines, 'Assumptions', toBulletItems(context.assumptions));

  const evidence = normalizeAutocodeContextEvidenceSources(
    Array.isArray(context.evidence_sources) ? context.evidence_sources : [],
  );
  addSection(
    lines,
    'Evidence Sources',
    evidence.map((item) => formatContextEvidenceSource(item)),
  );

  const createdAt = singleLine(context.created_at);
  if (createdAt) {
    addSection(lines, 'Metadata', [`Created At: ${createdAt}`]);
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function validateContextMarkdownEvidence(contextMarkdown: string, requireEvidence: boolean): string[] {
  const evidenceSection = getMarkdownSection(contextMarkdown, 'Evidence Sources');
  const errors: string[] = [];
  if (requireEvidence && hasContextMarkdownClaims(contextMarkdown) && !/-\s+\S/.test(evidenceSection)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} missing non-empty "Evidence Sources" section.`);
    return errors;
  }

  const evidenceLines = evidenceSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line));
  evidenceLines.forEach((line, index) => {
    if (!isTraceableAutocodeEvidence(line)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} Evidence Sources item ${index + 1} is vague; cite a file, project doc, or verified reference.`);
    }
  });
  return errors;
}

function addSection(lines: string[], heading: string, items: string[]): void {
  const normalized = items.map(singleLine).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  lines.push(`## ${heading}`, '');
  if (normalized.length === 1 && !normalized[0].includes(':')) {
    lines.push(normalized[0], '');
    return;
  }

  lines.push(...normalized.map((item) => `- ${item}`), '');
}

function toBulletItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringifyContextMarkdownValue).filter(Boolean);
  }
  const text = stringifyContextMarkdownValue(value);
  return text ? [text] : [];
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [value];
}

function formatFileModificationItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.name);
    const reason = singleLine(record.reason ?? record.purpose ?? record.description);
    const change = singleLine(record.change_needed ?? record.changeNeeded ?? record.action ?? record.status);
    return [path, reason ? `reason: ${reason}` : '', change ? `change: ${change}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatFileReferenceItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.name);
    const reason = singleLine(record.reason ?? record.purpose ?? record.description);
    const pattern = singleLine(record.pattern ?? record.guidance ?? record.existing_usage);
    return [path, reason ? `reason: ${reason}` : '', pattern ? `pattern: ${pattern}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatDesignPatternItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const name = singleLine(record.name ?? record.pattern ?? record.title);
    const usage = singleLine(record.existing_usage ?? record.usage ?? record.location);
    const guidance = singleLine(record.guidance ?? record.description ?? record.reason);
    return [name, usage ? `usage: ${usage}` : '', guidance ? `guidance: ${guidance}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatContextEvidenceSource(item: AutocodeContextEvidenceSource): string {
  const detail = [
    item.symbol ? `symbol: ${item.symbol}` : '',
    item.lines ? `lines: ${item.lines}` : '',
    `confidence: ${item.confidence}`,
  ].filter(Boolean).join('; ');
  return `${item.path}${detail ? ` (${detail})` : ''} - ${item.proves}`;
}

function hasContextMarkdownClaims(contextMarkdown: string): boolean {
  return [
    'Architecture Summary',
    'Files To Modify',
    'Files To Reference',
    'Design Patterns',
    'Implementation Notes',
    'Risks',
  ].some((heading) => {
    const section = getMarkdownSection(contextMarkdown, heading);
    return Boolean(section && /\S/.test(section));
  });
}

function stringifyContextMarkdownValue(value: unknown): string {
  if (typeof value === 'string') {
    return singleLine(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(stringifyContextMarkdownValue).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferred = singleLine(
      record.path ??
      record.name ??
      record.title ??
      record.proves ??
      record.description ??
      record.reason,
    );
    return preferred || JSON.stringify(value);
  }
  return '';
}

function parseContextObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasSectionContent(markdown: string, heading: string): boolean {
  const section = getMarkdownSection(markdown, heading);
  return Boolean(section && /(?:^|\n)\s*(?:[-*]|\d+\.)\s+\S/.test(section));
}

function sectionContainsEvidence(markdown: string, heading: string): boolean {
  const section = getMarkdownSection(markdown, heading);
  return Boolean(section && /\bEvidence\s*:/i.test(section));
}

function getMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^##\\s+${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im').exec(markdown);
  return match?.[1]?.trim() ?? '';
}

function normalizeAutocodeEvidenceConfidence(value: unknown): AutocodeEvidenceConfidence {
  const text = singleLine(value).toLowerCase();
  if (text === 'low' || text === 'medium' || text === 'high') {
    return text;
  }
  return 'medium';
}

function singleLine(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
