import { describe, expect, it } from 'vitest';
import { detectRemoteProviderFromUrl } from '../remote-provider-detector';

describe('detectRemoteProviderFromUrl', () => {
  it('detects GitHub remotes', () => {
    expect(
      detectRemoteProviderFromUrl('git@github.com:octocat/hello-world.git')
    ).toMatchObject({
      provider: 'github',
      host: 'github.com',
      repoPath: 'octocat/hello-world',
    });
  });

  it('detects GitBlit remotes from host or /r/ path', () => {
    expect(
      detectRemoteProviderFromUrl('https://gitblit.example.com/r/team/repository.git')
    ).toMatchObject({
      provider: 'gitblit',
      baseUrl: 'https://gitblit.example.com',
      path: 'r/team/repository.git',
    });
  });

  it('detects GitLab remotes', () => {
    expect(
      detectRemoteProviderFromUrl('https://gitlab.example.com/group/project.git')
    ).toMatchObject({
      provider: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      repoPath: 'group/project',
    });
  });

  it('returns unknown for unsupported remotes', () => {
    expect(
      detectRemoteProviderFromUrl('ssh://git@example.internal:2222/team/project.git')
    ).toMatchObject({
      provider: 'unknown',
      repoPath: 'team/project',
    });
  });
});
