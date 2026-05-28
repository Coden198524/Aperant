import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { getAutocodeSpecDir, listAutocodeTasks } from './spec-store.js';

export type AutocodeTaskLogPhase = 'planning' | 'coding' | 'validation';
export type AutocodeTaskLogPhaseStatus = 'pending' | 'active' | 'completed' | 'failed';
export type AutocodeTaskLogEntryType =
  | 'text'
  | 'tool_start'
  | 'tool_end'
  | 'phase_start'
  | 'phase_end'
  | 'error'
  | 'success'
  | 'info';

export interface AutocodeTaskLogEntry {
  timestamp: string;
  type: AutocodeTaskLogEntryType;
  content: string;
  phase: AutocodeTaskLogPhase;
  model?: {
    provider?: string;
    modelId?: string;
  };
  tool_name?: string;
  tool_input?: string;
  tool_success?: boolean;
  tool_call_id?: string;
  subtask_id?: string;
  session?: number;
  detail?: string;
  subphase?: string;
  collapsed?: boolean;
}

export interface AutocodeTaskPhaseLog {
  phase: AutocodeTaskLogPhase;
  status: AutocodeTaskLogPhaseStatus;
  started_at: string | null;
  completed_at: string | null;
  entries: AutocodeTaskLogEntry[];
}

export interface AutocodeTaskLogs {
  spec_id: string;
  created_at: string;
  updated_at: string;
  phases: Record<AutocodeTaskLogPhase, AutocodeTaskPhaseLog>;
}

export interface AutocodeTaskLogsInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
}

export interface AppendAutocodeTaskLogEntryInput extends AutocodeTaskLogsInput {
  phase: AutocodeTaskLogPhase;
  type: AutocodeTaskLogEntryType;
  content: string;
  timestamp?: string;
  detail?: string;
}

export interface UpdateAutocodeTaskLogPhaseInput extends AutocodeTaskLogsInput {
  phase: AutocodeTaskLogPhase;
  status: AutocodeTaskLogPhaseStatus;
  message?: string;
}

const LOG_TEXT_MAX_CHARS = 4000;
const LOG_DETAIL_MAX_CHARS = 12000;

export function getAutocodeTaskLogsPath(input: AutocodeTaskLogsInput): string {
  return join(resolveTaskSpecDir(input), AUTOCODE_TASK_ARTIFACTS.taskLogs);
}

export function createEmptyAutocodeTaskLogs(specId: string, now = new Date().toISOString()): AutocodeTaskLogs {
  return {
    spec_id: sanitizeText(specId, 200),
    created_at: now,
    updated_at: now,
    phases: {
      planning: createEmptyPhaseLog('planning'),
      coding: createEmptyPhaseLog('coding'),
      validation: createEmptyPhaseLog('validation'),
    },
  };
}

export function readAutocodeTaskLogs(input: AutocodeTaskLogsInput): AutocodeTaskLogs | null {
  const logPath = getAutocodeTaskLogsPath(input);
  if (!existsSync(logPath)) {
    return null;
  }

  try {
    return sanitizeLogs(JSON.parse(readFileSync(logPath, 'utf8')) as AutocodeTaskLogs, input.taskId);
  } catch (error) {
    return salvageTaskLogs(readTextIfPresent(logPath), input.taskId, error);
  }
}

export function appendAutocodeTaskLogEntry(input: AppendAutocodeTaskLogEntryInput): AutocodeTaskLogs {
  const logPath = getAutocodeTaskLogsPath(input);
  const now = new Date().toISOString();
  const logs = readAutocodeTaskLogs(input) ?? createEmptyAutocodeTaskLogs(input.taskId, now);
  const phaseLog = logs.phases[input.phase] ?? createEmptyPhaseLog(input.phase);

  if (phaseLog.status === 'pending') {
    phaseLog.status = 'active';
    phaseLog.started_at = phaseLog.started_at ?? now;
  }

  phaseLog.entries.push({
    timestamp: input.timestamp ?? now,
    type: input.type,
    phase: input.phase,
    content: sanitizeText(input.content, LOG_TEXT_MAX_CHARS),
    ...(input.detail ? { detail: sanitizeText(input.detail, LOG_DETAIL_MAX_CHARS), collapsed: true } : {}),
  });
  logs.phases[input.phase] = phaseLog;
  logs.updated_at = now;
  writeAutocodeTaskLogs(logPath, logs);
  return logs;
}

export function updateAutocodeTaskLogPhase(input: UpdateAutocodeTaskLogPhaseInput): AutocodeTaskLogs {
  const logPath = getAutocodeTaskLogsPath(input);
  const now = new Date().toISOString();
  const logs = readAutocodeTaskLogs(input) ?? createEmptyAutocodeTaskLogs(input.taskId, now);
  const phaseLog = logs.phases[input.phase] ?? createEmptyPhaseLog(input.phase);
  const wasPending = phaseLog.status === 'pending';

  phaseLog.status = input.status;
  if ((input.status === 'active' || wasPending) && !phaseLog.started_at) {
    phaseLog.started_at = now;
  }
  if (input.status === 'completed' || input.status === 'failed') {
    phaseLog.completed_at = now;
  }
  if (input.message) {
    phaseLog.entries.push({
      timestamp: now,
      type: input.status === 'failed' ? 'error' : input.status === 'completed' ? 'success' : 'info',
      phase: input.phase,
      content: sanitizeText(input.message, LOG_TEXT_MAX_CHARS),
    });
  }

  logs.phases[input.phase] = phaseLog;
  logs.updated_at = now;
  writeAutocodeTaskLogs(logPath, logs);
  return logs;
}

function writeAutocodeTaskLogs(logPath: string, logs: AutocodeTaskLogs): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const sanitized = sanitizeLogs(logs, logs.spec_id);
  const tmpPath = `${logPath}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, logPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors and rethrow the original write failure.
    }
    throw error;
  }
}

function resolveTaskSpecDir(input: AutocodeTaskLogsInput): string {
  const task = listAutocodeTasks({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
  }).find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);

  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  return getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });
}

function createEmptyPhaseLog(phase: AutocodeTaskLogPhase): AutocodeTaskPhaseLog {
  return {
    phase,
    status: 'pending',
    started_at: null,
    completed_at: null,
    entries: [],
  };
}

function sanitizeLogs(logs: AutocodeTaskLogs, fallbackSpecId: string): AutocodeTaskLogs {
  const createdAt = typeof logs.created_at === 'string' ? logs.created_at : new Date().toISOString();
  const updatedAt = typeof logs.updated_at === 'string' ? logs.updated_at : createdAt;
  return {
    spec_id: sanitizeText(typeof logs.spec_id === 'string' ? logs.spec_id : fallbackSpecId, 200),
    created_at: createdAt,
    updated_at: updatedAt,
    phases: {
      planning: sanitizePhaseLog(logs.phases?.planning, 'planning'),
      coding: sanitizePhaseLog(logs.phases?.coding, 'coding'),
      validation: sanitizePhaseLog(logs.phases?.validation, 'validation'),
    },
  };
}

function sanitizePhaseLog(value: AutocodeTaskPhaseLog | undefined, phase: AutocodeTaskLogPhase): AutocodeTaskPhaseLog {
  const status = isPhaseStatus(value?.status) ? value.status : 'pending';
  return {
    phase,
    status,
    started_at: typeof value?.started_at === 'string' ? value.started_at : null,
    completed_at: typeof value?.completed_at === 'string' ? value.completed_at : null,
    entries: Array.isArray(value?.entries)
      ? value.entries.map((entry) => sanitizeEntry(entry, phase))
      : [],
  };
}

function sanitizeEntry(value: AutocodeTaskLogEntry, fallbackPhase: AutocodeTaskLogPhase): AutocodeTaskLogEntry {
  const phase = isPhase(value.phase) ? value.phase : fallbackPhase;
  return {
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : new Date().toISOString(),
    type: isEntryType(value.type) ? value.type : 'info',
    phase,
    content: sanitizeText(value.content, LOG_TEXT_MAX_CHARS),
    ...(value.detail ? { detail: sanitizeText(value.detail, LOG_DETAIL_MAX_CHARS) } : {}),
    ...(value.tool_name ? { tool_name: sanitizeText(value.tool_name, 200) } : {}),
    ...(value.tool_input ? { tool_input: sanitizeText(value.tool_input, 1000) } : {}),
    ...(value.tool_success !== undefined ? { tool_success: Boolean(value.tool_success) } : {}),
    ...(value.tool_call_id ? { tool_call_id: sanitizeText(value.tool_call_id, 200) } : {}),
    ...(value.subtask_id ? { subtask_id: sanitizeText(value.subtask_id, 200) } : {}),
    ...(typeof value.session === 'number' ? { session: value.session } : {}),
    ...(value.subphase ? { subphase: sanitizeText(value.subphase, 200) } : {}),
    ...(value.collapsed !== undefined ? { collapsed: Boolean(value.collapsed) } : {}),
    ...(value.model ? { model: value.model } : {}),
  };
}

function salvageTaskLogs(content: string, specId: string, error: unknown): AutocodeTaskLogs {
  const now = new Date().toISOString();
  const logs = createEmptyAutocodeTaskLogs(specId, now);
  logs.phases.planning.status = 'failed';
  logs.phases.planning.started_at = now;
  logs.phases.planning.completed_at = now;
  logs.phases.planning.entries.push({
    timestamp: now,
    type: 'error',
    phase: 'planning',
    content: `${AUTOCODE_TASK_ARTIFACTS.taskLogs} could not be parsed. ${error instanceof Error ? error.message : String(error)}`,
    detail: sanitizeText(content, LOG_DETAIL_MAX_CHARS),
    collapsed: true,
  });
  return logs;
}

function readTextIfPresent(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function sanitizeText(value: unknown, maxLength: number): string {
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function isPhase(value: unknown): value is AutocodeTaskLogPhase {
  return value === 'planning' || value === 'coding' || value === 'validation';
}

function isPhaseStatus(value: unknown): value is AutocodeTaskLogPhaseStatus {
  return value === 'pending' || value === 'active' || value === 'completed' || value === 'failed';
}

function isEntryType(value: unknown): value is AutocodeTaskLogEntryType {
  return (
    value === 'text' ||
    value === 'tool_start' ||
    value === 'tool_end' ||
    value === 'phase_start' ||
    value === 'phase_end' ||
    value === 'error' ||
    value === 'success' ||
    value === 'info'
  );
}
