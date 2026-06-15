/**
 * Memory Observer
 *
 * Passive behavioral observation layer. Runs on the MAIN THREAD.
 * Taps every postMessage event from worker threads.
 *
 * RULES:
 * - observe() MUST complete in < 2ms
 * - observe() NEVER awaits
 * - observe() NEVER accesses the database
 * - observe() NEVER throws
 */

import type {
  MemoryCandidate,
  SessionOutcome,
  SessionType,
  AcuteCandidate,
} from '../types.js';
import {
  compactAutocodeMemoryRuntimeToolArgs,
  type AutocodeMemoryRuntimeObservationIpcRequest,
} from '../runtime.js';
import { stripLowValueMemoryLines } from '../outcome-content.js';
import { Scratchpad } from './scratchpad.js';
import { detectDeadEnd } from './dead-end-detector.js';
import { applyTrustGate } from './trust-gate.js';
import { SELF_CORRECTION_PATTERNS } from './signals.js';
import { SESSION_TYPE_PROMOTION_LIMITS } from './promotion.js';

export type MemoryObserverIpcRequest = AutocodeMemoryRuntimeObservationIpcRequest;

// ============================================================
// EXTERNAL TOOL NAMES (for trust gate)
// ============================================================

const EXTERNAL_TOOL_NAMES = new Set(['WebFetch', 'WebSearch']);
const MAX_CO_ACCESS_CANDIDATES = 8;
const MAX_OBSERVER_RELATED_MODULES = 6;
const MAX_CONTEXT_COST_RELATED_FILES = 4;
const OBSERVER_ACUTE_MEMORY_SNIPPET_MAX_CHARS = 220;
const CONTEXT_TOKEN_SPIKE_DEFAULT_EXPECTED_TOKENS = 8_000;
const CONTEXT_TOKEN_SPIKE_MIN_INPUT_TOKENS = 12_000;
const CONTEXT_TOKEN_SPIKE_WINDOW_RATIO = 0.72;
const CONTEXT_TOKEN_SPIKE_MIN_RATIO = 1.35;
const OBSERVER_GENERIC_GREP_PATTERNS = new Set([
  'app',
  'apps',
  'class',
  'const',
  'content',
  'data',
  'error',
  'errors',
  'export',
  'fixme',
  'function',
  'import',
  'interface',
  'let',
  'lib',
  'libs',
  'result',
  'return',
  'spec',
  'src',
  'test',
  'tests',
  'todo',
  'type',
  'types',
  'var',
]);
const OBSERVER_GENERIC_GREP_FILE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.go',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.ts',
  '.tsx',
]);
const OBSERVER_GENERIC_PATH_SEGMENTS = new Set([
  'app',
  'apps',
  'ai',
  'cli',
  'client',
  'component',
  'components',
  'core',
  'desktop',
  'e2e',
  'feature',
  'features',
  'helper',
  'helpers',
  'lib',
  'libs',
  'main',
  'package',
  'packages',
  'preload',
  'renderer',
  'server',
  'service',
  'services',
  'shared',
  'spec',
  'specs',
  'src',
  'test',
  'tests',
  'util',
  'utils',
]);

interface RankedCoAccessPair {
  fileA: string;
  fileB: string;
  key: string;
  accessScore: number;
  lastAccessStep: number;
}

interface ContextTokenSpikeSnapshot {
  inputTokens: number;
  expectedTokens: number;
  spikeRatio: number;
  filesAccessedCount: number;
  contextWindowLimit?: number;
  stepNumber: number;
}

// ============================================================
// MEMORY OBSERVER
// ============================================================

export class MemoryObserver {
  private readonly scratchpad: Scratchpad;
  private externalToolCallStep: number | undefined = undefined;
  private contextTokenSpike: ContextTokenSpikeSnapshot | undefined = undefined;

  constructor(sessionId: string, sessionType: SessionType, _projectId: string) {
    this.scratchpad = new Scratchpad(sessionId, sessionType);
  }

  /**
   * Called for every IPC message from worker thread.
   * MUST complete in < 2ms. Never awaits. Never accesses DB.
   */
  observe(message: MemoryObserverIpcRequest): void {
    const start = process.hrtime.bigint();

    try {
      switch (message.type) {
        case 'memory:tool-call':
          this.onToolCall(message);
          break;
        case 'memory:tool-result':
          this.onToolResult(message);
          break;
        case 'memory:reasoning':
          this.onReasoning(message);
          break;
        case 'memory:token-usage':
          this.onTokenUsage(message);
          break;
        case 'memory:step-complete':
          this.onStepComplete(message.stepNumber);
          break;
      }
    } catch {
      // Observer must never throw — swallow all errors silently
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (elapsed > 2) {
      console.warn(`[MemoryObserver] observe() budget exceeded: ${elapsed.toFixed(2)}ms`);
    }
  }

  /**
   * Get the underlying scratchpad for checkpointing.
   */
  getScratchpad(): Scratchpad {
    return this.scratchpad;
  }

  /**
   * Get all acute candidates captured since the given step.
   */
  getNewCandidatesSince(stepNumber: number): AcuteCandidate[] {
    return this.scratchpad.getNewSince(stepNumber);
  }

  /**
   * Finalize the session: collect all signals, apply gates, return candidates.
   *
   * This is called AFTER the session completes. It may be slow (LLM synthesis, etc.)
   * but must complete within a reasonable budget.
   */
  async finalize(outcome: SessionOutcome): Promise<MemoryCandidate[]> {
    let candidates: MemoryCandidate[] = [
      ...this.finalizeCoAccess(),
      ...this.finalizeErrorRetry(),
      ...this.finalizeAcuteCandidates(),
      ...this.finalizeRepeatedGrep(),
      ...this.finalizeContextTokenSpike(),
    ];

    if (outcome === 'failure' || outcome === 'abandoned') {
      candidates = candidates.filter((candidate) => candidate.proposedType === 'dead_end');
    }

    // Apply trust gate to all candidates
    const gated = candidates.map((c) => applyTrustGate(c, this.externalToolCallStep));

    // Apply session-type promotion limit
    const limit = SESSION_TYPE_PROMOTION_LIMITS[this.scratchpad.sessionType];
    const filtered = gated.sort((a, b) => b.priority - a.priority).slice(0, limit);

    // Optional LLM synthesis for co-access patterns on successful builds
    if (outcome === 'success' && filtered.some((c) => c.signalType === 'co_access')) {
      const synthesized = await this.synthesizeCoAccessWithLLM(filtered);
      // Don't exceed the limit
      const remaining = limit - filtered.length;
      if (remaining > 0) {
        filtered.push(...synthesized.slice(0, remaining));
      }
    }

    return filtered;
  }

  // ============================================================
  // PRIVATE: EVENT HANDLERS (all synchronous, O(1))
  // ============================================================

  private onToolCall(
    msg: Extract<MemoryObserverIpcRequest, { type: 'memory:tool-call' }>,
  ): void {
    const { toolName, stepNumber } = msg;
    const args = compactAutocodeMemoryRuntimeToolArgs(msg.args);

    // Track external tool calls for trust gate
    if (EXTERNAL_TOOL_NAMES.has(toolName)) {
      if (this.externalToolCallStep === undefined) {
        this.externalToolCallStep = stepNumber;
      }
    }

    // Update scratchpad analytics
    this.scratchpad.recordToolCall(toolName, args, stepNumber);

    // Track file edits
    if ((toolName === 'Edit' || toolName === 'Write') && typeof args.file_path === 'string') {
      this.scratchpad.recordFileEdit(args.file_path);
    }
  }

  private onToolResult(
    msg: Extract<MemoryObserverIpcRequest, { type: 'memory:tool-result' }>,
  ): void {
    const { toolName, result, stepNumber } = msg;
    this.scratchpad.recordToolResult(toolName, result, stepNumber);
  }

  private onReasoning(
    msg: Extract<MemoryObserverIpcRequest, { type: 'memory:reasoning' }>,
  ): void {
    const { text, stepNumber } = msg;

    // Detect self-corrections
    for (const pattern of SELF_CORRECTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        this.scratchpad.recordSelfCorrection(stepNumber);

        // Create acute candidate
        const candidate: AcuteCandidate = {
          signalType: 'self_correction',
          rawData: {
            triggeringText: text.slice(0, 200),
            matchedPattern: pattern.toString(),
            matchText: match[0],
          },
          priority: 0.9,
          capturedAt: Date.now(),
          stepNumber,
        };
        this.scratchpad.acuteCandidates.push(candidate);
        break; // Only record first matching pattern per reasoning chunk
      }
    }

    // Detect dead-end language
    const deadEnd = detectDeadEnd(text);
    if (deadEnd.matched) {
      const candidate: AcuteCandidate = {
        signalType: 'backtrack',
        rawData: {
          triggeringText: text.slice(0, 200),
          matchedPattern: deadEnd.pattern,
          matchedText: deadEnd.matchedText,
        },
        priority: 0.68,
        capturedAt: Date.now(),
        stepNumber,
      };
      this.scratchpad.acuteCandidates.push(candidate);
    }
  }

  private onTokenUsage(
    msg: Extract<MemoryObserverIpcRequest, { type: 'memory:token-usage' }>,
  ): void {
    const inputTokens = Math.floor(msg.inputTokens);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
      return;
    }

    this.scratchpad.recordTokenUsage(inputTokens);

    const spike = buildContextTokenSpikeSnapshot(
      inputTokens,
      msg.stepNumber,
      this.scratchpad.analytics.fileAccessCounts.size,
      msg.contextWindowLimit,
    );
    if (
      spike &&
      (!this.contextTokenSpike ||
        spike.inputTokens > this.contextTokenSpike.inputTokens ||
        (spike.inputTokens === this.contextTokenSpike.inputTokens &&
          spike.stepNumber > this.contextTokenSpike.stepNumber))
    ) {
      this.contextTokenSpike = spike;
    }
  }

  private onStepComplete(stepNumber: number): void {
    this.scratchpad.analytics.currentStep = stepNumber;
    // Co-access detection happens continuously in recordToolCall
    // Step complete is a good time to emit any pending signals
  }

  // ============================================================
  // PRIVATE: FINALIZE HELPERS
  // ============================================================

  private finalizeCoAccess(): MemoryCandidate[] {
    const { fileAccessCounts, fileLastAccess, intraSessionCoAccess } =
      this.scratchpad.analytics;
    const pairsByKey = new Map<string, RankedCoAccessPair>();

    for (const [fileA, coFiles] of intraSessionCoAccess) {
      for (const fileB of coFiles) {
        const pair = rankCoAccessPair(
          fileA,
          fileB,
          fileAccessCounts,
          fileLastAccess,
        );
        if (!pair) {
          continue;
        }

        const existing = pairsByKey.get(pair.key);
        if (
          !existing ||
          pair.accessScore > existing.accessScore ||
          (pair.accessScore === existing.accessScore &&
            pair.lastAccessStep > existing.lastAccessStep)
        ) {
          pairsByKey.set(pair.key, pair);
        }
      }
    }

    return [...pairsByKey.values()]
      .sort(
        (a, b) =>
          b.accessScore - a.accessScore ||
          b.lastAccessStep - a.lastAccessStep ||
          a.key.localeCompare(b.key),
      )
      .slice(0, MAX_CO_ACCESS_CANDIDATES)
      .map((pair) => ({
        signalType: 'co_access',
        proposedType: 'prefetch_pattern',
        content: formatCoAccessPrefetchPattern(pair),
        relatedFiles: [pair.fileA, pair.fileB],
        relatedModules: inferObserverRelatedModules([pair.fileA, pair.fileB]),
        confidence: 0.65,
        priority: 0.91,
        originatingStep: this.scratchpad.analytics.currentStep,
      }));
  }

  private finalizeErrorRetry(): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const { errorFingerprints, errorFingerprintSamples } = this.scratchpad.analytics;

    for (const [fingerprint, count] of errorFingerprints) {
      if (count >= 2) {
        const sample = formatObserverErrorRetrySample(errorFingerprintSamples.get(fingerprint));
        candidates.push({
          signalType: 'error_retry',
          proposedType: 'error_pattern',
          content: sample
            ? `Recurring error pattern (${count} times): ${sample} [fingerprint: ${fingerprint}]`
            : `Recurring error pattern (fingerprint: ${fingerprint}) encountered ${count} times in this session.`,
          relatedFiles: [],
          relatedModules: [],
          confidence: 0.6 + Math.min(0.3, count * 0.05),
          priority: 0.85,
          originatingStep: this.scratchpad.analytics.currentStep,
        });
      }
    }

    return candidates;
  }

  private finalizeAcuteCandidates(): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    for (const acute of this.scratchpad.acuteCandidates) {
      const rawData = acute.rawData as Record<string, unknown>;

      if (acute.signalType === 'self_correction') {
        const snippet = formatObserverAcuteMemorySnippet(rawData.triggeringText, rawData.matchText);
        if (!snippet) {
          continue;
        }
        candidates.push({
          signalType: 'self_correction',
          proposedType: 'gotcha',
          content: `Self-correction detected: ${snippet}`,
          relatedFiles: [],
          relatedModules: [],
          confidence: 0.8,
          priority: acute.priority,
          originatingStep: acute.stepNumber,
        });
      } else if (acute.signalType === 'backtrack') {
        const snippet = formatObserverAcuteMemorySnippet(rawData.triggeringText, rawData.matchedText);
        if (!snippet || !isObserverBacktrackSnippetWorthRemembering(snippet)) {
          continue;
        }
        candidates.push({
          signalType: 'backtrack',
          proposedType: 'dead_end',
          content: `Approach abandoned mid-session: ${snippet}`,
          relatedFiles: [],
          relatedModules: [],
          confidence: 0.65,
          priority: acute.priority,
          originatingStep: acute.stepNumber,
        });
      }
    }

    return candidates;
  }

  private finalizeRepeatedGrep(): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const { grepPatternCounts } = this.scratchpad.analytics;

    for (const [pattern, count] of grepPatternCounts) {
      if (count >= 3 && isObserverRepeatedGrepPatternWorthRemembering(pattern)) {
        candidates.push({
          signalType: 'repeated_grep',
          proposedType: 'module_insight',
          content: `Pattern "${pattern}" was searched ${count} times — may indicate a module that is hard to navigate.`,
          relatedFiles: [],
          relatedModules: [],
          confidence: 0.55 + Math.min(0.3, count * 0.04),
          priority: 0.76,
          originatingStep: this.scratchpad.analytics.currentStep,
        });
      }
    }

    return candidates;
  }

  private finalizeContextTokenSpike(): MemoryCandidate[] {
    const spike = this.contextTokenSpike;
    if (!spike) {
      return [];
    }

    const relatedFiles = selectTopObserverFilesByAccess(
      this.scratchpad.analytics.fileAccessCounts,
      this.scratchpad.analytics.fileLastAccess,
      MAX_CONTEXT_COST_RELATED_FILES,
    );

    return [{
      signalType: 'context_token_spike',
      proposedType: 'context_cost',
      content: formatContextTokenSpikeMemoryContent(spike),
      relatedFiles,
      relatedModules: inferObserverRelatedModules(relatedFiles),
      confidence: Math.min(0.82, 0.58 + Math.min(0.18, (spike.spikeRatio - 1) * 0.08)),
      priority: 0.63,
      originatingStep: spike.stepNumber,
    }];
  }

  /**
   * Optional LLM synthesis for co-access patterns.
   * Single generateText call per session maximum.
   */
  private async synthesizeCoAccessWithLLM(
    _candidates: MemoryCandidate[],
  ): Promise<MemoryCandidate[]> {
    // Placeholder — full implementation requires access to the AI provider.
    // In production this would call generateText() with a synthesis prompt
    // to convert raw co-access data into 1-3 sentence memory content.
    // Deferred to PromotionPipeline which has access to the provider factory.
    return [];
  }
}

function formatObserverErrorRetrySample(sample: string | undefined): string {
  const text = sample?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) {
    return '';
  }
  return formatObserverAcuteMemorySnippet(text, text);
}

function formatObserverAcuteMemorySnippet(primary: unknown, fallback: unknown): string {
  const rawText = String(primary ?? fallback ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = getObserverReusableAcuteText(rawText);
  if (!text) {
    return '';
  }
  if (text.length <= OBSERVER_ACUTE_MEMORY_SNIPPET_MAX_CHARS) {
    return text;
  }

  const marker = ' ... ';
  const budget = OBSERVER_ACUTE_MEMORY_SNIPPET_MAX_CHARS - marker.length;
  const headChars = Math.ceil(budget * 0.65);
  const tailChars = Math.max(0, budget - headChars);
  return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}`;
}

function getObserverReusableAcuteText(text: string): string {
  const cleaned = stripLowValueMemoryLines(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }

  return cleaned;
}

function isObserverBacktrackSnippetWorthRemembering(snippet: string): boolean {
  const normalized = snippet.toLowerCase();
  if (/^let me try a different approach(?: to solve this problem)?\.?$/.test(normalized)) {
    return false;
  }

  return /\b(because|unavailable|deprecated|removed|environment|production|test|ci|permission|api|method|signature|path|file|module)\b/i
    .test(snippet);
}

function isObserverRepeatedGrepPatternWorthRemembering(pattern: string): boolean {
  const normalized = pattern.replace(/\s+/g, ' ').trim();
  if (normalized.length < 4) {
    return false;
  }

  const compact = normalized.toLowerCase();
  if (
    OBSERVER_GENERIC_GREP_PATTERNS.has(compact) ||
    OBSERVER_GENERIC_GREP_FILE_EXTENSIONS.has(compact)
  ) {
    return false;
  }

  if (!/[a-z0-9_\u0080-\uffff]/i.test(normalized)) {
    return false;
  }

  return !/^[\s\\^$.*+?()[\]{}|/-]+$/.test(normalized);
}

function formatCoAccessPrefetchPattern(pair: RankedCoAccessPair): string {
  return JSON.stringify({
    alwaysReadFiles: [],
    frequentlyReadFiles: [pair.fileA, pair.fileB],
  });
}

function rankCoAccessPair(
  fileA: string,
  fileB: string,
  fileAccessCounts: ReadonlyMap<string, number>,
  fileLastAccess: ReadonlyMap<string, number>,
): RankedCoAccessPair | null {
  const keyA = normalizeObserverPathKey(fileA);
  const keyB = normalizeObserverPathKey(fileB);
  if (!keyA || !keyB || keyA === keyB) {
    return null;
  }

  const [firstFile, secondFile, firstKey, secondKey] =
    keyA <= keyB
      ? [fileA, fileB, keyA, keyB]
      : [fileB, fileA, keyB, keyA];
  return {
    fileA: firstFile,
    fileB: secondFile,
    key: `${firstKey}\0${secondKey}`,
    accessScore:
      (fileAccessCounts.get(fileA) ?? 0) + (fileAccessCounts.get(fileB) ?? 0),
    lastAccessStep: Math.max(
      fileLastAccess.get(fileA) ?? 0,
      fileLastAccess.get(fileB) ?? 0,
    ),
  };
}

function buildContextTokenSpikeSnapshot(
  inputTokens: number,
  stepNumber: number,
  filesAccessedCount: number,
  contextWindowLimit?: number,
): ContextTokenSpikeSnapshot | null {
  const normalizedWindowLimit =
    typeof contextWindowLimit === 'number' &&
    Number.isFinite(contextWindowLimit) &&
    contextWindowLimit > 0
      ? Math.floor(contextWindowLimit)
      : undefined;
  const expectedTokens = normalizedWindowLimit
    ? Math.max(
      CONTEXT_TOKEN_SPIKE_DEFAULT_EXPECTED_TOKENS,
      Math.floor(normalizedWindowLimit * 0.5),
    )
    : CONTEXT_TOKEN_SPIKE_DEFAULT_EXPECTED_TOKENS;
  const spikeThreshold = normalizedWindowLimit
    ? Math.max(
      CONTEXT_TOKEN_SPIKE_MIN_INPUT_TOKENS,
      Math.floor(normalizedWindowLimit * CONTEXT_TOKEN_SPIKE_WINDOW_RATIO),
    )
    : CONTEXT_TOKEN_SPIKE_MIN_INPUT_TOKENS;
  const spikeRatio = inputTokens / expectedTokens;

  if (
    inputTokens < spikeThreshold ||
    spikeRatio < CONTEXT_TOKEN_SPIKE_MIN_RATIO
  ) {
    return null;
  }

  return {
    inputTokens,
    expectedTokens,
    spikeRatio,
    filesAccessedCount,
    contextWindowLimit: normalizedWindowLimit,
    stepNumber,
  };
}

function formatContextTokenSpikeMemoryContent(spike: ContextTokenSpikeSnapshot): string {
  const windowText = spike.contextWindowLimit
    ? ` of a ${formatObserverTokenCount(spike.contextWindowLimit)} context window`
    : '';
  return [
    `Context token spike: prompt reached ${formatObserverTokenCount(spike.inputTokens)} tokens${windowText}`,
    `(${spike.spikeRatio.toFixed(1)}x expected).`,
    `Files touched before spike: ${spike.filesAccessedCount}.`,
    'Future runs should narrow searches and avoid broad file rereads in this area.',
  ].join(' ');
}

function formatObserverTokenCount(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);
}

function selectTopObserverFilesByAccess(
  fileAccessCounts: ReadonlyMap<string, number>,
  fileLastAccess: ReadonlyMap<string, number>,
  limit: number,
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];

  for (const [file] of [...fileAccessCounts.entries()].sort(
    ([fileA, countA], [fileB, countB]) =>
      countB - countA ||
      (fileLastAccess.get(fileB) ?? 0) - (fileLastAccess.get(fileA) ?? 0) ||
      fileA.localeCompare(fileB),
  )) {
    const key = normalizeObserverPathKey(file);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(file);
    if (files.length >= limit) {
      break;
    }
  }

  return files;
}

function normalizeObserverPathKey(filePath: string): string {
  return filePath
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function inferObserverRelatedModules(filePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const modules: string[] = [];

  for (const filePath of filePaths) {
    const normalized = normalizeObserverPathKey(filePath);
    if (!normalized) {
      continue;
    }

    const segments = normalized.split('/').filter(Boolean);
    const directorySegments = getObserverModuleDirectorySegments(segments);
    const candidates = directorySegments.length > 0
      ? directorySegments
      : [stripObserverFileExtension(segments.at(-1) ?? '')];

    for (const segment of candidates) {
      if (
        !segment ||
        OBSERVER_GENERIC_PATH_SEGMENTS.has(segment) ||
        seen.has(segment)
      ) {
        continue;
      }

      seen.add(segment);
      modules.push(segment);
      if (modules.length >= MAX_OBSERVER_RELATED_MODULES) {
        return modules;
      }
    }
  }

  return modules;
}

function stripObserverFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function getObserverModuleDirectorySegments(segments: readonly string[]): string[] {
  const directorySegments = segments.slice(0, -1);
  const sourceIndex = directorySegments.lastIndexOf('src');
  const scopedDirectories =
    sourceIndex >= 0
      ? directorySegments.slice(sourceIndex + 1)
      : directorySegments;

  return scopedDirectories.filter(
    (segment) => !OBSERVER_GENERIC_PATH_SEGMENTS.has(segment),
  );
}
