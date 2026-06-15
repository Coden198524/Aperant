/**
 * StepMemoryState
 *
 * Tracks per-step memory state during a session.
 * Used by the prepareStep callback to feed context to StepInjectionDecider.
 */

import {
  compactAutocodeMemoryRuntimeInjectedMemoryIds,
  compactAutocodeMemoryRuntimeToolArgs,
} from '../runtime.js';
import type { RecentToolCallContext } from './step-injection-decider.js';

// ============================================================
// STEP MEMORY STATE
// ============================================================

type RecentToolCall = { toolName: string; args: Record<string, unknown> };

export class StepMemoryState {
  private recentToolCalls: RecentToolCall[] = [];
  private injectedMemoryIds = new Set<string>();

  /**
   * Record a tool call. Maintains a rolling window of the last 20 calls.
   */
  recordToolCall(toolName: string, args: Record<string, unknown>): void {
    this.recentToolCalls.push({
      toolName,
      args: normalizeMemoryToolArgs(toolName, compactAutocodeMemoryRuntimeToolArgs(args)),
    });
    if (this.recentToolCalls.length > 20) {
      this.recentToolCalls.shift();
    }
  }

  /**
   * Mark memory IDs as having been injected so they are not injected again.
   */
  markInjected(memoryIds: string[]): void {
    this.injectedMemoryIds = new Set(
      compactAutocodeMemoryRuntimeInjectedMemoryIds([
        ...this.injectedMemoryIds,
        ...memoryIds,
      ]),
    );
  }

  /**
   * Get the recent tool call context for the injection decider.
   *
   * @param windowSize - How many of the most recent calls to include (default 5)
   */
  getRecentContext(windowSize = 5): RecentToolCallContext {
    const recentUniqueCalls = selectRecentUniqueToolCalls(this.recentToolCalls, windowSize);
    return {
      toolCalls: recentUniqueCalls,
      injectedMemoryIds: new Set(this.injectedMemoryIds),
    };
  }

  /**
   * Reset all state (call at session start or when starting a new subtask).
   */
  reset(): void {
    this.recentToolCalls = [];
    this.injectedMemoryIds.clear();
  }
}

function selectRecentUniqueToolCalls(
  calls: RecentToolCall[],
  windowSize: number,
): RecentToolCall[] {
  const normalizedWindowSize = Number.isFinite(windowSize) ? Math.max(0, Math.floor(windowSize)) : 0;
  if (normalizedWindowSize <= 0 || calls.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const selected: Array<{ call: RecentToolCall; index: number }> = [];
  const collect = (predicate: (call: RecentToolCall) => boolean): void => {
    for (let index = calls.length - 1; index >= 0 && selected.length < normalizedWindowSize; index -= 1) {
      const call = calls[index];
      if (!predicate(call)) {
        continue;
      }

      const signature = getToolCallSignature(call);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      selected.push({ call, index });
    }
  };

  collect(isMemoryTriggeringToolCall);
  collect(() => true);

  return selected
    .sort((a, b) => a.index - b.index)
    .map((item) => item.call);
}

function isMemoryTriggeringToolCall(call: RecentToolCall): boolean {
  switch (call.toolName) {
    case 'Read':
    case 'Edit':
      return getMemoryToolFilePathArg(call).length > 0;
    case 'Grep':
      return typeof call.args.pattern === 'string' && call.args.pattern.trim().length > 0;
    case 'Glob':
      return typeof call.args.glob === 'string' && call.args.glob.trim().length > 0;
    default:
      return false;
  }
}

function getToolCallSignature(call: RecentToolCall): string {
  return `${call.toolName}:${stableStringify(normalizeToolCallArgsForSignature(call.args))}`;
}

function normalizeToolCallArgsForSignature(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[key] =
      (key === 'file_path' || key === 'path') && typeof value === 'string'
        ? normalizeMemoryFilePathArg(value).toLowerCase()
        : value;
  }
  return normalized;
}

function normalizeMemoryToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      normalized[key] = value;
      continue;
    }
    if (key === 'path' && isFilePathToolName(toolName)) {
      if (typeof normalized.file_path === 'string') {
        continue;
      }
      normalized.file_path = normalizeMemoryFilePathArg(value);
      continue;
    }
    if (key === 'file_path' || key === 'path') {
      normalized[key] = normalizeMemoryFilePathArg(value);
      continue;
    }
    if (key === 'pattern' || key === 'glob' || key === 'query') {
      normalized[key] = value.trim();
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function getMemoryToolFilePathArg(call: RecentToolCall): string {
  const value = call.args.file_path ?? call.args.path;
  return typeof value === 'string' ? value.trim() : '';
}

function isFilePathToolName(toolName: string): boolean {
  return toolName === 'Read' || toolName === 'Edit' || toolName === 'Write';
}

function normalizeMemoryFilePathArg(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
