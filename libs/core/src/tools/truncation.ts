/**
 * Shared tool output truncation policy.
 *
 * Host runtimes decide whether and where to write full spillover output.
 * Core owns the pure decisions: limits, preview content, sanitized names, and
 * hint text.
 */

import { randomUUID } from 'node:crypto';

export const TOOL_OUTPUT_MAX_LINES = 2000;
export const TOOL_OUTPUT_MAX_BYTES = 50_000;
export const SAFETY_NET_MAX_BYTES = 100_000;

export interface ToolOutputTruncationPlan {
  content: string;
  wasTruncated: boolean;
  originalSize: number;
  lineCount: number;
  displayedLineCount: number;
  sanitizedToolName: string;
}

export interface ToolOutputTruncationContentOptions {
  spilloverPath?: string;
  spilloverWriteFailed?: boolean;
}

export function sanitizeToolOutputName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createToolOutputSpilloverFileName(toolName: string, now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]/g, '');
  return `${sanitizeToolOutputName(toolName)}-${timestamp}-${randomUUID().slice(0, 8)}.txt`;
}

export function planToolOutputTruncation(
  output: string,
  toolName: string,
  maxBytes: number = TOOL_OUTPUT_MAX_BYTES,
  maxLines: number = TOOL_OUTPUT_MAX_LINES,
): ToolOutputTruncationPlan {
  const bytes = Buffer.byteLength(output, 'utf-8');
  const lines = output.split('\n');

  if (bytes <= maxBytes && lines.length <= maxLines) {
    return {
      content: output,
      wasTruncated: false,
      originalSize: bytes,
      lineCount: lines.length,
      displayedLineCount: lines.length,
      sanitizedToolName: sanitizeToolOutputName(toolName),
    };
  }

  const truncatedLines = lines.slice(0, maxLines);
  let content = truncatedLines.join('\n');
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    content = content.slice(0, maxBytes);
  }

  return {
    content,
    wasTruncated: true,
    originalSize: bytes,
    lineCount: lines.length,
    displayedLineCount: Math.min(lines.length, maxLines),
    sanitizedToolName: sanitizeToolOutputName(toolName),
  };
}

export function buildToolOutputTruncationContent(
  plan: ToolOutputTruncationPlan,
  options: ToolOutputTruncationContentOptions = {},
): string {
  if (!plan.wasTruncated) {
    return plan.content;
  }

  if (options.spilloverWriteFailed || !options.spilloverPath) {
    return `${plan.content}\n\n[Output truncated: ${plan.lineCount} lines / ${plan.originalSize} bytes - spillover write failed]`;
  }

  const hint = [
    '',
    `[Output truncated: ${plan.lineCount} lines / ${plan.originalSize} bytes -> showing first ${plan.displayedLineCount} lines]`,
    `[Full output saved to: ${options.spilloverPath}]`,
    '[Hint: Use the Read tool to view the full output, or narrow your search pattern for more specific results]',
  ].join('\n');

  return plan.content + hint;
}
