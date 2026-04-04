import i18n from '../../../../shared/i18n';
import type { GitHubIssue } from '../../../../shared/types';

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString(i18n.resolvedLanguage || i18n.language || 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

export function filterIssuesBySearch(issues: GitHubIssue[], searchQuery: string): GitHubIssue[] {
  if (!searchQuery) {
    return issues;
  }

  const query = searchQuery.toLowerCase();
  return issues.filter(issue =>
    issue.title.toLowerCase().includes(query) ||
    issue.body?.toLowerCase().includes(query)
  );
}

// Re-export GitHub error parser utilities
export {
  parseGitHubError,
  isRateLimitError,
  isAuthError,
  isNetworkError,
  isRecoverableError,
  requiresSettingsAction,
} from './github-error-parser';
