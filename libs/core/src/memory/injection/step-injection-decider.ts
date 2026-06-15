/**
 * StepInjectionDecider
 *
 * Decides whether to inject memory context between agent steps.
 * Three triggers: gotcha injection, scratchpad reflection, search short-circuit.
 */

import type {
  AutocodeMemoryRuntimeRecentToolCallContext,
  AutocodeMemoryRuntimeStepInjection,
} from '../runtime.js';
import type {
  Memory,
  MemoryService,
} from '../types.js';
import type { Scratchpad } from '../observer/scratchpad.js';
import type { AcuteCandidate } from '../types.js';
import { isMemoryEligibleForPromptContext } from '../retrieval/context-packer.js';
import { selectMemoryContextItems } from './context-selection.js';
import { compactMemoryInjectionText } from './text-compaction.js';

// ============================================================
// TYPES
// ============================================================

export type RecentToolCallContext = AutocodeMemoryRuntimeRecentToolCallContext;
export type StepInjection = AutocodeMemoryRuntimeStepInjection;

const MAX_GOTCHA_INJECTION_MEMORIES = 2;
const GOTCHA_SEARCH_CANDIDATE_LIMIT = MAX_GOTCHA_INJECTION_MEMORIES * 3;
const MAX_MEMORY_ALERT_CHARS = 260;
const MAX_MEMORY_ALERT_TOKENS = 85;
const MAX_MEMORY_ALERT_FILE_REFS = 3;
const MAX_MEMORY_ALERT_FILE_REF_CHARS = 36;
const MAX_MEMORY_ALERT_FILE_REF_TOKENS = 16;
const MAX_SCRATCHPAD_REFLECTIONS = 2;
const MAX_SCRATCHPAD_TEXT_CHARS = 120;
const MAX_SCRATCHPAD_TEXT_TOKENS = 40;
const MIN_SCRATCHPAD_REFLECTION_PRIORITY = 0.75;
const MAX_SHORT_CIRCUIT_CHARS = 260;
const MAX_SHORT_CIRCUIT_TOKENS = 85;
const MAX_SHORT_CIRCUIT_PATTERN_CHARS = 120;
const BROAD_SEARCH_PATTERN_CHARS = 3;
const SCRATCHPAD_MEMORY_ID_PREFIX = 'scratchpad:';

// ============================================================
// STEP INJECTION DECIDER
// ============================================================

export class StepInjectionDecider {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly scratchpad: Scratchpad,
    private readonly projectId: string,
  ) {}

  /**
   * Evaluate the current step context and decide if a memory injection is warranted.
   * Returns null if no injection is needed, or a StepInjection if one should be made.
   *
   * Enforces a 50ms soft budget; if exceeded, still returns the result.
   */
  async decide(
    stepNumber: number,
    recentContext: RecentToolCallContext,
  ): Promise<StepInjection | null> {
    const start = process.hrtime.bigint();

    try {
      // Trigger 1: Agent read a file with unseen gotchas
      const recentReads = recentContext.toolCalls
        .filter((t) => t.toolName === 'Read' || t.toolName === 'Edit')
        .map((t) => normalizeAccessedFilePath(t.args.file_path))
        .filter(Boolean);

      if (recentReads.length > 0) {
        const freshGotchas = await this.memoryService.search({
          types: ['gotcha', 'error_pattern', 'dead_end'],
          relatedFiles: uniqueInOrder(recentReads),
          limit: GOTCHA_SEARCH_CANDIDATE_LIMIT,
          minConfidence: 0.65,
          projectId: this.projectId,
          promptContextOnly: true,
          filter: (m) => !recentContext.injectedMemoryIds.has(m.id),
        });

        const eligibleGotchas = selectMemoryContextItems(
          freshGotchas.filter((memory) => !recentContext.injectedMemoryIds.has(memory.id)),
          {
            maxItems: MAX_GOTCHA_INJECTION_MEMORIES,
            minConfidence: 0.65,
          },
        );
        if (eligibleGotchas.length > 0) {
          return {
            content: this.formatGotchas(eligibleGotchas),
            type: 'gotcha_injection',
            memoryIds: eligibleGotchas.map((m) => m.id),
          };
        }
      }

      // Trigger 2: New scratchpad entry from agent's record_memory call
      const newEntries = this.scratchpad
        .getNewSince(stepNumber - 1)
        .filter((entry) => shouldInjectScratchpadEntry(entry))
        .filter((entry) => !recentContext.injectedMemoryIds.has(getScratchpadInjectionId(entry)));
      if (newEntries.length > 0) {
        return {
          content: this.formatScratchpadEntries(newEntries),
          type: 'scratchpad_reflection',
          memoryIds: newEntries.slice(0, MAX_SCRATCHPAD_REFLECTIONS).map(getScratchpadInjectionId),
        };
      }

      // Trigger 3: Agent is searching for something already in memory
      const recentSearches = recentContext.toolCalls
        .filter((t) => t.toolName === 'Grep' || t.toolName === 'Glob')
        .slice(-3);
      const seenSearchPatterns = new Set<string>();

      for (const search of recentSearches) {
        const pattern = normalizeSearchPattern(search.args.pattern ?? search.args.glob);
        if (!isPreciseSearchPattern(pattern)) continue;
        if (seenSearchPatterns.has(pattern)) continue;
        seenSearchPatterns.add(pattern);

        const known = await this.memoryService.searchByPattern(pattern, { projectId: this.projectId });
        if (
          known &&
          isMemoryEligibleForPromptContext(known) &&
          !recentContext.injectedMemoryIds.has(known.id)
        ) {
          return {
            content: `MEMORY CONTEXT: ${truncateText(
              known.content,
              MAX_SHORT_CIRCUIT_CHARS,
              MAX_SHORT_CIRCUIT_TOKENS,
            )}`,
            type: 'search_short_circuit',
            memoryIds: [known.id],
          };
        }
      }

      return null;
    } catch {
      // Gracefully return null on any failure; never disrupt the agent loop.
      return null;
    } finally {
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (elapsed > 50) {
        console.warn(`[StepInjectionDecider] decide() exceeded 50ms budget: ${elapsed.toFixed(2)}ms`);
      }
    }
  }

  // ============================================================
  // PRIVATE FORMATTING HELPERS
  // ============================================================

  private formatGotchas(memories: Memory[]): string {
    const bullets = memories
      .map((m) => {
        const fileContext = formatFileRefs(m.relatedFiles);
        return `- [${m.type}]${fileContext}: ${truncateText(
          m.content,
          MAX_MEMORY_ALERT_CHARS,
          MAX_MEMORY_ALERT_TOKENS,
        )}`;
      })
      .join('\n');

    return `MEMORY ALERT - Gotchas for files you just accessed:\n${bullets}`;
  }

  private formatScratchpadEntries(entries: AcuteCandidate[]): string {
    const lines = entries
      .slice(0, MAX_SCRATCHPAD_REFLECTIONS)
      .map((e) => {
        const rawData = e.rawData as Record<string, unknown>;
        const text = truncateText(
          String(rawData.triggeringText ?? rawData.matchedText ?? ''),
          MAX_SCRATCHPAD_TEXT_CHARS,
          MAX_SCRATCHPAD_TEXT_TOKENS,
        );
        return `- [step ${e.stepNumber}] ${e.signalType}: ${text}`;
      })
      .join('\n');

    return `MEMORY REFLECTION - New observations recorded this step:\n${lines}`;
  }
}

function shouldInjectScratchpadEntry(entry: AcuteCandidate): boolean {
  return entry.priority >= MIN_SCRATCHPAD_REFLECTION_PRIORITY &&
    ['self_correction', 'error_retry', 'backtrack', 'context_token_spike', 'parallel_conflict']
      .includes(entry.signalType);
}

function getScratchpadInjectionId(entry: AcuteCandidate): string {
  return `${SCRATCHPAD_MEMORY_ID_PREFIX}${entry.signalType}:${entry.stepNumber}:${entry.capturedAt}`;
}

function normalizeAccessedFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    return '';
  }
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim();
}

function normalizeSearchPattern(pattern: unknown): string {
  if (typeof pattern !== 'string') {
    return '';
  }
  return pattern.replace(/\s+/g, ' ').trim();
}

function isPreciseSearchPattern(pattern: string): boolean {
  const normalized = normalizeSearchPattern(pattern);
  if (normalized.length < BROAD_SEARCH_PATTERN_CHARS) {
    return false;
  }
  if (normalized.length > MAX_SHORT_CIRCUIT_PATTERN_CHARS) {
    return false;
  }
  if (/^[*?{}[\]./\\]+$/.test(normalized)) {
    return false;
  }
  if (/[*?{}[\]]/.test(normalized)) {
    return false;
  }
  if (normalized === '.' || normalized === './' || normalized === '/' || normalized === '**') {
    return false;
  }
  return true;
}

function formatFileRefs(files: readonly string[]): string {
  if (files.length === 0) {
    return '';
  }

  const visible = files
    .slice(0, MAX_MEMORY_ALERT_FILE_REFS)
    .map((file) => truncateText(
      file.split(/[\\/]/).pop() || file,
      MAX_MEMORY_ALERT_FILE_REF_CHARS,
      MAX_MEMORY_ALERT_FILE_REF_TOKENS,
    ));
  const omitted = files.length - visible.length;
  if (omitted > 0) {
    visible.push(`+${omitted} more`);
  }

  return ` (${visible.join(', ')})`;
}

function truncateText(text: string, maxChars: number, maxTokens: number): string {
  return compactMemoryInjectionText(text, maxChars, maxTokens);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}
