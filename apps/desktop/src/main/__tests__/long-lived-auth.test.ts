/**
 * Tests for Long-Lived Auth Fix
 *
 * Verifies that:
 * 1. Manual setup tokens are passed alongside the isolated config directory
 * 2. Profile loading preserves encrypted setup tokens
 * 3. UsageMonitor reads fresh tokens from Keychain
 *
 * See: docs/LONG_LIVED_AUTH_PLAN.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the profile manager
const mockGetProfile = vi.fn();
const mockGetActiveProfile = vi.fn();
const mockGetProfileToken = vi.fn();
const mockGetActiveProfileToken = vi.fn();
const mockGetProfileEnv = vi.fn();
const mockGetActiveProfileEnv = vi.fn();

vi.mock('../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({
    getProfile: mockGetProfile,
    getActiveProfile: mockGetActiveProfile,
    getProfileToken: mockGetProfileToken,
    getActiveProfileToken: mockGetActiveProfileToken,
    getProfileEnv: mockGetProfileEnv,
    getActiveProfileEnv: mockGetActiveProfileEnv,
  }),
}));

// Import after mocking
import { getProfileEnv } from '../rate-limit-detector';

// Mock for profile storage tests - needs to be imported dynamically
const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
};

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockFs.existsSync(...args),
  readFileSync: (...args: unknown[]) => mockFs.readFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockFs.writeFileSync(...args),
  readFile: vi.fn(),
}));

describe('Long-Lived Auth Fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProfileEnv', () => {
    it('should return empty env for default profile (Claude CLI uses ~/.claude)', () => {
      // Since getProfileEnv now delegates to profile manager, mock the manager's method
      mockGetActiveProfileEnv.mockReturnValue({});

      const env = getProfileEnv();

      expect(env).toEqual({});
      expect(mockGetActiveProfileEnv).toHaveBeenCalled();
      // Should NOT call getProfileToken or getActiveProfileToken
      expect(mockGetProfileToken).not.toHaveBeenCalled();
      expect(mockGetActiveProfileToken).not.toHaveBeenCalled();
    });

    it('should return CLAUDE_CONFIG_DIR for non-default profile with configDir', () => {
      // Since getProfileEnv now delegates to profile manager, mock the manager's method
      mockGetActiveProfileEnv.mockReturnValue({
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-profiles/work',
      });

      const env = getProfileEnv();

      expect(env).toEqual({
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-profiles/work',
      });
      expect(mockGetActiveProfileEnv).toHaveBeenCalled();
      // Should NOT use the cached token - this is the key fix!
      expect(mockGetProfileToken).not.toHaveBeenCalled();
      expect(mockGetActiveProfileToken).not.toHaveBeenCalled();
    });

    it('should return the manual OAuth token alongside CLAUDE_CONFIG_DIR', () => {
      mockGetActiveProfileEnv.mockReturnValue({
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-profiles/personal',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-manual-token',
      });

      const env = getProfileEnv();

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-manual-token');
      expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-profiles/personal');
    });

    it('should support a token-only profile without configDir', () => {
      mockGetActiveProfileEnv.mockReturnValue({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token-only',
      });

      const env = getProfileEnv();

      expect(env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token-only',
      });
    });

    it('should use specific profile when profileId is provided', () => {
      // Since getProfileEnv now delegates to profile manager, mock the manager's method
      mockGetProfileEnv.mockReturnValue({
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-profiles/specific',
      });

      const env = getProfileEnv('specific-profile');

      expect(mockGetProfileEnv).toHaveBeenCalledWith('specific-profile');
      expect(env).toEqual({
        CLAUDE_CONFIG_DIR: '/Users/test/.claude-profiles/specific',
      });
    });
  });

  describe('Profile Storage Migration', () => {
    it('should remove cached oauthToken during profile loading', async () => {
      const storeWithToken = {
        version: 3,
        activeProfileId: 'work',
        profiles: [
          {
            id: 'work',
            name: 'Work Account',
            isDefault: false,
            configDir: '/Users/test/.claude-profiles/work',
            oauthToken: 'enc:stale-cached-token-that-should-be-removed',
            tokenCreatedAt: '2024-01-01T00:00:00.000Z',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storeWithToken));

      // Import profile storage dynamically to get fresh module with mocks
      const { loadProfileStore } = await import('../claude-profile/profile-storage');

      const result = loadProfileStore('/test/path');

      expect(result).not.toBeNull();
      expect(result?.profiles[0]).toBeDefined();

      expect(result?.profiles[0]).not.toHaveProperty('oauthToken');
      expect(result?.profiles[0]).not.toHaveProperty('tokenCreatedAt');

      // Other properties should be preserved
      expect(result?.profiles[0].id).toBe('work');
      expect(result?.profiles[0].name).toBe('Work Account');
      expect(result?.profiles[0].configDir).toBe('/Users/test/.claude-profiles/work');
    });

    it('should preserve profiles without oauthToken', async () => {
      const storeWithoutToken = {
        version: 3,
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            isDefault: true,
            configDir: '/Users/test/.claude',
            createdAt: '2024-01-01T00:00:00.000Z',
            // No oauthToken - this profile never had one
          },
        ],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(storeWithoutToken));

      const { loadProfileStore } = await import('../claude-profile/profile-storage');

      const result = loadProfileStore('/test/path');

      expect(result).not.toBeNull();
      expect(result?.profiles[0].id).toBe('default');
      expect(result?.profiles[0]).not.toHaveProperty('oauthToken');
    });
  });
});
