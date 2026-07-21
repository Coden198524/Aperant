import { parseAutocodeImplementationPlanMarkdown } from './plan-store.js';
import { parseAutocodeTaskRequirementsMarkdown } from './requirements-store.js';
import {
  AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS,
  isAutocodeSlimRuntimeLedger,
} from './runtime-ledger.js';

export interface ValidateAutocodeStandardArtifactResponsibilitiesInput {
  requirementsMarkdown?: string | null;
  specMarkdown?: string | null;
  tasksMarkdown?: string | null;
  implementationPlanMarkdown?: string | null;
  previousTasksMarkdown?: string | null;
  previousImplementationPlanMarkdown?: string | null;
}

export interface AutocodeStandardArtifactResponsibilityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface RequirementEntry {
  id: string;
  body: string;
}

const REQUIREMENT_ID_PATTERN = /^(R\d+|AC\d+|C\d+|A\d+|Q\d+|E\d+)$/i;
const REQUIREMENT_REFERENCE_PATTERN = /\b(?:R|AC|C|A|Q|E)\d+\b/gi;
const RUNTIME_TASK_METADATA_PATTERN = /_?(?:Started|Completed|Updated|Duration|Retry(?: Count)?|Attempt(?: Count)?|Failure(?: Reason)?|Blocked(?: Reason)?|Git Commit)\s*:/i;
const SLIM_PLAN_STATIC_FIELD_PATTERN = /_?(?:Files(?: to (?:create|modify))?|Requirements|Design|Architecture|Evidence|Done when|Verification)\s*:/i;

export function validateAutocodeStandardArtifactResponsibilities(
  input: ValidateAutocodeStandardArtifactResponsibilitiesInput,
): AutocodeStandardArtifactResponsibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requirementsMarkdown = input.requirementsMarkdown ?? '';
  const requirementsContract = /^(?:Requirements-Contract|Contract-Version):\s*1\s*$/im.test(requirementsMarkdown);
  const entries = collectRequirementEntries(requirementsMarkdown);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  if (requirementsContract) {
    errors.push(...validateRequirementsOwnership(requirementsMarkdown, entries, entryById));
  }
  if (input.specMarkdown != null && (requirementsContract || hasSpecificationContract(input.specMarkdown))) {
    errors.push(...validateSpecificationOwnership(input.specMarkdown, entries, entryById));
  }
  if (input.tasksMarkdown != null && (requirementsContract || hasTasksContract(input.tasksMarkdown))) {
    errors.push(...validateTasksOwnership(
      input.tasksMarkdown,
      input.specMarkdown ?? '',
      entries,
      entryById,
    ));
  }
  if (
    input.tasksMarkdown != null &&
    input.previousTasksMarkdown != null &&
    input.previousImplementationPlanMarkdown != null
  ) {
    const historyResult = validateAutocodeCompletedTaskDefinitionHistory({
      tasksMarkdown: input.tasksMarkdown,
      previousTasksMarkdown: input.previousTasksMarkdown,
      previousImplementationPlanMarkdown: input.previousImplementationPlanMarkdown,
    });
    errors.push(...historyResult.errors);
    warnings.push(...historyResult.warnings);
  }
  if (input.implementationPlanMarkdown != null) {
    errors.push(...validateImplementationPlanOwnership(
      input.implementationPlanMarkdown,
      input.tasksMarkdown ?? '',
    ));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateAutocodeCompletedTaskDefinitionHistory(input: {
  tasksMarkdown: string;
  previousTasksMarkdown: string;
  previousImplementationPlanMarkdown: string;
}): AutocodeStandardArtifactResponsibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let previousPlan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    previousPlan = parseAutocodeImplementationPlanMarkdown(input.previousImplementationPlanMarkdown);
  } catch {
    return {
      valid: true,
      errors,
      warnings: ['Previous implementation_plan.md could not be parsed; completed task definition history was not checked.'],
    };
  }

  const completedTaskIds = new Set<string>();
  for (const phase of previousPlan.phases ?? []) {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const subtask of subtasks) {
      if (subtask.status !== 'completed') {
        continue;
      }
      for (const taskId of stringArrayFrom(subtask.upstream_task_ids)) {
        completedTaskIds.add(taskId);
      }
    }
  }
  if (completedTaskIds.size === 0) {
    return { valid: true, errors, warnings };
  }

  const previousDefinitions = collectStaticTaskDefinitions(input.previousTasksMarkdown);
  const currentDefinitions = collectStaticTaskDefinitions(input.tasksMarkdown);
  if (!previousDefinitions || !currentDefinitions) {
    return {
      valid: true,
      errors,
      warnings: ['tasks.md history could not be parsed; completed task definition history was not checked.'],
    };
  }

  for (const taskId of Array.from(completedTaskIds).sort()) {
    const previousDefinition = previousDefinitions.get(taskId);
    if (!previousDefinition) {
      warnings.push(
        `Previous tasks.md does not contain completed task ${taskId}; its historical definition could not be checked.`,
      );
      continue;
    }
    const currentDefinition = currentDefinitions.get(taskId);
    if (!currentDefinition) {
      errors.push(
        `tasks.md removed completed task ${taskId}; restore its prior definition and add revised work under a new task ID.`,
      );
      continue;
    }
    if (currentDefinition !== previousDefinition) {
      errors.push(
        `tasks.md changed completed task ${taskId}; restore its prior definition and add revised work under a new task ID.`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateRequirementsOwnership(
  markdown: string,
  entries: RequirementEntry[],
  entryById: Map<string, RequirementEntry>,
): string[] {
  const errors: string[] = [];
  const parsed = parseAutocodeTaskRequirementsMarkdown(markdown);
  errors.push(...validateRequirementSectionIds('User Requirements', parsed.user_requirements, 'R'));
  errors.push(...validateRequirementSectionIds('Acceptance Criteria', parsed.acceptance_criteria, 'AC'));
  errors.push(...validateRequirementSectionIds('Evidence Sources', parsed.evidence_sources, 'E'));
  errors.push(...validateOptionalRequirementSectionIds('Constraints', parsed.constraints, 'C'));
  errors.push(...validateOptionalRequirementSectionIds('Standards References', parsed.standards_references, 'E'));
  errors.push(...validateOptionalRequirementSectionIds('Assumptions', parsed.assumptions, 'A'));
  errors.push(...validateOptionalRequirementSectionIds('Open Questions', parsed.open_questions, 'Q'));

  const duplicateIds = entries
    .map((entry) => entry.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    errors.push(`requirements.md defines duplicate stable IDs: ${Array.from(new Set(duplicateIds)).join(', ')}.`);
  }

  if (entryById.size === 0) {
    errors.push('requirements.md contract v1 must define stable R*, AC*, and E* entries.');
  }
  if (/\b(?:class|interface|module|component|service)\s+(?:architecture|design)\b/i.test(markdown)) {
    errors.push('requirements.md must not own internal architecture or design decisions; move them to design.md.');
  }
  return errors;
}

function validateOptionalRequirementSectionIds(
  sectionName: string,
  values: string[] | undefined,
  expectedPrefix: string,
): string[] {
  const meaningful = (values ?? []).filter((value) => !/^none$/i.test(value.trim()));
  if (meaningful.length === 0) {
    return [];
  }
  return validateRequirementSectionIds(sectionName, meaningful, expectedPrefix);
}

function validateRequirementSectionIds(
  sectionName: string,
  values: string[] | undefined,
  expectedPrefix: string,
): string[] {
  const meaningful = (values ?? []).filter((value) => !/^none$/i.test(value.trim()));
  if (meaningful.length === 0) {
    return [`requirements.md ${sectionName} must contain at least one ${expectedPrefix}* entry.`];
  }
  const invalid = meaningful.filter((value) => {
    const id = parseRequirementEntry(value)?.id ?? '';
    return !id.startsWith(expectedPrefix);
  });
  return invalid.length > 0
    ? [`requirements.md ${sectionName} entries must use stable ${expectedPrefix}* IDs: ${invalid.slice(0, 3).join('; ')}`]
    : [];
}

function validateSpecificationOwnership(
  markdown: string,
  requirementEntries: RequirementEntry[],
  entryById: Map<string, RequirementEntry>,
): string[] {
  const errors: string[] = [];
  if (!hasSpecificationContract(markdown)) {
    errors.push('spec.md must declare Specification-Contract: 1.');
  }
  const scenarios = collectScenarioSections(markdown);
  if (scenarios.length === 0) {
    errors.push('spec.md must define at least one stable SCN-* observable behavior section.');
  }
  for (const scenario of scenarios) {
    if (!/\bCovers\s*:\s*(?=[^\n]*(?:R|AC)\d+)/i.test(scenario.body)) {
      errors.push(`spec.md ${scenario.id} must link observable behavior with Covers: R*, AC*.`);
    }
    if (!/\bEvidence\s*:\s*[^\n]*\bE\d+\b/i.test(scenario.body)) {
      errors.push(`spec.md ${scenario.id} must cite requirements.md evidence with Evidence: E*.`);
    }
  }
  const coveredRequirementIds = new Set(
    scenarios.flatMap((scenario) => {
      const coversLine = /^\s*Covers\s*:\s*([^\n]+)$/im.exec(scenario.body)?.[1] ?? '';
      return (coversLine.match(/\b(?:R|AC)\d+\b/gi) ?? [])
        .map((reference) => reference.toUpperCase());
    }),
  );
  const uncoveredObservableIds = requirementEntries
    .map((entry) => entry.id)
    .filter((id) => /^(?:R|AC)\d+$/i.test(id) && !coveredRequirementIds.has(id));
  if (uncoveredObservableIds.length > 0) {
    errors.push(
      `spec.md scenarios do not cover requirements.md IDs: ${uncoveredObservableIds.join(', ')}.`,
    );
  }
  errors.push(...validateKnownReferences('spec.md', collectReferences(markdown), entryById));
  for (const entry of requirementEntries) {
    if (entry.body.length >= 24 && normalizeProse(markdown).includes(normalizeProse(entry.body))) {
      errors.push(`spec.md repeats ${entry.id} prose; keep the body only in requirements.md and cite ${entry.id}.`);
    }
  }
  if (/^##\s+(?:Evidence Sources?|Requirements|Acceptance Criteria)\s*$/im.test(markdown)) {
    errors.push('spec.md must reference R*/AC*/E* IDs instead of owning Requirements, Acceptance Criteria, or Evidence prose sections.');
  }
  return errors;
}

function validateTasksOwnership(
  markdown: string,
  specMarkdown: string,
  requirementEntries: RequirementEntry[],
  entryById: Map<string, RequirementEntry>,
): string[] {
  const errors: string[] = [];
  if (!hasTasksContract(markdown)) {
    errors.push('tasks.md must declare Tasks-Contract: 1.');
  }
  if (RUNTIME_TASK_METADATA_PATTERN.test(markdown)) {
    errors.push('tasks.md must not contain runtime status, timing, retry, failure, or commit metadata.');
  }

  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(markdown);
  } catch {
    return [...errors, 'tasks.md could not be parsed as static task definitions.'];
  }
  const subtasks = (plan.phases ?? []).flatMap((phase) =>
    Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [],
  );
  const knownScenarioIds = new Set(
    collectScenarioSections(specMarkdown).map((scenario) => scenario.id),
  );
  for (const task of subtasks) {
    const id = String(task.id ?? 'unknown');
    if (task.status !== 'pending') {
      errors.push(`tasks.md task ${id} uses a runtime checkbox state; static definitions must use [ ].`);
    }
    const references = collectReferences((task.requirements ?? []) as unknown);
    if (!references.some((reference) => /^R\d+$/i.test(reference) || /^AC\d+$/i.test(reference))) {
      errors.push(`tasks.md task ${id} must reference at least one R* or AC* ID.`);
    }
    errors.push(...validateKnownReferences(`tasks.md task ${id}`, references, entryById));
    const taskText = [
      String(task.description ?? ''),
      ...((task.requirements ?? []) as unknown[]).map((value) => String(value ?? '')),
      String(task.evidence ?? ''),
    ].join('\n');
    const scenarioReferences = Array.from(new Set(
      (taskText.match(/\bSCN-\d+\b/gi) ?? []).map((value) => value.toUpperCase()),
    ));
    if (hasSpecificationContract(specMarkdown) && scenarioReferences.length === 0) {
      errors.push(`tasks.md task ${id} must reference at least one SCN-* behavior from spec.md.`);
    }
    const unknownScenarios = scenarioReferences.filter((reference) => !knownScenarioIds.has(reference));
    if (unknownScenarios.length > 0) {
      errors.push(`tasks.md task ${id} references unknown spec.md scenarios: ${unknownScenarios.join(', ')}.`);
    }
    if (entryById.size > 0 && !/\bE\d+\b/i.test(String(task.evidence ?? ''))) {
      errors.push(`tasks.md task ${id} must reference at least one E* evidence ID.`);
    }
  }
  for (const entry of requirementEntries) {
    if (entry.body.length >= 24 && normalizeProse(markdown).includes(normalizeProse(entry.body))) {
      errors.push(`tasks.md repeats ${entry.id} prose; use the stable ID in _Requirements_ instead.`);
    }
  }
  return errors;
}

function validateImplementationPlanOwnership(markdown: string, tasksMarkdown: string): string[] {
  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(markdown);
  } catch {
    return ['implementation_plan.md could not be parsed.'];
  }
  if (!isAutocodeSlimRuntimeLedger(plan)) {
    return [];
  }

  const errors: string[] = [];
  const knownTaskIds = collectTaskIds(tasksMarkdown);
  if (SLIM_PLAN_STATIC_FIELD_PATTERN.test(markdown)) {
    errors.push('implementation_plan.md runtime ledger must not contain static task-definition fields.');
  }
  for (const phase of plan.phases ?? []) {
    const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [];
    for (const subtask of subtasks) {
      const historyOnly = subtask.history_only === true;
      const staticFields = AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS.filter((key) =>
        key !== 'title' && key !== 'description' && subtask[key] !== undefined,
      );
      if (staticFields.length > 0) {
        errors.push(`implementation_plan.md work package ${String(subtask.id ?? 'unknown')} persists static fields: ${staticFields.join(', ')}.`);
      }
      if (!historyOnly && (!Array.isArray(subtask.upstream_task_ids) || subtask.upstream_task_ids.length === 0)) {
        errors.push(`implementation_plan.md work package ${String(subtask.id ?? 'unknown')} is missing source task IDs.`);
      }
      if (!historyOnly && (typeof subtask.definition_fingerprint !== 'string' || !subtask.definition_fingerprint)) {
        errors.push(`implementation_plan.md work package ${String(subtask.id ?? 'unknown')} is missing a definition fingerprint.`);
      }
      const sourceIds = stringArrayFrom(subtask.upstream_task_ids);
      const sourceFingerprints = subtask.source_task_fingerprints &&
        typeof subtask.source_task_fingerprints === 'object' &&
        !Array.isArray(subtask.source_task_fingerprints)
        ? subtask.source_task_fingerprints as Record<string, unknown>
        : {};
      for (const sourceId of sourceIds) {
        if (
          knownTaskIds.size > 0 &&
          !knownTaskIds.has(sourceId) &&
          subtask.history_only !== true
        ) {
          errors.push(
            `implementation_plan.md work package ${String(subtask.id ?? 'unknown')} references unknown tasks.md ID ${sourceId}.`,
          );
        }
        if (typeof sourceFingerprints[sourceId] !== 'string' || !sourceFingerprints[sourceId]) {
          errors.push(
            `implementation_plan.md work package ${String(subtask.id ?? 'unknown')} is missing the definition fingerprint for source task ${sourceId}.`,
          );
        }
      }
    }
  }
  return errors;
}

function collectScenarioSections(markdown: string): Array<{ id: string; body: string }> {
  const normalized = markdown.replace(/\r\n/g, '\n');
  // Accept SCN-* entries at any heading level (## to ####). The stable-ID convention across
  // the design package uses ### subsections (e.g. ### RM-001), and models naturally place
  // ### SCN-001 under a ## Observable Scenarios heading; requiring exactly ## rejected valid
  // specs and forced the spec stage to fail.
  const matches = Array.from(normalized.matchAll(/^#{2,4}\s+(SCN-\d+)\b[^\n]*$/gim));
  return matches.map((match, index) => ({
    id: match[1].toUpperCase(),
    body: normalized.slice(
      match.index ?? 0,
      index + 1 < matches.length ? matches[index + 1].index : normalized.length,
    ),
  }));
}

function collectTaskIds(markdown: string): Set<string> {
  if (!markdown.trim()) {
    return new Set();
  }
  try {
    const plan = parseAutocodeImplementationPlanMarkdown(markdown);
    return new Set((plan.phases ?? []).flatMap((phase) => {
      const subtasks = Array.isArray(phase.subtasks)
        ? phase.subtasks
        : Array.isArray(phase.chunks)
          ? phase.chunks
          : [];
      return subtasks.map((task) => String(task.id ?? task.subtask_id ?? '')).filter(Boolean);
    }));
  } catch {
    return new Set();
  }
}

function collectStaticTaskDefinitions(markdown: string): Map<string, string> | null {
  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(markdown);
  } catch {
    return null;
  }

  const definitions = new Map<string, string>();
  for (const phase of plan.phases ?? []) {
    const phaseId = normalizeText(String(phase.id ?? phase.phase ?? ''));
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const task of subtasks) {
      const id = normalizeText(String(task.id ?? task.subtask_id ?? ''));
      if (!id) {
        continue;
      }
      definitions.set(id, JSON.stringify({
        phaseId,
        title: normalizeText(String(task.title ?? '')),
        description: normalizeText(String(task.description ?? '')),
        files: normalizeStringList(task.files),
        filesToCreate: normalizeStringList(task.files_to_create),
        filesToModify: normalizeStringList(task.files_to_modify),
        patternFiles: normalizeStringList(task.pattern_files),
        dependsOn: normalizeStringList(task.depends_on),
        requirements: normalizeStringList(task.requirements),
        designRefs: normalizeStringList(task.design_refs),
        architecture: normalizeText(String(task.architecture ?? '')),
        evidence: normalizeText(String(task.evidence ?? '')),
        verification: stableValue(task.verification),
      }));
    }
  }
  return definitions;
}

function collectRequirementEntries(markdown: string): RequirementEntry[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(?:\[)?((?:R|AC|C|A|Q|E)\d+)(?:\])?\s*(?::|\.|-|\u2013)\s*(.+?)\s*$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ id: match[1].toUpperCase(), body: match[2].trim() }));
}

function parseRequirementEntry(value: string): RequirementEntry | null {
  const match = value.match(/^\s*(?:\[)?((?:R|AC|C|A|Q|E)\d+)(?:\])?\s*(?::|\.|-|\u2013)\s*(.+?)\s*$/i);
  return match ? { id: match[1].toUpperCase(), body: match[2].trim() } : null;
}

function collectReferences(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  return Array.from(new Set((text.match(REQUIREMENT_REFERENCE_PATTERN) ?? []).map((id) => id.toUpperCase())));
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeText(String(entry ?? ''))).filter(Boolean)
    : [];
}

function normalizeStringList(value: unknown): string[] {
  return Array.from(new Set(stringArrayFrom(value))).sort();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value ?? null;
}

function validateKnownReferences(
  owner: string,
  references: string[],
  entryById: Map<string, RequirementEntry>,
): string[] {
  const unknown = references.filter((reference) => REQUIREMENT_ID_PATTERN.test(reference) && !entryById.has(reference));
  return unknown.length > 0 ? [`${owner} references unknown requirements.md IDs: ${unknown.join(', ')}.`] : [];
}

function hasSpecificationContract(markdown: string): boolean {
  return /^Specification-Contract:\s*1\s*$/im.test(markdown);
}

function hasTasksContract(markdown: string): boolean {
  return /^Tasks-Contract:\s*1\s*$/im.test(markdown);
}

function normalizeProse(value: string): string {
  return value.toLowerCase().replace(/[`*_#>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}
