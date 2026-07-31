/**
 * Read File Tool
 * ==============
 *
 * Reads a file from the local filesystem with support for:
 * - Line offset and limit for partial reads
 * - Direct bounded byte ranges for deep large-file continuation
 * - Image file detection (returns base64 for multimodal)
 * - PDF file detection with page range support
 * - Line number prefixing (cat -n style)
 *
 * Integrates with path-containment security to prevent
 * reads outside the project directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  LARGE_TEXT_FILE_BYTES,
  MAX_READ_LINE_LENGTH,
  TASK_LOG_SUMMARY_BYTES,
  buildLargeReadFileNote,
  decodeTextBuffer,
  formatImageReadResult,
  formatReadContent,
  formatWithLineNumbers,
  getEffectiveReadLineLimit,
  isActiveTaskLogFile,
  isImageFile,
  isPdfFile,
  isTaskLogFile,
  joinReadNotes,
  normalizeReadPathInput,
  summarizeTaskLog,
} from '@autocode/core';
import { z } from 'zod/v3';

import {
  assertExactFilePathAllowed,
  assertOpenedExactFilePathAllowed,
} from '../../security/exact-file-authorization';
import { assertPathContained } from '../../security/path-containment';
import { Tool } from '../define';
import { DEFAULT_EXECUTION_OPTIONS, ToolPermission } from '../types';
import type { FileContentCache } from '../cache/file-cache';

const PARTIAL_READ_CHUNK_BYTES = 64 * 1024;
const PARTIAL_READ_ENCODING_PROBE_BYTES = 64 * 1024;
const BINARY_DETECTION_BYTES = 8 * 1024;
const MAX_READ_OUTPUT_CHARS = 72 * 1024;
const MAX_READ_TEXT_CONTENT_CHARS = 60 * 1024;
const MAX_READ_IMAGE_BYTES = 48 * 1024;
const MAX_READ_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_READ_SCAN_DURATION_MS = 100;
const MAX_READ_BYTE_RANGE_BYTES = 8 * 1024;
const MAX_EXPLICIT_READ_LINE_LIMIT = 500;
const MAX_READ_OFFSET = Number.MAX_SAFE_INTEGER - MAX_EXPLICIT_READ_LINE_LIMIT;
const MAX_READ_BYTE_OFFSET = Number.MAX_SAFE_INTEGER - MAX_READ_BYTE_RANGE_BYTES;
const READ_LONG_LINE_OMISSION_MARKER = ' ... [line middle omitted] ... ';
const READ_LONG_LINE_HEAD_RATIO = 0.6;
const READ_LONG_LINE_BUDGET = MAX_READ_LINE_LENGTH - READ_LONG_LINE_OMISSION_MARKER.length;
const READ_LONG_LINE_HEAD_LENGTH = Math.ceil(READ_LONG_LINE_BUDGET * READ_LONG_LINE_HEAD_RATIO);
const READ_LONG_LINE_TAIL_LENGTH = Math.max(0, READ_LONG_LINE_BUDGET - READ_LONG_LINE_HEAD_LENGTH);
const DECODED_ENCODING_PATTERN = /^\[Decoded as ([^;]+);/;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

function isValidPdfPageRange(value: string): boolean {
  const [startText, endText = startText] = value.split('-');
  const start = Number(startText);
  const end = Number(endText);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 1 &&
    end >= start &&
    end - start + 1 <= 20;
}

const pdfPagesSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^\d+(?:-\d+)?$/, 'Pages must be a single page or an inclusive range such as 1-5')
  .refine(isValidPdfPageRange, 'Pages must be positive, ordered, and contain at most 20 pages');

const READ_OPTIONAL_INPUT_KEYS = [
  'offset',
  'limit',
  'byte_offset',
  'byte_limit',
  'pages',
] as const;

function isValidOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return value === undefined ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum);
}

function hasValidReadModeValues(input: Record<string, unknown>): boolean {
  return isValidOptionalInteger(input.offset, 0, MAX_READ_OFFSET) &&
    isValidOptionalInteger(input.limit, 1, MAX_EXPLICIT_READ_LINE_LIMIT) &&
    isValidOptionalInteger(input.byte_offset, 0, MAX_READ_BYTE_OFFSET) &&
    isValidOptionalInteger(input.byte_limit, 1, MAX_READ_BYTE_RANGE_BYTES) &&
    (input.pages === undefined || pdfPagesSchema.safeParse(input.pages).success);
}

/**
 * Some OpenAI-compatible providers populate every optional Read property,
 * which combines line, byte, and PDF modes into one otherwise-invalid call.
 * Normalize only unambiguous/default collisions before Zod validation; invalid
 * types, ranges, and genuinely conflicting non-zero offsets still fail.
 */
function normalizeReadInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const input = { ...(value as Record<string, unknown>) };
  for (const key of READ_OPTIONAL_INPUT_KEYS) {
    if (input[key] === null) {
      delete input[key];
    }
  }

  if (typeof input.file_path !== 'string' || !hasValidReadModeValues(input)) {
    return input;
  }

  if (isPdfFile(input.file_path)) {
    delete input.offset;
    delete input.limit;
    delete input.byte_offset;
    delete input.byte_limit;
    return input;
  }

  if (isImageFile(input.file_path)) {
    for (const key of READ_OPTIONAL_INPUT_KEYS) {
      delete input[key];
    }
    return input;
  }

  // Page ranges have no meaning for text files and are commonly emitted as
  // the default "1" alongside every other optional field.
  delete input.pages;

  const hasLineMode = input.offset !== undefined || input.limit !== undefined;
  const hasByteMode = input.byte_offset !== undefined || input.byte_limit !== undefined;
  if (!hasLineMode || !hasByteMode) {
    return input;
  }

  const lineOffset = typeof input.offset === 'number' ? input.offset : 0;
  const byteOffset = typeof input.byte_offset === 'number' ? input.byte_offset : 0;

  // Two non-zero starting positions express genuinely different ranges. Keep
  // the call invalid so the model must choose instead of silently changing it.
  if (lineOffset > 0 && byteOffset > 0) {
    return input;
  }

  if (byteOffset > 0) {
    delete input.offset;
    delete input.limit;
  } else {
    // At the start of a text file, ordinary line mode is the least surprising
    // interpretation and handles the provider "all optionals filled" pattern.
    delete input.byte_offset;
    delete input.byte_limit;
  }

  return input;
}

const validatedInputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_READ_OFFSET)
    .optional()
    .describe('Line mode only: zero-based line offset. Never combine with byte_offset, byte_limit, or pages'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_EXPLICIT_READ_LINE_LIMIT)
    .optional()
    .describe(`Line mode only: number of lines to read (maximum ${MAX_EXPLICIT_READ_LINE_LIMIT}). Never combine with byte_offset, byte_limit, or pages.`),
  byte_offset: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_READ_BYTE_OFFSET)
    .optional()
    .describe('Byte mode only: absolute byte offset for a large text file. Never combine with offset, limit, or pages. Use the next byte_offset returned by Read for continuation.'),
  byte_limit: z
    .number()
    .int()
    .positive()
    .max(MAX_READ_BYTE_RANGE_BYTES)
    .optional()
    .describe(`Byte mode only: number of bytes to read with byte_offset (maximum ${MAX_READ_BYTE_RANGE_BYTES}). Never combine with offset, limit, or pages.`),
  pages: pdfPagesSchema
    .optional()
    .describe('PDF mode only: optional page-range metadata (e.g., 1-5, 3, 10-20). Never combine with line or byte ranges; this tool does not extract PDF page text.'),
}).superRefine((value, context) => {
  if (value.byte_limit !== undefined && value.byte_offset === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'byte_limit requires byte_offset',
      path: ['byte_limit'],
    });
  }
  if (
    value.byte_offset !== undefined &&
    (value.offset !== undefined || value.limit !== undefined || value.pages !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'byte_offset cannot be combined with line offset/limit or PDF pages',
      path: ['byte_offset'],
    });
  }
});

const inputSchema = z.preprocess(normalizeReadInput, validatedInputSchema);

interface PartialTextReadResult {
  lines: string[];
  totalLines?: number;
  decodedLength: number;
  hasMoreLines: boolean;
  scanLimit?: ReadScanLimit;
  note?: string;
}

interface BoundedBufferReadResult {
  buffer: Buffer;
  bytesRead: number;
  exceededLimit: boolean;
}

type ReadScanStopReason = 'consumer' | 'byte-limit' | 'time-limit';

interface DecodedTextScanResult {
  completed: boolean;
  bytesRead: number;
  stopReason?: ReadScanStopReason;
  note?: string;
}

interface ReadScanLimit {
  bytesRead: number;
  reason: 'byte-limit' | 'time-limit';
  includesPartialLine: boolean;
}

interface TextFileProbe {
  encoding: string;
  isLikelyBinary: boolean;
  note?: string;
}

interface TaskLogSummaryCounts {
  toolStart: number;
  toolEnd: number;
  text: number;
  error: number;
  read: number;
  glob: number;
  grep: number;
  bash: number;
  write: number;
  edit: number;
}

const TASK_LOG_COUNT_PATTERNS: ReadonlyArray<{
  key: keyof TaskLogSummaryCounts;
  pattern: RegExp;
}> = [
  { key: 'toolStart', pattern: /\x22type\x22\s*:\s*\x22tool_start\x22/g },
  { key: 'toolEnd', pattern: /\x22type\x22\s*:\s*\x22tool_end\x22/g },
  { key: 'text', pattern: /\x22type\x22\s*:\s*\x22text\x22/g },
  { key: 'error', pattern: /\x22type\x22\s*:\s*\x22error\x22/g },
  { key: 'read', pattern: /\x22tool_name\x22\s*:\s*\x22Read\x22/g },
  { key: 'glob', pattern: /\x22tool_name\x22\s*:\s*\x22Glob\x22/g },
  { key: 'grep', pattern: /\x22tool_name\x22\s*:\s*\x22Grep\x22/g },
  { key: 'bash', pattern: /\x22tool_name\x22\s*:\s*\x22Bash\x22/g },
  { key: 'write', pattern: /\x22tool_name\x22\s*:\s*\x22Write\x22/g },
  { key: 'edit', pattern: /\x22tool_name\x22\s*:\s*\x22Edit\x22/g },
];
const TASK_LOG_PATTERN_OVERLAP = 1024;

/**
 * Retains only the data needed to reproduce core's long-line compaction.
 *
 * The extra trailing code unit lets us remove a CR immediately before LF
 * without incorrectly truncating a logical line that is exactly at the limit.
 */
class BoundedReadLine {
  private length = 0;
  private shortContent = '';
  private head = '';
  private tail = '';

  append(value: string): void {
    if (!value) {
      return;
    }

    this.length += value.length;
    if (this.shortContent) {
      const combined = this.shortContent + value;
      if (this.length <= MAX_READ_LINE_LENGTH + 1) {
        this.shortContent = combined;
        return;
      }

      this.head = combined.slice(0, READ_LONG_LINE_HEAD_LENGTH);
      this.tail = combined.slice(-(READ_LONG_LINE_TAIL_LENGTH + 1));
      this.shortContent = '';
      return;
    }

    if (this.length <= MAX_READ_LINE_LENGTH + 1) {
      this.shortContent = value;
      return;
    }

    if (this.head.length < READ_LONG_LINE_HEAD_LENGTH) {
      this.head = (this.head + value).slice(0, READ_LONG_LINE_HEAD_LENGTH);
    }
    this.tail = (this.tail + value).slice(-(READ_LONG_LINE_TAIL_LENGTH + 1));
  }

  finish(): string {
    const hasTrailingCarriageReturn = this.endsWithCarriageReturn();
    const logicalLength = this.length - (hasTrailingCarriageReturn ? 1 : 0);

    if (this.shortContent) {
      const content = hasTrailingCarriageReturn
        ? this.shortContent.slice(0, -1)
        : this.shortContent;
      return compactBufferedReadLine(content);
    }

    if (logicalLength === 0) {
      return '';
    }

    const tailWithoutCarriageReturn = hasTrailingCarriageReturn
      ? this.tail.slice(0, -1)
      : this.tail;
    return [
      this.head.trimEnd(),
      READ_LONG_LINE_OMISSION_MARKER,
      READ_LONG_LINE_TAIL_LENGTH > 0
        ? tailWithoutCarriageReturn.slice(-READ_LONG_LINE_TAIL_LENGTH).trimStart()
        : '',
    ].join('');
  }

  private endsWithCarriageReturn(): boolean {
    if (this.length === 0) {
      return false;
    }
    const content = this.shortContent || this.tail;
    return content.endsWith('\r');
  }
}

function compactBufferedReadLine(line: string): string {
  if (line.length <= MAX_READ_LINE_LENGTH) {
    return line;
  }

  return [
    line.slice(0, READ_LONG_LINE_HEAD_LENGTH).trimEnd(),
    READ_LONG_LINE_OMISSION_MARKER,
    READ_LONG_LINE_TAIL_LENGTH > 0
      ? line.slice(-READ_LONG_LINE_TAIL_LENGTH).trimStart()
      : '',
  ].join('');
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspiciousControlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      suspiciousControlBytes += 1;
    }
  }
  return suspiciousControlBytes / buffer.length > 0.1;
}

function throwIfReadAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new DOMException('Read operation was aborted', 'AbortError');
  }
}

function readBufferAtMost(
  fd: number,
  maxContentBytes: number,
  abortSignal?: AbortSignal,
  startByte = 0,
): BoundedBufferReadResult {
  const buffer = Buffer.allocUnsafe(maxContentBytes + 1);
  let bytesReadTotal = 0;

  while (bytesReadTotal < buffer.length) {
    throwIfReadAborted(abortSignal);
    const bytesRead = fs.readSync(
      fd,
      buffer,
      bytesReadTotal,
      Math.min(PARTIAL_READ_CHUNK_BYTES, buffer.length - bytesReadTotal),
      startByte + bytesReadTotal,
    );
    if (bytesRead === 0) {
      break;
    }
    bytesReadTotal += bytesRead;
  }

  return {
    buffer: buffer.subarray(0, Math.min(bytesReadTotal, maxContentBytes)),
    bytesRead: bytesReadTotal,
    exceededLimit: bytesReadTotal > maxContentBytes,
  };
}

function readTextFileProbe(fd: number): TextFileProbe {
  const probe = Buffer.allocUnsafe(PARTIAL_READ_ENCODING_PROBE_BYTES);
  const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
  const content = probe.subarray(0, bytesRead);
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return {
      encoding: 'utf-16le',
      isLikelyBinary: false,
      note: '[Decoded as utf-16le; BOM detected.]',
    };
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return {
      encoding: 'utf-16be',
      isLikelyBinary: false,
      note: '[Decoded as utf-16be; BOM detected.]',
    };
  }
  if (isLikelyBinaryBuffer(content.subarray(0, BINARY_DETECTION_BYTES))) {
    return { encoding: 'utf-8', isLikelyBinary: true };
  }

  const decoded = decodeTextBuffer(trimIncompleteUtf8Probe(content));
  const encoding = decoded.note?.match(DECODED_ENCODING_PATTERN)?.[1] ?? 'utf-8';
  return { encoding, isLikelyBinary: false, note: decoded.note };
}

function isUtf16Encoding(encoding: string): boolean {
  return encoding === 'utf-16le' || encoding === 'utf-16be';
}

function readTextByteRange(
  fd: number,
  filePath: string,
  snapshotSize: number,
  requestedByteOffset: number,
  byteLimit: number,
  probe: TextFileProbe,
  abortSignal?: AbortSignal,
): string {
  const utf16 = isUtf16Encoding(probe.encoding);
  const byteOffset = utf16 && requestedByteOffset % 2 !== 0
    ? requestedByteOffset - 1
    : requestedByteOffset;
  if (byteOffset >= snapshotSize) {
    return `[No bytes in requested range: byte_offset ${requestedByteOffset} is beyond the file snapshot size of ${snapshotSize} bytes.]`;
  }

  if (utf16 && byteLimit < 2) {
    return `Error: byte_limit must be at least 2 for ${probe.encoding} text so Read can preserve code-unit alignment.`;
  }
  const alignedByteLimit = utf16 ? byteLimit - (byteLimit % 2) : byteLimit;
  const snapshotBytesRemaining = snapshotSize - byteOffset;
  const contentByteLimit = Math.min(alignedByteLimit, snapshotBytesRemaining);
  const rangeRead = readBufferAtMost(
    fd,
    contentByteLimit,
    abortSignal,
    byteOffset,
  );
  if (rangeRead.buffer.length === 0) {
    return `[No bytes could be read at byte_offset ${requestedByteOffset}; the file changed after the ${snapshotSize}-byte snapshot was captured. Retry Read to obtain a fresh snapshot before continuing.]`;
  }
  const endByteExclusive = byteOffset + rangeRead.buffer.length;
  const hasMoreBytes = rangeRead.exceededLimit || endByteExclusive < snapshotSize;
  const nextByteOffset = endByteExclusive;
  const adjustmentNote = byteOffset !== requestedByteOffset
    ? `Requested byte_offset ${requestedByteOffset} was aligned down to ${byteOffset} for ${probe.encoding} code-unit alignment.`
    : undefined;
  const rangeDescription = rangeRead.buffer.length > 0
    ? `${byteOffset}-${endByteExclusive - 1}`
    : `${byteOffset} (empty)`;
  const continuation = hasMoreBytes
    ? `More bytes are available; use byte_offset ${nextByteOffset} with byte_limit up to ${MAX_READ_BYTE_RANGE_BYTES} to continue.`
    : `Reached the end of the ${snapshotSize}-byte file snapshot.`;

  if (
    !utf16 &&
    isLikelyBinaryBuffer(rangeRead.buffer.subarray(0, BINARY_DETECTION_BYTES))
  ) {
    return [
      `[Binary data in requested byte range ${rangeDescription} of: ${path.basename(filePath)}]`,
      adjustmentNote,
      'Content was not decoded because this bounded byte range contains binary control bytes.',
      continuation,
    ].filter((line): line is string => line !== undefined).join('\n');
  }

  const content = new TextDecoder(probe.encoding).decode(rangeRead.buffer);
  const formatted = formatWithLineNumbers(content, 0);
  return [
    `[Byte range ${rangeDescription} of ${snapshotSize}-byte snapshot: ${filePath}]`,
    adjustmentNote,
    probe.note,
    'Line numbers are relative to this byte chunk. Its first and last decoded characters or lines may be fragments when the range splits a multibyte character or logical line.',
    '',
    formatted,
    '',
    `[${continuation}]`,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function trimIncompleteUtf8Probe(content: Buffer): Buffer {
  const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
  for (let trimBytes = 0; trimBytes <= 3 && trimBytes < content.length; trimBytes += 1) {
    const candidate = content.subarray(0, content.length - trimBytes);
    try {
      fatalUtf8Decoder.decode(candidate);
      return candidate;
    } catch {
      // A valid UTF-8 probe can end midway through a multi-byte code point.
    }
  }
  return content;
}

function scanDecodedText(
  fd: number,
  probe: TextFileProbe,
  consume: (text: string) => boolean | undefined,
  snapshotSize: number,
  abortSignal?: AbortSignal,
): DecodedTextScanResult {
  const decoder = new TextDecoder(probe.encoding);
  const buffer = Buffer.allocUnsafe(PARTIAL_READ_CHUNK_BYTES);
  const scanEnd = Math.min(Math.max(0, snapshotSize), MAX_READ_SCAN_BYTES);
  const startedAt = Date.now();
  let position = 0;

  while (position < scanEnd) {
    throwIfReadAborted(abortSignal);
    if (position > 0 && Date.now() - startedAt >= MAX_READ_SCAN_DURATION_MS) {
      return {
        completed: false,
        bytesRead: position,
        stopReason: 'time-limit',
        note: probe.note,
      };
    }

    const bytesRead = fs.readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, scanEnd - position),
      position,
    );
    if (bytesRead === 0) {
      if (consume(decoder.decode()) === false) {
        return {
          completed: false,
          bytesRead: position,
          stopReason: 'consumer',
          note: probe.note,
        };
      }
      return { completed: true, bytesRead: position, note: probe.note };
    }
    position += bytesRead;
    if (consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true })) === false) {
      return {
        completed: false,
        bytesRead: position,
        stopReason: 'consumer',
        note: probe.note,
      };
    }
  }

  if (snapshotSize > MAX_READ_SCAN_BYTES) {
    return {
      completed: false,
      bytesRead: position,
      stopReason: 'byte-limit',
      note: probe.note,
    };
  }

  if (consume(decoder.decode()) === false) {
    return {
      completed: false,
      bytesRead: position,
      stopReason: 'consumer',
      note: probe.note,
    };
  }
  return { completed: true, bytesRead: position, note: probe.note };
}

function readPartialText(
  fd: number,
  startLine: number,
  lineLimit: number,
  probe: TextFileProbe,
  snapshotSize: number,
  abortSignal?: AbortSignal,
): PartialTextReadResult {
  const selectedLines: string[] = [];
  const endLine = startLine + lineLimit;
  let currentLineIndex = 0;
  let currentLine = currentLineIndex >= startLine && currentLineIndex < endLine
    ? new BoundedReadLine()
    : undefined;
  let decodedLength = 0;
  let selectedCharacterCost = 0;
  let stoppedForOutputBudget = false;

  const consumeDecodedText = (text: string): boolean => {
    decodedLength += text.length;
    let segmentStart = 0;
    let newlineIndex = text.indexOf('\n');

    while (newlineIndex >= 0) {
      currentLine?.append(text.slice(segmentStart, newlineIndex));
      if (currentLine) {
        const completedLine = currentLine.finish();
        const formattedCost = completedLine.length + String(currentLineIndex + 1).length + 2;
        if (selectedCharacterCost + formattedCost > MAX_READ_TEXT_CONTENT_CHARS) {
          stoppedForOutputBudget = true;
          return false;
        }
        selectedLines.push(completedLine);
        selectedCharacterCost += formattedCost;
      }

      currentLineIndex += 1;
      if (selectedLines.length >= lineLimit) {
        return false;
      }
      currentLine = currentLineIndex >= startLine && currentLineIndex < endLine
        ? new BoundedReadLine()
        : undefined;
      segmentStart = newlineIndex + 1;
      newlineIndex = text.indexOf('\n', segmentStart);
    }

    currentLine?.append(text.slice(segmentStart));
    return true;
  };

  const scan = scanDecodedText(
    fd,
    probe,
    consumeDecodedText,
    snapshotSize,
    abortSignal,
  );
  const stoppedForScanLimit = scan.stopReason === 'byte-limit' ||
    scan.stopReason === 'time-limit';
  let includesPartialLine = false;

  if ((scan.completed || stoppedForScanLimit) && currentLine) {
    const completedLine = currentLine.finish();
    const formattedCost = completedLine.length + String(currentLineIndex + 1).length + 2;
    if (selectedCharacterCost + formattedCost > MAX_READ_TEXT_CONTENT_CHARS) {
      stoppedForOutputBudget = true;
    } else {
      selectedLines.push(completedLine);
      includesPartialLine = stoppedForScanLimit;
    }
  }

  return {
    lines: selectedLines,
    totalLines: scan.completed ? currentLineIndex + 1 : undefined,
    decodedLength,
    hasMoreLines: !scan.completed || stoppedForOutputBudget,
    scanLimit: stoppedForScanLimit
      ? {
          bytesRead: scan.bytesRead,
          reason: scan.stopReason as ReadScanLimit['reason'],
          includesPartialLine,
        }
      : undefined,
    note: scan.note,
  };
}

function summarizeTaskLogStream(
  fd: number,
  fileSize: number,
  filePath: string,
  probe: TextFileProbe,
  abortSignal?: AbortSignal,
): string {
  const counts: TaskLogSummaryCounts = {
    toolStart: 0,
    toolEnd: 0,
    text: 0,
    error: 0,
    read: 0,
    glob: 0,
    grep: 0,
    bash: 0,
    write: 0,
    edit: 0,
  };
  let pending = '';

  const countMatchesBefore = (content: string, startLimit: number): void => {
    for (const { key, pattern } of TASK_LOG_COUNT_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(content);
      while (match) {
        if ((match.index ?? 0) >= startLimit) {
          break;
        }
        counts[key] += 1;
        match = pattern.exec(content);
      }
    }
  };

  const scan = scanDecodedText(fd, probe, (text) => {
    const combined = pending + text;
    const deferredStart = Math.max(0, combined.length - TASK_LOG_PATTERN_OVERLAP);
    countMatchesBefore(combined, deferredStart);
    pending = combined.slice(deferredStart);
    return undefined;
  }, fileSize, abortSignal);
  countMatchesBefore(pending, Number.POSITIVE_INFINITY);

  const partialScope = scan.stopReason === 'byte-limit'
    ? `Summary scope: partial prefix only (${formatByteCount(scan.bytesRead)} scanned; synchronous scan byte limit reached).`
    : scan.stopReason === 'time-limit'
      ? `Summary scope: partial prefix only (${formatByteCount(scan.bytesRead)} scanned; synchronous scan time limit reached).`
      : undefined;
  const continuationGuidance = partialScope
    ? `Use byte_offset ${scan.bytesRead} with byte_limit up to ${MAX_READ_BYTE_RANGE_BYTES} to inspect the next bounded text chunk, or use explicit line offset/limit for ranges within the scanned prefix.`
    : 'Use explicit offset/limit only when this task is specifically debugging the log file.';

  return [
    `[Task log file: ${filePath}]`,
    `Size: ${fileSize} bytes`,
    partialScope,
    `Entries: tool_start=${counts.toolStart}, tool_end=${counts.toolEnd}, text=${counts.text}, error=${counts.error}`,
    `Tools: Read=${counts.read}, Glob=${counts.glob}, Grep=${counts.grep}, Bash=${counts.bash}, Write=${counts.write}, Edit=${counts.edit}`,
    '',
    'Full task logs are intentionally not returned by default because they can contain large prior tool outputs and amplify context usage.',
    continuationGuidance,
  ].filter((line): line is string => line !== undefined).join('\n');
}

function formatByteCount(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)}MB`;
  }
  return `${Math.ceil(bytes / 1024)}KB`;
}

function formatBinaryReadResult(filePath: string, fileSize: number): string {
  return [
    `[Binary file: ${path.basename(filePath)}, size: ${fileSize} bytes]`,
    'Content was not decoded because the bounded file prefix contains binary control bytes.',
  ].join('\n');
}

function formatPdfMetadata(filePath: string, fileSize: number, pages?: string): string {
  const requestedPages = pages ? `, requested pages: ${pages}` : '';
  return [
    `[PDF file: ${path.basename(filePath)}, size: ${Math.round(fileSize / 1024)}KB${requestedPages}]`,
    'The built-in Read tool reports PDF metadata only and does not extract page content.',
    `File exists at: ${filePath}`,
  ].join('\n');
}

function formatPartialTextRead(
  result: PartialTextReadResult,
  startLine: number,
  note?: string,
): string {
  const prefix = note ? `${note}\n\n` : '';
  if (result.totalLines !== undefined && startLine >= result.totalLines) {
    return `${prefix}[No lines in requested range: offset ${startLine} is beyond the file's ${result.totalLines} total lines.]`;
  }

  if (result.scanLimit && result.lines.length === 0) {
    const reason = result.scanLimit.reason === 'byte-limit'
      ? 'the synchronous scan byte limit'
      : 'the synchronous scan time limit';
    return `${prefix}[Read stopped after ${formatByteCount(result.scanLimit.bytesRead)} because it reached ${reason} before line offset ${startLine}. Use byte_offset ${result.scanLimit.bytesRead} with byte_limit up to ${MAX_READ_BYTE_RANGE_BYTES} to inspect the next bounded chunk, or use a targeted search command.]`;
  }

  const endLine = startLine + result.lines.length;
  const formatted = formatWithLineNumbers(result.lines.join('\n'), startLine);
  if (result.scanLimit) {
    const reason = result.scanLimit.reason === 'byte-limit'
      ? 'synchronous scan byte limit'
      : 'synchronous scan time limit';
    const partialLineNote = result.scanLimit.includesPartialLine
      ? ' The final displayed line is only the prefix scanned within that limit.'
      : '';
    return `${prefix}${formatted}\n\n[Read stopped after ${formatByteCount(result.scanLimit.bytesRead)} at the ${reason}.${partialLineNote} Use byte_offset ${result.scanLimit.bytesRead} with byte_limit up to ${MAX_READ_BYTE_RANGE_BYTES} to inspect the next bounded chunk, or use a targeted search command.]`;
  }
  if (result.hasMoreLines) {
    return `${prefix}${formatted}\n\n[Showing lines ${startLine + 1}-${endLine}. More lines are available; use offset ${endLine} with a bounded limit to continue.]`;
  }
  if (result.totalLines !== undefined && endLine < result.totalLines) {
    return `${prefix}${formatted}\n\n[Showing lines ${startLine + 1}-${endLine} of ${result.totalLines} total lines]`;
  }
  return `${prefix}${formatted}`;
}

function boundReadOutput(output: string): string {
  if (output.length <= MAX_READ_OUTPUT_CHARS) {
    return output;
  }

  const noticeReserve = 180;
  const prefixBudget = MAX_READ_OUTPUT_CHARS - noticeReserve;
  const candidate = output.slice(0, prefixBudget);
  const lastLineBreak = candidate.lastIndexOf('\n');
  const safePrefix = lastLineBreak >= Math.floor(prefixBudget / 2)
    ? candidate.slice(0, lastLineBreak)
    : candidate;
  const numberedLines = [...safePrefix.matchAll(/^\s*(\d+)\t/gm)];
  const lastLineNumber = numberedLines.at(-1)?.[1];
  const continuation = lastLineNumber
    ? ` Use offset ${lastLineNumber} with a bounded limit to continue.`
    : ' Use offset/limit to request a smaller continuation range.';
  const notice = `\n\n[Read output capped at 72KB.${continuation}]`;
  return `${safePrefix}${notice}`;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const readTool = Tool.define({
  metadata: {
    name: 'Read',
    description:
      'Reads bounded text ranges from the local filesystem with line numbers. Supports byte_offset/byte_limit for direct continuation into deep regions of very large text files, returns supported images within the size limit as base64, and reports PDF metadata without extracting page text.',
    permission: ToolPermission.ReadOnly,
    executionOptions: DEFAULT_EXECUTION_OPTIONS,
  },
  inputSchema,
  execute: async (input, context) => {
    let { file_path, offset, limit, byte_offset, byte_limit, pages } = input;

    throwIfReadAborted(context.abortSignal);
    file_path = normalizeReadPathInput(file_path);

    const allowedRoots = context.allowedPathRoots?.length ? context.allowedPathRoots : context.projectDir;

    // Security: prefer normal directory containment. Explicit file references
    // are a Read-only fallback and never become directory roots.
    let resolvedPath: string;
    let exactFileAuthorizationUsed = false;
    try {
      ({ resolvedPath } = assertPathContained(file_path, allowedRoots));
    } catch (containmentError) {
      if (!context.allowedExactFilePaths?.length) {
        throw containmentError;
      }
      ({ resolvedPath } = assertExactFilePathAllowed(
        file_path,
        context.allowedExactFilePaths,
      ));
      exactFileAuthorizationUsed = true;
    }

    // Exact external references must be tied to a freshly opened handle. A
    // path-only cache entry could otherwise outlive a replaced attachment.
    const cache = exactFileAuthorizationUsed
      ? undefined
      : context.fileCache as FileContentCache | undefined;
    if (cache && !pages && byte_offset === undefined) {
      const cached = cache.getSync(resolvedPath);
      if (cached) {
        if (cached.length === 0) {
          return `[File exists but is empty: ${file_path}]`;
        }
        const cachedSize = Buffer.byteLength(cached, 'utf-8');
        if (
          isTaskLogFile(resolvedPath) &&
          isActiveTaskLogFile(resolvedPath, context.specDir) &&
          offset === undefined &&
          limit === undefined &&
          cachedSize > TASK_LOG_SUMMARY_BYTES
        ) {
          return summarizeTaskLog(cached, file_path);
        }
        const hasExplicitRange = offset !== undefined || limit !== undefined;
        const { lineLimit, isLargeFileDefault } = getEffectiveReadLineLimit(
          cachedSize,
          context.workflowMode,
          hasExplicitRange,
          limit,
        );
        return boundReadOutput(formatReadContent(
          cached,
          offset ?? 0,
          lineLimit,
          isLargeFileDefault
            ? {
                note: buildLargeReadFileNote(cachedSize, lineLimit),
              }
            : undefined,
        ));
      }
    }

    // Open fd once; all subsequent stat/read operations use this fd to avoid TOCTOU.
    let fd: number;
    try {
      fd = fs.openSync(resolvedPath, 'r');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return `Error: File not found: ${file_path}`;
      }
      if (code === 'EISDIR') {
        return `Error: '${file_path}' is a directory, not a file. Use the Bash tool with ls to list directory contents.`;
      }
      throw err;
    }
    try {
      if (exactFileAuthorizationUsed) {
        ({ resolvedPath } = assertOpenedExactFilePathAllowed(
          file_path,
          context.allowedExactFilePaths ?? [],
          fd,
        ));
      }

      const stat = fs.fstatSync(fd);
      if (stat.isDirectory()) {
        return `Error: '${file_path}' is a directory, not a file. Use the Bash tool with ls to list directory contents.`;
      }
      if (!stat.isFile()) {
        return `Error: '${file_path}' is not a regular file. Read refuses devices, sockets, and named pipes.`;
      }

      const pdfFile = isPdfFile(resolvedPath);
      if (pages && !pdfFile) {
        return `Error: The pages parameter is only valid for PDF files: ${file_path}`;
      }
      if (byte_offset !== undefined && (pdfFile || isImageFile(resolvedPath))) {
        return `Error: byte_offset is only valid for text files: ${file_path}`;
      }

      // Image files are read with cap + 1, so growth after fstat cannot bypass
      // the base64 expansion limit.
      if (isImageFile(resolvedPath)) {
        if (stat.size > MAX_READ_IMAGE_BYTES) {
          return `Error: Image file exceeds the ${MAX_READ_IMAGE_BYTES / 1024}KB inline Read limit: ${file_path}`;
        }
        const imageRead = readBufferAtMost(
          fd,
          MAX_READ_IMAGE_BYTES,
          context.abortSignal,
        );
        if (imageRead.exceededLimit) {
          return `Error: Image file exceeds the ${MAX_READ_IMAGE_BYTES / 1024}KB inline Read limit: ${file_path}`;
        }
        const base64 = imageRead.buffer.toString('base64');
        return formatImageReadResult(resolvedPath, base64);
      }

      // PDF files: size comes from the same fstat.
      if (pdfFile) {
        return formatPdfMetadata(resolvedPath, stat.size, pages);
      }

      if (stat.size === 0) {
        return `[File exists but is empty: ${file_path}]`;
      }

      const textProbe = readTextFileProbe(fd);
      if (textProbe.isLikelyBinary) {
        return formatBinaryReadResult(resolvedPath, stat.size);
      }

      if (byte_offset !== undefined) {
        return readTextByteRange(
          fd,
          resolvedPath,
          stat.size,
          byte_offset,
          byte_limit ?? MAX_READ_BYTE_RANGE_BYTES,
          textProbe,
          context.abortSignal,
        );
      }

      const startLine = offset ?? 0;
      const hasExplicitRange = offset !== undefined || limit !== undefined;
      const { lineLimit, isLargeFileDefault } = getEffectiveReadLineLimit(
        stat.size,
        context.workflowMode,
        hasExplicitRange,
        limit,
      );

      if (
        !hasExplicitRange &&
        isTaskLogFile(resolvedPath) &&
        isActiveTaskLogFile(resolvedPath, context.specDir) &&
        stat.size > TASK_LOG_SUMMARY_BYTES
      ) {
        return summarizeTaskLogStream(
          fd,
          stat.size,
          file_path,
          textProbe,
          context.abortSignal,
        );
      }

      if (hasExplicitRange || isLargeFileDefault) {
        const partial = readPartialText(
          fd,
          startLine,
          lineLimit,
          textProbe,
          stat.size,
          context.abortSignal,
        );
        if (partial.decodedLength === 0) {
          return `[File exists but is empty: ${file_path}]`;
        }
        const note = joinReadNotes(
          partial.note,
          isLargeFileDefault
            ? buildLargeReadFileNote(stat.size, lineLimit)
            : undefined,
        );
        return boundReadOutput(formatPartialTextRead(partial, startLine, note));
      }

      // Small text files use a cap + 1 read. If the file grows across the
      // large-file threshold, fall back to the bounded scanner instead of
      // allocating the newly grown file in full.
      const fullRead = readBufferAtMost(
        fd,
        LARGE_TEXT_FILE_BYTES,
        context.abortSignal,
      );
      if (fullRead.exceededLimit) {
        const latestStat = fs.fstatSync(fd);
        const observedSize = Math.max(stat.size, latestStat.size, fullRead.bytesRead);

        if (
          isTaskLogFile(resolvedPath) &&
          isActiveTaskLogFile(resolvedPath, context.specDir) &&
          observedSize > TASK_LOG_SUMMARY_BYTES
        ) {
          return summarizeTaskLogStream(
            fd,
            observedSize,
            file_path,
            textProbe,
            context.abortSignal,
          );
        }

        const grownFileLimits = getEffectiveReadLineLimit(
          observedSize,
          context.workflowMode,
          false,
          limit,
        );
        const partial = readPartialText(
          fd,
          startLine,
          grownFileLimits.lineLimit,
          textProbe,
          observedSize,
          context.abortSignal,
        );
        const note = joinReadNotes(
          partial.note,
          buildLargeReadFileNote(observedSize, grownFileLimits.lineLimit),
        );
        return boundReadOutput(formatPartialTextRead(partial, startLine, note));
      }

      if (
        !isUtf16Encoding(textProbe.encoding) &&
        isLikelyBinaryBuffer(fullRead.buffer.subarray(0, BINARY_DETECTION_BYTES))
      ) {
        return formatBinaryReadResult(
          resolvedPath,
          Math.max(stat.size, fullRead.bytesRead),
        );
      }

      const content = new TextDecoder(textProbe.encoding).decode(fullRead.buffer);

      // Cache the content if no offset/limit (full file read)
      if (cache && !offset && !limit) {
        cache.set(resolvedPath, content, stat.mtimeMs);
      }

      if (content.length === 0) {
        return `[File exists but is empty: ${file_path}]`;
      }

      const note = joinReadNotes(
        textProbe.note,
        isLargeFileDefault
          ? buildLargeReadFileNote(stat.size, lineLimit)
          : undefined,
      );

      return boundReadOutput(formatReadContent(
        content,
        startLine,
        lineLimit,
        note ? { note } : undefined,
      ));
    } finally {
      fs.closeSync(fd);
    }
  },
});
