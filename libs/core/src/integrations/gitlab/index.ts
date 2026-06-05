export {
  DEFAULT_GITLAB_URL,
  encodeGitLabProjectPath,
  normalizeGitLabInstanceUrl,
  normalizeGitLabProjectReference,
  parseGitLabInstanceUrl,
} from './api-utils.js';

export {
  buildGitLabIssueContext,
  sanitizeGitLabIssueForContext,
} from './issue-context.js';

export type {
  GitLabIssueContextIssue,
  GitLabIssueContextNote,
} from './issue-context.js';
