/**
 * StepInjectionDecider
 *
 * Decides whether to inject memory context between agent steps.
 * Three triggers: gotcha injection, scratchpad reflection, search short-circuit.
 */

import { createHash } from 'node:crypto';

import type { Scratchpad } from '../observer/scratchpad.js';
import { isMemoryEligibleForPromptContext } from '../retrieval/context-packer.js';
import type {
  AutocodeMemoryRuntimeRecentToolCallContext,
  AutocodeMemoryRuntimeStepInjection,
} from '../runtime.js';
import type { AcuteCandidate, Memory, MemoryService } from '../types.js';
import { recordSelectedMemoryAccess } from './access-tracking.js';
import { selectMemoryContextItems } from './context-selection.js';
import { compactMemoryInjectionText } from './text-compaction.js';
import { stripLowValueMemoryLines } from '../outcome-content.js';

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
const SCRATCHPAD_MEMORY_ID_HASH_CHARS = 16;
const SEARCH_PATTERN_MEMORY_ID_PREFIX = 'search-pattern:';
const SEARCH_PATTERN_MEMORY_ID_HASH_CHARS = 16;

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
          recordAccess: false,
          filter: (m) => !recentContext.injectedMemoryIds.has(m.id),
        });

        const eligibleGotchas = selectMemoryContextItems(
          freshGotchas.filter(
            (memory) =>
              !recentContext.injectedMemoryIds.has(memory.id) &&
              hasInjectableMemoryContent(memory),
          ),
          {
            maxItems: MAX_GOTCHA_INJECTION_MEMORIES,
            minConfidence: 0.65,
            getContent: getInjectableMemoryContent,
          },
        );
        if (eligibleGotchas.length > 0) {
          await recordSelectedMemoryAccess(this.memoryService, eligibleGotchas);
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
        .filter(
          (entry) =>
            !getScratchpadInjectionIds(entry).some((id) =>
              recentContext.injectedMemoryIds.has(id),
            ),
        );
      const selectedScratchpadEntries = selectScratchpadEntriesForInjection(newEntries);
      if (selectedScratchpadEntries.length > 0) {
        return {
          content: this.formatScratchpadEntries(selectedScratchpadEntries),
          type: 'scratchpad_reflection',
          memoryIds: selectedScratchpadEntries.map(getScratchpadInjectionId),
        };
      }

      // Trigger 3: Agent is searching for something already in memory
      const recentSearches = recentContext.toolCalls
        .filter((t) => t.toolName === 'Grep' || t.toolName === 'Glob')
        .slice(-3);
      const seenSearchPatterns = new Set<string>();

      for (const search of recentSearches) {
        const pattern = normalizeSearchPattern(
          search.args.pattern ?? search.args.glob,
        );
        if (!isPreciseSearchPattern(pattern)) continue;
        if (seenSearchPatterns.has(pattern)) continue;
        seenSearchPatterns.add(pattern);
        const patternInjectionId = getSearchPatternInjectionId(pattern);
        if (recentContext.injectedMemoryIds.has(patternInjectionId)) continue;

        const known = await this.memoryService.searchByPattern(pattern, {
          projectId: this.projectId,
          recordAccess: false,
        });
        if (
          known &&
          isMemoryEligibleForPromptContext(known) &&
          hasInjectableMemoryContent(known) &&
          !recentContext.injectedMemoryIds.has(known.id)
        ) {
          const content = getInjectableMemoryContent(known);
          await recordSelectedMemoryAccess(this.memoryService, [known]);
          return {
            content: `MEMORY CONTEXT: ${truncateText(
              content,
              MAX_SHORT_CIRCUIT_CHARS,
              MAX_SHORT_CIRCUIT_TOKENS,
            )}`,
            type: 'search_short_circuit',
            memoryIds: [known.id, patternInjectionId],
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
        console.warn(
          `[StepInjectionDecider] decide() exceeded 50ms budget: ${elapsed.toFixed(2)}ms`,
        );
      }
    }
  }

  // ============================================================
  // PRIVATE FORMATTING HELPERS
  // ============================================================

  private formatGotchas(memories: Memory[]): string {
    const bullets = memories
      .map((memory) => this.formatGotchaLine(memory))
      .join('\n');

    return `MEMORY ALERT - Gotchas for files you just accessed:\n${bullets}`;
  }

  private formatGotchaLine(memory: Memory): string {
    const content = truncateText(
      getInjectableMemoryContent(memory),
      MAX_MEMORY_ALERT_CHARS,
      MAX_MEMORY_ALERT_TOKENS,
    );
    const fileContext = formatFileRefs(memory.relatedFiles, content);
    return `- [${memory.type}]${fileContext}: ${content}`;
  }

  private formatScratchpadEntries(entries: AcuteCandidate[]): string {
    const lines = entries
      .map((e) => {
        const text = truncateText(
          getScratchpadEntryText(e),
          MAX_SCRATCHPAD_TEXT_CHARS,
          MAX_SCRATCHPAD_TEXT_TOKENS,
        );
        return `- [step ${e.stepNumber}] ${e.signalType}: ${text}`;
      })
      .join('\n');

    return `MEMORY REFLECTION - New observations recorded this step:\n${lines}`;
  }
}

interface RankedScratchpadEntry {
  entry: AcuteCandidate;
  rank: number;
}

function selectScratchpadEntriesForInjection(entries: AcuteCandidate[]): AcuteCandidate[] {
  const byRenderedText = new Map<string, RankedScratchpadEntry>();
  entries.forEach((entry, rank) => {
    const key = getScratchpadRenderedTextKey(entry);
    if (!key) {
      return;
    }

    const existing = byRenderedText.get(key);
    if (!existing || isHigherPriorityScratchpadEntry(entry, existing.entry)) {
      byRenderedText.set(key, {
        entry,
        rank: existing?.rank ?? rank,
      });
    }
  });

  return [...byRenderedText.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_SCRATCHPAD_REFLECTIONS)
    .map((item) => item.entry);
}

function getScratchpadRenderedTextKey(entry: AcuteCandidate): string {
  return truncateText(
    getScratchpadEntryText(entry),
    MAX_SCRATCHPAD_TEXT_CHARS,
    MAX_SCRATCHPAD_TEXT_TOKENS,
  )
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isHigherPriorityScratchpadEntry(candidate: AcuteCandidate, existing: AcuteCandidate): boolean {
  return candidate.priority > existing.priority ||
    candidate.priority === existing.priority && candidate.capturedAt > existing.capturedAt;
}

function shouldInjectScratchpadEntry(entry: AcuteCandidate): boolean {
  return (
    entry.priority >= MIN_SCRATCHPAD_REFLECTION_PRIORITY &&
    getScratchpadEntryText(entry).length > 0 &&
    [
      'self_correction',
      'error_retry',
      'backtrack',
      'context_token_spike',
      'parallel_conflict',
    ].includes(entry.signalType)
  );
}

function getScratchpadEntryText(entry: AcuteCandidate): string {
  const rawData = isRecord(entry.rawData) ? entry.rawData : {};
  const value = rawData.triggeringText ?? rawData.matchedText;
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function getInjectableMemoryContent(memory: Memory): string {
  return stripLowValueMemoryLines(memory.content);
}

function hasInjectableMemoryContent(memory: Memory): boolean {
  return getInjectableMemoryContent(memory).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getScratchpadInjectionId(entry: AcuteCandidate): string {
  const key = getScratchpadRenderedTextKey(entry);
  if (!key) {
    return getLegacyScratchpadInjectionId(entry);
  }

  const hash = getShortHash(key, SCRATCHPAD_MEMORY_ID_HASH_CHARS);
  return `${SCRATCHPAD_MEMORY_ID_PREFIX}${hash}`;
}

function getScratchpadInjectionIds(entry: AcuteCandidate): string[] {
  return [
    getScratchpadInjectionId(entry),
    getLegacyScratchpadInjectionId(entry),
  ];
}

function getLegacyScratchpadInjectionId(entry: AcuteCandidate): string {
  return `${SCRATCHPAD_MEMORY_ID_PREFIX}${entry.signalType}:${entry.stepNumber}:${entry.capturedAt}`;
}

function getSearchPatternInjectionId(pattern: string): string {
  return `${SEARCH_PATTERN_MEMORY_ID_PREFIX}${getShortHash(
    normalizeSearchPattern(pattern),
    SEARCH_PATTERN_MEMORY_ID_HASH_CHARS,
  )}`;
}

function getShortHash(value: string, chars: number): string {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, chars);
}

function normalizeAccessedFilePath(filePath: unknown): string {
  if (typeof filePath !== 'string') {
    return '';
  }
  return normalizeInjectionFilePath(filePath);
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
  if (
    normalized === '.' ||
    normalized === './' ||
    normalized === '/' ||
    normalized === '**'
  ) {
    return false;
  }
  return true;
}

function formatFileRefs(files: readonly string[], content = ''): string {
  if (files.length === 0) {
    return '';
  }

  const uniqueFiles = uniqueFileRefs(files)
    .filter((file) => !isFileRefMentionedInText(file, content));
  const visible = uniqueFiles
    .slice(0, MAX_MEMORY_ALERT_FILE_REFS)
    .map((file) =>
      truncateText(
        file.split(/[\\/]/).pop() || file,
        MAX_MEMORY_ALERT_FILE_REF_CHARS,
        MAX_MEMORY_ALERT_FILE_REF_TOKENS,
      ),
    );
  const omitted = uniqueFiles.length - visible.length;
  if (omitted > 0) {
    visible.push(`+${omitted} more`);
  }

  return ` (${visible.join(', ')})`;
}

function isFileRefMentionedInText(filePath: string, text: string): boolean {
  const normalizedText = normalizeTextForFileRefMatch(text);
  if (!normalizedText) {
    return false;
  }

  const normalizedPath = normalizeTextForFileRefMatch(filePath);
  const fileName = normalizeTextForFileRefMatch(filePath.split(/[\\/]/).pop() ?? filePath);
  return normalizedText.includes(normalizedPath) ||
    (fileName.length > 0 && containsStandaloneFileRefName(normalizedText, fileName));
}

function containsStandaloneFileRefName(text: string, fileName: string): boolean {
  return new RegExp(
    `(?:^|[^a-z0-9_.-])${escapeRegExp(fileName)}(?:$|[^a-z0-9_.-])`,
  ).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTextForFileRefMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueFileRefs(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const file of files) {
    const normalized = normalizeInjectionFilePath(file);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function normalizeInjectionFilePath(filePath: string): string {
  return filePath
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function truncateText(
  text: string,
  maxChars: number,
  maxTokens: number,
): string {
  return compactMemoryInjectionText(text, maxChars, maxTokens);
}

function uniqueInOrder(values: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}
