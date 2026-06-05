import { sanitizeStringArray, sanitizeText } from '../../security/sanitize.js';

export interface GitLabIssueContextIssue {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: 'opened' | 'closed';
  labels: string[];
  assignees: Array<{ username: string }>;
  milestone?: { title: string };
  created_at: string;
  web_url: string;
}

export interface GitLabIssueContextNote {
  body: string;
  author?: {
    username?: string;
  };
}

interface SanitizedGitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  labels: string[];
  assignees: Array<{ username: string }>;
  milestone?: { title: string };
  created_at: string;
  web_url: string;
}

function sanitizeIssueNumber(value: unknown): number {
  const issueId = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return 0;
  }
  return issueId;
}

function sanitizeIssueState(value: unknown): 'opened' | 'closed' {
  return value === 'closed' ? 'closed' : 'opened';
}

function sanitizeAssignees(value: unknown): Array<{ username: string }> {
  if (!Array.isArray(value)) return [];
  const sanitized: Array<{ username: string }> = [];
  for (const assignee of value) {
    if (!assignee || typeof assignee !== 'object') continue;
    const username = sanitizeText((assignee as { username?: unknown }).username, 100);
    if (username) {
      sanitized.push({ username });
    }
    if (sanitized.length >= 20) {
      break;
    }
  }
  return sanitized;
}

function sanitizeMilestone(value: unknown): { title: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const title = sanitizeText((value as { title?: unknown }).title, 200);
  return title ? { title } : undefined;
}

function sanitizeIsoDate(value: unknown): string {
  if (typeof value !== 'string') {
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function sanitizeIssueUrl(rawUrl: unknown, instanceUrl: string): string {
  if (typeof rawUrl !== 'string') return '';
  try {
    const parsedUrl = new URL(rawUrl);
    const expectedHost = new URL(instanceUrl).host;
    if (parsedUrl.host !== expectedHost) return '';
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return '';
    if (parsedUrl.username || parsedUrl.password) return '';
    return parsedUrl.toString();
  } catch {
    return '';
  }
}

export function sanitizeGitLabIssueForContext(issue: GitLabIssueContextIssue, instanceUrl: string): SanitizedGitLabIssue {
  const issueIid = sanitizeIssueNumber(issue.iid);
  const title = sanitizeText(issue.title, 200) || `Issue ${issueIid || 'unknown'}`;
  return {
    id: sanitizeIssueNumber(issue.id),
    iid: issueIid,
    title,
    description: sanitizeText(issue.description ?? '', 20000, true),
    state: sanitizeIssueState(issue.state),
    labels: sanitizeStringArray(issue.labels, 50, 100),
    assignees: sanitizeAssignees(issue.assignees),
    milestone: sanitizeMilestone(issue.milestone),
    created_at: sanitizeIsoDate(issue.created_at),
    web_url: sanitizeIssueUrl(issue.web_url, instanceUrl),
  };
}

export function buildGitLabIssueContext(
  issue: GitLabIssueContextIssue,
  projectPath: string,
  instanceUrl: string,
  notes?: GitLabIssueContextNote[],
): string {
  const lines: string[] = [];
  const safeProjectPath = sanitizeText(projectPath, 200);
  const safeIssue = sanitizeGitLabIssueForContext(issue, instanceUrl);

  lines.push(`# GitLab Issue #${safeIssue.iid}: ${safeIssue.title}`);
  lines.push('');
  lines.push(`**Project:** ${safeProjectPath}`);
  lines.push(`**State:** ${safeIssue.state}`);
  lines.push(`**Created:** ${new Date(safeIssue.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`);

  if (safeIssue.labels.length > 0) {
    lines.push(`**Labels:** ${safeIssue.labels.join(', ')}`);
  }

  if (safeIssue.assignees.length > 0) {
    lines.push(`**Assignees:** ${safeIssue.assignees.map(assignee => assignee.username).join(', ')}`);
  }

  if (safeIssue.milestone) {
    lines.push(`**Milestone:** ${safeIssue.milestone.title}`);
  }

  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(safeIssue.description || '_No description provided_');
  lines.push('');
  lines.push(`**Web URL:** ${safeIssue.web_url}`);

  if (notes && notes.length > 0) {
    lines.push('');
    lines.push(`## Notes (${notes.length})`);
    lines.push('');
    for (const note of notes) {
      const safeAuthor = sanitizeText(note.author?.username || 'unknown', 100);
      const safeBody = sanitizeText(note.body, 20000, true);
      lines.push(`**${safeAuthor}:** ${safeBody}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
