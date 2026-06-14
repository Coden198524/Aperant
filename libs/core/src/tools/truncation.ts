/**
 * Shared tool output truncation policy.
 *
 * Host runtimes decide whether and where to write full spillover output.
 * Core owns the pure decisions: limits, preview content, sanitized names, and
 * hint text.
 */

import { randomUUID } from 'node:crypto';

export const TOOL_OUTPUT_MAX_LINES = 800;
export const TOOL_OUTPUT_MAX_BYTES = 50_000;
export const SAFETY_NET_MAX_BYTES = 100_000;
const TOOL_OUTPUT_TRUNCATION_HEAD_RATIO = 0.65;
const TOOL_OUTPUT_LINE_OMISSION_MARKER_PREFIX = '[... ';
const TOOL_OUTPUT_BYTE_OMISSION_MARKER = '\n[Output middle omitted for byte budget]\n';

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

  const truncatedLines = selectHeadTailOutputLines(lines, maxLines);
  let content = truncatedLines.join('\n');
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    content = truncateUtf8HeadTailText(content, maxBytes);
  }

  return {
    content,
    wasTruncated: true,
    originalSize: bytes,
    lineCount: lines.length,
    displayedLineCount: content ? content.split('\n').length : 0,
    sanitizedToolName: sanitizeToolOutputName(toolName),
  };
}

function selectHeadTailOutputLines(lines: string[], maxLines: number): string[] {
  if (maxLines <= 0) {
    return [];
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  if (maxLines === 1) {
    return [`${TOOL_OUTPUT_LINE_OMISSION_MARKER_PREFIX}${lines.length} line(s) omitted ...]`];
  }

  const budget = maxLines - 1;
  const headCount = Math.ceil(budget * TOOL_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailCount = Math.max(0, budget - headCount);
  return [
    ...lines.slice(0, headCount),
    `${TOOL_OUTPUT_LINE_OMISSION_MARKER_PREFIX}${lines.length - headCount - tailCount} line(s) omitted ...]`,
    ...(tailCount > 0 ? lines.slice(-tailCount) : []),
  ];
}

function truncateUtf8HeadTailText(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(TOOL_OUTPUT_BYTE_OMISSION_MARKER, 'utf-8');
  if (markerBytes >= maxBytes - 2) {
    return fitUtf8Segment(value, maxBytes, 'head');
  }

  const budget = maxBytes - markerBytes;
  const headBytes = Math.ceil(budget * TOOL_OUTPUT_TRUNCATION_HEAD_RATIO);
  const tailBytes = Math.max(0, budget - headBytes);
  return [
    fitUtf8Segment(value, headBytes, 'head').trimEnd(),
    TOOL_OUTPUT_BYTE_OMISSION_MARKER,
    fitUtf8Segment(value, tailBytes, 'tail').trimStart(),
  ].join('');
}

function fitUtf8Segment(value: string, maxBytes: number, side: 'head' | 'tail'): string {
  if (maxBytes <= 0) {
    return '';
  }

  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  let best = '';

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = side === 'head'
      ? chars.slice(0, count).join('')
      : chars.slice(chars.length - count).join('');
    if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return best;
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
    `[Output truncated: ${plan.lineCount} lines / ${plan.originalSize} bytes -> showing ${plan.displayedLineCount} preview lines from head/tail]`,
    `[Full output saved to: ${options.spilloverPath}]`,
    '[Hint: Use the Read tool to view the full output, or narrow your search pattern for more specific results]',
  ].join('\n');

  return plan.content + hint;
}
