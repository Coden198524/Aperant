/**
 * Tests for profile-utils module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import { isAPIProfileAuthenticated, isProfileAuthenticated } from './profile-utils';
import type { APIProfile, ClaudeProfile } from '../../shared/types';

const tempDirs: string[] = [];

function createTempProfile(): ClaudeProfile & { configDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'aperant-profile-auth-'));
  tempDirs.push(configDir);
  return {
    id: 'test-profile',
    name: 'Test Profile',
    configDir,
    isDefault: false,
    createdAt: new Date(),
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('isProfileAuthenticated', () => {
  it('does not treat settings.json as authentication', () => {
    const profile = createTempProfile();
    writeFileSync(join(profile.configDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Read'] },
    }));

    expect(isProfileAuthenticated(profile)).toBe(false);
  });

  it('does not treat project history as authentication', () => {
    const profile = createTempProfile();
    const projectsDir = join(profile.configDir, 'projects');
    mkdirSync(projectsDir);
    writeFileSync(join(projectsDir, 'history.jsonl'), '{"message":"hello"}\n');

    expect(isProfileAuthenticated(profile)).toBe(false);
  });

  it('does not treat credential metadata without tokens as authentication', () => {
    const profile = createTempProfile();
    writeFileSync(join(profile.configDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { email: 'user@example.com' },
    }));

    expect(isProfileAuthenticated(profile)).toBe(false);
  });

  it('accepts a credential file containing an OAuth token', () => {
    const profile = createTempProfile();
    writeFileSync(join(profile.configDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-valid-token' },
    }));

    expect(isProfileAuthenticated(profile)).toBe(true);
  });
});

describe('isAPIProfileAuthenticated', () => {
  it('should return true when both apiKey and baseUrl are present and non-empty', () => {
    const validProfile: APIProfile = {
      id: 'test-1',
      name: 'Test Profile',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-api03-test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(validProfile)).toBe(true);
  });

  it('should return false when apiKey is missing', () => {
    const profileWithoutApiKey: APIProfile = {
      id: 'test-2',
      name: 'Test Profile',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithoutApiKey)).toBe(false);
  });

  it('should return false when baseUrl is missing', () => {
    const profileWithoutBaseUrl: APIProfile = {
      id: 'test-3',
      name: 'Test Profile',
      baseUrl: '',
      apiKey: 'sk-ant-api03-test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithoutBaseUrl)).toBe(false);
  });

  it('should return false when apiKey is only whitespace', () => {
    const profileWithWhitespaceApiKey: APIProfile = {
      id: 'test-4',
      name: 'Test Profile',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '   ',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithWhitespaceApiKey)).toBe(false);
  });

  it('should return false when baseUrl is only whitespace', () => {
    const profileWithWhitespaceBaseUrl: APIProfile = {
      id: 'test-5',
      name: 'Test Profile',
      baseUrl: '   ',
      apiKey: 'sk-ant-api03-test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithWhitespaceBaseUrl)).toBe(false);
  });

  it('should return false when both apiKey and baseUrl are missing', () => {
    const profileWithoutCredentials: APIProfile = {
      id: 'test-6',
      name: 'Test Profile',
      baseUrl: '',
      apiKey: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithoutCredentials)).toBe(false);
  });

  it('should return false when profile is undefined', () => {
    expect(isAPIProfileAuthenticated(undefined as any)).toBe(false);
  });

  it('should return false when profile is null', () => {
    expect(isAPIProfileAuthenticated(null as any)).toBe(false);
  });

  it('should handle profiles with apiKey and baseUrl containing leading/trailing whitespace', () => {
    const profileWithWhitespace: APIProfile = {
      id: 'test-7',
      name: 'Test Profile',
      baseUrl: '  https://api.anthropic.com  ',
      apiKey: '  sk-ant-api03-test  ',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(isAPIProfileAuthenticated(profileWithWhitespace)).toBe(true);
  });
});
