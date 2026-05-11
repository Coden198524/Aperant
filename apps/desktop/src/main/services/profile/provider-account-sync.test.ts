import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIProfile } from '@shared/types/profile';
import type { ProviderAccount } from '@shared/types/provider-account';
import {
  deactivateAPIProfileProviderAccounts,
  getAPIProfileProviderAccountId,
  removeAPIProfileProviderAccount,
  syncAPIProfileToProviderAccount,
} from './provider-account-sync';
import { readSettingsFile, writeSettingsFile } from '../../settings-utils';

vi.mock('../../settings-utils', () => ({
  readSettingsFile: vi.fn(),
  writeSettingsFile: vi.fn(),
}));

const profile: APIProfile = {
  id: 'profile-1',
  name: 'Custom Anthropic',
  baseUrl: 'https://custom.example.com',
  apiKey: 'sk-test-profile-key',
  createdAt: 100,
  updatedAt: 200,
};

const openAIAccount: ProviderAccount = {
  id: 'account-openai',
  provider: 'openai',
  name: 'OpenAI',
  authType: 'api-key',
  apiKey: 'sk-openai',
  billingModel: 'pay-per-use',
  createdAt: 10,
  updatedAt: 10,
};

describe('provider-account-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mirrors an API profile as an Anthropic provider account and activates it', () => {
    vi.mocked(readSettingsFile).mockReturnValue({
      providerAccounts: [openAIAccount],
      globalPriorityOrder: ['missing-account', openAIAccount.id],
    });

    const account = syncAPIProfileToProviderAccount(profile, { activate: true });
    const written = vi.mocked(writeSettingsFile).mock.calls[0]?.[0] as {
      providerAccounts: ProviderAccount[];
      globalPriorityOrder: string[];
    };

    expect(account.id).toBe(getAPIProfileProviderAccountId(profile.id));
    expect(account.provider).toBe('anthropic');
    expect(account.baseUrl).toBe(profile.baseUrl);
    expect(account.apiKey).toBe(profile.apiKey);
    expect(written.providerAccounts).toHaveLength(2);
    expect(written.providerAccounts[1]).toMatchObject({
      id: 'api-profile:profile-1',
      provider: 'anthropic',
      name: 'Custom Anthropic',
      baseUrl: 'https://custom.example.com',
      apiKey: 'sk-test-profile-key',
    });
    expect(written.globalPriorityOrder).toEqual([
      'api-profile:profile-1',
      openAIAccount.id,
    ]);
  });

  it('updates an existing mirrored account without changing its createdAt timestamp', () => {
    const existing: ProviderAccount = {
      id: 'api-profile:profile-1',
      provider: 'anthropic',
      name: 'Old Name',
      authType: 'api-key',
      apiKey: 'old-key',
      baseUrl: 'https://old.example.com',
      billingModel: 'pay-per-use',
      createdAt: 999,
      updatedAt: 1000,
    };
    vi.mocked(readSettingsFile).mockReturnValue({
      providerAccounts: [existing],
      globalPriorityOrder: [existing.id],
    });

    syncAPIProfileToProviderAccount(profile);
    const written = vi.mocked(writeSettingsFile).mock.calls[0]?.[0] as {
      providerAccounts: ProviderAccount[];
      globalPriorityOrder: string[];
    };

    expect(written.providerAccounts).toHaveLength(1);
    expect(written.providerAccounts[0]).toMatchObject({
      id: existing.id,
      name: profile.name,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      createdAt: existing.createdAt,
    });
    expect(written.globalPriorityOrder).toEqual([existing.id]);
  });

  it('upgrades an existing openai-compatible mirror to the stable API profile id', () => {
    const legacy: ProviderAccount = {
      id: 'legacy-id',
      provider: 'openai-compatible',
      name: profile.name,
      authType: 'api-key',
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      billingModel: 'pay-per-use',
      createdAt: 321,
      updatedAt: 654,
    };
    vi.mocked(readSettingsFile).mockReturnValue({
      providerAccounts: [legacy],
      globalPriorityOrder: [legacy.id],
      crossProviderPriorityOrder: [legacy.id],
    });

    syncAPIProfileToProviderAccount(profile);
    const written = vi.mocked(writeSettingsFile).mock.calls[0]?.[0] as {
      providerAccounts: ProviderAccount[];
      globalPriorityOrder: string[];
      crossProviderPriorityOrder: string[];
    };

    expect(written.providerAccounts).toHaveLength(1);
    expect(written.providerAccounts[0]).toMatchObject({
      id: 'api-profile:profile-1',
      provider: 'anthropic',
      name: profile.name,
      createdAt: legacy.createdAt,
    });
    expect(written.globalPriorityOrder).toEqual(['api-profile:profile-1']);
    expect(written.crossProviderPriorityOrder).toEqual(['api-profile:profile-1']);
  });

  it('removes a deleted API profile from accounts and queues', () => {
    vi.mocked(readSettingsFile).mockReturnValue({
      providerAccounts: [
        openAIAccount,
        {
          ...openAIAccount,
          id: 'api-profile:profile-1',
          provider: 'anthropic',
          name: 'Custom Anthropic',
        } satisfies ProviderAccount,
      ],
      globalPriorityOrder: ['api-profile:profile-1', openAIAccount.id],
      crossProviderPriorityOrder: [openAIAccount.id, 'api-profile:profile-1'],
    });

    removeAPIProfileProviderAccount(profile.id);
    const written = vi.mocked(writeSettingsFile).mock.calls[0]?.[0] as {
      providerAccounts: ProviderAccount[];
      globalPriorityOrder: string[];
      crossProviderPriorityOrder: string[];
    };

    expect(written.providerAccounts.map(account => account.id)).toEqual([openAIAccount.id]);
    expect(written.globalPriorityOrder).toEqual([openAIAccount.id]);
    expect(written.crossProviderPriorityOrder).toEqual([openAIAccount.id]);
  });

  it('deactivates API profiles by removing mirrored accounts while preserving profiles.json', () => {
    vi.mocked(readSettingsFile).mockReturnValue({
      providerAccounts: [
        { ...openAIAccount, id: 'api-profile:profile-1', provider: 'anthropic' },
        openAIAccount,
      ],
      globalPriorityOrder: ['api-profile:profile-1', openAIAccount.id],
      crossProviderPriorityOrder: ['api-profile:profile-1', openAIAccount.id],
    });

    deactivateAPIProfileProviderAccounts();
    const written = vi.mocked(writeSettingsFile).mock.calls[0]?.[0] as {
      providerAccounts: ProviderAccount[];
      globalPriorityOrder: string[];
      crossProviderPriorityOrder: string[];
    };

    expect(written.providerAccounts.map(account => account.id)).toEqual([openAIAccount.id]);
    expect(written.globalPriorityOrder).toEqual([openAIAccount.id]);
    expect(written.crossProviderPriorityOrder).toEqual([openAIAccount.id]);
  });
});
