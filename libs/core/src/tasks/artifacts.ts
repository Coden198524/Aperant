export const AUTOCODE_PROJECT_DATA_DIR_NAME = '.autocode';
export const AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME = '.auto-claude';
export const AUTOCODE_SPECS_DIR_NAME = 'specs';

export const AUTOCODE_TASK_ARTIFACTS = {
  implementationPlan: 'implementation_plan.json',
  specFile: 'spec.md',
  requirements: 'requirements.json',
  taskMetadata: 'task_metadata.json',
  taskLogs: 'task_logs.json',
  directSummary: 'direct_summary.md',
  qaReport: 'qa_report.md',
  runResult: 'autocode-run-result.json',
} as const;

export type AutocodeTaskArtifactName = keyof typeof AUTOCODE_TASK_ARTIFACTS;
export type AutocodeTaskArtifactFileName = (typeof AUTOCODE_TASK_ARTIFACTS)[AutocodeTaskArtifactName];

export const AUTOCODE_TASK_ARTIFACT_FILE_NAMES: ReadonlySet<string> = new Set(
  Object.values(AUTOCODE_TASK_ARTIFACTS),
);

export function normalizeAutocodeProjectDataDirName(value?: string): string {
  const dataDirName = (value?.trim() || AUTOCODE_PROJECT_DATA_DIR_NAME)
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+$/, '');
  const normalized = dataDirName.replace(/\\/g, '/');
  if (
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error('dataDirName must be a project-relative directory.');
  }
  return dataDirName;
}

export function getAutocodeSpecsRelativeDir(dataDirName?: string): string {
  return `${normalizeAutocodeProjectDataDirName(dataDirName).replace(/\\/g, '/')}/${AUTOCODE_SPECS_DIR_NAME}`;
}

export function isAutocodeTaskArtifactFileName(fileName: string): fileName is AutocodeTaskArtifactFileName {
  return AUTOCODE_TASK_ARTIFACT_FILE_NAMES.has(fileName);
}
