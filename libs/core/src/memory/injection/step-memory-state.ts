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

export class StepMemoryState {
  private recentToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  private injectedMemoryIds = new Set<string>();

  /**
   * Record a tool call. Maintains a rolling window of the last 20 calls.
   */
  recordToolCall(toolName: string, args: Record<string, unknown>): void {
    this.recentToolCalls.push({
      toolName,
      args: normalizeMemoryToolArgs(compactAutocodeMemoryRuntimeToolArgs(args)),
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
  calls: Array<{ toolName: string; args: Record<string, unknown> }>,
  windowSize: number,
): Array<{ toolName: string; args: Record<string, unknown> }> {
  const normalizedWindowSize = Number.isFinite(windowSize) ? Math.max(0, Math.floor(windowSize)) : 0;
  if (normalizedWindowSize <= 0 || calls.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const selected: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  for (let index = calls.length - 1; index >= 0 && selected.length < normalizedWindowSize; index -= 1) {
    const call = calls[index];
    const signature = getToolCallSignature(call);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    selected.push(call);
  }

  return selected.reverse();
}

function getToolCallSignature(call: { toolName: string; args: Record<string, unknown> }): string {
  return `${call.toolName}:${stableStringify(call.args)}`;
}

function normalizeMemoryToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      normalized[key] = value;
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

function normalizeMemoryFilePathArg(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim();
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
