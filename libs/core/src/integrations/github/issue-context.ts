export interface GitHubIssueContextComment {
  body: string;
  user: {
    login: string;
  };
}

export function buildGitHubIssueContext(
  issueNumber: number,
  issueTitle: string,
  issueBody: string | undefined,
  labels: string[],
  htmlUrl: string,
  comments: GitHubIssueContextComment[],
): string {
  return `
# GitHub Issue #${issueNumber}: ${issueTitle}

${issueBody || 'No description provided.'}

${comments.length > 0 ? `## Comments (${comments.length}):
${comments.map(comment => `**${comment.user.login}:** ${comment.body}`).join('\n\n')}` : ''}

**Labels:** ${labels.join(', ') || 'None'}
**URL:** ${htmlUrl}
`;
}

export function buildGitHubInvestigationTask(
  issueNumber: number,
  issueTitle: string,
  issueContext: string,
): string {
  return `Investigate GitHub Issue #${issueNumber}: ${issueTitle}

${issueContext}

Please analyze this issue and provide:
1. A brief summary of what the issue is about
2. A proposed solution approach
3. The files that would likely need to be modified
4. Estimated complexity (simple/standard/complex)
5. Acceptance criteria for resolving this issue`;
}
