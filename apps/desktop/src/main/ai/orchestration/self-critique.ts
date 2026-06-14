import { open } from 'node:fs/promises';
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

export const SELF_CRITIQUE_PATTERN_FILES_MAX = 5;
export const SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES = 32_000;

export async function runSelfCritique(config: SelfCritiqueConfig): Promise<CritiqueResult> {
  const patternContents: string[] = [];

  for (const patternFile of (config.subtask.patternFiles ?? []).slice(0, SELF_CRITIQUE_PATTERN_FILES_MAX)) {
    try {
      patternContents.push(await readPatternFileSample(config.projectDir, patternFile));
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

export async function readPatternFileSample(projectDir: string, patternFile: string): Promise<string> {
  const filePath = join(projectDir, patternFile);
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (stats.size <= SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES) {
      return await handle.readFile({ encoding: 'utf-8' });
    }

    const marker = `\n\n/* ... [self-critique pattern sample truncated, ${stats.size} bytes total] ... */\n\n`;
    const headBytes = Math.floor(SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES * 0.55);
    const tailBytes = SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES - headBytes;
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
