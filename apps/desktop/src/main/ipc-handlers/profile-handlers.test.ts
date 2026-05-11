/**
 * Tests for profile IPC handlers
 *
 * Tests profiles:set-active handler with support for:
 * - Setting valid profile as active
 * - Switching to OAuth (null profileId)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIProfile, ProfilesFile } from '@shared/types/profile';

// Hoist mocked functions to avoid circular dependency in atomicModifyProfiles
const {
  mockedLoadProfilesFile,
  mockedSaveProfilesFile,
  mockedHasAPIProfileProviderAccount,
  mockedSyncAPIProfileToProviderAccount,
  mockedRemoveAPIProfileProviderAccount,
  mockedDeactivateAPIProfileProviderAccounts
} = vi.hoisted(() => ({
  mockedLoadProfilesFile: vi.fn(),
  mockedSaveProfilesFile: vi.fn(),
  mockedHasAPIProfileProviderAccount: vi.fn(),
  mockedSyncAPIProfileToProviderAccount: vi.fn(),
  mockedRemoveAPIProfileProviderAccount: vi.fn(),
  mockedDeactivateAPIProfileProviderAccounts: vi.fn()
}));

// Mock electron before importing
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}));

// Mock profile service
vi.mock('../services/profile', () => ({
  loadProfilesFile: mockedLoadProfilesFile,
  saveProfilesFile: mockedSaveProfilesFile,
  validateFilePermissions: vi.fn(),
  getProfilesFilePath: vi.fn(() => '/test/profiles.json'),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  testConnection: vi.fn(),
  discoverModels: vi.fn(),
  atomicModifyProfiles: vi.fn(async (modifier: (file: unknown) => unknown) => {
    const file = await mockedLoadProfilesFile();
    const modified = modifier(file);
    await mockedSaveProfilesFile(modified as never);
    return modified;
  })
}));

vi.mock('../services/profile/provider-account-sync', () => ({
  hasAPIProfileProviderAccount: mockedHasAPIProfileProviderAccount,
  syncAPIProfileToProviderAccount: mockedSyncAPIProfileToProviderAccount,
  removeAPIProfileProviderAccount: mockedRemoveAPIProfileProviderAccount,
  deactivateAPIProfileProviderAccounts: mockedDeactivateAPIProfileProviderAccounts
}));

import { registerProfileHandlers } from './profile-handlers';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  loadProfilesFile,
  saveProfilesFile,
  validateFilePermissions,
  testConnection
} from '../services/profile';
import type { TestConnectionResult } from '@shared/types/profile';

// Get the handler function for testing
function getSetActiveHandler() {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const setActiveCall = calls.find(
    (call) => call[0] === IPC_CHANNELS.PROFILES_SET_ACTIVE
  );
  return setActiveCall?.[1];
}

function getProfilesHandler() {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const profilesCall = calls.find(
    (call) => call[0] === IPC_CHANNELS.PROFILES_GET
  );
  return profilesCall?.[1];
}

function getDeleteHandler() {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const deleteCall = calls.find(
    (call) => call[0] === IPC_CHANNELS.PROFILES_DELETE
  );
  return deleteCall?.[1];
}

// Get the testConnection handler function for testing
function getTestConnectionHandler() {
  const calls = (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const testConnectionCall = calls.find(
    (call) => call[0] === IPC_CHANNELS.PROFILES_TEST_CONNECTION
  );
  return testConnectionCall?.[1];
}

describe('profile-handlers - setActiveProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedHasAPIProfileProviderAccount.mockReturnValue(false);
    registerProfileHandlers();
  });
  const mockProfiles: APIProfile[] = [
    {
      id: 'profile-1',
      name: 'Test Profile 1',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test-key-1',
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      id: 'profile-2',
      name: 'Test Profile 2',
      baseUrl: 'https://custom.api.com',
      apiKey: 'sk-custom-key-2',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ];

  describe('setting valid profile as active', () => {
    it('should set active profile with valid profileId', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getSetActiveHandler();
      const result = await handler({}, 'profile-1');

      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: 'profile-1'
        })
      );
      expect(mockedSyncAPIProfileToProviderAccount).toHaveBeenCalledWith(
        mockProfiles[0],
        { activate: true }
      );
    });

    it('should return error for non-existent profile', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);

      const handler = getSetActiveHandler();
      const result = await handler({}, 'non-existent-id');

      expect(result).toEqual({
        success: false,
        error: 'Profile not found'
      });
    });
  });

  describe('switching to OAuth (null profileId)', () => {
    it('should accept null profileId to switch to OAuth', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: 'profile-1',
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getSetActiveHandler();
      const result = await handler({}, null);

      // Should succeed and clear activeProfileId
      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalledWith(
        expect.objectContaining({
          activeProfileId: null
        })
      );
      expect(mockedDeactivateAPIProfileProviderAccounts).toHaveBeenCalled();
    });

    it('should handle null when no profile was active', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockResolvedValue(undefined);
      vi.mocked(validateFilePermissions).mockResolvedValue(true);

      const handler = getSetActiveHandler();
      const result = await handler({}, null);

      // Should succeed (idempotent operation)
      expect(result).toEqual({ success: true });
      expect(saveProfilesFile).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle loadProfilesFile errors', async () => {
      vi.mocked(loadProfilesFile).mockRejectedValue(
        new Error('Failed to load profiles')
      );

      const handler = getSetActiveHandler();
      const result = await handler({}, 'profile-1');

      expect(result).toEqual({
        success: false,
        error: 'Failed to load profiles'
      });
    });

    it('should handle saveProfilesFile errors', async () => {
      const mockFile: ProfilesFile = {
        profiles: mockProfiles,
        activeProfileId: null,
        version: 1
      };

      vi.mocked(loadProfilesFile).mockResolvedValue(mockFile);
      vi.mocked(saveProfilesFile).mockRejectedValue(
        new Error('Failed to save')
      );

      const handler = getSetActiveHandler();
      const result = await handler({}, 'profile-1');

      expect(result).toEqual({
        success: false,
        error: 'Failed to save'
      });
    });
  });
});

describe('profile-handlers - provider account sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedHasAPIProfileProviderAccount.mockReturnValue(false);
    registerProfileHandlers();
  });

  const mockProfile: APIProfile = {
    id: 'profile-1',
    name: 'Test Profile',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test-key-123456',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  it('should sync active API profile when profiles are loaded', async () => {
    vi.mocked(loadProfilesFile).mockResolvedValue({
      profiles: [mockProfile],
      activeProfileId: mockProfile.id,
      version: 1
    });

    const handler = getProfilesHandler();
    const result = await handler({});

    expect(result.success).toBe(true);
    expect(mockedSyncAPIProfileToProviderAccount).toHaveBeenCalledWith(
      mockProfile,
      { activate: true }
    );
  });

  it('should not reorder the queue when the active API profile is already mirrored', async () => {
    mockedHasAPIProfileProviderAccount.mockReturnValue(true);
    vi.mocked(loadProfilesFile).mockResolvedValue({
      profiles: [mockProfile],
      activeProfileId: mockProfile.id,
      version: 1
    });

    const handler = getProfilesHandler();
    const result = await handler({});

    expect(result.success).toBe(true);
    expect(mockedSyncAPIProfileToProviderAccount).not.toHaveBeenCalled();
  });

  it('should remove mirrored provider account after deleting a profile', async () => {
    const { deleteProfile } = await import('../services/profile');
    vi.mocked(deleteProfile).mockResolvedValue(undefined);

    const handler = getDeleteHandler();
    const result = await handler({}, mockProfile.id);

    expect(result).toEqual({ success: true });
    expect(mockedRemoveAPIProfileProviderAccount).toHaveBeenCalledWith(mockProfile.id);
  });
});

describe('profile-handlers - testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedHasAPIProfileProviderAccount.mockReturnValue(false);
    registerProfileHandlers();
  });

  describe('successful connection tests', () => {
    it('should return success result for valid connection', async () => {
      const mockResult: TestConnectionResult = {
        success: true,
        message: 'Connection successful'
      };

      vi.mocked(testConnection).mockResolvedValue(mockResult);

      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: true,
        data: mockResult
      });
      expect(testConnection).toHaveBeenCalledWith(
        'https://api.anthropic.com',
        'sk-test-key-12chars',
        expect.any(AbortSignal)
      );
    });
  });

  describe('input validation', () => {
    it('should return error for empty baseUrl', async () => {
      const handler = getTestConnectionHandler();
      const result = await handler({}, '', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Base URL is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for whitespace-only baseUrl', async () => {
      const handler = getTestConnectionHandler();
      const result = await handler({}, '   ', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Base URL is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for empty apiKey', async () => {
      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', '');

      expect(result).toEqual({
        success: false,
        error: 'API key is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });

    it('should return error for whitespace-only apiKey', async () => {
      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', '   ');

      expect(result).toEqual({
        success: false,
        error: 'API key is required'
      });
      expect(testConnection).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return IPCResult with TestConnectionResult data for service errors', async () => {
      const mockResult: TestConnectionResult = {
        success: false,
        errorType: 'auth',
        message: 'Authentication failed. Please check your API key.'
      };

      vi.mocked(testConnection).mockResolvedValue(mockResult);

      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', 'invalid-key');

      expect(result).toEqual({
        success: true,
        data: mockResult
      });
    });

    it('should return error for unexpected exceptions', async () => {
      vi.mocked(testConnection).mockRejectedValue(new Error('Unexpected error'));

      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Unexpected error'
      });
    });

    it('should return error for non-Error exceptions', async () => {
      vi.mocked(testConnection).mockRejectedValue('String error');

      const handler = getTestConnectionHandler();
      const result = await handler({}, 'https://api.anthropic.com', 'sk-test-key-12chars');

      expect(result).toEqual({
        success: false,
        error: 'Failed to test connection'
      });
    });
  });
});
