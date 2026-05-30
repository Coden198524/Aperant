/**
 * Disk-Spillover Tool Output Truncation
 * ======================================
 *
 * Desktop adapter for the shared truncation policy. Core decides if and how
 * output should be truncated; desktop writes full spillover output to disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TOOL_OUTPUT_MAX_BYTES,
  buildToolOutputTruncationContent,
  createToolOutputSpilloverFileName,
  planToolOutputTruncation,
  withAutocodeRuntimeFileWriteLockSync,
} from '@autocode/core';
import { getAutocodeToolOutputDir } from '@autocode/core/project/data-paths';

export { SAFETY_NET_MAX_BYTES } from '@autocode/core';

export interface TruncationResult {
  content: string;
  wasTruncated: boolean;
  originalSize: number;
  spilloverPath?: string;
}

/**
 * Truncate tool output if it exceeds size limits.
 * Full output is preserved on disk with a routing hint for the agent.
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  projectDir: string,
  maxBytes: number = TOOL_OUTPUT_MAX_BYTES,
): TruncationResult {
  const plan = planToolOutputTruncation(output, toolName, maxBytes);

  if (!plan.wasTruncated) {
    return {
      content: output,
      wasTruncated: false,
      originalSize: plan.originalSize,
    };
  }

  const spilloverDir = getAutocodeToolOutputDir(projectDir);
  try {
    fs.mkdirSync(spilloverDir, { recursive: true });
  } catch {
    // Directory may already exist.
  }

  const spilloverPath = path.join(spilloverDir, createToolOutputSpilloverFileName(toolName));

  try {
    withAutocodeRuntimeFileWriteLockSync(
      {
        projectRoot: projectDir,
        filePath: spilloverPath,
        ownerId: `tool-output:${plan.sanitizedToolName}`,
      },
      () => {
        fs.writeFileSync(spilloverPath, output, { encoding: 'utf-8', flag: 'wx' });
      },
    );
  } catch {
    return {
      content: buildToolOutputTruncationContent(plan, { spilloverWriteFailed: true }),
      wasTruncated: true,
      originalSize: plan.originalSize,
    };
  }

  return {
    content: buildToolOutputTruncationContent(plan, { spilloverPath }),
    wasTruncated: true,
    originalSize: plan.originalSize,
    spilloverPath,
  };
}
