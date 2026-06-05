/**
 * Active memory learning desktop adapter.
 *
 * Core owns knowledge extraction; desktop keeps filesystem access and memory
 * service writes.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAutocodeWorkUnitOutcomeMemoryEntry,
  type MemoryService,
} from '@autocode/core';
import {
  createAutocodeExtractedKnowledge,
  extractAutocodeCodePatternsFromContent,
  formatAutocodeKnowledgeSummary,
  generateAutocodeLearningSessionId,
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
  const filesToAnalyze = [
    ...(config.subtask.filesToModify ?? []),
    ...(config.subtask.filesToCreate ?? []),
  ];

  for (const file of filesToAnalyze.slice(0, 5)) {
    try {
      const content = await readFile(join(config.projectDir, file), 'utf-8');
      patterns.push(...extractAutocodeCodePatternsFromContent(content, file));
    } catch {
      // Skip files that cannot be read.
    }
  }

  return patterns;
}

async function storeToMemory(knowledge: ExtractedKnowledge, config: LearningConfig): Promise<void> {
  if (!config.memoryService) {
    return;
  }

  try {
    await config.memoryService.store(buildAutocodeWorkUnitOutcomeMemoryEntry({
      projectId: config.projectId,
      sessionId: knowledge.sessionId,
      workUnitId: config.subtask.id,
      workUnitDescription: config.subtask.description,
      outcome: mapAutocodeSessionOutcome(config.sessionResult.outcome),
      phase: 'coding',
      source: 'desktop-worker',
      summary: summarizeAutocodeSessionForMemory(knowledge),
      error: config.sessionResult.error?.message,
      relatedFiles: knowledge.keyFiles,
      completedAt: knowledge.timestamp,
    }));

    if (knowledge.successPatterns) {
      for (const pattern of knowledge.successPatterns) {
        await config.memoryService.store({
          type: 'pattern',
          content: JSON.stringify(pattern),
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
          content: JSON.stringify(pattern),
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
          content: JSON.stringify(pattern),
          confidence: 0.7,
          tags: [pattern.category, pattern.language],
          relatedFiles: [pattern.sourceFile],
          projectId: config.projectId,
          sessionId: knowledge.sessionId,
        });
      }
    }

    for (const insight of knowledge.insights) {
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
