import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatAutocodeCritiqueSummary,
  runAutocodeSelfCritique,
  type AutocodeCritiqueCheck,
  type AutocodeCritiqueResult,
  type AutocodeGeneratedFile,
} from '@autocode/core/runtime/agent-self-critique';

export interface SelfCritiqueConfig {
  generatedFiles: GeneratedFile[];
  subtask: {
    id: string;
    description: string;
    filesToModify?: string[];
    patternFiles?: string[];
  };
  projectDir: string;
  specDir: string;
  minScore?: number;
}

export type GeneratedFile = AutocodeGeneratedFile;
export type CritiqueResult = AutocodeCritiqueResult;
export type CritiqueCheck = AutocodeCritiqueCheck;

export async function runSelfCritique(config: SelfCritiqueConfig): Promise<CritiqueResult> {
  const patternContents: string[] = [];

  for (const patternFile of config.subtask.patternFiles ?? []) {
    try {
      patternContents.push(await readFile(join(config.projectDir, patternFile), 'utf-8'));
    } catch {
      // Pattern loading is best-effort; the core scorer will report if none load.
    }
  }

  return runAutocodeSelfCritique({
    generatedFiles: config.generatedFiles,
    subtask: config.subtask,
    patternContents,
    minScore: config.minScore,
  });
}

export function formatCritiqueSummary(result: CritiqueResult): string {
  return formatAutocodeCritiqueSummary(result);
}
