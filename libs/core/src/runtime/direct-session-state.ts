import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUTOCODE_DIRECT_SESSION_STATE_FILE = 'direct_session.json';
export const AUTOCODE_DIRECT_SESSION_STATE_VERSION = 1;
export const AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS = 1_200;
export const AUTOCODE_DIRECT_SESSION_ORIGINAL_REQUEST_MAX_CHARS = 4_000;
const LATEST_SUMMARY_TRUNCATION_MARKER =
  '\n...[direct session summary middle omitted for continuation budget; inspect runtime logs if exact omitted detail is required]...\n';
const ORIGINAL_REQUEST_TRUNCATION_MARKER =
  '\n...[original request middle omitted for state budget; inspect task metadata if exact omitted detail is required]...\n';

export interface AutocodeDirectSessionState {
  version: typeof AUTOCODE_DIRECT_SESSION_STATE_VERSION;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  iteration: number;
  provider?: string;
  modelId?: string;
  providerResponseId?: string;
  originalRequest?: string;
  latestSummary?: string;
  changedFiles?: string[];
  lastOutcome?: string;
}

export function getAutocodeDirectSessionStatePath(specDir: string): string {
  return join(specDir, AUTOCODE_DIRECT_SESSION_STATE_FILE);
}

export function loadAutocodeDirectSessionState(specDir: string): AutocodeDirectSessionState | null {
  const filePath = getAutocodeDirectSessionStatePath(specDir);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return normalizeAutocodeDirectSessionState(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function saveAutocodeDirectSessionState(
  specDir: string,
  state: AutocodeDirectSessionState,
): void {
  const filePath = getAutocodeDirectSessionStatePath(specDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(trimAutocodeDirectSessionState(state), null, 2)}\n`, 'utf-8');
}

export function resolveAutocodeDirectSessionState(
  ...specDirs: Array<string | undefined | null>
): AutocodeDirectSessionState | null {
  for (const specDir of specDirs) {
    if (!specDir) {
      continue;
    }
    const state = loadAutocodeDirectSessionState(specDir);
    if (state) {
      return state;
    }
  }
  return null;
}

export function compactAutocodeDirectSessionLatestSummary(value: string | undefined): string | undefined {
  return limitHeadTailString(
    value,
    AUTOCODE_DIRECT_SESSION_LATEST_SUMMARY_MAX_CHARS,
    LATEST_SUMMARY_TRUNCATION_MARKER,
  );
}

function normalizeAutocodeDirectSessionState(value: unknown): AutocodeDirectSessionState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  if (!sessionId) {
    return null;
  }

  const now = new Date().toISOString();
  return trimAutocodeDirectSessionState({
    version: AUTOCODE_DIRECT_SESSION_STATE_VERSION,
    sessionId,
    createdAt: typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt : now,
    iteration: typeof record.iteration === 'number' && Number.isFinite(record.iteration)
      ? Math.max(1, Math.floor(record.iteration))
      : 1,
    provider: readString(record.provider),
    modelId: readString(record.modelId),
    providerResponseId: readString(record.providerResponseId),
    originalRequest: readString(record.originalRequest),
    latestSummary: readString(record.latestSummary),
    changedFiles: Array.isArray(record.changedFiles)
      ? record.changedFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined,
    lastOutcome: readString(record.lastOutcome),
  });
}

function trimAutocodeDirectSessionState(state: AutocodeDirectSessionState): AutocodeDirectSessionState {
  return {
    ...state,
    originalRequest: limitHeadTailString(
      state.originalRequest,
      AUTOCODE_DIRECT_SESSION_ORIGINAL_REQUEST_MAX_CHARS,
      ORIGINAL_REQUEST_TRUNCATION_MARKER,
    ),
    latestSummary: compactAutocodeDirectSessionLatestSummary(state.latestSummary),
    changedFiles: Array.from(new Set((state.changedFiles ?? []).filter(Boolean))).slice(0, 100),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function limitHeadTailString(value: string | undefined, maxLength: number, marker: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const budget = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    marker,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}
