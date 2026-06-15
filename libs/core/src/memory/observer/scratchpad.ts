/**
 * Scratchpad
 *
 * In-memory accumulator for a single agent session.
 * Holds all behavioral signals, analytics, and acute candidates.
 *
 * RULES:
 * - Never writes to the database during execution
 * - All analytics updates are O(1)
 * - Checkpoint to disk at subtask boundaries for crash recovery
 */

import { createHash } from 'node:crypto';
import { foldRepeatedAutocodePromptLines } from '../../runtime/prompt-context.js';
import type { AcuteCandidate, SessionType, SignalType, WorkUnitRef } from '../types.js';
import type { ObserverSignal } from './signals.js';

export interface ScratchpadCheckpointClient {
  execute(request: {
    sql: string;
    args?: unknown[];
  }): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// ============================================================
// ANALYTICS INTERFACE
// ============================================================

export interface ScratchpadAnalytics {
  fileAccessCounts: Map<string, number>;
  fileFirstAccess: Map<string, number>;  // step number of first access
  fileLastAccess: Map<string, number>;   // step number of last access
  fileEditSet: Set<string>;
  grepPatternCounts: Map<string, number>;
  grepPatternResults: Map<string, boolean[]>; // pattern → [result1_empty, ...]
  errorFingerprints: Map<string, number>;     // fingerprint → occurrence count
  errorFingerprintSamples: Map<string, string>;
  currentStep: number;
  recentToolSequence: string[];               // circular buffer, last 8 tool calls
  intraSessionCoAccess: Map<string, Set<string>>; // fileA → Set<fileB> co-accessed
  configFilesTouched: Set<string>;
  selfCorrectionCount: number;
  lastSelfCorrectionStep: number;
  totalInputTokens: number;
  peakContextTokens: number;
}

// ============================================================
// CONFIG FILE DETECTION
// ============================================================

const CONFIG_FILE_PATTERNS = [
  'package.json',
  'tsconfig',
  'vite.config',
  '.env',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'webpack.config',
  'babel.config',
  'jest.config',
  'vitest.config',
  'biome.json',
  '.eslintrc',
  '.prettierrc',
  'tailwind.config',
];

const SCRATCHPAD_ERROR_TRACKED_TOOLS = new Set(['Bash', 'Edit', 'Write']);
const SCRATCHPAD_ERROR_SIGNAL_PATTERN = /\b(error|failed|failure|exception|traceback)\b/i;
const SCRATCHPAD_ERROR_TEXT_MAX_CHARS = 4_000;
const SCRATCHPAD_ERROR_TEXT_SAMPLE_CHARS = 1_800;
const SCRATCHPAD_ERROR_OBJECT_KEY_LIMIT = 10;
const SCRATCHPAD_ERROR_UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SCRATCHPAD_ERROR_TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const SCRATCHPAD_ERROR_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\\\\)[^\s'"<>|),;]+/g;
const SCRATCHPAD_ERROR_POSIX_ABSOLUTE_PATH_PATTERN =
  /(^|[\s("'=])\/(?:[^\s:'"<>|),;]+\/)+[^\s:'"<>|),;]+(?::\d+(?::\d+)?)?/g;
const SCRATCHPAD_ERROR_RELATIVE_PATH_PATTERN = /\.[./][^\s:'"]+/g;
const SCRATCHPAD_ERROR_PATH_LINE_COLUMN_PATTERN =
  /((?:\.{1,2}[\\/]|[\w.-]+[\\/])[\w./\\@+-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/g;
const SCRATCHPAD_ERROR_OBJECT_KEYS = [
  'diagnostic_text',
  'error',
  'message',
  'reason',
  'status',
  'exit_code',
  'code',
  'stderr',
  'stdout',
  'output',
  'summary',
];
const SCRATCHPAD_OBJECT_KEY_ALIASES = new Map<string, string>([
  ['diagnostictext', 'diagnostic_text'],
  ['exitcode', 'exit_code'],
  ['file_path', 'file_path'],
  ['filepath', 'file_path'],
  ['std_out', 'stdout'],
  ['standard_output', 'stdout'],
  ['std_err', 'stderr'],
  ['standard_error', 'stderr'],
]);

/**
 * Returns true if the file path is a recognized config file.
 */
export function isConfigFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return CONFIG_FILE_PATTERNS.some((p) => lower.includes(p));
}

// ============================================================
// ERROR FINGERPRINTING
// ============================================================

/**
 * Produce a stable fingerprint for an error message by normalizing out
 * file paths, line numbers, and timestamps, then hashing.
 */
export function computeErrorFingerprint(errorMessage: string): string {
  const normalized = compactScratchpadErrorFingerprintInput(errorMessage)
    // Strip timestamps before generic :line matching can alter them.
    .replace(SCRATCHPAD_ERROR_TIMESTAMP_PATTERN, '<ts>')
    // Strip Windows absolute paths
    .replace(SCRATCHPAD_ERROR_WINDOWS_ABSOLUTE_PATH_PATTERN, '<path>')
    // Strip absolute file paths
    .replace(SCRATCHPAD_ERROR_POSIX_ABSOLUTE_PATH_PATTERN, '$1<path>')
    // Strip relative paths
    .replace(SCRATCHPAD_ERROR_RELATIVE_PATH_PATTERN, '<path>')
    // Strip line/column numbers like :42 or :42:7
    .replace(/:\d+(:\d+)?/g, '')
    // Strip UUIDs
    .replace(SCRATCHPAD_ERROR_UUID_PATTERN, '<uuid>')
    .trim()
    .toLowerCase();

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ============================================================
// SCRATCHPAD CLASS
// ============================================================

function makeEmptyAnalytics(): ScratchpadAnalytics {
  return {
    fileAccessCounts: new Map(),
    fileFirstAccess: new Map(),
    fileLastAccess: new Map(),
    fileEditSet: new Set(),
    grepPatternCounts: new Map(),
    grepPatternResults: new Map(),
    errorFingerprints: new Map(),
    errorFingerprintSamples: new Map(),
    currentStep: 0,
    recentToolSequence: [],
    intraSessionCoAccess: new Map(),
    configFilesTouched: new Set(),
    selfCorrectionCount: 0,
    lastSelfCorrectionStep: -1,
    totalInputTokens: 0,
    peakContextTokens: 0,
  };
}

export class Scratchpad {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly startedAt: number;

  signals: Map<SignalType, ObserverSignal[]>;
  analytics: ScratchpadAnalytics;
  acuteCandidates: AcuteCandidate[];

  constructor(sessionId: string, sessionType: SessionType) {
    this.sessionId = sessionId;
    this.sessionType = sessionType;
    this.startedAt = Date.now();
    this.signals = new Map();
    this.analytics = makeEmptyAnalytics();
    this.acuteCandidates = [];
  }

  /**
   * Record a tool call into analytics. O(1).
   */
  recordToolCall(toolName: string, args: Record<string, unknown>, stepNumber: number): void {
    this.analytics.currentStep = stepNumber;

    // Track file accesses from Read/Edit/Write/Glob
    const filePath = this.extractFilePath(toolName, args);
    if (filePath) {
      const count = (this.analytics.fileAccessCounts.get(filePath) ?? 0) + 1;
      this.analytics.fileAccessCounts.set(filePath, count);

      if (!this.analytics.fileFirstAccess.has(filePath)) {
        this.analytics.fileFirstAccess.set(filePath, stepNumber);
      }
      this.analytics.fileLastAccess.set(filePath, stepNumber);

      if (isConfigFile(filePath)) {
        this.analytics.configFilesTouched.add(filePath);
      }

      // Track co-access: record this file was accessed in this step window
      for (const [otherFile] of this.analytics.fileAccessCounts) {
        if (
          otherFile !== filePath &&
          (this.analytics.fileLastAccess.get(otherFile) ?? 0) >= stepNumber - 5
        ) {
          // Within 5-step window → co-access
          if (!this.analytics.intraSessionCoAccess.has(filePath)) {
            this.analytics.intraSessionCoAccess.set(filePath, new Set());
          }
          this.analytics.intraSessionCoAccess.get(filePath)?.add(otherFile);
        }
      }
    }

    // Track grep patterns
    const pattern = getScratchpadRecordString(args, 'pattern');
    if (toolName === 'Grep' && pattern) {
      const count = (this.analytics.grepPatternCounts.get(pattern) ?? 0) + 1;
      this.analytics.grepPatternCounts.set(pattern, count);
    }

    // Maintain circular buffer of last 8 tool calls
    this.analytics.recentToolSequence.push(toolName);
    if (this.analytics.recentToolSequence.length > 8) {
      this.analytics.recentToolSequence.shift();
    }
  }

  /**
   * Record a tool result. O(1).
   */
  recordToolResult(toolName: string, result: unknown, stepNumber: number): void {
    this.analytics.currentStep = stepNumber;

    // Track edits
    if (toolName === 'Edit' || toolName === 'Write') {
      // Extract file path from most recent corresponding tool call
      // (We'll rely on the observer to pass this in via recordToolCall)
    }

    // Track errors from Bash/other tool failures
    if (SCRATCHPAD_ERROR_TRACKED_TOOLS.has(toolName)) {
      const errorText = summarizeScratchpadToolResultErrorText(result);
      if (!errorText) {
        return;
      }
      const fingerprint = computeErrorFingerprint(errorText);
      const count = (this.analytics.errorFingerprints.get(fingerprint) ?? 0) + 1;
      this.analytics.errorFingerprints.set(fingerprint, count);
      if (!this.analytics.errorFingerprintSamples.has(fingerprint)) {
        this.analytics.errorFingerprintSamples.set(
          fingerprint,
          sanitizeScratchpadErrorSample(compactScratchpadErrorFingerprintInput(errorText)),
        );
      }
    }

    // Track grep result empty/non-empty for pattern reliability
    if (toolName === 'Grep' || toolName === 'Glob') {
      // Can't get the pattern here without matching the call, tracked in recordToolCall
    }
  }

  /**
   * Record edit of a file (called from Edit/Write tool calls).
   */
  recordFileEdit(filePath: string): void {
    const normalizedFilePath = normalizeScratchpadFilePath(filePath);
    if (!normalizedFilePath) {
      return;
    }

    this.analytics.fileEditSet.add(normalizedFilePath);
    if (isConfigFile(normalizedFilePath)) {
      this.analytics.configFilesTouched.add(normalizedFilePath);
    }
  }

  /**
   * Record a self-correction event.
   */
  recordSelfCorrection(stepNumber: number): void {
    this.analytics.selfCorrectionCount++;
    this.analytics.lastSelfCorrectionStep = stepNumber;
  }

  /**
   * Update token counts.
   */
  recordTokenUsage(inputTokens: number): void {
    this.analytics.totalInputTokens += inputTokens;
    if (inputTokens > this.analytics.peakContextTokens) {
      this.analytics.peakContextTokens = inputTokens;
    }
  }

  /**
   * Add a signal to the signals map.
   */
  addSignal(signal: ObserverSignal): void {
    const existing = this.signals.get(signal.type) ?? [];
    existing.push(signal);
    this.signals.set(signal.type, existing);
  }

  /**
   * Get all acute candidates captured since the given step number.
   */
  getNewSince(stepNumber: number): AcuteCandidate[] {
    return this.acuteCandidates.filter((c) => c.stepNumber >= stepNumber);
  }

  /**
   * Checkpoint to DB for crash recovery at subtask boundaries.
   */
  async checkpoint(workUnitRef: WorkUnitRef, dbClient: ScratchpadCheckpointClient): Promise<void> {
    const payload = JSON.stringify({
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      startedAt: this.startedAt,
      workUnitRef,
      analytics: this.serializeAnalytics(),
      acuteCandidatesCount: this.acuteCandidates.length,
      signalCounts: Object.fromEntries(
        [...this.signals.entries()].map(([k, v]) => [k, v.length]),
      ),
    });

    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO observer_synthesis_log
              (module, project_id, trigger_count, synthesized_at, memories_generated)
              VALUES (?, ?, ?, ?, ?)`,
      args: [
        `scratchpad:${this.sessionId}`,
        workUnitRef.methodology,
        this.analytics.currentStep,
        Date.now(),
        0,
      ],
    });

    // Store checkpoint JSON in a dedicated table if it exists, else no-op
    try {
      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO observer_scratchpad_checkpoints
                (session_id, payload, updated_at)
                VALUES (?, ?, ?)`,
        args: [this.sessionId, payload, Date.now()],
      });
    } catch {
      // Table may not exist yet — checkpoint is best-effort
    }
  }

  /**
   * Restore a scratchpad from a DB checkpoint.
   */
  static async restore(sessionId: string, dbClient: ScratchpadCheckpointClient): Promise<Scratchpad | null> {
    try {
      const result = await dbClient.execute({
        sql: `SELECT payload FROM observer_scratchpad_checkpoints WHERE session_id = ?`,
        args: [sessionId],
      });

      if (result.rows.length === 0) return null;

      const raw = JSON.parse(result.rows[0].payload as string) as {
        sessionType: SessionType;
        startedAt: number;
      };

      const scratchpad = new Scratchpad(sessionId, raw.sessionType);
      // Restore minimal analytics from checkpoint (signals are not fully restored)
      return scratchpad;
    } catch {
      return null;
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private extractFilePath(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    const filePath = (() => {
      switch (toolName) {
        case 'Read':
        case 'Edit':
        case 'Write':
          return getScratchpadRecordString(args, 'file_path') ??
            getScratchpadRecordString(args, 'path') ??
            null;
        case 'Glob':
          return null; // Glob returns multiple files.
        case 'Grep':
          return getScratchpadRecordString(args, 'path') ?? null;
        default:
          return null;
      }
    })();

    return filePath ? normalizeScratchpadFilePath(filePath) : null;
  }

  private serializeAnalytics(): Record<string, unknown> {
    return {
      fileAccessCounts: Object.fromEntries(this.analytics.fileAccessCounts),
      fileEditSetSize: this.analytics.fileEditSet.size,
      grepPatternCounts: Object.fromEntries(this.analytics.grepPatternCounts),
      errorFingerprintCount: this.analytics.errorFingerprints.size,
      currentStep: this.analytics.currentStep,
      configFilesTouchedCount: this.analytics.configFilesTouched.size,
      selfCorrectionCount: this.analytics.selfCorrectionCount,
      totalInputTokens: this.analytics.totalInputTokens,
      peakContextTokens: this.analytics.peakContextTokens,
    };
  }
}

function normalizeScratchpadFilePath(filePath: string): string | null {
  const normalized = filePath
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : null;
}

function summarizeScratchpadToolResultErrorText(result: unknown): string | undefined {
  const text = compactScratchpadToolResultText(result);
  if (!text) {
    return undefined;
  }
  return SCRATCHPAD_ERROR_SIGNAL_PATTERN.test(text) || hasScratchpadFailureStatus(result)
    ? text
    : undefined;
}

function compactScratchpadToolResultText(result: unknown): string {
  if (typeof result === 'string') {
    return compactScratchpadTextSample(result, SCRATCHPAD_ERROR_TEXT_MAX_CHARS);
  }
  if (typeof result === 'number' || typeof result === 'boolean' || result === null) {
    return String(result);
  }
  if (Array.isArray(result)) {
    return result
      .slice(0, SCRATCHPAD_ERROR_OBJECT_KEY_LIMIT)
      .map((item) => compactScratchpadToolResultText(item))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof result !== 'object') {
    return '';
  }

  const record = result as Record<string, unknown>;
  const entries = SCRATCHPAD_ERROR_OBJECT_KEYS
    .map((key) => [key, getScratchpadRecordValue(record, key)] as const)
    .filter(([, value]) => value !== undefined)
    .slice(0, SCRATCHPAD_ERROR_OBJECT_KEY_LIMIT)
    .map(([key, value]) => `${key}: ${compactScratchpadToolResultText(value)}`)
    .filter((part) => part.length > 0);
  if (entries.length > 0) {
    return compactScratchpadTextSample(entries.join(' '), SCRATCHPAD_ERROR_TEXT_MAX_CHARS);
  }

  return Object.entries(record)
    .slice(0, SCRATCHPAD_ERROR_OBJECT_KEY_LIMIT)
    .map(([key, value]) => `${key}: ${compactScratchpadToolResultText(value)}`)
    .filter((part) => part.length > 0)
    .join(' ');
}

function compactScratchpadTextSample(text: string, maxChars: number): string {
  const folded = foldRepeatedAutocodePromptLines(text);
  if (folded.length <= maxChars) {
    return normalizeScratchpadInlineText(folded);
  }

  const marker = ' ... [middle omitted] ... ';
  const head = normalizeScratchpadInlineText(folded.slice(0, SCRATCHPAD_ERROR_TEXT_SAMPLE_CHARS));
  const tail = normalizeScratchpadInlineText(folded.slice(-SCRATCHPAD_ERROR_TEXT_SAMPLE_CHARS));
  return `${head}${marker}${tail}`.slice(0, maxChars).trim();
}

function compactScratchpadErrorFingerprintInput(text: string): string {
  const sampled = compactScratchpadTextSample(text, SCRATCHPAD_ERROR_TEXT_MAX_CHARS);
  const signalIndex = sampled.search(SCRATCHPAD_ERROR_SIGNAL_PATTERN);
  if (signalIndex < 0) {
    return sampled;
  }

  const windowStart = Math.max(0, signalIndex - 160);
  const windowEnd = Math.min(sampled.length, signalIndex + 2_000);
  return sampled.slice(windowStart, windowEnd).trim();
}

function sanitizeScratchpadErrorSample(text: string): string {
  return normalizeScratchpadInlineText(text)
    .replace(SCRATCHPAD_ERROR_TIMESTAMP_PATTERN, '<ts>')
    .replace(SCRATCHPAD_ERROR_WINDOWS_ABSOLUTE_PATH_PATTERN, '<path>')
    .replace(SCRATCHPAD_ERROR_POSIX_ABSOLUTE_PATH_PATTERN, '$1<path>')
    .replace(SCRATCHPAD_ERROR_PATH_LINE_COLUMN_PATTERN, '$1')
    .replace(SCRATCHPAD_ERROR_UUID_PATTERN, '<uuid>')
    .trim();
}

function normalizeScratchpadInlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hasScratchpadFailureStatus(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }

  const record = result as Record<string, unknown>;
  const exitCode = getScratchpadRecordValue(record, 'exit_code') ?? getScratchpadRecordValue(record, 'code');
  if (typeof exitCode === 'number') {
    return exitCode !== 0;
  }
  if (typeof exitCode === 'string') {
    const parsed = Number(exitCode);
    return Number.isFinite(parsed) && parsed !== 0;
  }
  const ok = getScratchpadRecordValue(record, 'ok');
  if (typeof ok === 'boolean') {
    return !ok;
  }
  const status = getScratchpadRecordValue(record, 'status');
  if (typeof status === 'string') {
    return /fail|error|exception/i.test(status);
  }
  return false;
}

function getScratchpadRecordString(
  record: Record<string, unknown>,
  canonicalKey: string,
): string | undefined {
  const value = getScratchpadRecordValue(record, canonicalKey);
  return typeof value === 'string' ? value : undefined;
}

function getScratchpadRecordValue(
  record: Record<string, unknown>,
  canonicalKey: string,
): unknown {
  for (const [key, value] of Object.entries(record)) {
    if (canonicalizeScratchpadRecordKey(key) === canonicalKey) {
      return value;
    }
  }
  return undefined;
}

function canonicalizeScratchpadRecordKey(key: string): string {
  const canonicalKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  return SCRATCHPAD_OBJECT_KEY_ALIASES.get(canonicalKey) ?? canonicalKey;
}
