import { normalizeAutocodeProjectDataDirName } from '../tasks/artifacts.js';

export const AUTOCODE_ROADMAP_DIR_NAME = 'roadmap';
export const AUTOCODE_IDEATION_DIR_NAME = 'ideation';
export const AUTOCODE_INSIGHTS_DIR_NAME = 'insights';
export const AUTOCODE_INSIGHTS_SESSIONS_DIR_NAME = 'sessions';
export const AUTOCODE_PROJECT_LOCKS_DIR_NAME = '.locks';
export const AUTOCODE_PROJECT_PROMPTS_DIR_NAME = 'prompts';
export const AUTOCODE_PROJECT_DOCS_DIR_NAME = 'project-docs';
export const AUTOCODE_TOOL_OUTPUT_DIR_NAME = 'tool-output';
export const AUTOCODE_SMART_TERMINAL_DIR_NAME = 'smart-terminal';
export const AUTOCODE_DEEPSEEK_SMART_TERMINAL_DIR_NAME = 'deepseek';
export const AUTOCODE_GITHUB_DIR_NAME = 'github';
export const AUTOCODE_GITLAB_DIR_NAME = 'gitlab';
export const AUTOCODE_YUNXIAO_DIR_NAME = 'yunxiao';

export const AUTOCODE_PROJECT_INDEX_FILE_NAME = 'project_index.json';
export const AUTOCODE_PROJECT_ENV_FILE_NAME = '.env';
export const AUTOCODE_GENERATION_PROGRESS_FILE_NAME = 'generation_progress.json';
export const AUTOCODE_SPEC_NUMBER_LOCK_FILE_NAME = 'spec-numbering.lock';
export const AUTOCODE_PROJECT_PROMPT_PROFILE_FILE_NAME = 'prompt_profile.json';
export const AUTOCODE_GITHUB_TMP_COMMENT_BODY_FILE_NAME = 'tmp_comment_body.txt';
export const AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME = 'index.md';
export const AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME = 'product.md';
export const AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME = 'architecture.md';
export const AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME = 'technical.md';
export const AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME = 'doc_outline.json';
export const AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME = 'evidence_index.json';

export const AUTOCODE_ROADMAP_FILE_NAME = 'roadmap.json';
export const AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME = 'roadmap_discovery.json';
export const AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME = 'competitor_analysis.json';
export const AUTOCODE_MANUAL_COMPETITORS_FILE_NAME = 'manual_competitors.json';

export const AUTOCODE_IDEATION_FILE_NAME = 'ideation.json';
export const AUTOCODE_IDEATION_CONTEXT_FILE_NAME = 'ideation_context.json';

export const AUTOCODE_INSIGHTS_CURRENT_SESSION_FILE_NAME = 'current_session.json';
export const AUTOCODE_INSIGHTS_LEGACY_SESSION_FILE_NAME = 'session.json';

function trimPathEnd(value: string): string {
  if (/^[\\/]+$/.test(value)) {
    return value.replace(/\\/g, '/');
  }
  return value.replace(/[\\/]+$/, '');
}

function appendPathSegment(base: string, segment: string): string {
  const cleanSegment = segment.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!cleanSegment) {
    return trimPathEnd(base);
  }
  const cleanBase = trimPathEnd(base);
  if (!cleanBase) {
    return cleanSegment;
  }
  const separator = cleanBase.endsWith('/') || cleanBase.endsWith('\\') ? '' : '/';
  return `${cleanBase}${separator}${cleanSegment}`;
}

function appendPathSegments(base: string, segments: readonly string[]): string {
  return segments.reduce((current, segment) => appendPathSegment(current, segment), base);
}

export function getAutocodeProjectDataRelativeDir(dataDirName?: string): string {
  return normalizeAutocodeProjectDataDirName(dataDirName).replace(/\\/g, '/');
}

export function getAutocodeProjectDataDir(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(projectRoot, getAutocodeProjectDataRelativeDir(dataDirName));
}

export function getAutocodeProjectDataRelativePath(
  pathSegments: readonly string[],
  dataDirName?: string,
): string {
  return appendPathSegments(getAutocodeProjectDataRelativeDir(dataDirName), pathSegments).replace(/\\/g, '/');
}

export function getAutocodeProjectDataPath(
  projectRoot: string,
  pathSegments: readonly string[],
  dataDirName?: string,
): string {
  return appendPathSegments(getAutocodeProjectDataDir(projectRoot, dataDirName), pathSegments);
}

export function getAutocodeProjectIndexRelativePath(dataDirName?: string): string {
  return `${getAutocodeProjectDataRelativeDir(dataDirName)}/${AUTOCODE_PROJECT_INDEX_FILE_NAME}`;
}

export function getAutocodeProjectIndexPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeProjectDataDir(projectRoot, dataDirName), AUTOCODE_PROJECT_INDEX_FILE_NAME);
}

export function getAutocodeProjectEnvRelativePath(dataDirName?: string): string {
  return `${getAutocodeProjectDataRelativeDir(dataDirName)}/${AUTOCODE_PROJECT_ENV_FILE_NAME}`;
}

export function getAutocodeProjectEnvPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeProjectDataDir(projectRoot, dataDirName), AUTOCODE_PROJECT_ENV_FILE_NAME);
}

export function getAutocodeProjectLocksDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_PROJECT_LOCKS_DIR_NAME], dataDirName);
}

export function getAutocodeSpecNumberLockPath(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(
    projectRoot,
    [AUTOCODE_PROJECT_LOCKS_DIR_NAME, AUTOCODE_SPEC_NUMBER_LOCK_FILE_NAME],
    dataDirName,
  );
}

export function getAutocodeProjectPromptsRelativeDir(dataDirName?: string): string {
  return getAutocodeProjectDataRelativePath([AUTOCODE_PROJECT_PROMPTS_DIR_NAME], dataDirName);
}

export function getAutocodeProjectPromptsDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_PROJECT_PROMPTS_DIR_NAME], dataDirName);
}

export function getAutocodeProjectPromptProfileRelativePath(dataDirName?: string): string {
  return getAutocodeProjectDataRelativePath([AUTOCODE_PROJECT_PROMPT_PROFILE_FILE_NAME], dataDirName);
}

export function getAutocodeProjectPromptProfilePath(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_PROJECT_PROMPT_PROFILE_FILE_NAME], dataDirName);
}

export function getAutocodeProjectDocsRelativeDir(dataDirName?: string): string {
  return getAutocodeProjectDataRelativePath([AUTOCODE_PROJECT_DOCS_DIR_NAME], dataDirName);
}

export function getAutocodeProjectDocsDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_PROJECT_DOCS_DIR_NAME], dataDirName);
}

export function getAutocodeProjectDocsRelativePath(fileName: string, dataDirName?: string): string {
  return getAutocodeProjectDataRelativePath([AUTOCODE_PROJECT_DOCS_DIR_NAME, fileName], dataDirName);
}

export function getAutocodeProjectDocsPath(
  projectRoot: string,
  fileName: string,
  dataDirName?: string,
): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_PROJECT_DOCS_DIR_NAME, fileName], dataDirName);
}

export function getAutocodeToolOutputDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_TOOL_OUTPUT_DIR_NAME], dataDirName);
}

export function getAutocodeDeepSeekSmartTerminalDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(
    projectRoot,
    [AUTOCODE_SMART_TERMINAL_DIR_NAME, AUTOCODE_DEEPSEEK_SMART_TERMINAL_DIR_NAME],
    dataDirName,
  );
}

export function getAutocodeGithubDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_GITHUB_DIR_NAME], dataDirName);
}

export function getAutocodeGitlabDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_GITLAB_DIR_NAME], dataDirName);
}

export function getAutocodeYunxiaoDir(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(projectRoot, [AUTOCODE_YUNXIAO_DIR_NAME], dataDirName);
}

export function getAutocodeGithubTmpCommentBodyPath(projectRoot: string, dataDirName?: string): string {
  return getAutocodeProjectDataPath(
    projectRoot,
    [AUTOCODE_GITHUB_TMP_COMMENT_BODY_FILE_NAME],
    dataDirName,
  );
}

export function getAutocodeRoadmapRelativeDir(dataDirName?: string): string {
  return `${getAutocodeProjectDataRelativeDir(dataDirName)}/${AUTOCODE_ROADMAP_DIR_NAME}`;
}

export function getAutocodeRoadmapDir(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(projectRoot, getAutocodeRoadmapRelativeDir(dataDirName));
}

export function getAutocodeRoadmapFilePath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeRoadmapDir(projectRoot, dataDirName), AUTOCODE_ROADMAP_FILE_NAME);
}

export function getAutocodeRoadmapDiscoveryPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeRoadmapDir(projectRoot, dataDirName), AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME);
}

export function getAutocodeRoadmapProgressPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeRoadmapDir(projectRoot, dataDirName), AUTOCODE_GENERATION_PROGRESS_FILE_NAME);
}

export function getAutocodeCompetitorAnalysisPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeRoadmapDir(projectRoot, dataDirName), AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME);
}

export function getAutocodeManualCompetitorsPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeRoadmapDir(projectRoot, dataDirName), AUTOCODE_MANUAL_COMPETITORS_FILE_NAME);
}

export function getAutocodeIdeationRelativeDir(dataDirName?: string): string {
  return `${getAutocodeProjectDataRelativeDir(dataDirName)}/${AUTOCODE_IDEATION_DIR_NAME}`;
}

export function getAutocodeIdeationDir(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(projectRoot, getAutocodeIdeationRelativeDir(dataDirName));
}

export function getAutocodeIdeationFilePath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeIdeationDir(projectRoot, dataDirName), AUTOCODE_IDEATION_FILE_NAME);
}

export function getAutocodeIdeationContextPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeIdeationDir(projectRoot, dataDirName), AUTOCODE_IDEATION_CONTEXT_FILE_NAME);
}

export function getAutocodeIdeationTypeIdeasPath(
  projectRoot: string,
  ideationType: string,
  dataDirName?: string,
): string {
  return appendPathSegment(getAutocodeIdeationDir(projectRoot, dataDirName), `${ideationType}_ideas.json`);
}

export function getAutocodeInsightsRelativeDir(dataDirName?: string): string {
  return `${getAutocodeProjectDataRelativeDir(dataDirName)}/${AUTOCODE_INSIGHTS_DIR_NAME}`;
}

export function getAutocodeInsightsDir(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(projectRoot, getAutocodeInsightsRelativeDir(dataDirName));
}

export function getAutocodeInsightsSessionsDir(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeInsightsDir(projectRoot, dataDirName), AUTOCODE_INSIGHTS_SESSIONS_DIR_NAME);
}

export function getAutocodeInsightsSessionPath(
  projectRoot: string,
  sessionId: string,
  dataDirName?: string,
): string {
  return appendPathSegment(getAutocodeInsightsSessionsDir(projectRoot, dataDirName), `${sessionId}.json`);
}

export function getAutocodeInsightsCurrentSessionPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeInsightsDir(projectRoot, dataDirName), AUTOCODE_INSIGHTS_CURRENT_SESSION_FILE_NAME);
}

export function getAutocodeInsightsLegacySessionPath(projectRoot: string, dataDirName?: string): string {
  return appendPathSegment(getAutocodeInsightsDir(projectRoot, dataDirName), AUTOCODE_INSIGHTS_LEGACY_SESSION_FILE_NAME);
}
