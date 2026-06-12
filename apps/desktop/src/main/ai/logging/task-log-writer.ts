/**
 * Task Log Writer
 * ===============
 *
 * Writes task_logs.jsonl files during TypeScript agent session execution.
 * This replaces the Python backend's TaskLogger/LogStorage system.
 *
 * The writer maps AI SDK stream events to append-only JSONL records that
 * are aggregated into the TaskLogs shape expected by the frontend.
 *
 * Phase mapping (Phase → TaskLogPhase):
 *   spec     → planning
 *   planning → planning
 *   coding   → coding
 *   qa       → validation
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TaskLogs, TaskLogPhase, TaskLogPhaseStatus, TaskLogEntry, TaskLogEntryType } from '../../../shared/types';
import type { StreamEvent } from '../session/types';
import {
  AUTOCODE_TASK_ARTIFACTS,
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  parseAutocodeTaskLogs,
  repairAutocodeChineseMojibakeText,
  serializeAutocodeTaskLogRecord,
  withAutocodeRuntimeFileWriteLockSync,
  type AutocodeTaskLogJsonlRecord,
  type AutocodeRuntimeFileWriteLockScope,
  type Phase,
} from '@autocode/core';

const DEFAULT_LIVE_TEXT_FLUSH_MS = 1000;
const DEFAULT_LIVE_TEXT_MAX_CHARS = 1200;
const TEXT_ENTRY_MAX_CHARS = 4000;
const FIELD_MAX_CHARS = 2000;
const TOOL_DETAIL_MAX_CHARS = 3000;
const TOOL_DETAIL_PREVIEW_CHARS = 1600;
const TOOL_DETAIL_PREVIEW_LINES = 80;

interface TaskLogWriterOptions {
  liveTextFlushMs?: number;
  liveTextMaxChars?: number;
}

// =============================================================================
// Phase Mapping
// =============================================================================

/** Map execution phase to log phase */
function toLogPhase(phase: Phase | undefined): TaskLogPhase {
  switch (phase) {
    case 'spec':
    case 'planning':
      return 'planning';
    case 'coding':
      return 'coding';
    case 'qa':
      return 'validation';
    default:
      return 'coding'; // Fallback for unknown phases
  }
}

function normalizeLogText(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);

  return repairAutocodeChineseMojibakeText(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function sanitizeLogText(value: unknown, maxLength = FIELD_MAX_CHARS): string {
  const normalized = normalizeLogText(value);
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function takeToolPreview(text: string): string {
  const lines = text.split('\n');
  const byLines = lines.slice(0, TOOL_DETAIL_PREVIEW_LINES).join('\n');
  return byLines.length > TOOL_DETAIL_PREVIEW_CHARS
    ? `${byLines.slice(0, TOOL_DETAIL_PREVIEW_CHARS)}\n... [preview truncated]`
    : byLines;
}

function summarizeToolResult(toolName: string, isError: boolean, result: unknown): string | undefined {
  if (result === null || result === undefined) {
    return undefined;
  }

  const raw = normalizeLogText(stringifyToolResult(result));
  if (!raw.trim()) {
    return undefined;
  }

  const lines = raw.split('\n');
  const shouldCompact = raw.length > TOOL_DETAIL_PREVIEW_CHARS || lines.length > TOOL_DETAIL_PREVIEW_LINES;
  if (!shouldCompact) {
    return raw;
  }

  const status = isError ? 'error' : 'success';
  const preview = takeToolPreview(raw);
  return sanitizeLogText([
    '[Tool result summary]',
    `Tool: ${toolName}`,
    `Status: ${status}`,
    `Size: ${lines.length} lines / ${raw.length} chars / ${Buffer.byteLength(raw, 'utf-8')} bytes`,
    '',
    'Preview:',
    preview,
    '',
    `Output compacted in ${AUTOCODE_TASK_ARTIFACTS.taskLogs}. Re-run the tool with a narrower range or pattern when exact output is needed.`,
  ].join('\n'), TOOL_DETAIL_MAX_CHARS);
}

function sanitizeEntry(entry: Partial<TaskLogEntry>, fallbackPhase: TaskLogPhase): TaskLogEntry {
  const phase = entry.phase ?? fallbackPhase;
  return {
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
    type: entry.type ?? 'info',
    content: sanitizeLogText(entry.content),
    phase,
    ...(entry.subtask_id ? { subtask_id: sanitizeLogText(entry.subtask_id, 200) } : {}),
    ...(entry.tool_name ? { tool_name: sanitizeLogText(entry.tool_name, 200) } : {}),
    ...(entry.tool_input ? { tool_input: sanitizeLogText(entry.tool_input) } : {}),
    ...(entry.tool_call_id ? { tool_call_id: sanitizeLogText(entry.tool_call_id, 200) } : {}),
    ...(entry.detail ? { detail: sanitizeLogText(entry.detail, TOOL_DETAIL_MAX_CHARS) } : {}),
    ...(entry.collapsed !== undefined ? { collapsed: Boolean(entry.collapsed) } : {}),
  };
}

function sanitizeLogs(logs: TaskLogs): TaskLogs {
  const phases: TaskLogs['phases'] = {
    planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
    coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
    validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
  };

  for (const phase of Object.keys(phases) as TaskLogPhase[]) {
    const source = logs.phases?.[phase];
    if (!source) {
      continue;
    }
    phases[phase] = {
      phase,
      status: source.status ?? 'pending',
      started_at: source.started_at ?? null,
      completed_at: source.completed_at ?? null,
      entries: Array.isArray(source.entries)
        ? source.entries.map((entry) => sanitizeEntry(entry, phase))
        : [],
    };
  }

  return {
    spec_id: sanitizeLogText(logs.spec_id, 200),
    created_at: typeof logs.created_at === 'string' ? logs.created_at : new Date().toISOString(),
    updated_at: typeof logs.updated_at === 'string' ? logs.updated_at : new Date().toISOString(),
    phases,
  };
}

// =============================================================================
// TaskLogWriter
// =============================================================================

/**
 * Writes task_logs.jsonl to the spec directory during agent execution.
 *
 * Usage:
 * ```ts
 * const writer = new TaskLogWriter(specDir, specId);
 * writer.startPhase('planning');
 * writer.processEvent(streamEvent); // called for each stream event
 * writer.endPhase('planning', true);
 * ```
 */
export class TaskLogWriter {
  private readonly logFile: string;
  private readonly fileWriteLockScope: AutocodeRuntimeFileWriteLockScope;
  private readonly liveTextFlushMs: number;
  private readonly liveTextMaxChars: number;
  private data: TaskLogs;
  private pendingRecords: AutocodeTaskLogJsonlRecord[] = [];
  private currentPhase: TaskLogPhase = 'planning';
  private currentSubtask: string | undefined;
  private pendingText = '';
  private pendingTextPhase: TaskLogPhase | undefined;
  private pendingTextSubtask: string | undefined;
  private pendingTextFlushTimer: NodeJS.Timeout | undefined;

  constructor(specDir: string, specId: string, options: TaskLogWriterOptions = {}) {
    this.logFile = join(specDir, AUTOCODE_TASK_ARTIFACTS.taskLogs);
    this.fileWriteLockScope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(specDir);
    this.liveTextFlushMs = options.liveTextFlushMs ?? DEFAULT_LIVE_TEXT_FLUSH_MS;
    this.liveTextMaxChars = options.liveTextMaxChars ?? DEFAULT_LIVE_TEXT_MAX_CHARS;
    this.data = this.loadOrCreate(specDir, specId);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Mark a phase as started. Flushes any pending text from the previous phase.
   */
  startPhase(phase: Phase, message?: string): void {
    this.flushPendingText();
    const logPhase = toLogPhase(phase);
    this.currentPhase = logPhase;

    // Auto-close any other active phases (handles resume/restart scenarios)
    for (const [key, phaseData] of Object.entries(this.data.phases)) {
      if (key !== logPhase && phaseData.status === 'active') {
        this.data.phases[key as TaskLogPhase].status = 'completed';
        this.data.phases[key as TaskLogPhase].completed_at = this.timestamp();
        this.pendingRecords.push(this.createPhaseRecord(this.data.phases[key as TaskLogPhase]));
      }
    }

    this.data.phases[logPhase].status = 'active';
    this.data.phases[logPhase].started_at = this.timestamp();
    this.data.phases[logPhase].completed_at = null;
    this.pendingRecords.push(this.createPhaseRecord(this.data.phases[logPhase]));

    const content = message ?? `Starting ${logPhase} phase`;
    this.addEntry(logPhase, 'phase_start', content);
    this.save();
  }

  /**
   * Mark a phase as completed or failed.
   */
  endPhase(phase: Phase, success: boolean, message?: string): void {
    this.flushPendingText();
    const logPhase = toLogPhase(phase);
    const status: TaskLogPhaseStatus = success ? 'completed' : 'failed';
    this.data.phases[logPhase].status = status;
    this.data.phases[logPhase].completed_at = this.timestamp();
    this.pendingRecords.push(this.createPhaseRecord(this.data.phases[logPhase]));

    const content = message ?? `${success ? 'Completed' : 'Failed'} ${logPhase} phase`;
    this.addEntry(logPhase, 'phase_end', content);
    this.save();
  }

  /**
   * Set the current subtask ID for subsequent log entries.
   */
  setSubtask(subtaskId: string | undefined): void {
    if (this.pendingText && this.currentSubtask !== subtaskId) {
      this.flushPendingText();
    }
    this.currentSubtask = subtaskId;
  }

  /**
   * Process a stream event from the AI SDK session.
   * Routes to the appropriate log entry writer.
   */
  processEvent(event: StreamEvent, phase?: Phase): void {
    const logPhase = phase ? toLogPhase(phase) : this.currentPhase;

    switch (event.type) {
      case 'text-delta':
        this.accumulateText(event.text, logPhase);
        break;

      case 'tool-call':
        // Flush pending text before the tool call entry
        this.flushPendingText();
        this.writeToolStart(logPhase, event.toolName, this.extractToolInput(event.toolName, event.args), event.toolCallId);
        break;

      case 'tool-result':
        this.writeToolEnd(logPhase, event.toolName, event.isError, event.result, event.toolCallId);
        break;

      case 'step-finish':
        // Flush accumulated text on step finish
        this.flushPendingText();
        break;

      case 'error':
        this.flushPendingText();
        this.addEntry(logPhase, 'error', event.error.message);
        this.save();
        break;

      default:
        // Ignore thinking-delta, usage-update
        break;
    }
  }

  /**
   * Write a plain text log message to the current phase.
   */
  logText(content: string, phase?: Phase, entryType: TaskLogEntryType = 'text'): void {
    this.flushPendingText();
    const logPhase = phase ? toLogPhase(phase) : this.currentPhase;
    const phaseData = this.data.phases[logPhase];
    if (phaseData?.status === 'pending') {
      phaseData.status = 'active';
      phaseData.started_at = phaseData.started_at ?? this.timestamp();
      phaseData.completed_at = null;
      this.pendingRecords.push(this.createPhaseRecord(phaseData));
    }
    this.addEntry(logPhase, entryType, content);
    this.save();
  }

  /**
   * Flush any accumulated text and save.
   */
  flush(): void {
    this.flushPendingText();
    this.save();
  }

  /**
   * Get the current log data.
   */
  getData(): TaskLogs {
    return this.data;
  }

  // ===========================================================================
  // Private: Core Writing
  // ===========================================================================

  private addEntry(
    phase: TaskLogPhase,
    type: TaskLogEntryType,
    content: string,
    extra?: Partial<TaskLogEntry>,
    subtaskId = this.currentSubtask
  ): void {
    const entry: TaskLogEntry = {
      timestamp: this.timestamp(),
      type,
      content: sanitizeLogText(content), // Reasonable cap to prevent huge entries
      phase,
      ...(subtaskId ? { subtask_id: subtaskId } : {}),
      ...extra,
    };

    // Ensure phase exists and is initialized
    if (!this.data.phases[phase]) {
      this.data.phases[phase] = {
        phase,
        status: 'pending',
        started_at: null,
        completed_at: null,
        entries: [],
      };
    }

    const sanitizedEntry = sanitizeEntry(entry, phase);
    this.data.phases[phase].entries.push(sanitizedEntry);
    this.pendingRecords.push({ record_type: 'entry', entry: sanitizedEntry });
  }

  private writeToolStart(phase: TaskLogPhase, toolName: string, toolInput?: string, toolCallId?: string): void {
    const content = `[${toolName}] ${toolInput || ''}`.trim();
    this.addEntry(phase, 'tool_start', content, {
      tool_name: toolName,
      tool_input: toolInput,
      tool_call_id: toolCallId,
    });
    this.save();
  }

  private writeToolEnd(
    phase: TaskLogPhase,
    toolName: string,
    isError: boolean,
    result: unknown,
    toolCallId?: string
  ): void {
    const status = isError ? 'Error' : 'Done';
    const content = `[${toolName}] ${status}`;

    const detail = summarizeToolResult(toolName, isError, result);

    this.addEntry(phase, 'tool_end', content, {
      tool_name: toolName,
      tool_call_id: toolCallId,
      ...(detail ? { detail, collapsed: true } : {}),
    });
    this.save();
  }

  // ===========================================================================
  // Private: Text Accumulation
  // ===========================================================================

  /**
   * Accumulate text deltas instead of writing one entry per delta.
   * Flushes happen on step-finish, tool-call, or phase changes.
   */
  private accumulateText(text: string, phase: TaskLogPhase): void {
    if (this.pendingTextPhase && this.pendingTextPhase !== phase) {
      // Phase changed mid-accumulation — flush what we have
      this.flushPendingText();
    }
    if (!this.pendingText) {
      this.pendingTextPhase = phase;
      this.pendingTextSubtask = this.currentSubtask;
    }

    this.pendingText += text;

    if (this.pendingText.length >= this.liveTextMaxChars) {
      this.flushPendingText();
      return;
    }

    this.schedulePendingTextFlush();
  }

  private flushPendingText(): void {
    this.clearPendingTextFlushTimer();

    if (!this.pendingText.trim()) {
      this.pendingText = '';
      this.pendingTextPhase = undefined;
      this.pendingTextSubtask = undefined;
      return;
    }

    const phase = this.pendingTextPhase ?? this.currentPhase;
    const content = this.pendingText.trim();
    const subtaskId = this.pendingTextSubtask;

    // Write as a text entry
    this.addEntry(phase, 'text', sanitizeLogText(content, TEXT_ENTRY_MAX_CHARS), undefined, subtaskId);
    this.save();

    this.pendingText = '';
    this.pendingTextPhase = undefined;
    this.pendingTextSubtask = undefined;
  }

  private schedulePendingTextFlush(): void {
    if (this.pendingTextFlushTimer || this.liveTextFlushMs <= 0) {
      return;
    }

    this.pendingTextFlushTimer = setTimeout(() => {
      this.pendingTextFlushTimer = undefined;
      this.flushPendingText();
    }, this.liveTextFlushMs);

    this.pendingTextFlushTimer.unref?.();
  }

  private clearPendingTextFlushTimer(): void {
    if (!this.pendingTextFlushTimer) {
      return;
    }

    clearTimeout(this.pendingTextFlushTimer);
    this.pendingTextFlushTimer = undefined;
  }

  // ===========================================================================
  // Private: Tool Input Extraction
  // ===========================================================================

  /**
   * Extract a brief display string from tool arguments.
   * Shows the primary input (file path, command, pattern, etc.)
   */
  private extractToolInput(toolName: string, args: Record<string, unknown>): string | undefined {
    const truncate = (s: string, max = 200): string =>
      s.length > max ? `${s.slice(0, max - 3)}...` : s;

    switch (toolName) {
      case 'Read':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Write':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Edit':
        return typeof args.file_path === 'string' ? truncate(args.file_path) : undefined;
      case 'Bash':
        return typeof args.command === 'string' ? truncate(args.command) : undefined;
      case 'Glob':
        return typeof args.pattern === 'string' ? truncate(args.pattern) : undefined;
      case 'Grep':
        return typeof args.pattern === 'string' ? truncate(args.pattern) : undefined;
      case 'WebFetch':
        return typeof args.url === 'string' ? truncate(args.url) : undefined;
      case 'WebSearch':
        return typeof args.query === 'string' ? truncate(args.query) : undefined;
      default: {
        // Generic: try common field names
        const value = args.file_path ?? args.path ?? args.command ?? args.query ?? args.pattern;
        return typeof value === 'string' ? truncate(value) : undefined;
      }
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private loadOrCreate(_specDir: string, specId: string): TaskLogs {
    if (existsSync(this.logFile)) {
      try {
        const content = readFileSync(this.logFile, 'utf-8');
        if (content.trim()) {
          return sanitizeLogs(parseAutocodeTaskLogs(content, specId) as TaskLogs);
        }
      } catch {
        // Corrupted file — start fresh
      }
    }

    const now = this.timestamp();
    return {
      spec_id: specId,
      created_at: now,
      updated_at: now,
      phases: {
        planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
        coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
        validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
      },
    };
  }

  private save(): void {
    this.data.updated_at = this.timestamp();
    try {
      withAutocodeRuntimeFileWriteLockSync(
        {
          ...this.fileWriteLockScope,
          filePath: this.logFile,
          ownerId: `desktop:task-log-writer:${this.data.spec_id}`,
        },
        () => {
          // Ensure directory exists
          const dir = dirname(this.logFile);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          const records = [
            ...(this.hasExistingLogRecords() ? [] : [this.createMetaRecord()]),
            ...this.pendingRecords,
          ];
          if (records.length === 0) {
            return;
          }

          appendFileSync(
            this.logFile,
            `${records.map((record) => serializeAutocodeTaskLogRecord(record)).join('\n')}\n`,
            'utf-8',
          );
          this.pendingRecords = [];
        },
      );
    } catch {
      // Non-fatal: log write failures don't break execution
      // (The UI will just show an empty log section)
    }
  }

  private createMetaRecord(): AutocodeTaskLogJsonlRecord {
    return {
      record_type: 'meta',
      spec_id: this.data.spec_id,
      created_at: this.data.created_at,
      updated_at: this.data.updated_at,
    };
  }

  private createPhaseRecord(phaseData: TaskLogs['phases'][TaskLogPhase]): AutocodeTaskLogJsonlRecord {
    return {
      record_type: 'phase',
      timestamp: this.timestamp(),
      phase: phaseData.phase,
      status: phaseData.status,
      started_at: phaseData.started_at,
      completed_at: phaseData.completed_at,
    };
  }

  private hasExistingLogRecords(): boolean {
    try {
      return existsSync(this.logFile) && statSync(this.logFile).size > 0;
    } catch {
      return false;
    }
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
