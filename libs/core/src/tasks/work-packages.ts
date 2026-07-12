import {
  analyzeAutocodeWorkDependencies,
  describeAutocodeWorkDependencyBlockers,
  normalizeAutocodeWorkDependencyIds,
} from '../runtime/work-dependencies.js';
import type {
  MutableAutocodePlan,
  MutableAutocodePlanPhase,
  MutableAutocodePlanSubtask,
} from './plan-file.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import {
  parseAutocodeImplementationPlanMarkdown,
  stringifyAutocodeImplementationPlanMarkdown,
} from './plan-store.js';
import { isTraceableAutocodeEvidence } from './plan-quality.js';

export { stringifyAutocodeImplementationPlanMarkdown };

export interface AutocodeRuntimeTask {
  id: string;
  title: string;
  description: string;
  status: string;
  titleState?: 'obsolete' | 'needs_revision';
  phaseId: string;
  phaseName: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  dependsOn: string[];
  requirements: string[];
  architecture?: string;
  evidence?: string;
  verification?: unknown;
}

export interface AutocodeRuntimeWorkPackage {
  id: string;
  title: string;
  phaseId: string;
  phaseName: string;
  tasks: AutocodeRuntimeTask[];
  dependsOn: string[];
}

export interface BuildAutocodeRuntimeWorkPackagePhasesInput {
  parsedPhases: Array<Record<string, unknown>>;
  language?: string;
  sourceName?: string;
  sourcePath?: string;
  requireTaskEvidence?: boolean;
  includeCompletedTasks?: boolean;
  preserveCompletedStateFromPreviousPlanMarkdown?: string;
  emptyTasksFallback?: MutableAutocodePlanSubtask;
}

export interface BuildAutocodeRuntimeImplementationPlanFromTasksInput {
  title?: string;
  description?: string;
  now: string;
  language?: string;
  sourcePath?: string;
  sourceKind?: string;
  upstreamOwner?: string;
  requireTaskEvidence?: boolean;
  includeCompletedTasks?: boolean;
  preserveCompletedStateFromPreviousPlanMarkdown?: string;
}

const AUTOCODE_WORK_PACKAGE_MAX_TASKS = 5;
const AUTOCODE_WORK_PACKAGE_TARGET_EFFORT = 10;
const AUTOCODE_WORK_PACKAGE_MAX_ESTIMATED_EFFORT = 20;
const AUTOCODE_RUNTIME_TASK_TITLE_STATE_TAG =
  '(?:needs[_\\s-]*revision|revision[_\\s-]*required|obsolete|superseded|deprecated)';

export function buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
  tasksMarkdown: string,
  input: BuildAutocodeRuntimeImplementationPlanFromTasksInput,
): MutableAutocodePlan {
  const parsedTasks = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  const parsedPhases = getExecutableParsedPhases(parsedTasks.phases);
  const sourcePath = input.sourcePath || AUTOCODE_TASK_ARTIFACTS.tasks;
  const phases = buildAutocodeRuntimeWorkPackagePhases({
    parsedPhases,
    language: input.language,
    sourceName: 'Autocode',
    sourcePath,
    requireTaskEvidence: input.requireTaskEvidence,
    includeCompletedTasks: input.includeCompletedTasks,
    preserveCompletedStateFromPreviousPlanMarkdown: input.preserveCompletedStateFromPreviousPlanMarkdown,
  });

  if (!hasRuntimeWorkPackages(phases)) {
    throw new Error(`${sourcePath} has no executable tasks.`);
  }

  const parsedSourceTask = parsedTasks.source_task && typeof parsedTasks.source_task === 'object' && !Array.isArray(parsedTasks.source_task)
    ? parsedTasks.source_task as Record<string, unknown>
    : {};

  const runtimePlan: MutableAutocodePlan = {
    ...parsedTasks,
    feature: input.title || parsedTasks.feature || getAutocodeRuntimePlanFeatureFallback(input.language),
    description: input.description || parsedTasks.description || '',
    workflow_type: parsedTasks.workflow_type || 'feature',
    status: 'pending',
    planStatus: 'pending',
    created_at: parsedTasks.created_at || input.now,
    updated_at: input.now,
    phases,
    source_task: {
      ...parsedSourceTask,
      kind: input.sourceKind || 'autocode-tasks',
      tasks: sourcePath,
      runtime_granularity: 'work_package',
      ownership: {
        upstream: input.upstreamOwner || 'autocode-tasks',
        downstream: 'autocode-runtime',
      },
    },
  };

  return preserveAutocodeRuntimePlanCompletedStateFromPreviousMarkdown(
    runtimePlan,
    input.preserveCompletedStateFromPreviousPlanMarkdown,
  );
}

export function preserveAutocodeRuntimePlanCompletedStateFromPreviousMarkdown(
  plan: MutableAutocodePlan,
  previousPlanMarkdown: string | undefined,
): MutableAutocodePlan {
  if (!previousPlanMarkdown?.trim()) {
    return plan;
  }

  try {
    return preserveAutocodeRuntimePlanCompletedState(
      plan,
      parseAutocodeImplementationPlanMarkdown(previousPlanMarkdown),
    );
  } catch {
    return plan;
  }
}

export function preserveAutocodeRuntimePlanCompletedState(
  plan: MutableAutocodePlan,
  previousPlan: MutableAutocodePlan | null | undefined,
): MutableAutocodePlan {
  if (!previousPlan) {
    return plan;
  }

  const completedBySignature = new Map<string, MutableAutocodePlanSubtask>();
  for (const previousSubtask of getRuntimePlanSubtasks(previousPlan)) {
    if (previousSubtask.status !== 'completed') {
      continue;
    }
    const signature = buildRuntimePlanSubtaskContentSignature(previousSubtask);
    if (signature) {
      completedBySignature.set(signature, previousSubtask);
    }
  }

  if (completedBySignature.size > 0) {
    for (const subtask of getRuntimePlanSubtasks(plan)) {
      const signature = buildRuntimePlanSubtaskContentSignature(subtask);
      const previousCompleted = signature ? completedBySignature.get(signature) : undefined;
      if (!previousCompleted) {
        continue;
      }
      applyCompletedRuntimePlanSubtaskState(subtask, previousCompleted);
    }
  }

  return appendOmittedCompletedRuntimeSubtasks(plan, previousPlan);
}

function appendOmittedCompletedRuntimeSubtasks(
  plan: MutableAutocodePlan,
  previousPlan: MutableAutocodePlan,
): MutableAutocodePlan {
  const previousCompletedSubtasks = getRuntimePlanSubtasks(previousPlan)
    .filter((subtask) => subtask.status === 'completed');
  if (previousCompletedSubtasks.length === 0) {
    return plan;
  }

  const currentSubtasks = getRuntimePlanSubtasks(plan);
  const currentSignatures = new Set(
    currentSubtasks
      .map(buildRuntimePlanSubtaskContentSignature)
      .filter(Boolean),
  );
  const omittedCompletedSubtasks = previousCompletedSubtasks
    .filter((previousSubtask) => {
      const signature = buildRuntimePlanSubtaskContentSignature(previousSubtask);
      if (signature && currentSignatures.has(signature)) {
        return false;
      }
      return true;
    })
    .map((previousSubtask) => {
      const historicalSubtask = cloneMutableAutocodePlanSubtask(previousSubtask);
      historicalSubtask.history_only = true;
      historicalSubtask.depends_on = toStringArray(historicalSubtask.depends_on);
      return historicalSubtask;
    });

  if (omittedCompletedSubtasks.length === 0) {
    return plan;
  }

  const phases = plan.phases ?? [];
  if (phases.length === 0) {
    phases.push({ id: 'wp', name: 'Work Packages', subtasks: [] });
    plan.phases = phases;
  }

  const targetPhase = phases[0];
  const targetSubtasks = Array.isArray(targetPhase.subtasks) ? targetPhase.subtasks : [];
  targetPhase.subtasks = targetSubtasks;

  const reservedIds = new Set(omittedCompletedSubtasks.map((subtask) => stringFrom(subtask.id)).filter(Boolean));
  const idRemaps = new Map<string, string>();
  for (const subtask of targetSubtasks) {
    const id = stringFrom(subtask.id);
    if (!id) {
      continue;
    }
    if (!reservedIds.has(id)) {
      reservedIds.add(id);
      continue;
    }
    const nextId = getNextAvailableRuntimeWorkPackageSubtaskId(reservedIds);
    idRemaps.set(id, nextId);
    subtask.id = nextId;
    reservedIds.add(nextId);
  }

  if (idRemaps.size > 0) {
    for (const subtask of getRuntimePlanSubtasks(plan)) {
      const dependsOn = toStringArray(subtask.depends_on);
      if (dependsOn.length === 0) {
        continue;
      }
      subtask.depends_on = dependsOn.map((dependencyId) => idRemaps.get(dependencyId) ?? dependencyId);
    }
  }

  targetPhase.subtasks = [
    ...omittedCompletedSubtasks,
    ...targetSubtasks,
  ];

  return plan;
}

function getNextAvailableRuntimeWorkPackageSubtaskId(reservedIds: Set<string>): string {
  let index = 1;
  while (reservedIds.has(`wp-${index}`)) {
    index += 1;
  }
  return `wp-${index}`;
}

function cloneMutableAutocodePlanSubtask(subtask: MutableAutocodePlanSubtask): MutableAutocodePlanSubtask {
  return JSON.parse(JSON.stringify(subtask)) as MutableAutocodePlanSubtask;
}

const COMPLETED_RUNTIME_SUBTASK_STATE_FIELDS = [
  'completed_at',
  'completion_summary',
  'completionSummary',
  'completed_summary',
  'notes',
  'actual_output',
  'duration_ms',
  'started_at',
] as const;

function applyCompletedRuntimePlanSubtaskState(
  subtask: MutableAutocodePlanSubtask,
  previousCompleted: MutableAutocodePlanSubtask,
): void {
  subtask.status = 'completed';
  const target = subtask as Record<string, unknown>;
  const source = previousCompleted as Record<string, unknown>;
  for (const field of COMPLETED_RUNTIME_SUBTASK_STATE_FIELDS) {
    if (source[field] !== undefined) {
      target[field] = source[field];
    }
  }
}

function getRuntimePlanSubtasks(plan: MutableAutocodePlan): MutableAutocodePlanSubtask[] {
  return (plan.phases ?? []).flatMap((phase) => Array.isArray(phase.subtasks)
    ? phase.subtasks
    : Array.isArray(phase.chunks)
      ? phase.chunks
      : []);
}

function buildRuntimePlanSubtaskContentSignature(subtask: MutableAutocodePlanSubtask): string {
  const upstreamTaskIds = toStringArray(subtask.upstream_task_ids).sort();
  if (upstreamTaskIds.length === 0) {
    return '';
  }

  return JSON.stringify({
    upstreamTaskIds,
    title: singleLine(stringFrom(subtask.title)),
    filesToCreate: toStringArray(subtask.files_to_create).sort(),
    filesToModify: toStringArray(subtask.files_to_modify).sort(),
    patternFiles: toStringArray(subtask.pattern_files).sort(),
    requirements: toStringArray(subtask.requirements).sort(),
    architecture: normalizeRuntimePlanSignatureText(stringFrom(subtask.architecture)),
    verification: stableRuntimePlanSignatureValue(subtask.verification),
    upstreamSource: singleLine(stringFrom(subtask.upstream_source)),
    workPackage: subtask.work_package === true,
  });
}

function normalizeRuntimePlanSignatureText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function stableRuntimePlanSignatureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableRuntimePlanSignatureValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableRuntimePlanSignatureValue(entry)]),
    );
  }
  return value ?? null;
}
function hasCompletedAutocodeRuntimePlanSubtasks(previousPlanMarkdown: string | undefined): boolean {
  if (!previousPlanMarkdown?.trim()) {
    return false;
  }

  try {
    const previousPlan = parseAutocodeImplementationPlanMarkdown(previousPlanMarkdown);
    return getRuntimePlanSubtasks(previousPlan).some((subtask) => subtask.status === 'completed');
  } catch {
    return false;
  }
}
function preserveAutocodeRuntimeTaskCompletedStateFromPreviousMarkdown(
  tasks: AutocodeRuntimeTask[],
  previousPlanMarkdown: string | undefined,
): AutocodeRuntimeTask[] {
  if (!previousPlanMarkdown?.trim()) {
    return tasks;
  }

  let previousPlan: MutableAutocodePlan;
  try {
    previousPlan = parseAutocodeImplementationPlanMarkdown(previousPlanMarkdown);
  } catch {
    return tasks;
  }

  const completedSubtasksByUpstreamId = new Map<string, MutableAutocodePlanSubtask[]>();
  for (const previousSubtask of getRuntimePlanSubtasks(previousPlan)) {
    if (previousSubtask.status !== 'completed') {
      continue;
    }
    for (const upstreamTaskId of toStringArray(previousSubtask.upstream_task_ids)) {
      const existing = completedSubtasksByUpstreamId.get(upstreamTaskId) ?? [];
      existing.push(previousSubtask);
      completedSubtasksByUpstreamId.set(upstreamTaskId, existing);
    }
  }

  if (completedSubtasksByUpstreamId.size === 0) {
    return tasks;
  }

  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (task.status === 'completed') {
      return task;
    }
    const completedCandidates = completedSubtasksByUpstreamId.get(task.id) ?? [];
    const matchingCompletedSubtask = completedCandidates.find((candidate) =>
      isAutocodeRuntimeTaskCompatibleWithCompletedSubtask(task, candidate),
    );
    if (!matchingCompletedSubtask) {
      return task;
    }
    changed = true;
    return {
      ...task,
      status: 'completed',
    };
  });

  return changed ? nextTasks : tasks;
}

function isAutocodeRuntimeTaskCompatibleWithCompletedSubtask(
  task: AutocodeRuntimeTask,
  completedSubtask: MutableAutocodePlanSubtask,
): boolean {
  const completedDescription = stringFrom(completedSubtask.description);
  if (
    !normalizedRuntimePlanSignatureIncludes(completedDescription, task.id) ||
    !normalizedRuntimePlanSignatureIncludes(completedDescription, task.title) ||
    !normalizedRuntimePlanSignatureIncludes(completedDescription, task.description)
  ) {
    return false;
  }

  return runtimeTaskStringsAreCoveredBySubtask(task.filesToCreate, completedSubtask.files_to_create) &&
    runtimeTaskStringsAreCoveredBySubtask(task.filesToModify, completedSubtask.files_to_modify) &&
    runtimeTaskStringsAreCoveredBySubtask(task.patternFiles, completedSubtask.pattern_files) &&
    runtimeTaskStringsAreCoveredBySubtask(task.requirements, completedSubtask.requirements) &&
    normalizedRuntimePlanSignatureIncludes(stringFrom(completedSubtask.architecture), task.architecture || '') &&
    normalizedRuntimePlanSignatureIncludes(stringFrom(completedSubtask.evidence), task.evidence || '') &&
    normalizedRuntimePlanSignatureIncludes(
      stringifyAutocodeRuntimeVerification(completedSubtask.verification),
      stringifyAutocodeRuntimeVerification(task.verification),
    );
}

function runtimeTaskStringsAreCoveredBySubtask(values: string[], completedValues: unknown): boolean {
  const completed = new Set(toStringArray(completedValues).map(normalizeRuntimePlanSignatureText));
  return values
    .map(normalizeRuntimePlanSignatureText)
    .filter(Boolean)
    .every((value) => completed.has(value));
}

function normalizedRuntimePlanSignatureIncludes(value: string, expected: string): boolean {
  const normalizedExpected = normalizeRuntimePlanSignatureText(expected).toLowerCase();
  if (!normalizedExpected) {
    return true;
  }
  return normalizeRuntimePlanSignatureText(value).toLowerCase().includes(normalizedExpected);
}
export function buildAutocodeRuntimeWorkPackagePhases(
  input: BuildAutocodeRuntimeWorkPackagePhasesInput,
): MutableAutocodePlanPhase[] {
  const flattenedTasks = flattenAutocodeRuntimeTasks(input.parsedPhases, input.language, input.sourceName);
  const previousCompletionSourceMarkdown = input.preserveCompletedStateFromPreviousPlanMarkdown;
  const shouldUsePreviousPlanAsCompletionSource = hasCompletedAutocodeRuntimePlanSubtasks(
    previousCompletionSourceMarkdown,
  );
  const tasksReadyForCompletionPreservation = shouldUsePreviousPlanAsCompletionSource
    ? resetAutocodeRuntimeTaskCompletedStatusForIteration(flattenedTasks)
    : flattenedTasks;
  const completionPreservedTasks = shouldUsePreviousPlanAsCompletionSource
    ? preserveAutocodeRuntimeTaskCompletedStateFromPreviousMarkdown(
        tasksReadyForCompletionPreservation,
        previousCompletionSourceMarkdown,
      )
    : tasksReadyForCompletionPreservation;
  const evidenceReadyTasks = input.requireTaskEvidence
    ? normalizeAutocodeRuntimeTaskEvidenceMetadata(completionPreservedTasks, {
        sourceName: input.sourceName || 'Autocode',
        sourcePath: input.sourcePath || AUTOCODE_TASK_ARTIFACTS.tasks,
      })
    : completionPreservedTasks;
  if (input.requireTaskEvidence) {
    const evidenceErrors = validateAutocodeRuntimeTaskEvidenceMetadata(
      evidenceReadyTasks,
      `${input.sourceName || 'Autocode'} task`,
    );
    if (evidenceErrors.length > 0) {
      throw new Error(evidenceErrors.join('; '));
    }
  }
  const runtimeTasks = completeAutocodeRuntimeTaskDependencyGraph(
    evidenceReadyTasks,
  );
  assertAutocodeRuntimeTasksHaveValidDependencies(runtimeTasks, `${input.sourceName || 'Autocode'} task`);
  const executableTasks = input.includeCompletedTasks === false
    ? omitCompletedAutocodeRuntimeTasks(runtimeTasks)
    : runtimeTasks;
  if (executableTasks.length === 0) {
    if (input.emptyTasksFallback) {
      return [
        {
          id: 'wp',
          name: getRuntimeWorkPackagePhaseLabel(input.language),
          subtasks: [input.emptyTasksFallback],
        },
      ];
    }
    return [];
  }

  const workPackages = groupAutocodeRuntimeTasksIntoWorkPackages(executableTasks, input.language);
  return [
    {
      id: 'wp',
      name: getRuntimeWorkPackagePhaseLabel(input.language),
      subtasks: workPackages.map((workPackage) =>
        buildAutocodeRuntimeWorkPackageSubtask(workPackage, {
          language: input.language,
          sourceName: input.sourceName || 'Autocode',
          sourcePath: input.sourcePath || AUTOCODE_TASK_ARTIFACTS.tasks,
        }),
      ),
    },
  ];
}

function resetAutocodeRuntimeTaskCompletedStatusForIteration(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[] {
  let changed = false;
  const nextTasks = tasks.map((task) => {
    if (task.status !== 'completed' || task.titleState === 'obsolete') {
      return task;
    }
    changed = true;
    return {
      ...task,
      status: 'pending',
    };
  });

  return changed ? nextTasks : tasks;
}
function omitCompletedAutocodeRuntimeTasks(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[] {
  const completedTaskIds = new Set(
    tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.id),
  );
  const remainingTaskIds = new Set(
    tasks
      .filter((task) => !completedTaskIds.has(task.id))
      .map((task) => task.id),
  );

  return tasks
    .filter((task) => !completedTaskIds.has(task.id))
    .map((task) => ({
      ...task,
      status: 'pending',
      dependsOn: task.dependsOn.filter((dependencyId) => remainingTaskIds.has(dependencyId)),
    }));
}

export function flattenAutocodeRuntimeTasks(
  parsedPhases: Array<Record<string, unknown>>,
  language?: string,
  sourceName = 'Autocode',
): AutocodeRuntimeTask[] {
  const tasks: AutocodeRuntimeTask[] = [];
  for (const [phaseIndex, phase] of parsedPhases.entries()) {
    const phaseId = stringFrom(phase.id ?? phase.phase) || String(phaseIndex + 1);
    const phaseName = stringFrom(phase.name ?? phase.title)
      || (isChineseLanguage(language) ? `${sourceName} 阶段 ${phaseIndex + 1}` : `${sourceName} phase ${phaseIndex + 1}`);
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const [subtaskIndex, rawSubtask] of subtasks.entries()) {
      if (!rawSubtask || typeof rawSubtask !== 'object') {
        continue;
      }
      const subtask = rawSubtask as Record<string, unknown>;
      const id = stringFrom(subtask.id ?? subtask.subtask_id) || `${phaseId}.${subtaskIndex + 1}`;
      const rawTitle = stringFrom(subtask.title ?? subtask.description);
      const titleState = getAutocodeRuntimeTaskTitleState(rawTitle);
      const fallbackTitle = isChineseLanguage(language) ? `${sourceName} 任务 ${id}` : `${sourceName} task ${id}`;
      const title = sanitizeAutocodeRuntimeTaskTitle(
        rawTitle,
        fallbackTitle,
      );
      const description = sanitizeAutocodeRuntimeTaskDescription(stringFrom(subtask.description) || title, title);
      tasks.push({
        id,
        title,
        description,
        status: titleState === 'obsolete' ? 'completed' : stringFrom(subtask.status) || 'pending',
        ...(titleState ? { titleState } : {}),
        phaseId,
        phaseName,
        filesToCreate: toStringArray(subtask.files_to_create),
        filesToModify: uniqueAutocodeRuntimeStrings([
          ...toStringArray(subtask.files_to_modify),
          ...toStringArray(subtask.files),
        ]),
        patternFiles: toStringArray(subtask.pattern_files),
        dependsOn: sanitizeAutocodeRuntimeDependencyIds(subtask.depends_on),
        requirements: toStringArray(subtask.requirements),
        architecture: stringFrom(subtask.architecture),
        evidence: stringFrom(subtask.evidence),
        verification: subtask.verification,
      });
    }
  }
  return tasks;
}

export function completeAutocodeRuntimeTaskDependencyGraph(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[] {
  if (tasks.length <= 1) {
    return tasks;
  }

  const hasExplicitDependencyGraph = tasks.some((task) => task.dependsOn.length > 0);
  const taskIds = new Set(tasks.map((task) => task.id));
  const tasksWithBaseDependencies = tasks.map((task, index) => {
    let dependsOn: string[];
    if (task.dependsOn.length > 0) {
      dependsOn = task.dependsOn;
    } else {
      dependsOn = inferAutocodeRuntimeTaskDependencies(task, index, tasks, hasExplicitDependencyGraph);
    }
    return { ...task, dependsOn };
  });

  const tasksWithSamePhaseDependencies = tasksWithBaseDependencies.map((task, index) => ({
    ...task,
    dependsOn: normalizeAutocodeRuntimeTaskDependencies({
      task,
      taskIndex: index,
      tasks: tasksWithBaseDependencies,
      dependsOn: task.dependsOn,
      taskIds,
      phaseTerminalTaskIds: new Map(),
    }),
  }));

  const phaseTerminalTaskIds = getAutocodeRuntimePhaseTerminalTaskIds(tasksWithSamePhaseDependencies, taskIds);

  return tasksWithSamePhaseDependencies.map((task, index) => {
    return {
      ...task,
      dependsOn: normalizeAutocodeRuntimeTaskDependencies({
        task,
        taskIndex: index,
        tasks: tasksWithSamePhaseDependencies,
        dependsOn: task.dependsOn,
        taskIds,
        phaseTerminalTaskIds,
      }),
    };
  });
}

export function assertAutocodeRuntimeTasksHaveValidDependencies(
  tasks: AutocodeRuntimeTask[],
  label = 'runtime task',
): void {
  if (tasks.length === 0) {
    return;
  }
  const analysis = analyzeAutocodeWorkDependencies(
    tasks.map((task) => ({
      id: task.id,
      status: task.status,
      dependsOn: task.dependsOn,
    })),
  );
  if (analysis.issues.length === 0) {
    return;
  }

  const invalidBlocked = analysis.blocked.filter((blocked) => blocked.issues.length > 0);
  const summary = describeAutocodeWorkDependencyBlockers(invalidBlocked);
  throw new Error(`${label} dependency graph is invalid: ${summary}`);
}

export function validateAutocodeRuntimeTaskEvidenceMetadata(
  tasks: AutocodeRuntimeTask[],
  label = 'runtime task',
): string[] {
  return tasks
    .filter((task) => !isTraceableAutocodeEvidence(task.evidence))
    .map((task) => `${label} ${task.id} missing traceable _Evidence: ..._ metadata`);
}

export function normalizeAutocodeRuntimeTaskEvidenceMetadata(
  tasks: AutocodeRuntimeTask[],
  input: {
    sourceName?: string;
    sourcePath?: string;
  } = {},
): AutocodeRuntimeTask[] {
  return tasks.map((task) => {
    if (isTraceableAutocodeEvidence(task.evidence)) {
      return task;
    }

    return {
      ...task,
      evidence: buildAutocodeRuntimeTraceableTaskEvidence(task, input),
    };
  });
}

function buildAutocodeRuntimeTraceableTaskEvidence(
  task: AutocodeRuntimeTask,
  input: {
    sourceName?: string;
    sourcePath?: string;
  },
): string {
  const sourcePath = input.sourcePath || AUTOCODE_TASK_ARTIFACTS.tasks;
  const sourceName = input.sourceName || 'Autocode';
  return uniqueAutocodeRuntimeStrings([
    task.evidence || '',
    'spec.md Requirements',
    'requirements.md Evidence Sources',
    `${sourcePath} task ${task.id}`,
    `${sourceName} planning task ${task.id}`,
  ]).join('; ');
}

export function groupAutocodeRuntimeTasksIntoWorkPackages(
  tasks: AutocodeRuntimeTask[],
  language?: string,
): AutocodeRuntimeWorkPackage[] {
  const packages: AutocodeRuntimeWorkPackage[] = [];
  let packageIndex = 1;

  const pushPackage = (packageTasks: AutocodeRuntimeTask[]) => {
    if (packageTasks.length === 0) {
      return;
    }
    packages.push({
      id: `wp-${packageIndex++}`,
      title: buildAutocodeRuntimeWorkPackageTitle(packageTasks, language),
      phaseId: 'wp',
      phaseName: buildAutocodeRuntimeWorkPackagePhaseName(packageTasks, language),
      tasks: packageTasks,
      dependsOn: [],
    });
  };

  for (const phaseTasks of groupAutocodeRuntimeTasksByPhase(tasks)) {
    for (const packageTasks of buildAutocodeRuntimeTaskDependencyChains(phaseTasks)) {
      for (const statusAlignedPackageTasks of splitAutocodeRuntimeWorkPackageTasksByCompletionStatus(packageTasks)) {
        pushPackage(statusAlignedPackageTasks);
      }
    }
  }

  populateAutocodeRuntimeWorkPackageDependencies(packages);
  assertAutocodeRuntimeWorkPackagesHaveValidDependencies(packages);
  return packages;
}

function splitAutocodeRuntimeWorkPackageTasksByCompletionStatus(
  tasks: AutocodeRuntimeTask[],
): AutocodeRuntimeTask[][] {
  if (tasks.length <= 1) {
    return [tasks];
  }

  const groups: AutocodeRuntimeTask[][] = [];
  let active: AutocodeRuntimeTask[] = [];
  let activeCompleted: boolean | undefined;

  for (const task of tasks) {
    const completed = task.status === 'completed';
    if (active.length > 0 && activeCompleted !== completed) {
      groups.push(active);
      active = [];
    }
    active.push(task);
    activeCompleted = completed;
  }

  if (active.length > 0) {
    groups.push(active);
  }

  return groups;
}
export function estimateAutocodeRuntimeTaskEffort(task: AutocodeRuntimeTask): number {
  const text = singleLine(`${task.title} ${task.description}`).toLowerCase();
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  let effort = 2;

  effort += Math.min(4, Math.floor(wordCount / 35));
  effort += Math.min(6, (
    task.filesToCreate.length * 1.5 +
    task.filesToModify.length +
    task.patternFiles.length * 2
  ));
  effort += Math.min(3, task.requirements.length * 0.75);

  if (stringifyAutocodeRuntimeVerification(task.verification)) {
    effort += 1;
  }

  if (/\b(refactor|restructure|architecture|migration|global|cross-cutting|shared|security|auth|permission|database|persistence|schema|concurrent|parallel|pipeline|integration|network|protocol|state machine)\b/i.test(text)) {
    effort += 3;
  }

  if (/\b(api|ipc|workflow|orchestration|parser|validation|test|qa|build|config|cache|sync|error handling|ui|renderer|preload)\b/i.test(text)) {
    effort += 2;
  }

  if (
    effort > 1 &&
    /\b(copy|text|docs?|documentation|readme|comment|rename|style|label)\b/i.test(text) &&
    task.filesToCreate.length + task.filesToModify.length + task.patternFiles.length <= 1
  ) {
    effort -= 1;
  }

  return Math.max(1, Math.min(AUTOCODE_WORK_PACKAGE_MAX_ESTIMATED_EFFORT, Math.round(effort)));
}

export function buildAutocodeRuntimeWorkPackageTitle(
  tasks: AutocodeRuntimeTask[],
  language?: string,
): string {
  if (tasks.length === 1) {
    const title = sanitizeAutocodeRuntimeTaskTitle(tasks[0].title);
    return isChineseLanguage(language) ? `工作包：${title}` : `Work package: ${title}`;
  }
  const first = sanitizeAutocodeRuntimeTaskTitle(tasks[0]?.title, isChineseLanguage(language) ? '任务' : 'tasks');
  return isChineseLanguage(language)
    ? `工作包：${first}（另含 ${tasks.length - 1} 个相关任务）`
    : `Work package: ${first} (+${tasks.length - 1} related tasks)`;
}

export function buildAutocodeRuntimeWorkPackagePhaseName(
  tasks: AutocodeRuntimeTask[],
  language?: string,
): string {
  const packagePhases = uniqueAutocodeRuntimeStrings(tasks.map((task) => task.phaseName));
  return packagePhases.length === 1
    ? packagePhases[0]
    : getRuntimeWorkPackagePhaseLabel(language);
}

export function sanitizeAutocodeRuntimeTaskDescription(description: string, fallbackTitle = ''): string {
  const cleanedLines = description
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripAutocodeRuntimeTaskTitleStatePrefix(stripDependencyMetadataPrefix(line)).trim())
    .filter(Boolean);
  return cleanedLines.join('\n') || fallbackTitle;
}

export function sanitizeAutocodeRuntimeTaskTitle(title: unknown, fallbackTitle = ''): string {
  const rawTitle = singleLine(stringFrom(title));
  const fallback = singleLine(fallbackTitle);
  const cleaned = stripAutocodeRuntimeTaskTitleStatePrefix(rawTitle);
  return cleaned || fallback || rawTitle;
}

export function uniqueAutocodeRuntimeStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => singleLine(item)).filter(Boolean))];
}

export function stringifyAutocodeRuntimeVerification(value: unknown): string {
  if (typeof value === 'string') {
    return singleLine(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return singleLine(stringFrom(record.run) || stringFrom(record.command) || stringFrom(record.scenario) || stringFrom(record.description));
  }
  return '';
}

function getExecutableParsedPhases(phases: unknown): Array<Record<string, unknown>> {
  return Array.isArray(phases)
    ? phases.filter((phase): phase is Record<string, unknown> => {
        if (!phase || typeof phase !== 'object') {
          return false;
        }
        const record = phase as Record<string, unknown>;
        const subtasks = Array.isArray(record.subtasks)
          ? record.subtasks
          : Array.isArray(record.chunks)
            ? record.chunks
            : [];
        return subtasks.length > 0;
      })
    : [];
}

function hasRuntimeWorkPackages(phases: MutableAutocodePlanPhase[]): boolean {
  return phases.some((phase) => {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return subtasks.length > 0;
  });
}

function buildAutocodeRuntimeWorkPackageSubtask(
  workPackage: AutocodeRuntimeWorkPackage,
  input: {
    language?: string;
    sourceName: string;
    sourcePath: string;
  },
): MutableAutocodePlanSubtask {
  const upstreamTaskIds = workPackage.tasks.map((task) => task.id);
  const filesToCreate = uniqueAutocodeRuntimeStrings(workPackage.tasks.flatMap((task) => task.filesToCreate));
  const filesToModify = uniqueAutocodeRuntimeStrings(workPackage.tasks.flatMap((task) => task.filesToModify));
  const patternFiles = uniqueAutocodeRuntimeStrings(workPackage.tasks.flatMap((task) => task.patternFiles));
  const requirements = uniqueAutocodeRuntimeStrings([
    ...upstreamTaskIds,
    ...workPackage.tasks.flatMap((task) => task.requirements),
  ]);
  const evidence = uniqueAutocodeRuntimeStrings(workPackage.tasks.map((task) => task.evidence || ''));
  const architecture = uniqueAutocodeRuntimeStrings(workPackage.tasks.map((task) => task.architecture || ''));
  const hasWriteIntent = filesToCreate.length > 0 || filesToModify.length > 0 || patternFiles.length > 0;

  return {
    id: workPackage.id,
    title: workPackage.title,
    description: buildRuntimeWorkPackageDescription(workPackage, input),
    status: workPackage.tasks.every((task) => task.status === 'completed') ? 'completed' : 'pending',
    ...(filesToCreate.length > 0 ? { files_to_create: filesToCreate } : {}),
    files_to_modify: hasWriteIntent ? filesToModify : [],
    ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
    depends_on: workPackage.dependsOn,
    ...(requirements.length > 0 ? { requirements } : {}),
    ...(architecture.length > 0 ? { architecture: architecture.join('; ') } : {}),
    ...(evidence.length > 0 ? { evidence: evidence.join('; ') } : {}),
    verification: {
      type: 'manual',
      run: buildWorkPackageVerification(workPackage, input.language),
    },
    upstream_source: input.sourcePath,
    upstream_task_ids: upstreamTaskIds,
    work_package: true,
  };
}

function buildRuntimeWorkPackageDescription(
  workPackage: AutocodeRuntimeWorkPackage,
  input: {
    language?: string;
    sourceName: string;
    sourcePath: string;
  },
): string {
  if (isChineseLanguage(input.language)) {
    return [
      `实现此运行工作包，来源为 ${input.sourceName} 上游任务。`,
      '',
      `上游文件：${input.sourcePath}`,
      `上游任务：${workPackage.tasks.map((task) => task.id).join(', ')}`,
      '',
      '包含任务：',
      ...workPackage.tasks.flatMap((task) => [
        `- ${task.id} ${sanitizeAutocodeRuntimeTaskTitle(task.title, task.id)}`,
        `  ${singleLine(sanitizeAutocodeRuntimeTaskDescription(task.description, sanitizeAutocodeRuntimeTaskTitle(task.title, task.id)))}`,
        ...(task.architecture ? [`  Architecture: ${singleLine(task.architecture)}`] : []),
        ...(task.evidence ? [`  Evidence: ${singleLine(task.evidence)}`] : []),
        ...(task.dependsOn.length > 0 ? [`  依赖：${task.dependsOn.join(', ')}`] : []),
      ]),
      '',
      '运行规则：在本次 agent 执行中完成包含的上游任务，然后由运行时更新工作包状态。',
    ].join('\n');
  }

  return [
    `Implement this runtime work package from upstream ${input.sourceName} tasks.`,
    '',
    `Upstream file: ${input.sourcePath}`,
    `Upstream tasks: ${workPackage.tasks.map((task) => task.id).join(', ')}`,
    '',
    'Included tasks:',
    ...workPackage.tasks.flatMap((task) => [
      `- ${task.id} ${sanitizeAutocodeRuntimeTaskTitle(task.title, task.id)}`,
      `  ${singleLine(sanitizeAutocodeRuntimeTaskDescription(task.description, sanitizeAutocodeRuntimeTaskTitle(task.title, task.id)))}`,
      ...(task.architecture ? [`  Architecture: ${singleLine(task.architecture)}`] : []),
      ...(task.evidence ? [`  Evidence: ${singleLine(task.evidence)}`] : []),
      ...(task.dependsOn.length > 0 ? [`  Upstream prerequisites: ${task.dependsOn.join(', ')}`] : []),
    ]),
    '',
    'Runtime rule: complete all included upstream tasks in this single agent run; the runner updates work package status.',
  ].join('\n');
}

function buildWorkPackageVerification(workPackage: AutocodeRuntimeWorkPackage, language?: string): string {
  const verifications = uniqueAutocodeRuntimeStrings(
    workPackage.tasks
      .map((task) => stringifyAutocodeRuntimeVerification(task.verification))
      .filter(Boolean),
  );
  return verifications.length > 0
    ? verifications.join('; ')
    : isChineseLanguage(language)
      ? '运行此工作包最相关的最小验证，并记录结果。'
      : 'Run the smallest relevant validation for this work package and record the result.';
}

function normalizeAutocodeRuntimeTaskDependencies(input: {
  task: AutocodeRuntimeTask;
  taskIndex: number;
  tasks: AutocodeRuntimeTask[];
  dependsOn: string[];
  taskIds: ReadonlySet<string>;
  phaseTerminalTaskIds: ReadonlyMap<string, string[]>;
}): string[] {
  const normalized: string[] = [];

  for (const dependencyId of input.dependsOn) {
    if (!dependencyId) {
      continue;
    }

    if (dependencyId === input.task.id) {
      normalized.push(dependencyId);
      continue;
    }

    if (input.taskIds.has(dependencyId)) {
      normalized.push(dependencyId);
      continue;
    }

    if (dependencyId === input.task.phaseId) {
      const previousSamePhase = findPreviousAutocodeRuntimeTaskInPhase(input.task, input.taskIndex, input.tasks);
      if (previousSamePhase) {
        normalized.push(previousSamePhase.id);
      }
      continue;
    }

    const phaseTerminals = input.phaseTerminalTaskIds.get(dependencyId) ?? [];
    if (phaseTerminals.length === 0) {
      normalized.push(dependencyId);
      continue;
    }

    normalized.push(...phaseTerminals.filter((taskId) => taskId !== input.task.id));
  }

  return uniqueAutocodeRuntimeStrings(normalized);
}

function getAutocodeRuntimePhaseTerminalTaskIds(
  tasks: AutocodeRuntimeTask[],
  taskIds: ReadonlySet<string>,
): Map<string, string[]> {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const tasksByPhase = new Map<string, AutocodeRuntimeTask[]>();
  for (const task of tasks) {
    const phaseTasks = tasksByPhase.get(task.phaseId) ?? [];
    phaseTasks.push(task);
    tasksByPhase.set(task.phaseId, phaseTasks);
  }

  const terminalTaskIdsByPhase = new Map<string, string[]>();
  for (const [phaseId, phaseTasks] of tasksByPhase) {
    const dependencyIds = new Set<string>();
    for (const task of phaseTasks) {
      for (const dependencyId of task.dependsOn) {
        if (!taskIds.has(dependencyId)) {
          continue;
        }
        const dependency = taskById.get(dependencyId);
        if (dependency?.phaseId === phaseId) {
          dependencyIds.add(dependencyId);
        }
      }
    }

    const terminalIds = phaseTasks
      .filter((task) => !dependencyIds.has(task.id))
      .map((task) => task.id);
    terminalTaskIdsByPhase.set(phaseId, terminalIds.length > 0 ? terminalIds : [phaseTasks[phaseTasks.length - 1].id]);
  }

  return terminalTaskIdsByPhase;
}

function inferAutocodeRuntimeTaskDependencies(
  task: AutocodeRuntimeTask,
  taskIndex: number,
  tasks: AutocodeRuntimeTask[],
  hasExplicitDependencyGraph: boolean,
): string[] {
  const mentionedDependencies = extractAutocodeRuntimeTaskDependencyMentions(task, taskIndex, tasks);
  if (mentionedDependencies.length > 0) {
    return mentionedDependencies;
  }

  const previousSamePhase = findPreviousAutocodeRuntimeTaskInPhase(task, taskIndex, tasks);
  if (!hasExplicitDependencyGraph) {
    return previousSamePhase
      ? [previousSamePhase.id]
      : findPreviousAutocodeRuntimePhaseTerminalTaskIds(task, taskIndex, tasks);
  }

  if (isVerificationAutocodeRuntimeTask(task)) {
    return previousSamePhase
      ? [previousSamePhase.id]
      : findPreviousAutocodeRuntimePhaseTerminalTaskIds(task, taskIndex, tasks);
  }

  return [];
}

function extractAutocodeRuntimeTaskDependencyMentions(
  task: AutocodeRuntimeTask,
  taskIndex: number,
  tasks: AutocodeRuntimeTask[],
): string[] {
  const text = `${task.title}\n${task.description}`;
  if (!/\b(depends?|requires?|after|prerequisite|blocked by|based on)\b|依赖|前置|先完成|完成后|基于/u.test(text)) {
    return [];
  }

  const previousTasks = tasks.slice(0, taskIndex);
  const previousById = new Map(previousTasks.map((candidate) => [candidate.id, candidate]));
  return previousTasks
    .map((candidate) => candidate.id)
    .sort((left, right) => right.length - left.length)
    .filter((candidateId) => previousById.has(candidateId) && containsAutocodeRuntimeTaskId(text, candidateId));
}

function containsAutocodeRuntimeTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.])${escaped}($|[^A-Za-z0-9.])`, 'u').test(text);
}

function findPreviousAutocodeRuntimeTaskInPhase(
  task: AutocodeRuntimeTask,
  taskIndex: number,
  tasks: AutocodeRuntimeTask[],
): AutocodeRuntimeTask | undefined {
  for (let index = taskIndex - 1; index >= 0; index -= 1) {
    const candidate = tasks[index];
    if (candidate.phaseId === task.phaseId) {
      return candidate;
    }
  }
  return undefined;
}

function findPreviousAutocodeRuntimePhaseTerminalTaskIds(
  task: AutocodeRuntimeTask,
  taskIndex: number,
  tasks: AutocodeRuntimeTask[],
): string[] {
  for (let index = taskIndex - 1; index >= 0; index -= 1) {
    const candidate = tasks[index];
    if (candidate.phaseId !== task.phaseId) {
      return [candidate.id];
    }
  }
  return [];
}

function isVerificationAutocodeRuntimeTask(task: AutocodeRuntimeTask): boolean {
  return /\b(test|verify|verification|validate|validation|qa|review)\b|测试|验证|验收|检查|审核/u
    .test(`${task.title}\n${task.description}`.toLowerCase());
}

function groupAutocodeRuntimeTasksByPhase(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[][] {
  const groups: AutocodeRuntimeTask[][] = [];
  let active: AutocodeRuntimeTask[] = [];
  let activePartitionId = '';

  for (const task of tasks) {
    const partitionId = getAutocodeRuntimeTaskPackagingPartitionId(task);
    if (active.length > 0 && activePartitionId !== partitionId) {
      groups.push(active);
      active = [];
    }
    active.push(task);
    activePartitionId = partitionId;
  }

  if (active.length > 0) {
    groups.push(active);
  }
  return groups;
}

function getAutocodeRuntimeTaskPackagingPartitionId(task: AutocodeRuntimeTask): string {
  return isTopLevelAutocodeRuntimeTask(task) ? '__top_level_tasks__' : task.phaseId;
}

function buildAutocodeRuntimeTaskDependencyChains(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[][] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const internalDependenciesById = new Map(tasks.map((task) => [task.id, new Set<string>()]));
  const internalChildrenById = new Map(tasks.map((task) => [task.id, new Set<string>()]));

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependency = taskById.get(dependencyId);
      if (!dependency || !canGroupAutocodeRuntimeTaskDependency(task, dependency)) {
        continue;
      }
      internalDependenciesById.get(task.id)?.add(dependencyId);
      internalChildrenById.get(dependencyId)?.add(task.id);
    }
  }

  const orderedTasks = topologicallySortAutocodeRuntimeTasks(tasks);
  const visited = new Set<string>();
  const chains: AutocodeRuntimeTask[][] = [];

  for (const task of orderedTasks) {
    if (visited.has(task.id)) {
      continue;
    }

    const chain = collectAutocodeRuntimeLinearTaskChain({
      start: task,
      visited,
      orderedTasks,
      taskById,
      internalChildrenById,
      internalDependenciesById,
    });
    chains.push(...splitAutocodeRuntimeLinearTaskChain(chain));
  }

  return balanceAutocodeRuntimeWorkPackageCandidates(chains, {
    orderedTasks,
    internalChildrenById,
  });
}

function collectAutocodeRuntimeLinearTaskChain(input: {
  start: AutocodeRuntimeTask;
  visited: Set<string>;
  orderedTasks: AutocodeRuntimeTask[];
  taskById: Map<string, AutocodeRuntimeTask>;
  internalChildrenById: Map<string, Set<string>>;
  internalDependenciesById: Map<string, Set<string>>;
}): AutocodeRuntimeTask[] {
  const chain: AutocodeRuntimeTask[] = [];
  let current: AutocodeRuntimeTask | undefined = input.start;

  while (current && !input.visited.has(current.id)) {
    chain.push(current);
    input.visited.add(current.id);

    const nextIds = [...(input.internalChildrenById.get(current.id) ?? [])]
      .filter((childId) => !input.visited.has(childId))
      .sort((left, right) => getAutocodeRuntimeTaskOrder(input.orderedTasks, left) - getAutocodeRuntimeTaskOrder(input.orderedTasks, right));
    if (nextIds.length !== 1) {
      break;
    }

    const [nextId] = nextIds;
    const next = input.taskById.get(nextId);
    const nextDependencies = input.internalDependenciesById.get(nextId) ?? new Set<string>();
    if (!next || nextDependencies.size !== 1 || !nextDependencies.has(current.id)) {
      break;
    }

    current = next;
  }

  return chain;
}

function splitAutocodeRuntimeLinearTaskChain(chain: AutocodeRuntimeTask[]): AutocodeRuntimeTask[][] {
  return chooseAutocodeRuntimeBalancedTaskGroups(chain, (packageCount) =>
    splitOrderedAutocodeRuntimeTasksByEstimatedEffort(chain, packageCount),
  );
}

function balanceAutocodeRuntimeWorkPackageCandidates(
  candidates: AutocodeRuntimeTask[][],
  input: {
    orderedTasks: AutocodeRuntimeTask[];
    internalChildrenById: Map<string, Set<string>>;
  },
): AutocodeRuntimeTask[][] {
  const balanced: AutocodeRuntimeTask[][] = [];
  let packableTasks: AutocodeRuntimeTask[] = [];
  let activeDependencySignature = '';

  const flushPackableTasks = () => {
    if (packableTasks.length > 0) {
      balanced.push(...packAutocodeRuntimeIndependentTasksByEstimatedEffort(packableTasks, input.orderedTasks));
      packableTasks = [];
      activeDependencySignature = '';
    }
  };

  for (const candidate of candidates) {
    const task = candidate.length === 1 ? candidate[0] : undefined;
    const dependencySignature = task
      ? getAutocodeRuntimePackableTaskDependencySignature(task, input.internalChildrenById)
      : '';

    if (!task || !dependencySignature) {
      flushPackableTasks();
      balanced.push(candidate);
      continue;
    }

    if (activeDependencySignature && activeDependencySignature !== dependencySignature) {
      flushPackableTasks();
    }

    activeDependencySignature = dependencySignature;
    packableTasks.push(task);
  }

  flushPackableTasks();
  return balanced;
}

function getAutocodeRuntimePackableTaskDependencySignature(
  task: AutocodeRuntimeTask,
  internalChildrenById: Map<string, Set<string>>,
): string {
  if ((internalChildrenById.get(task.id)?.size ?? 0) > 0) {
    return '';
  }

  const dependencySignature = task.dependsOn.length > 0
    ? task.dependsOn.slice().sort().join('|')
    : '__no_dependencies__';
  return `${task.status}:${dependencySignature}`;
}

function packAutocodeRuntimeIndependentTasksByEstimatedEffort(
  tasks: AutocodeRuntimeTask[],
  orderedTasks: AutocodeRuntimeTask[],
): AutocodeRuntimeTask[][] {
  return chooseAutocodeRuntimeBalancedTaskGroups(tasks, (packageCount) =>
    packAutocodeRuntimeIndependentTasksIntoFixedBinCount(tasks, orderedTasks, packageCount),
  );
}

function packAutocodeRuntimeIndependentTasksIntoFixedBinCount(
  tasks: AutocodeRuntimeTask[],
  orderedTasks: AutocodeRuntimeTask[],
  packageCount: number,
): AutocodeRuntimeTask[][] {
  const bins = Array.from({ length: packageCount }, () => ({
    effort: 0,
    tasks: [] as AutocodeRuntimeTask[],
  }));
  const sortedTasks = tasks
    .slice()
    .sort((left, right) => {
      const effortDelta = estimateAutocodeRuntimeTaskEffort(right) - estimateAutocodeRuntimeTaskEffort(left);
      return effortDelta !== 0
        ? effortDelta
        : getAutocodeRuntimeTaskOrder(orderedTasks, left.id) - getAutocodeRuntimeTaskOrder(orderedTasks, right.id);
    });

  for (const task of sortedTasks) {
    const taskEffort = estimateAutocodeRuntimeTaskEffort(task);
    const targetBin = bins
      .filter((bin) => bin.tasks.length < AUTOCODE_WORK_PACKAGE_MAX_TASKS)
      .sort((left, right) => left.effort - right.effort || left.tasks.length - right.tasks.length)[0]
      ?? bins[0];
    targetBin.tasks.push(task);
    targetBin.effort += taskEffort;
  }

  return bins
    .filter((bin) => bin.tasks.length > 0)
    .map((bin) => sortAutocodeRuntimeTasksByOriginalOrder(bin.tasks, orderedTasks))
    .sort((left, right) =>
      getAutocodeRuntimeTaskOrder(orderedTasks, left[0]?.id ?? '') -
      getAutocodeRuntimeTaskOrder(orderedTasks, right[0]?.id ?? ''),
    );
}

function splitOrderedAutocodeRuntimeTasksByEstimatedEffort(
  tasks: AutocodeRuntimeTask[],
  packageCount: number,
): AutocodeRuntimeTask[][] {
  const weights = tasks.map((task) => estimateAutocodeRuntimeTaskEffort(task));
  const prefixWeights = [0];
  for (const weight of weights) {
    prefixWeights.push(prefixWeights[prefixWeights.length - 1] + weight);
  }
  const targetEffort = prefixWeights[prefixWeights.length - 1] / packageCount;
  const scores: Array<Array<{ maxEffort: number; deviation: number; previous: number } | undefined>> =
    Array.from({ length: packageCount + 1 }, () => Array(tasks.length + 1).fill(undefined));
  scores[0][0] = { maxEffort: 0, deviation: 0, previous: -1 };

  for (let groupCount = 1; groupCount <= packageCount; groupCount += 1) {
    for (let end = groupCount; end <= tasks.length; end += 1) {
      const minStart = Math.max(groupCount - 1, end - AUTOCODE_WORK_PACKAGE_MAX_TASKS);
      for (let start = minStart; start < end; start += 1) {
        const previous = scores[groupCount - 1][start];
        if (!previous) {
          continue;
        }
        const segmentEffort = prefixWeights[end] - prefixWeights[start];
        const candidate = {
          maxEffort: Math.max(previous.maxEffort, segmentEffort),
          deviation: previous.deviation + Math.abs(segmentEffort - targetEffort),
          previous: start,
        };
        const current = scores[groupCount][end];
        if (!current || isBetterAutocodeRuntimePackagePartition(candidate, current)) {
          scores[groupCount][end] = candidate;
        }
      }
    }
  }

  const chunks: AutocodeRuntimeTask[][] = [];
  let end = tasks.length;
  for (let groupCount = packageCount; groupCount >= 1; groupCount -= 1) {
    const state = scores[groupCount][end];
    if (!state) {
      return splitAutocodeRuntimeLinearTaskChainByCount(tasks, packageCount);
    }
    chunks.unshift(tasks.slice(state.previous, end));
    end = state.previous;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function isBetterAutocodeRuntimePackagePartition(
  candidate: { maxEffort: number; deviation: number },
  current: { maxEffort: number; deviation: number },
): boolean {
  return candidate.maxEffort < current.maxEffort ||
    (candidate.maxEffort === current.maxEffort && candidate.deviation < current.deviation);
}

function splitAutocodeRuntimeLinearTaskChainByCount(
  chain: AutocodeRuntimeTask[],
  packageCount: number,
): AutocodeRuntimeTask[][] {
  const baseSize = Math.floor(chain.length / packageCount);
  const extraCount = chain.length % packageCount;
  const chunks: AutocodeRuntimeTask[][] = [];
  let offset = 0;

  for (let index = 0; index < packageCount; index += 1) {
    const size = baseSize + (index < extraCount ? 1 : 0);
    chunks.push(chain.slice(offset, offset + size));
    offset += size;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function chooseAutocodeRuntimeBalancedTaskGroups(
  tasks: AutocodeRuntimeTask[],
  buildGroups: (packageCount: number) => AutocodeRuntimeTask[][],
): AutocodeRuntimeTask[][] {
  const minPackageCount = Math.max(1, Math.ceil(tasks.length / AUTOCODE_WORK_PACKAGE_MAX_TASKS));
  const maxPackageCount = estimateAutocodeRuntimeMaxWorkPackageCount(tasks);
  let bestGroups: AutocodeRuntimeTask[][] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let packageCount = minPackageCount; packageCount <= maxPackageCount; packageCount += 1) {
    const groups = buildGroups(packageCount).filter((group) => group.length > 0);
    if (groups.length === 0 || groups.some((group) => group.length > AUTOCODE_WORK_PACKAGE_MAX_TASKS)) {
      continue;
    }
    const score = scoreAutocodeRuntimeWorkPackageBalance(groups);
    if (score < bestScore) {
      bestGroups = groups;
      bestScore = score;
    }
  }

  return bestGroups ?? splitAutocodeRuntimeLinearTaskChainByCount(tasks, minPackageCount);
}

function scoreAutocodeRuntimeWorkPackageBalance(groups: AutocodeRuntimeTask[][]): number {
  const efforts = groups.map((group) =>
    group.reduce((sum, task) => sum + estimateAutocodeRuntimeTaskEffort(task), 0),
  );
  const totalEffort = efforts.reduce((sum, effort) => sum + effort, 0);
  const maxEffort = Math.max(...efforts);
  const minEffort = Math.min(...efforts);
  const imbalance = maxEffort - minEffort;
  const targetOverflow = Math.max(0, maxEffort - AUTOCODE_WORK_PACKAGE_TARGET_EFFORT);
  const serialUnderSplitPenalty = groups.length === 1 && totalEffort > AUTOCODE_WORK_PACKAGE_TARGET_EFFORT
    ? AUTOCODE_WORK_PACKAGE_TARGET_EFFORT
    : 0;

  return maxEffort +
    imbalance * 0.6 +
    targetOverflow * 0.8 +
    serialUnderSplitPenalty +
    groups.length * 0.25;
}

function estimateAutocodeRuntimeMaxWorkPackageCount(tasks: AutocodeRuntimeTask[]): number {
  if (tasks.length <= 1) {
    return tasks.length;
  }

  const totalEffort = tasks.reduce((sum, task) => sum + estimateAutocodeRuntimeTaskEffort(task), 0);
  const effortPackageCount = totalEffort >= AUTOCODE_WORK_PACKAGE_TARGET_EFFORT * 1.5
    ? Math.ceil(totalEffort / AUTOCODE_WORK_PACKAGE_TARGET_EFFORT)
    : 1;
  return Math.max(
    1,
    Math.min(
      tasks.length,
      Math.max(
        Math.ceil(tasks.length / AUTOCODE_WORK_PACKAGE_MAX_TASKS),
        effortPackageCount,
      ),
    ),
  );
}

function sortAutocodeRuntimeTasksByOriginalOrder(
  tasks: AutocodeRuntimeTask[],
  orderedTasks: AutocodeRuntimeTask[],
): AutocodeRuntimeTask[] {
  return tasks
    .slice()
    .sort((left, right) => getAutocodeRuntimeTaskOrder(orderedTasks, left.id) - getAutocodeRuntimeTaskOrder(orderedTasks, right.id));
}

function getAutocodeRuntimeTaskOrder(tasks: AutocodeRuntimeTask[], taskId: string): number {
  const index = tasks.findIndex((task) => task.id === taskId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function canGroupAutocodeRuntimeTaskDependency(task: AutocodeRuntimeTask, dependency: AutocodeRuntimeTask): boolean {
  if (task.status !== dependency.status) {
    return false;
  }
  return task.phaseId === dependency.phaseId || (isTopLevelAutocodeRuntimeTask(task) && isTopLevelAutocodeRuntimeTask(dependency));
}

function isTopLevelAutocodeRuntimeTask(task: AutocodeRuntimeTask): boolean {
  return task.phaseId === task.id && !task.id.includes('.');
}

function topologicallySortAutocodeRuntimeTasks(tasks: AutocodeRuntimeTask[]): AutocodeRuntimeTask[] {
  const remaining = new Set(tasks.map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const orderById = new Map(tasks.map((task, index) => [task.id, index]));
  const sorted: AutocodeRuntimeTask[] = [];

  while (remaining.size > 0) {
    const runnable = [...remaining]
      .map((id) => taskById.get(id))
      .filter((task): task is AutocodeRuntimeTask => Boolean(task))
      .filter((task) => task.dependsOn.every((dependencyId) => !remaining.has(dependencyId)))
      .sort((left, right) => (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0));

    if (runnable.length === 0) {
      return tasks;
    }

    for (const task of runnable) {
      sorted.push(task);
      remaining.delete(task.id);
    }
  }

  return sorted;
}

function populateAutocodeRuntimeWorkPackageDependencies(packages: AutocodeRuntimeWorkPackage[]): void {
  const packageByTaskId = new Map<string, string>();
  for (const workPackage of packages) {
    for (const task of workPackage.tasks) {
      packageByTaskId.set(task.id, workPackage.id);
    }
  }

  const packageOrder = new Map(packages.map((candidate, index) => [candidate.id, index]));
  for (const workPackage of packages) {
    const dependsOn = new Set<string>();
    for (const task of workPackage.tasks) {
      for (const upstreamDependencyId of task.dependsOn) {
        const dependencyPackageId = packageByTaskId.get(upstreamDependencyId);
        if (dependencyPackageId && dependencyPackageId !== workPackage.id) {
          dependsOn.add(dependencyPackageId);
        }
      }
    }
    workPackage.dependsOn = [...dependsOn].sort(
      (left, right) => (packageOrder.get(left) ?? 0) - (packageOrder.get(right) ?? 0),
    );
  }
}

function assertAutocodeRuntimeWorkPackagesHaveValidDependencies(packages: AutocodeRuntimeWorkPackage[]): void {
  const analysis = analyzeAutocodeWorkDependencies(
    packages.map((workPackage) => ({
      id: workPackage.id,
      status: 'pending',
      dependsOn: workPackage.dependsOn,
    })),
  );
  if (analysis.issues.length > 0) {
    const summary = describeAutocodeWorkDependencyBlockers(analysis.blocked);
    throw new Error(`Runtime work package dependency graph is invalid: ${summary}`);
  }
}

function sanitizeAutocodeRuntimeDependencyIds(value: unknown): string[] {
  return uniqueAutocodeRuntimeStrings(
    normalizeAutocodeWorkDependencyIds(value)
      .filter((dependencyId) => /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/u.test(dependencyId)),
  );
}

function stripDependencyMetadataPrefix(line: string): string {
  return line.replace(/^\s*(?:-\s+)?_(?:Depends on|依赖|依赖于前置任务|前置|先决条件)\s*[:：]\s*[^_]+?_\s*/iu, '');
}

function stripAutocodeRuntimeTaskTitleStatePrefix(value: string): string {
  let cleaned = singleLine(value);
  for (let index = 0; index < 5; index += 1) {
    const withoutBracketedTag = cleaned.replace(
      new RegExp(`^\\s*[\\[(]\\s*${AUTOCODE_RUNTIME_TASK_TITLE_STATE_TAG}\\s*[\\])]\\s*(?:[-:]\\s*)?`, 'iu'),
      '',
    );
    const withoutPlainTag = withoutBracketedTag.replace(
      new RegExp(`^\\s*${AUTOCODE_RUNTIME_TASK_TITLE_STATE_TAG}\\s*[-:]\\s*`, 'iu'),
      '',
    );
    const next = withoutPlainTag.trim();
    if (next === cleaned) {
      break;
    }
    cleaned = next;
  }
  return cleaned;
}

function getAutocodeRuntimeTaskTitleState(value: string): 'obsolete' | 'needs_revision' | undefined {
  const tag = getAutocodeRuntimeTaskTitleStateTag(value);
  if (!tag) {
    return undefined;
  }
  if (tag === 'obsolete' || tag === 'superseded' || tag === 'deprecated') {
    return 'obsolete';
  }
  return 'needs_revision';
}

function getAutocodeRuntimeTaskTitleStateTag(value: string): string {
  const cleaned = singleLine(value);
  const bracketed = cleaned.match(
    new RegExp(`^\\s*[\\[(]\\s*(${AUTOCODE_RUNTIME_TASK_TITLE_STATE_TAG})\\s*[\\])]`, 'iu'),
  );
  const plain = cleaned.match(
    new RegExp(`^\\s*(${AUTOCODE_RUNTIME_TASK_TITLE_STATE_TAG})\\s*[-:]\\s*`, 'iu'),
  );
  return normalizeAutocodeRuntimeTaskTitleStateTag(bracketed?.[1] ?? plain?.[1] ?? '');
}

function normalizeAutocodeRuntimeTaskTitleStateTag(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/gu, '_');
}

function getRuntimeWorkPackagePhaseLabel(language?: string): string {
  return isChineseLanguage(language) ? '运行工作包' : 'Runtime work packages';
}

function getAutocodeRuntimePlanFeatureFallback(language?: string): string {
  return isChineseLanguage(language) ? 'Autocode 任务' : 'Autocode task';
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringFrom(item)).filter(Boolean);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function isChineseLanguage(language: unknown): boolean {
  const normalized = stringFrom(language).toLowerCase().replace(/_/g, '-');
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('chinese');
}
