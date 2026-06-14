export const SPEC_TASK_DESCRIPTION_FROM_INITIAL_MAX_CHARS = 4_000;

const SPEC_TASK_DESCRIPTION_TRUNCATION_MARKER =
  '\n\n...[task description middle omitted for worker budget; inspect task metadata if exact omitted detail is required]...\n\n';

const SPEC_TASK_METADATA_LINE_PATTERN =
  /^(Project directory|Spec directory|Base branch|Auto-approve|Require review before coding)\s*:/i;

export function extractSpecTaskDescriptionFromInitialMessages(
  initialMessages: Array<{ content: unknown }> | undefined,
): string {
  const firstContent = initialMessages?.[0]?.content;
  const raw = typeof firstContent === 'string'
    ? firstContent
    : 'Create the specification as described in your system prompt.';
  return compactSpecTaskDescription(cleanSpecTaskDescription(raw));
}

function cleanSpecTaskDescription(value: string): string {
  const withoutProjectDocs = value
    .split(/\n(?=#{1,3}\s*Project Documentation Reference\b|Project Documentation Reference\b)/i)[0]
    .trim();
  const lines = withoutProjectDocs
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  const taskLineIndex = lines.findIndex((line) => /^Task\s*:/i.test(line.trim()));
  const relevantLines = taskLineIndex >= 0 ? lines.slice(taskLineIndex) : lines;
  const cleaned: string[] = [];

  for (let index = 0; index < relevantLines.length; index++) {
    const rawLine = relevantLines[index];
    const trimmed = rawLine.trim();
    if (SPEC_TASK_METADATA_LINE_PATTERN.test(trimmed)) {
      break;
    }
    if (index === 0 && /^Task\s*:/i.test(trimmed)) {
      const withoutPrefix = rawLine.replace(/^(\s*)Task\s*:\s*/i, '$1');
      if (withoutPrefix.trim()) {
        cleaned.push(withoutPrefix);
      }
      continue;
    }
    cleaned.push(rawLine);
  }

  const result = cleaned
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return result || 'Create the specification as described in your system prompt.';
}

function compactSpecTaskDescription(value: string): string {
  if (value.length <= SPEC_TASK_DESCRIPTION_FROM_INITIAL_MAX_CHARS) {
    return value;
  }
  const budget = Math.max(0, SPEC_TASK_DESCRIPTION_FROM_INITIAL_MAX_CHARS - SPEC_TASK_DESCRIPTION_TRUNCATION_MARKER.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    value.slice(0, headLength).trimEnd(),
    SPEC_TASK_DESCRIPTION_TRUNCATION_MARKER,
    value.slice(-tailLength).trimStart(),
  ].join('');
}
