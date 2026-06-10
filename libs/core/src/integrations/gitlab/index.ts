export {
  DEFAULT_GITLAB_URL,
  GITLAB_MAX_PROJECT_REF_LENGTH,
  encodeGitLabProjectPath,
  normalizeGitLabInstanceUrl,
  normalizeGitLabProjectReference,
  parseGitLabInstanceUrl,
  sanitizeGitLabProjectRef,
  sanitizeGitLabToken,
} from './api-utils.js';

export {
  buildGitLabIssueContext,
  sanitizeGitLabIssueForContext,
} from './issue-context.js';

export type {
  GitLabIssueContextIssue,
  GitLabIssueContextNote,
} from './issue-context.js';
