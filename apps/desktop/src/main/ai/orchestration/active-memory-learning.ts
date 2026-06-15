/**
 * Active memory learning desktop adapter.
 *
 * Core owns knowledge extraction; desktop keeps filesystem access and memory
 * service writes.
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAutocodeWorkUnitOutcomeMemoryEntry,
  type MemoryService,
} from '@autocode/core';
import {
  createAutocodeExtractedKnowledge,
  extractAutocodeCodePatternsFromContent,
  formatAutocodeCodePatternMemory,
  formatAutocodeFailurePatternMemory,
  formatAutocodeKnowledgeSummary,
  formatAutocodeSuccessPatternMemory,
  generateAutocodeLearningSessionId,
  isAutocodeSessionMetricInsight,
  mapAutocodeSessionOutcome,
  summarizeAutocodeSessionForMemory,
  type AutocodeCodePattern,
  type AutocodeExtractedKnowledge,
  type AutocodeFailureLearningPattern,
  type AutocodeSuccessPattern,
} from '@autocode/core/runtime/agent-memory-learning';

import type { SessionResult } from '../session/types';

export interface LearningConfig {
  sessionResult: SessionResult;
  subtask: {
    id: string;
    description: string;
    filesToModify?: string[];
    filesToCreate?: string[];
    patternFiles?: string[];
  };
  projectDir: string;
  specDir: string;
  memoryService?: Pick<MemoryService, 'store'>;
  projectId: string;
}

export type ExtractedKnowledge = AutocodeExtractedKnowledge;
export type SuccessPattern = AutocodeSuccessPattern;
export type FailurePattern = AutocodeFailureLearningPattern;
export type CodePattern = AutocodeCodePattern;

export const ACTIVE_MEMORY_CODE_PATTERN_FILES_MAX = 5;
export const ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES = 32_000;

const MODULE_SPECIFIC_INSIGHT_PATTERN =
  /(?:^|[\s`'"])(?:[\w.-]+[\\/][\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|cs|cpp|h|md|json)\b)|\b(module|component|service|store|hook|api|ipc|renderer|preload)\b|模块|组件|服务|状态|接口|渲染|主进程|预加载/i;

export async function extractAndStoreKnowledge(config: LearningConfig): Promise<ExtractedKnowledge> {
  const knowledge = createAutocodeExtractedKnowledge({
    sessionResult: config.sessionResult,
    subtask: config.subtask,
    codePatterns: await extractCodePatterns(config),
    sessionId: generateAutocodeLearningSessionId(),
    timestamp: new Date().toISOString(),
  });

  if (config.memoryService) {
    await storeToMemory(knowledge, config);
  }

  await storeToLocalHistory(knowledge, config.specDir);

  return knowledge;
}

async function extractCodePatterns(config: LearningConfig): Promise<CodePattern[]> {
  const patterns: CodePattern[] = [];
  const filesToAnalyze = normalizeCodePatternFiles([
    ...(config.subtask.filesToModify ?? []),
    ...(config.subtask.filesToCreate ?? []),
  ]);

  for (const file of filesToAnalyze.slice(0, ACTIVE_MEMORY_CODE_PATTERN_FILES_MAX)) {
    try {
      const content = await readCodePatternFileSample(config.projectDir, file);
      patterns.push(...extractAutocodeCodePatternsFromContent(content, file));
    } catch {
      // Skip files that cannot be read.
    }
  }

  return patterns;
}

function normalizeCodePatternFiles(files: readonly string[]): string[] {
  const normalizedFiles: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = normalizeCodePatternFile(file);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedFiles.push(normalized);
  }
  return normalizedFiles;
}

function normalizeCodePatternFile(file: string): string {
  return file
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

export async function readCodePatternFileSample(projectDir: string, file: string): Promise<string> {
  const filePath = join(projectDir, file);
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (stats.size <= ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES) {
      return await handle.readFile({ encoding: 'utf-8' });
    }

    const marker = `\n\n/* ... [active memory file sample truncated, ${stats.size} bytes total] ... */\n\n`;
    const headBytes = Math.floor(ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES * 0.55);
    const tailBytes = ACTIVE_MEMORY_CODE_PATTERN_FILE_MAX_BYTES - headBytes;
    const headBuffer = Buffer.alloc(headBytes);
    const tailBuffer = Buffer.alloc(tailBytes);

    const head = await handle.read(headBuffer, 0, headBytes, 0);
    const tailStart = Math.max(0, stats.size - tailBytes);
    const tail = await handle.read(tailBuffer, 0, tailBytes, tailStart);

    return [
      headBuffer.subarray(0, head.bytesRead).toString('utf-8'),
      marker,
      tailBuffer.subarray(0, tail.bytesRead).toString('utf-8'),
    ].join('');
  } finally {
    await handle.close();
  }
}

async function storeToMemory(knowledge: ExtractedKnowledge, config: LearningConfig): Promise<void> {
  if (!config.memoryService) {
    return;
  }

  try {
    const longTermInsights = knowledge.insights.filter((insight) => shouldStoreModuleInsight(insight, knowledge));
    await config.memoryService.store(buildAutocodeWorkUnitOutcomeMemoryEntry({
      projectId: config.projectId,
      sessionId: knowledge.sessionId,
      workUnitId: config.subtask.id,
      workUnitDescription: config.subtask.description,
      outcome: mapAutocodeSessionOutcome(config.sessionResult.outcome),
      phase: 'coding',
      source: 'desktop-worker',
      summary: summarizeAutocodeSessionForMemory({ ...knowledge, insights: longTermInsights }),
      error: config.sessionResult.error?.message,
      relatedFiles: knowledge.keyFiles,
      completedAt: knowledge.timestamp,
    }));

    if (knowledge.successPatterns) {
      for (const pattern of knowledge.successPatterns) {
        await config.memoryService.store({
          type: 'pattern',
          content: formatAutocodeSuccessPatternMemory(pattern),
          confidence: pattern.confidence,
          tags: ['success', config.subtask.id],
          relatedFiles: knowledge.keyFiles,
          projectId: config.projectId,
          sessionId: knowledge.sessionId,
        });
      }
    }

    if (knowledge.failurePatterns) {
      for (const pattern of knowledge.failurePatterns) {
        await config.memoryService.store({
          type: 'error_pattern',
          content: formatAutocodeFailurePatternMemory(pattern),
          confidence: pattern.confidence,
          tags: ['failure', config.subtask.id],
          relatedFiles: knowledge.keyFiles,
          projectId: config.projectId,
          sessionId: knowledge.sessionId,
        });
      }
    }

    if (knowledge.codePatterns) {
      for (const pattern of knowledge.codePatterns) {
        await config.memoryService.store({
          type: 'pattern',
          content: formatAutocodeCodePatternMemory(pattern),
          confidence: 0.7,
          tags: [pattern.category, pattern.language],
          relatedFiles: [pattern.sourceFile],
          projectId: config.projectId,
          sessionId: knowledge.sessionId,
        });
      }
    }

    for (const insight of longTermInsights) {
      await config.memoryService.store({
        type: 'module_insight',
        content: insight,
        confidence: 0.7,
        tags: ['insight', config.subtask.id, config.sessionResult.outcome],
        relatedFiles: knowledge.keyFiles,
        projectId: config.projectId,
        sessionId: knowledge.sessionId,
        scope: knowledge.keyFiles.length > 0 ? 'module' : 'session',
        source: 'agent_explicit',
      });
    }
  } catch (error) {
    console.error('Failed to store knowledge to memory:', error);
  }
}

function shouldStoreModuleInsight(insight: string, knowledge: ExtractedKnowledge): boolean {
  const text = insight.trim();
  if (!text) {
    return false;
  }

  if (isAutocodeSessionMetricInsight(text)) {
    return false;
  }

  return knowledge.keyFiles.length > 0 || MODULE_SPECIFIC_INSIGHT_PATTERN.test(text);
}

async function storeToLocalHistory(knowledge: ExtractedKnowledge, specDir: string): Promise<void> {
  try {
    const historyDir = join(specDir, 'memory', 'session_insights');
    await mkdir(historyDir, { recursive: true });

    const historyFile = join(historyDir, `session_${knowledge.sessionId}.json`);
    await writeFile(historyFile, JSON.stringify(knowledge, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to store knowledge to local history:', error);
  }
}

export function formatKnowledgeSummary(knowledge: ExtractedKnowledge): string {
  return formatAutocodeKnowledgeSummary(knowledge);
}
