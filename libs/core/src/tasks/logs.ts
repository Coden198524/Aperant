import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
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
  git_commit?: string;
  git_commit_skipped?: string;
  changed_files?: string[];
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

export interface AutocodeTaskLogMetaRecord {
  record_type: 'meta';
  spec_id: string;
  created_at: string;
  updated_at?: string;
}

export interface AutocodeTaskLogPhaseRecord {
  record_type: 'phase';
  timestamp: string;
  phase: AutocodeTaskLogPhase;
  status: AutocodeTaskLogPhaseStatus;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface AutocodeTaskLogEntryRecord {
  record_type: 'entry';
  entry: AutocodeTaskLogEntry;
}

export type AutocodeTaskLogJsonlRecord =
  | AutocodeTaskLogMetaRecord
  | AutocodeTaskLogPhaseRecord
  | AutocodeTaskLogEntryRecord;

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
const NOISY_AUTOCODE_TASK_LOG_PATTERNS = [
  /WARN\s+codex_core::shell_snapshot:\s+Failed to create shell snapshot for powershell\b/i,
  /WARN\s+codex_core_plugins::manifest:\s+ignoring interface\.defaultPrompt\[[0-9]+]:\s+prompt must be at most [0-9]+ characters\b/i,
  /WARN\s+codex_core_skills::loader:\s+ignoring interface\.icon_(?:small|large):\s+icon path with '\.\.' must resolve under plugin assets\//i,
];

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
  const now = new Date().toISOString();
  const logs = createEmptyAutocodeTaskLogs(fallbackSpecId, now);
  let sawRecord = false;
  let invalidLineCount = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLineCount += 1;
      continue;
    }

    if (!isPlainRecord(record)) {
      invalidLineCount += 1;
      continue;
    }

    sawRecord = true;
    applyTaskLogJsonlRecord(logs, record, fallbackSpecId);
  }

  if (invalidLineCount > 0) {
    const warningTimestamp = new Date().toISOString();
    logs.phases.planning.status = logs.phases.planning.status === 'pending' ? 'failed' : logs.phases.planning.status;
    logs.phases.planning.started_at = logs.phases.planning.started_at ?? warningTimestamp;
    logs.phases.planning.completed_at = logs.phases.planning.completed_at ?? warningTimestamp;
    logs.phases.planning.entries.push({
      timestamp: warningTimestamp,
      type: 'error',
      phase: 'planning',
      content: `${AUTOCODE_TASK_ARTIFACTS.taskLogs} had ${invalidLineCount} invalid JSONL line(s); valid entries were loaded.`,
    });
  }

  return sanitizeLogs(logs, fallbackSpecId);
}

export function serializeAutocodeTaskLogRecord(record: AutocodeTaskLogJsonlRecord): string {
  return JSON.stringify(sanitizeTaskLogJsonlRecord(record));
}

export function serializeAutocodeTaskLogs(logs: AutocodeTaskLogs): string {
  const sanitized = sanitizeLogs(logs, logs.spec_id);
  const records: AutocodeTaskLogJsonlRecord[] = [
    {
      record_type: 'meta',
      spec_id: sanitized.spec_id,
      created_at: sanitized.created_at,
      updated_at: sanitized.updated_at,
    },
    ...(['planning', 'coding', 'validation'] as AutocodeTaskLogPhase[]).map((phase) => ({
      record_type: 'phase' as const,
      timestamp: sanitized.updated_at,
      phase,
      status: sanitized.phases[phase].status,
      started_at: sanitized.phases[phase].started_at,
      completed_at: sanitized.phases[phase].completed_at,
    })),
    ...(['planning', 'coding', 'validation'] as AutocodeTaskLogPhase[]).flatMap((phase) =>
      sanitized.phases[phase].entries.map((entry) => ({
        record_type: 'entry' as const,
        entry,
      }))
    ),
  ];

  return `${records.map((record) => serializeAutocodeTaskLogRecord(record)).join('\n')}\n`;
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
      const hasExistingRecords = hasTaskLogRecords(logPath);
      const logs = createEmptyAutocodeTaskLogs(input.taskId, now);
      const phaseLog = logs.phases[input.phase] ?? createEmptyPhaseLog(input.phase);
      const records: AutocodeTaskLogJsonlRecord[] = [];

      if (!hasExistingRecords) {
        records.push(createMetaRecord(logs));
      }

      if (phaseLog.status === 'pending') {
        phaseLog.status = 'active';
        phaseLog.started_at = phaseLog.started_at ?? now;
        if (!hasExistingRecords) {
          records.push(createPhaseRecord(phaseLog, now));
        }
      }

      const content = sanitizeLogMessageText(input.content, LOG_TEXT_MAX_CHARS);
      const detail = input.detail ? sanitizeLogMessageText(input.detail, LOG_DETAIL_MAX_CHARS) : undefined;
      if (!(input.type === 'text' && !content.trim() && !detail?.trim())) {
        const entry = sanitizeEntry({
          timestamp: input.timestamp ?? now,
          type: input.type,
          phase: input.phase,
          content,
          ...(detail ? { detail, collapsed: true } : {}),
        }, input.phase);
        if (entry) {
          phaseLog.entries.push(entry);
          records.push({ record_type: 'entry', entry });
        }
      }
      logs.phases[input.phase] = phaseLog;
      logs.updated_at = now;
      appendAutocodeTaskLogRecords(logPath, records);
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
      const hasExistingRecords = hasTaskLogRecords(logPath);
      const logs = createEmptyAutocodeTaskLogs(input.taskId, now);
      const phaseLog = logs.phases[input.phase] ?? createEmptyPhaseLog(input.phase);
      const wasPending = phaseLog.status === 'pending';
      const records: AutocodeTaskLogJsonlRecord[] = [];

      if (!hasExistingRecords) {
        records.push(createMetaRecord(logs));
      }

      phaseLog.status = input.status;
      if ((input.status === 'active' || wasPending) && !phaseLog.started_at) {
        phaseLog.started_at = now;
      }
      if (input.status === 'completed' || input.status === 'failed') {
        phaseLog.completed_at = now;
      }
      records.push(createPhaseRecord(phaseLog, now));

      if (input.message) {
        const entry = sanitizeEntry({
          timestamp: now,
          type: input.status === 'failed' ? 'error' : input.status === 'completed' ? 'success' : 'info',
          phase: input.phase,
          content: sanitizeLogMessageText(input.message, LOG_TEXT_MAX_CHARS),
        }, input.phase);
        if (entry) {
          phaseLog.entries.push(entry);
          records.push({ record_type: 'entry', entry });
        }
      }

      logs.phases[input.phase] = phaseLog;
      logs.updated_at = now;
      appendAutocodeTaskLogRecords(logPath, records);
      return logs;
    },
  );
}

function appendAutocodeTaskLogRecords(logPath: string, records: AutocodeTaskLogJsonlRecord[]): void {
  if (records.length === 0) {
    return;
  }

  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${records.map((record) => serializeAutocodeTaskLogRecord(record)).join('\n')}\n`,
    'utf8',
  );
}

function hasTaskLogRecords(logPath: string): boolean {
  try {
    return existsSync(logPath) && statSync(logPath).size > 0;
  } catch {
    return false;
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

function applyTaskLogJsonlRecord(
  logs: AutocodeTaskLogs,
  record: Record<string, unknown>,
  fallbackSpecId: string,
): void {
  if (record.record_type === 'meta') {
    logs.spec_id = sanitizeText(readString(record.spec_id) ?? fallbackSpecId, 200);
    logs.created_at = readString(record.created_at) ?? logs.created_at;
    logs.updated_at = readString(record.updated_at) ?? logs.updated_at;
    return;
  }

  if (record.record_type === 'phase') {
    const phase = isPhase(record.phase) ? record.phase : null;
    const status = isPhaseStatus(record.status) ? record.status : null;
    if (!phase || !status) {
      return;
    }

    const timestamp = readString(record.timestamp) ?? new Date().toISOString();
    const phaseLog = logs.phases[phase] ?? createEmptyPhaseLog(phase);
    phaseLog.status = status;
    if (record.started_at === null) {
      phaseLog.started_at = null;
    } else {
      phaseLog.started_at = readString(record.started_at) ?? phaseLog.started_at ?? (status === 'active' ? timestamp : null);
    }
    if (record.completed_at === null || status === 'active') {
      phaseLog.completed_at = null;
    } else {
      phaseLog.completed_at = readString(record.completed_at) ?? phaseLog.completed_at ?? (
        status === 'completed' || status === 'failed' ? timestamp : null
      );
    }
    logs.phases[phase] = phaseLog;
    touchLogs(logs, timestamp);
    return;
  }

  if (record.record_type === 'entry' && isPlainRecord(record.entry)) {
    const fallbackPhase = isPhase(record.entry.phase) ? record.entry.phase : 'coding';
    const entry = sanitizeEntry(record.entry, fallbackPhase);
    if (!entry) {
      return;
    }

    const phaseLog = logs.phases[entry.phase] ?? createEmptyPhaseLog(entry.phase);
    if (phaseLog.status === 'pending') {
      phaseLog.status = 'active';
      phaseLog.started_at = phaseLog.started_at ?? entry.timestamp;
    } else if (isTaskLogActiveOutputEntry(entry) && isEntryAfterPhaseCompletion(entry, phaseLog)) {
      phaseLog.status = 'active';
      phaseLog.completed_at = null;
      phaseLog.started_at = phaseLog.started_at ?? entry.timestamp;
    }
    phaseLog.entries.push(entry);
    logs.phases[entry.phase] = phaseLog;
    touchLogs(logs, entry.timestamp);
  }
}

function isTaskLogActiveOutputEntry(entry: AutocodeTaskLogEntry): boolean {
  return entry.type === 'text' ||
    entry.type === 'tool_start' ||
    entry.type === 'tool_end' ||
    entry.type === 'error' ||
    entry.type === 'success';
}

function isEntryAfterPhaseCompletion(
  entry: AutocodeTaskLogEntry,
  phaseLog: AutocodeTaskPhaseLog,
): boolean {
  if (phaseLog.status !== 'completed' && phaseLog.status !== 'failed') {
    return false;
  }
  if (!phaseLog.completed_at) {
    return false;
  }
  return Date.parse(entry.timestamp) > Date.parse(phaseLog.completed_at);
}

function createMetaRecord(logs: AutocodeTaskLogs): AutocodeTaskLogMetaRecord {
  return {
    record_type: 'meta',
    spec_id: logs.spec_id,
    created_at: logs.created_at,
    updated_at: logs.updated_at,
  };
}

function createPhaseRecord(phaseLog: AutocodeTaskPhaseLog, timestamp: string): AutocodeTaskLogPhaseRecord {
  return {
    record_type: 'phase',
    timestamp,
    phase: phaseLog.phase,
    status: phaseLog.status,
    started_at: phaseLog.started_at,
    completed_at: phaseLog.completed_at,
  };
}

function sanitizeTaskLogJsonlRecord(record: AutocodeTaskLogJsonlRecord): AutocodeTaskLogJsonlRecord {
  if (record.record_type === 'meta') {
    const createdAt = typeof record.created_at === 'string' ? record.created_at : new Date().toISOString();
    return {
      record_type: 'meta',
      spec_id: sanitizeText(record.spec_id, 200),
      created_at: createdAt,
      updated_at: typeof record.updated_at === 'string' ? record.updated_at : createdAt,
    };
  }

  if (record.record_type === 'phase') {
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString();
    return {
      record_type: 'phase',
      timestamp,
      phase: isPhase(record.phase) ? record.phase : 'coding',
      status: isPhaseStatus(record.status) ? record.status : 'active',
      started_at: typeof record.started_at === 'string' || record.started_at === null ? record.started_at : null,
      completed_at: typeof record.completed_at === 'string' || record.completed_at === null
        ? record.completed_at
        : null,
    };
  }

  return {
    record_type: 'entry',
    entry: sanitizeEntry(record.entry, isPhase(record.entry?.phase) ? record.entry.phase : 'coding') ?? {
      timestamp: new Date().toISOString(),
      type: 'info',
      phase: 'coding',
      content: '',
    },
  };
}

function touchLogs(logs: AutocodeTaskLogs, timestamp: string): void {
  if (timestamp > logs.updated_at) {
    logs.updated_at = timestamp;
  }
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
      ? value.entries
        .map((entry) => sanitizeEntry(entry, phase))
        .filter((entry): entry is AutocodeTaskLogEntry => entry !== null)
      : [],
  };
}

function sanitizeEntry(value: unknown, fallbackPhase: AutocodeTaskLogPhase): AutocodeTaskLogEntry | null {
  const source = isPlainRecord(value) ? value : {};
  const phase = isPhase(source.phase) ? source.phase : fallbackPhase;
  const type = isEntryType(source.type) ? source.type : 'info';
  const content = sanitizeLogMessageText(source.content, LOG_TEXT_MAX_CHARS);
  const detail = source.detail ? sanitizeLogMessageText(source.detail, LOG_DETAIL_MAX_CHARS) : undefined;
  if (type === 'text' && !content.trim() && !detail?.trim()) {
    return null;
  }

  return {
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : new Date().toISOString(),
    type,
    phase,
    content,
    ...(detail ? { detail } : {}),
    ...(source.tool_name ? { tool_name: sanitizeText(source.tool_name, 200) } : {}),
    ...(source.tool_input ? { tool_input: sanitizeText(source.tool_input, 1000) } : {}),
    ...(source.tool_success !== undefined ? { tool_success: Boolean(source.tool_success) } : {}),
    ...(source.tool_call_id ? { tool_call_id: sanitizeText(source.tool_call_id, 200) } : {}),
    ...(source.subtask_id ? { subtask_id: sanitizeText(source.subtask_id, 200) } : {}),
    ...(typeof source.session === 'number' ? { session: source.session } : {}),
    ...(source.git_commit ? { git_commit: sanitizeText(source.git_commit, 80) } : {}),
    ...(source.git_commit_skipped
      ? { git_commit_skipped: sanitizeText(source.git_commit_skipped, 600) }
      : {}),
    ...(Array.isArray(source.changed_files)
      ? {
          changed_files: Array.from(new Set(source.changed_files
            .filter((filePath): filePath is string => typeof filePath === 'string')
            .map((filePath) => sanitizeText(filePath, 1000))
            .filter(Boolean))).slice(0, 200),
        }
      : {}),
    ...(source.subphase ? { subphase: sanitizeText(source.subphase, 200) } : {}),
    ...(source.collapsed !== undefined ? { collapsed: Boolean(source.collapsed) } : {}),
    ...(isPlainRecord(source.model) ? { model: source.model } : {}),
  };
}

export function salvageAutocodeTaskLogs(content: string, fallbackSpecId: string, error: unknown): AutocodeTaskLogs {
  const now = new Date().toISOString();
  const logs = createEmptyAutocodeTaskLogs(fallbackSpecId, now);
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
  const normalized = normalizeText(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function sanitizeLogMessageText(value: unknown, maxLength: number): string {
  const normalized = stripNoisyAutocodeTaskLogText(normalizeText(value));
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function normalizeText(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : String(value);
  return repairAutocodeChineseMojibakeText(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function stripNoisyAutocodeTaskLogText(content: string): string {
  return String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isNoisyAutocodeTaskLogLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function isNoisyAutocodeTaskLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const message = trimmed.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s+/, '').trim();
  return NOISY_AUTOCODE_TASK_LOG_PATTERNS.some((pattern) => pattern.test(message));
}

function hasAutocodeTaskPhaseContent(phase: AutocodeTaskPhaseLog | undefined): boolean {
  return Boolean(phase) && ((phase?.entries?.length ?? 0) > 0 || phase?.status !== 'pending');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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
