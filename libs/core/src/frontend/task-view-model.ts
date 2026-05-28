import { calculateProgress } from '../tasks/progress.js';
import type { AutocodeTaskLogEntry, AutocodeTaskLogs } from '../tasks/logs.js';
import type { AutocodeTask } from '../tasks/spec-store.js';
import type { ProjectIndex, ServiceInfo } from '../project/index.js';
import type { WorkspaceSummary } from '../workspace/summary.js';

export interface AutocodeDisplayRow {
  key: string;
  label: string;
  value: string;
  tone?: 'default' | 'strong' | 'code';
}

export interface AutocodeWorkspaceSummaryViewModel {
  name: string;
  rootPath: string;
  packageNameLabel: string;
  packageManagerLabel: string;
  gitLabel: string;
  languagesLabel: string;
  frameworksLabel: string;
  scriptsLabel: string;
  sampledFilesLabel: string;
  projectTypeLabel: string;
  servicesLabel: string;
  sourceFilesLabel: string;
  rows: AutocodeDisplayRow[];
}

export interface AutocodeTaskDisplayInput {
  id: string;
  specId: string;
  title: string;
  description?: string;
  status: string;
  reviewReason?: string;
  executionPhase?: string;
  subtasks: Array<{ status: string }>;
  updatedAt: string | Date;
}

export interface BuildAutocodeTaskCardViewModelOptions {
  descriptionMaxLength?: number;
  logContentMaxLength?: number;
  latestLogEntries?: number;
  now?: Date;
}

export interface AutocodeTaskLogEntryViewModel {
  timestamp: string;
  timestampLabel: string;
  type: string;
  phase: string;
  content: string;
  contentPreview: string;
}

export interface AutocodeTaskLogsViewModel {
  hasLogs: boolean;
  phaseStatusText: string;
  latestEntries: AutocodeTaskLogEntryViewModel[];
}

export interface AutocodeTaskCardViewModel {
  id: string;
  specId: string;
  title: string;
  status: string;
  reviewReason?: string;
  executionPhase?: string;
  subtaskCount: number;
  activeSubtaskCount: number;
  completedSubtaskCount: number;
  failedSubtaskCount: number;
  hasParallelSubtasks: boolean;
  updatedAt: string;
  updatedAtLabel: string;
  updatedAtRelativeLabel: string;
  descriptionPreview: string;
  metaItems: string[];
  metaText: string;
  progressPercent: number;
  logs: AutocodeTaskLogsViewModel;
}

export interface AutocodeWorkspaceTasksViewModel {
  projectRoot: string | null;
  dataDirName: string;
  tasksPathLabel: string;
  workspace: AutocodeWorkspaceSummaryViewModel | null;
  tasks: AutocodeTaskCardViewModel[];
}

export interface AutocodeWorkspaceDisplayInput {
  projectRoot: string | null;
  dataDirName: string;
  summary: WorkspaceSummary | null;
  projectIndex: ProjectIndex | null;
  tasks: AutocodeTask[];
  logsByTaskId: Record<string, AutocodeTaskLogs | null>;
}

const DEFAULT_EMPTY_LABEL = 'Not detected';

export function buildAutocodeWorkspaceSummaryViewModel(
  summary: WorkspaceSummary,
  projectIndex: ProjectIndex | null = null,
): AutocodeWorkspaceSummaryViewModel {
  const sourceFiles = projectIndex?.source_summary?.source_file_count;
  const services = projectIndex ? Object.values(projectIndex.services) : [];
  const viewModel = {
    name: summary.name,
    rootPath: summary.rootPath,
    packageNameLabel: summary.packageName ?? DEFAULT_EMPTY_LABEL,
    packageManagerLabel: summary.packageManager ?? DEFAULT_EMPTY_LABEL,
    gitLabel: summary.hasGit ? 'Yes' : 'No',
    languagesLabel: formatAutocodeList(summary.detectedLanguages),
    frameworksLabel: formatAutocodeList(summary.detectedFrameworks),
    scriptsLabel: formatAutocodeList(summary.scripts.slice(0, 8)),
    sampledFilesLabel: `${summary.totalFilesSampled} files`,
    projectTypeLabel: projectIndex?.project_type ?? DEFAULT_EMPTY_LABEL,
    servicesLabel: formatAutocodeServiceList(services),
    sourceFilesLabel: sourceFiles === undefined ? DEFAULT_EMPTY_LABEL : `${sourceFiles} files`,
  };

  return {
    ...viewModel,
    rows: [
      { key: 'name', label: 'Name', value: viewModel.name, tone: 'strong' },
      { key: 'path', label: 'Path', value: viewModel.rootPath, tone: 'code' },
      { key: 'package', label: 'Package', value: viewModel.packageNameLabel },
      { key: 'manager', label: 'Manager', value: viewModel.packageManagerLabel },
      { key: 'git', label: 'Git', value: viewModel.gitLabel },
      { key: 'languages', label: 'Languages', value: viewModel.languagesLabel },
      { key: 'frameworks', label: 'Frameworks', value: viewModel.frameworksLabel },
      { key: 'scripts', label: 'Scripts', value: viewModel.scriptsLabel },
      { key: 'sampled', label: 'Sampled', value: viewModel.sampledFilesLabel },
      { key: 'project', label: 'Project', value: viewModel.projectTypeLabel },
      { key: 'services', label: 'Services', value: viewModel.servicesLabel },
      { key: 'source', label: 'Source', value: viewModel.sourceFilesLabel },
    ],
  };
}

export function buildAutocodeWorkspaceTasksViewModel(
  input: AutocodeWorkspaceDisplayInput,
  options: BuildAutocodeTaskCardViewModelOptions = {},
): AutocodeWorkspaceTasksViewModel {
  return {
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    tasksPathLabel: `${input.dataDirName.replace(/[\\/]+$/, '') || '.'}/specs`,
    workspace: input.summary
      ? buildAutocodeWorkspaceSummaryViewModel(input.summary, input.projectIndex)
      : null,
    tasks: input.tasks.map((task) => buildAutocodeTaskCardViewModel(
      task,
      input.logsByTaskId[task.id] ?? null,
      options,
    )),
  };
}

export function buildAutocodeTaskCardViewModel(
  task: AutocodeTaskDisplayInput,
  logs: AutocodeTaskLogs | null = null,
  options: BuildAutocodeTaskCardViewModelOptions = {},
): AutocodeTaskCardViewModel {
  const subtaskCount = task.subtasks.length;
  const activeSubtaskCount = task.subtasks.filter((subtask) => subtask.status === 'in_progress').length;
  const completedSubtaskCount = task.subtasks.filter((subtask) => subtask.status === 'completed').length;
  const failedSubtaskCount = task.subtasks.filter((subtask) => subtask.status === 'failed').length;
  const updatedAt = normalizeDateInput(task.updatedAt);
  const updatedAtLabel = formatAutocodeDate(updatedAt);
  const descriptionPreview = task.description
    ? truncateAutocodeText(task.description, options.descriptionMaxLength ?? 180)
    : '';
  const metaItems = [
    task.specId,
    task.status,
    task.reviewReason,
    `${subtaskCount} subtasks`,
    updatedAtLabel,
  ].filter((item): item is string => Boolean(item));

  return {
    id: task.id,
    specId: task.specId,
    title: task.title,
    status: task.status,
    ...(task.reviewReason ? { reviewReason: task.reviewReason } : {}),
    ...(task.executionPhase ? { executionPhase: task.executionPhase } : {}),
    subtaskCount,
    activeSubtaskCount,
    completedSubtaskCount,
    failedSubtaskCount,
    hasParallelSubtasks: activeSubtaskCount > 1,
    updatedAt,
    updatedAtLabel,
    updatedAtRelativeLabel: formatAutocodeRelativeTime(updatedAt, options.now),
    descriptionPreview,
    metaItems,
    metaText: metaItems.join(' | '),
    progressPercent: calculateProgress(task.subtasks),
    logs: buildAutocodeTaskLogsViewModel(logs, options),
  };
}

export function buildAutocodeTaskLogsViewModel(
  logs: AutocodeTaskLogs | null,
  options: BuildAutocodeTaskCardViewModelOptions = {},
): AutocodeTaskLogsViewModel {
  if (!logs) {
    return {
      hasLogs: false,
      phaseStatusText: 'No task logs yet.',
      latestEntries: [],
    };
  }

  const phaseStatusText = (['planning', 'coding', 'validation'] as const)
    .map((phase) => `${phase}: ${logs.phases[phase].status}`)
    .join(' | ');
  const latestEntries = collectLatestAutocodeLogEntries(logs, options.latestLogEntries ?? 3)
    .map((entry) => buildAutocodeTaskLogEntryViewModel(entry, options));

  return {
    hasLogs: true,
    phaseStatusText,
    latestEntries,
  };
}

export function buildAutocodeTaskLogEntryViewModel(
  entry: AutocodeTaskLogEntry,
  options: BuildAutocodeTaskCardViewModelOptions = {},
): AutocodeTaskLogEntryViewModel {
  return {
    timestamp: entry.timestamp,
    timestampLabel: formatAutocodeDate(entry.timestamp),
    type: entry.type,
    phase: entry.phase,
    content: entry.content,
    contentPreview: truncateAutocodeText(entry.content, options.logContentMaxLength ?? 140),
  };
}

export function collectLatestAutocodeLogEntries(
  logs: AutocodeTaskLogs,
  maxEntries: number,
): AutocodeTaskLogEntry[] {
  return Object.values(logs.phases)
    .flatMap((phase) => phase.entries)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, Math.max(0, maxEntries));
}

export function formatAutocodeList(values: string[], emptyLabel = DEFAULT_EMPTY_LABEL): string {
  return values.length > 0 ? values.join(', ') : emptyLabel;
}

export function formatAutocodeServiceList(
  services: Array<Pick<ServiceInfo, 'name' | 'language'>>,
  emptyLabel = DEFAULT_EMPTY_LABEL,
  maxItems = 5,
): string {
  if (services.length === 0) {
    return emptyLabel;
  }
  return services
    .slice(0, maxItems)
    .map((service) => service.language ? `${service.name} (${service.language})` : service.name)
    .join(', ');
}

export function formatAutocodeDate(value: string | Date): string {
  const normalized = normalizeDateInput(value);
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toLocaleString();
}

export function formatAutocodeRelativeTime(value: string | Date, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return normalizeDateInput(value);
  }

  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function truncateAutocodeText(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return '.'.repeat(maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeDateInput(value: string | Date): string {
  return value instanceof Date
    ? Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
    : value;
}
