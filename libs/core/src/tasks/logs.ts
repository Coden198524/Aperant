import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { getAutocodeSpecDir, listAutocodeTasks } from './spec-store.js';
import { withAutocodeRuntimeFileWriteLockSync } from '../runtime/workspace-claims.js';
import { repairAutocodeChineseMojibakeText } from '../text/encoding.js';

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
  dataDirName?: string;
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

export function getAutocodeTaskLogsPathFromSpecDir(specDir: string): string {
  return join(specDir, AUTOCODE_TASK_ARTIFACTS.taskLogs);
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
  return readAutocodeTaskLogsFromFile(getAutocodeTaskLogsPath(input), input.taskId);
}

export function readAutocodeTaskLogsFromSpecDir(
  specDir: string,
  fallbackSpecId = basename(specDir),
): AutocodeTaskLogs | null {
  return readAutocodeTaskLogsFromFile(getAutocodeTaskLogsPathFromSpecDir(specDir), fallbackSpecId);
}

export function parseAutocodeTaskLogs(content: string, fallbackSpecId: string): AutocodeTaskLogs {
  try {
    return sanitizeLogs(JSON.parse(content) as AutocodeTaskLogs, fallbackSpecId);
  } catch (error) {
    return salvageAutocodeTaskLogs(content, fallbackSpecId, error);
  }
}

export function mergeAutocodeTaskLogs(
  mainLogs: AutocodeTaskLogs | null,
  worktreeLogs: AutocodeTaskLogs | null,
): AutocodeTaskLogs | null {
  if (!worktreeLogs) {
    return mainLogs;
  }

  if (!mainLogs) {
    return worktreeLogs;
  }

  return {
    spec_id: mainLogs.spec_id,
    created_at: mainLogs.created_at,
    updated_at: worktreeLogs.updated_at > mainLogs.updated_at ? worktreeLogs.updated_at : mainLogs.updated_at,
    phases: {
      planning: combineAutocodeTaskPhaseLogs(mainLogs.phases.planning, worktreeLogs.phases.planning, 'planning'),
      coding: hasAutocodeTaskPhaseContent(worktreeLogs.phases.coding) ? worktreeLogs.phases.coding : mainLogs.phases.coding,
      validation: hasAutocodeTaskPhaseContent(worktreeLogs.phases.validation)
        ? worktreeLogs.phases.validation
        : mainLogs.phases.validation,
    },
  };
}

export function combineAutocodeTaskPhaseLogs(
  main: AutocodeTaskPhaseLog | undefined,
  worktree: AutocodeTaskPhaseLog | undefined,
  phase: AutocodeTaskLogPhase,
): AutocodeTaskPhaseLog {
  if (!main?.entries?.length && !worktree?.entries?.length) {
    return main || worktree || createEmptyPhaseLog(phase);
  }
  if (!main?.entries?.length) {
    return worktree!;
  }
  if (!worktree?.entries?.length) {
    return main;
  }

  const seen = new Set<string>();
  const entries = [...main.entries, ...worktree.entries]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .filter((entry) => {
      const key = `${entry.timestamp}|${entry.type}|${entry.content}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return {
    phase,
    status: worktree.status !== 'pending' ? worktree.status : main.status,
    started_at: main.started_at || worktree.started_at,
    completed_at: worktree.completed_at || main.completed_at,
    entries,
  };
}

function readAutocodeTaskLogsFromFile(logPath: string, fallbackSpecId: string): AutocodeTaskLogs | null {
  if (!existsSync(logPath)) {
    return null;
  }

  return parseAutocodeTaskLogs(readTextIfPresent(logPath), fallbackSpecId);
}

export function appendAutocodeTaskLogEntry(input: AppendAutocodeTaskLogEntryInput): AutocodeTaskLogs {
  const logPath = getAutocodeTaskLogsPath(input);
  return withAutocodeRuntimeFileWriteLockSync(
    getAutocodeTaskLogsFileWriteLockInput(input, logPath, `task-logs:${input.taskId}:${input.phase}:append`),
    () => {
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
    },
  );
}

export function updateAutocodeTaskLogPhase(input: UpdateAutocodeTaskLogPhaseInput): AutocodeTaskLogs {
  const logPath = getAutocodeTaskLogsPath(input);
  return withAutocodeRuntimeFileWriteLockSync(
    getAutocodeTaskLogsFileWriteLockInput(input, logPath, `task-logs:${input.taskId}:${input.phase}:phase`),
    () => {
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
    },
  );
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

function getAutocodeTaskLogsFileWriteLockInput(
  input: AutocodeTaskLogsInput,
  logPath: string,
  ownerId: string,
) {
  return {
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    filePath: logPath,
    ownerId,
  };
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

export function salvageAutocodeTaskLogs(content: string, fallbackSpecId: string, error: unknown): AutocodeTaskLogs {
  const now = new Date().toISOString();
  const specId = extractJsonStringField(content, 'spec_id') ?? fallbackSpecId;
  const logs = createEmptyAutocodeTaskLogs(specId, now);
  logs.created_at = extractJsonStringField(content, 'created_at') ?? now;
  logs.updated_at = extractJsonStringField(content, 'updated_at') ?? now;

  const entryPattern = /"timestamp"\s*:\s*"([^"]+)"[\s\S]{0,1200}?"type"\s*:\s*"([^"]+)"[\s\S]{0,1200}?"content"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"[\s\S]{0,1200}?"phase"\s*:\s*"(planning|coding|validation)"/g;
  for (const match of content.matchAll(entryPattern)) {
    const phase = match[4] as AutocodeTaskLogPhase;
    let entryContent = match[3] ?? '';
    try {
      entryContent = JSON.parse(`"${entryContent}"`) as string;
    } catch {
      // Keep the recovered fragment when an individual entry is also damaged.
    }

    logs.phases[phase].entries.push({
      timestamp: match[1] ?? now,
      type: isEntryType(match[2]) ? match[2] : 'info',
      phase,
      content: sanitizeText(entryContent, LOG_TEXT_MAX_CHARS),
    });
  }

  for (const phase of Object.keys(logs.phases) as AutocodeTaskLogPhase[]) {
    const phaseContentMatch = content.match(new RegExp(`"${phase}"\\s*:\\s*\\{[\\s\\S]*?\\}`));
    const phaseContent = phaseContentMatch?.[0] ?? '';
    const startedAt = extractJsonStringField(phaseContent, 'started_at');
    const completedAt = extractJsonStringField(phaseContent, 'completed_at');
    logs.phases[phase].started_at = startedAt;
    logs.phases[phase].completed_at = completedAt;
    if (completedAt) {
      logs.phases[phase].status = 'completed';
    } else if (startedAt || logs.phases[phase].entries.length > 0) {
      logs.phases[phase].status = 'active';
    }
  }

  logs.phases.planning.status = logs.phases.planning.status === 'pending' ? 'failed' : logs.phases.planning.status;
  logs.phases.planning.started_at = logs.phases.planning.started_at ?? now;
  logs.phases.planning.completed_at = logs.phases.planning.completed_at ?? now;
  logs.phases.planning.entries.push({
    timestamp: now,
    type: 'error',
    phase: 'planning',
    content: `${AUTOCODE_TASK_ARTIFACTS.taskLogs} could not be parsed; showing recovered log entries only. ${error instanceof Error ? error.message : String(error)}`,
    detail: sanitizeText(content, LOG_DETAIL_MAX_CHARS),
    collapsed: true,
  });
  return sanitizeLogs(logs, fallbackSpecId);
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
  const normalized = repairAutocodeChineseMojibakeText(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function hasAutocodeTaskPhaseContent(phase: AutocodeTaskPhaseLog | undefined): boolean {
  return Boolean(phase) && ((phase?.entries?.length ?? 0) > 0 || phase?.status !== 'pending');
}

function extractJsonStringField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`));
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
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
