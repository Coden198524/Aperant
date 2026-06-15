export const BROWSE_CONTENT_MAX_CHARS = 20_000;
export const BROWSE_CONTENT_MAX_LINE_LENGTH = 1000;
export const BROWSE_CONTENT_REPEATED_LINE_THRESHOLD = 4;

const BROWSE_CONTENT_OMISSION_MARKER =
  '\n\n[Content middle omitted for context budget]\n\n';
const BROWSE_LINE_OMISSION_MARKER = ' ... [line middle omitted] ... ';
const BROWSE_CONTENT_HEAD_RATIO = 0.6;
const BROWSE_LINE_HEAD_RATIO = 0.6;

export function compactBrowseContent(
  content: string,
  maxChars: number = BROWSE_CONTENT_MAX_CHARS,
): string {
  const normalized = normalizeBrowseContent(content);
  if (maxChars <= 0 || normalized.length <= maxChars) {
    return normalized;
  }
  if (BROWSE_CONTENT_OMISSION_MARKER.length >= maxChars - 2) {
    return normalized.slice(0, maxChars);
  }

  const budget = maxChars - BROWSE_CONTENT_OMISSION_MARKER.length;
  const headChars = Math.ceil(budget * BROWSE_CONTENT_HEAD_RATIO);
  const tailChars = Math.max(0, budget - headChars);
  return [
    normalized.slice(0, headChars).trimEnd(),
    BROWSE_CONTENT_OMISSION_MARKER,
    tailChars > 0 ? normalized.slice(-tailChars).trimStart() : '',
  ].join('');
}

function normalizeBrowseContent(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const normalizedLines: string[] = [];
  let blankRunLength = 0;

  for (const line of lines) {
    const compactLine = compactBrowseContentLine(line.trimEnd(), BROWSE_CONTENT_MAX_LINE_LENGTH);
    if (compactLine.trim().length === 0) {
      blankRunLength += 1;
      if (blankRunLength <= 1) {
        normalizedLines.push('');
      }
      continue;
    }

    blankRunLength = 0;
    normalizedLines.push(compactLine);
  }

  return collapseRepeatedBrowseContentLines(normalizedLines).join('\n').trim();
}

function collapseRepeatedBrowseContentLines(lines: string[]): string[] {
  const folded: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    let runLength = 1;
    while (index + runLength < lines.length && lines[index + runLength] === line) {
      runLength += 1;
    }

    if (line.trim() && runLength >= BROWSE_CONTENT_REPEATED_LINE_THRESHOLD) {
      folded.push(line, `[... ${runLength - 1} repeated content line(s) omitted ...]`);
    } else {
      folded.push(...lines.slice(index, index + runLength));
    }
    index += runLength;
  }
  return folded;
}

function compactBrowseContentLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }
  if (maxLength <= BROWSE_LINE_OMISSION_MARKER.length + 2) {
    return line.slice(0, maxLength);
  }

  const budget = maxLength - BROWSE_LINE_OMISSION_MARKER.length;
  const headLength = Math.ceil(budget * BROWSE_LINE_HEAD_RATIO);
  const tailLength = Math.max(0, budget - headLength);
  return [
    line.slice(0, headLength).trimEnd(),
    BROWSE_LINE_OMISSION_MARKER,
    tailLength > 0 ? line.slice(-tailLength).trimStart() : '',
  ].join('');
}
