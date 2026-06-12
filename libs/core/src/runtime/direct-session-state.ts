import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUTOCODE_DIRECT_SESSION_STATE_FILE = 'direct_session.json';
export const AUTOCODE_DIRECT_SESSION_STATE_VERSION = 1;

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
    originalRequest: limitString(state.originalRequest, 4_000),
    latestSummary: limitString(state.latestSummary, 4_000),
    changedFiles: Array.from(new Set((state.changedFiles ?? []).filter(Boolean))).slice(0, 100),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function limitString(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}
