export type RemoteProvider = 'github' | 'gitlab' | 'gitblit' | 'unknown';

export interface DetectedRemoteProvider {
  provider: RemoteProvider;
  remoteUrl: string;
  host: string;
  baseUrl: string;
  path: string;
  repoPath: string;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function buildBaseUrl(protocol: string, host: string, port?: string): string {
  if (!port || port === '80' || port === '443') {
    return `${protocol}://${host}`;
  }
  return `${protocol}://${host}:${port}`;
}

function parseScpLikeRemote(remoteUrl: string): DetectedRemoteProvider | null {
  const match = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  const host = match[1].trim();
  const path = match[2].trim().replace(/^\/+/, '');

  if (!host || !path) {
    return null;
  }

  return {
    provider: 'unknown',
    remoteUrl,
    host,
    baseUrl: `https://${host}`,
    path,
    repoPath: stripGitSuffix(path),
  };
}

function parseUrlLikeRemote(remoteUrl: string): DetectedRemoteProvider | null {
  try {
    const parsed = new URL(remoteUrl);
    const protocol = parsed.protocol.replace(/:$/, '') || 'https';
    const host = parsed.hostname.trim();
    const path = parsed.pathname.replace(/^\/+/, '').trim();

    if (!host || !path) {
      return null;
    }

    return {
      provider: 'unknown',
      remoteUrl,
      host,
      baseUrl: buildBaseUrl(protocol === 'http' ? 'http' : 'https', host, parsed.port),
      path,
      repoPath: stripGitSuffix(path),
    };
  } catch {
    return null;
  }
}

export function detectRemoteProviderFromUrl(remoteUrl: string): DetectedRemoteProvider | null {
  const trimmedRemoteUrl = remoteUrl.trim();
  if (!trimmedRemoteUrl) {
    return null;
  }

  const parsed =
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedRemoteUrl)
      ? parseUrlLikeRemote(trimmedRemoteUrl)
      : parseScpLikeRemote(trimmedRemoteUrl));

  if (!parsed) {
    return null;
  }

  const normalizedHost = parsed.host.toLowerCase();
  const normalizedPath = parsed.path.toLowerCase();

  let provider: RemoteProvider = 'unknown';

  if (normalizedHost === 'github.com' || normalizedHost.endsWith('.github.com')) {
    provider = 'github';
  } else if (
    normalizedHost.includes('gitblit') ||
    normalizedPath.startsWith('r/') ||
    normalizedPath.includes('/r/')
  ) {
    provider = 'gitblit';
  } else if (normalizedHost.includes('gitlab')) {
    provider = 'gitlab';
  }

  return {
    ...parsed,
    provider,
  };
}
