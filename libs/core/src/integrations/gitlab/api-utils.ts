export const DEFAULT_GITLAB_URL = 'https://gitlab.com';
export const GITLAB_MAX_PROJECT_REF_LENGTH = 1024;

export function parseGitLabInstanceUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizeGitLabInstanceUrl(value: string | undefined): string | null {
  return parseGitLabInstanceUrl(value || DEFAULT_GITLAB_URL);
}

export function normalizeGitLabProjectReference(project: string, instanceUrl: string = DEFAULT_GITLAB_URL): string {
  if (!project) return '';

  if (/^\d+$/.test(project)) {
    return project;
  }

  let normalized = project.replace(/\.git$/, '');

  let gitlabHostname: string;
  try {
    gitlabHostname = new URL(instanceUrl).hostname;
  } catch {
    gitlabHostname = 'gitlab.com';
  }

  const escapedHostname = gitlabHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const httpsPattern = new RegExp(`^https?://${escapedHostname}/`);
  if (httpsPattern.test(normalized)) {
    normalized = normalized.replace(httpsPattern, '');
  } else if (normalized.startsWith(`git@${gitlabHostname}:`)) {
    normalized = normalized.replace(`git@${gitlabHostname}:`, '');
  }

  return normalized.trim();
}

export function encodeGitLabProjectPath(projectPath: string): string {
  if (/^\d+$/.test(projectPath)) {
    return projectPath;
  }
  return encodeURIComponent(projectPath);
}

export function sanitizeGitLabToken(value: string | undefined): string | null {
  const sanitized = sanitizeGitLabControlChars(value);
  if (!sanitized) return null;
  return sanitized.length > 512 ? sanitized.substring(0, 512) : sanitized;
}

export function sanitizeGitLabProjectRef(value: string | undefined): string | null {
  const sanitized = sanitizeGitLabControlChars(value);
  if (!sanitized) return null;
  return sanitized.length > GITLAB_MAX_PROJECT_REF_LENGTH ? null : sanitized;
}

function sanitizeGitLabControlChars(value: string | undefined): string | null {
  if (!value) return null;

  let sanitized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) {
      continue;
    }
    sanitized += value[index];
  }

  const trimmed = sanitized.trim();
  if (!trimmed) return null;
  return trimmed;
}
