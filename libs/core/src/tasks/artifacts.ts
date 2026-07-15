export const AUTOCODE_PROJECT_DATA_DIR_NAME = '.autocode';
export const AUTOCODE_LEGACY_PROJECT_DATA_DIR_NAME = '.auto-claude';
export const AUTOCODE_SPECS_DIR_NAME = 'specs';

export const AUTOCODE_TASK_ARTIFACTS = {
  context: 'context.md',
  research: 'research.md',
  design: 'design.md',
  requirementModel: 'requirement_model.md',
  domainModel: 'domain_model.md',
  designModel: 'design_model.md',
  implementationModel: 'implementation_model.md',
  designReview: 'design_review.md',
  tasks: 'tasks.md',
  implementationPlan: 'implementation_plan.md',
  specFile: 'spec.md',
  requirements: 'requirements.md',
  taskMetadata: 'task_metadata.json',
  taskLogs: 'task_logs.jsonl',
  directSummary: 'direct_summary.md',
  directSession: 'direct_session.json',
  critiqueReport: 'critique_report.md',
  qaReport: 'qa_report.md',
  runResult: 'autocode-run-result.json',
  planningTransaction: 'planning-transaction.json',
} as const;

export const AUTOCODE_STANDARD_DESIGN_MODEL_ARTIFACTS = [
  AUTOCODE_TASK_ARTIFACTS.requirementModel,
  AUTOCODE_TASK_ARTIFACTS.domainModel,
  AUTOCODE_TASK_ARTIFACTS.designModel,
  AUTOCODE_TASK_ARTIFACTS.implementationModel,
] as const;

export const AUTOCODE_STANDARD_DESIGN_PACKAGE_ARTIFACTS = [
  AUTOCODE_TASK_ARTIFACTS.design,
  ...AUTOCODE_STANDARD_DESIGN_MODEL_ARTIFACTS,
] as const;

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
