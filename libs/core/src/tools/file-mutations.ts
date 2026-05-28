export interface EditPlanSuccess {
  ok: true;
  content: string;
  occurrenceCount: number;
  message: string;
}

export interface EditPlanFailure {
  ok: false;
  error: string;
}

export type EditPlanResult = EditPlanSuccess | EditPlanFailure;

export function normalizeFileMutationPathInput(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function countContentLines(content: string): number {
  return content.split(/\r?\n/).length;
}

export function formatWriteSuccess(filePath: string, content: string): string {
  return `Successfully wrote ${countContentLines(content)} lines to ${filePath}`;
}

export function validateJsonWriteContent(
  filePath: string,
  content: string,
): void {
  if (!filePath.endsWith('.json')) {
    return;
  }

  try {
    JSON.parse(content);
  } catch (jsonError) {
    const errorMsg = jsonError instanceof Error ? jsonError.message : String(jsonError);
    throw new Error(
      `Invalid JSON content: ${errorMsg}. Please ensure the JSON is properly formatted with escaped special characters.`,
    );
  }
}

export function countExactOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

export function formatEditFileNotFound(filePath: string): string {
  return `Error: File not found: ${filePath}`;
}

export function getEditInputValidationError(
  oldString: string,
  newString: string,
): string | null {
  if (oldString === newString) {
    return 'Error: old_string and new_string are identical. No changes needed.';
  }
  return null;
}

export function buildEditPlan(
  content: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): EditPlanResult {
  const inputError = getEditInputValidationError(oldString, newString);
  if (inputError) {
    return {
      ok: false,
      error: inputError,
    };
  }

  if (!content.includes(oldString)) {
    return {
      ok: false,
      error: `Error: old_string not found in ${filePath}. Make sure the string matches exactly, including whitespace and indentation.`,
    };
  }

  const occurrenceCount = countExactOccurrences(content, oldString);
  if (!replaceAll && occurrenceCount > 1) {
    return {
      ok: false,
      error: `Error: old_string appears ${occurrenceCount} times in ${filePath}. Provide more context to make it unique, or use replace_all: true to replace all occurrences.`,
    };
  }

  const newContent = replaceAll
    ? content.split(oldString).join(newString)
    : replaceFirstExact(content, oldString, newString);

  return {
    ok: true,
    content: newContent,
    occurrenceCount,
    message: replaceAll
      ? `Successfully replaced ${occurrenceCount} occurrence(s) in ${filePath}`
      : `Successfully edited ${filePath}`,
  };
}

function replaceFirstExact(
  content: string,
  oldString: string,
  newString: string,
): string {
  const index = content.indexOf(oldString);
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}
