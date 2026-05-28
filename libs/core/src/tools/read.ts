import * as path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

export const DEFAULT_READ_LINE_LIMIT = 500;
export const BALANCED_READ_LINE_LIMIT = 400;
export const AGGRESSIVE_READ_LINE_LIMIT = 120;
export const LARGE_TEXT_FILE_BYTES = 512 * 1024;
export const LARGE_TEXT_DEFAULT_LINE_LIMIT = 200;
export const TASK_LOG_SUMMARY_BYTES = 256 * 1024;
export const MAX_READ_LINE_LENGTH = 2000;
export const LEGACY_TEXT_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'windows-1252'] as const;

export const READ_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
] as const;

export const READ_PDF_EXTENSION = '.pdf';

const READ_IMAGE_EXTENSION_SET: ReadonlySet<string> = new Set(READ_IMAGE_EXTENSIONS);

export type ReadWorkflowMode = 'aggressive' | 'balanced' | string | undefined;

export interface DecodedTextBuffer {
  content: string;
  note?: string;
}

export interface EffectiveReadLimit {
  lineLimit: number;
  isLargeFileDefault: boolean;
}

export function normalizeReadPathInput(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function normalizeComparableReadPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

export function isImageFile(filePath: string): boolean {
  return READ_IMAGE_EXTENSION_SET.has(path.extname(filePath).toLowerCase());
}

export function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === READ_PDF_EXTENSION;
}

export function isTaskLogFile(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === 'task_logs.json';
}

export function isActiveTaskLogFile(filePath: string, specDir: string): boolean {
  return normalizeComparableReadPath(filePath) ===
    normalizeComparableReadPath(path.join(specDir, 'task_logs.json'));
}

export function getDefaultReadLineLimit(workflowMode: ReadWorkflowMode): number {
  if (workflowMode === 'aggressive') {
    return AGGRESSIVE_READ_LINE_LIMIT;
  }
  if (workflowMode === 'balanced') {
    return BALANCED_READ_LINE_LIMIT;
  }
  return DEFAULT_READ_LINE_LIMIT;
}

export function getEffectiveReadLineLimit(
  fileSizeBytes: number,
  workflowMode: ReadWorkflowMode,
  hasExplicitRange: boolean,
  requestedLimit?: number,
): EffectiveReadLimit {
  const isLargeFileDefault = fileSizeBytes > LARGE_TEXT_FILE_BYTES && !hasExplicitRange;
  return {
    lineLimit: requestedLimit ?? (
      isLargeFileDefault
        ? LARGE_TEXT_DEFAULT_LINE_LIMIT
        : getDefaultReadLineLimit(workflowMode)
    ),
    isLargeFileDefault,
  };
}

export function buildLargeReadFileNote(fileSizeBytes: number, lineLimit: number): string {
  return `[Large file: ${Math.round(fileSizeBytes / 1024)}KB. Showing the first ${lineLimit} lines by default; use offset/limit for a specific range.]`;
}

export function formatWithLineNumbers(content: string, offset: number): string {
  const lines = content.split(/\r?\n/);
  const maxLineNum = offset + lines.length;
  const padWidth = String(maxLineNum).length;

  return lines
    .map((line, index) => {
      const lineNum = String(offset + index + 1).padStart(padWidth, ' ');
      const truncated =
        line.length > MAX_READ_LINE_LENGTH
          ? `${line.slice(0, MAX_READ_LINE_LENGTH)}... (truncated)`
          : line;
      return `${lineNum}\t${truncated}`;
    })
    .join('\n');
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function scoreDecodedText(text: string): number {
  const replacementCount = countMatches(text, /\uFFFD/g);
  const controlCount = countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g);
  const extendedLatinCount = countMatches(text, /[\u00A0-\u00FF]/g);
  const cjkCount = countMatches(text, /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/g);
  const singleCjkPenalty = cjkCount > 0 && cjkCount < 2 ? 10 : 0;
  const cjkBonus = cjkCount >= 2 ? Math.min(cjkCount, 100) * 2 : 0;
  return (replacementCount * 1000) + (controlCount * 100) + (extendedLatinCount * 3) +
    singleCjkPenalty - cjkBonus;
}

export function decodeTextBuffer(input: Uint8Array | string): DecodedTextBuffer {
  if (typeof input === 'string') {
    return { content: input };
  }

  const utf8 = new TextDecoder('utf-8').decode(input);
  const utf8ReplacementCount = countMatches(utf8, /\uFFFD/g);
  if (utf8ReplacementCount === 0) {
    return { content: utf8 };
  }

  const candidates: Array<{ encoding: string; content: string; score: number }> = [
    { encoding: 'utf-8', content: utf8, score: scoreDecodedText(utf8) },
  ];

  for (const encoding of LEGACY_TEXT_ENCODINGS) {
    try {
      const content = new TextDecoder(encoding).decode(input);
      candidates.push({ encoding, content, score: scoreDecodedText(content) });
    } catch {
      // Ignore encodings not supported by the current Node/ICU build.
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best || best.encoding === 'utf-8') {
    return { content: utf8 };
  }

  return {
    content: best.content,
    note: `[Decoded as ${best.encoding}; file was not valid UTF-8.]`,
  };
}

export function joinReadNotes(...notes: Array<string | undefined>): string | undefined {
  const filtered = notes.filter((note): note is string => Boolean(note));
  return filtered.length > 0 ? filtered.join('\n') : undefined;
}

export function formatReadContent(
  content: string,
  startLine: number,
  lineLimit: number,
  options: { note?: string } = {},
): string {
  const lines = content.split(/\r?\n/);
  const sliced = lines.slice(startLine, startLine + lineLimit);
  const result = formatWithLineNumbers(sliced.join('\n'), startLine);

  const totalLines = lines.length;
  const prefix = options.note ? `${options.note}\n\n` : '';
  if (startLine + lineLimit < totalLines) {
    return `${prefix}${result}\n\n[Showing lines ${startLine + 1}-${startLine + lineLimit} of ${totalLines} total lines]`;
  }

  return `${prefix}${result}`;
}

export function summarizeTaskLog(content: string, filePath: string): string {
  const count = (pattern: RegExp) => (content.match(pattern) ?? []).length;
  const byteLength = new TextEncoder().encode(content).length;
  return [
    `[Task log file: ${filePath}]`,
    `Size: ${byteLength} bytes`,
    `Entries: tool_start=${count(/"type"\s*:\s*"tool_start"/g)}, tool_end=${count(/"type"\s*:\s*"tool_end"/g)}, text=${count(/"type"\s*:\s*"text"/g)}, error=${count(/"type"\s*:\s*"error"/g)}`,
    `Tools: Read=${count(/"tool_name"\s*:\s*"Read"/g)}, Glob=${count(/"tool_name"\s*:\s*"Glob"/g)}, Grep=${count(/"tool_name"\s*:\s*"Grep"/g)}, Bash=${count(/"tool_name"\s*:\s*"Bash"/g)}, Write=${count(/"tool_name"\s*:\s*"Write"/g)}, Edit=${count(/"tool_name"\s*:\s*"Edit"/g)}`,
    '',
    'Full task logs are intentionally not returned by default because they can contain large prior tool outputs and amplify context usage.',
    'Use explicit offset/limit only when this task is specifically debugging the log file.',
  ].join('\n');
}

export function formatImageReadResult(filePath: string, base64: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return `[Image file: ${path.basename(filePath)}]\ndata:${mimeType};base64,${base64}`;
}

export function formatPdfReadResult(
  filePath: string,
  fileSizeBytes: number,
  pages?: string,
): string {
  if (pages) {
    return `[PDF file: ${path.basename(filePath)}, pages: ${pages}]\nPDF reading requires external tooling. File exists at: ${filePath}`;
  }
  const fileSizeKb = Math.round(fileSizeBytes / 1024);
  return `[PDF file: ${path.basename(filePath)}, size: ${fileSizeKb}KB]\nUse the 'pages' parameter to read specific page ranges.`;
}
