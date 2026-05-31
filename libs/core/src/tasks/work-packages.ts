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

export { stringifyAutocodeImplementationPlanMarkdown };

export interface AutocodeRuntimeTask {
  id: string;
  title: string;
  description: string;
  status: string;
  phaseId: string;
  phaseName: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  dependsOn: string[];
  requirements: string[];
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
}

const AUTOCODE_WORK_PACKAGE_MAX_TASKS = 5;

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
  });

  if (!hasRuntimeWorkPackages(phases)) {
    throw new Error(`${sourcePath} has no executable tasks.`);
  }

  const parsedSourceTask = parsedTasks.source_task && typeof parsedTasks.source_task === 'object' && !Array.isArray(parsedTasks.source_task)
    ? parsedTasks.source_task as Record<string, unknown>
    : {};

  return {
    ...parsedTasks,
    feature: input.title || parsedTasks.feature || 'Autocode task',
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
}

export function buildAutocodeRuntimeWorkPackagePhases(
  input: BuildAutocodeRuntimeWorkPackagePhasesInput,
): MutableAutocodePlanPhase[] {
  const runtimeTasks = completeAutocodeRuntimeTaskDependencyGraph(
    flattenAutocodeRuntimeTasks(input.parsedPhases, input.language, input.sourceName),
  );
  assertAutocodeRuntimeTasksHaveValidDependencies(runtimeTasks, `${input.sourceName || 'Autocode'} task`);
  if (runtimeTasks.length === 0) {
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

  const workPackages = groupAutocodeRuntimeTasksIntoWorkPackages(runtimeTasks, input.language);
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
      const title = stringFrom(subtask.title ?? subtask.description)
        || (isChineseLanguage(language) ? `${sourceName} 任务 ${id}` : `${sourceName} task ${id}`);
      const description = sanitizeAutocodeRuntimeTaskDescription(stringFrom(subtask.description) || title, title);
      tasks.push({
        id,
        title,
        description,
        status: stringFrom(subtask.status) || 'pending',
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
  return tasks.map((task, index) => {
    if (task.dependsOn.length > 0) {
      return { ...task, dependsOn: uniqueAutocodeRuntimeStrings(task.dependsOn) };
    }

    const inferred = inferAutocodeRuntimeTaskDependencies(task, index, tasks, hasExplicitDependencyGraph);
    return inferred.length > 0
      ? { ...task, dependsOn: inferred }
      : { ...task, dependsOn: [] };
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

  const summary = describeAutocodeWorkDependencyBlockers(analysis.blocked);
  throw new Error(`${label} dependency graph is invalid: ${summary}`);
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
      pushPackage(packageTasks);
    }
  }

  populateAutocodeRuntimeWorkPackageDependencies(packages);
  assertAutocodeRuntimeWorkPackagesHaveValidDependencies(packages);
  return packages;
}

export function buildAutocodeRuntimeWorkPackageTitle(
  tasks: AutocodeRuntimeTask[],
  language?: string,
): string {
  if (tasks.length === 1) {
    return isChineseLanguage(language) ? `工作包：${tasks[0].title}` : `Work package: ${tasks[0].title}`;
  }
  const first = tasks[0]?.title ?? (isChineseLanguage(language) ? '任务' : 'tasks');
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
    .map((line) => stripDependencyMetadataPrefix(line).trim())
    .filter(Boolean);
  return cleanedLines.join('\n') || fallbackTitle;
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
        `- ${task.id} ${task.title}`,
        `  ${singleLine(sanitizeAutocodeRuntimeTaskDescription(task.description, task.title))}`,
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
      `- ${task.id} ${task.title}`,
      `  ${singleLine(sanitizeAutocodeRuntimeTaskDescription(task.description, task.title))}`,
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

  return chains;
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
  if (chain.length <= AUTOCODE_WORK_PACKAGE_MAX_TASKS) {
    return [chain];
  }

  const packageCount = Math.ceil(chain.length / AUTOCODE_WORK_PACKAGE_MAX_TASKS);
  const baseSize = Math.floor(chain.length / packageCount);
  const extraCount = chain.length % packageCount;
  const chunks: AutocodeRuntimeTask[][] = [];
  let offset = 0;

  for (let index = 0; index < packageCount; index += 1) {
    const size = baseSize + (index < extraCount ? 1 : 0);
    chunks.push(chain.slice(offset, offset + size));
    offset += size;
  }

  return chunks;
}

function getAutocodeRuntimeTaskOrder(tasks: AutocodeRuntimeTask[], taskId: string): number {
  const index = tasks.findIndex((task) => task.id === taskId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function canGroupAutocodeRuntimeTaskDependency(task: AutocodeRuntimeTask, dependency: AutocodeRuntimeTask): boolean {
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

function getRuntimeWorkPackagePhaseLabel(language?: string): string {
  return isChineseLanguage(language) ? '运行工作包' : 'Runtime work packages';
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
