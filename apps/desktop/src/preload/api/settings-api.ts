import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AppSettings,
  IPCResult,
  ToolDetectionResult,
  ProviderAccount
} from '../../shared/types';

/** Connection parameters accepted by the provider connection test handler. */
export interface ProviderConnectionTestConfig {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
}

export interface SettingsAPI {
  // App Settings
  getSettings: () => Promise<IPCResult<AppSettings>>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<IPCResult>;

  // CLI Tools Detection
  getCliToolsInfo: () => Promise<IPCResult<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    glab: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>>;

  // Claude Code onboarding status
  getClaudeCodeOnboardingStatus: () => Promise<IPCResult<{ hasCompletedOnboarding: boolean }>>;

  // App Info
  getAppVersion: () => Promise<string>;

  // Spell check
  setSpellCheckLanguages: (language: string) => Promise<IPCResult<{ success: boolean }>>;

  // Provider Account management (unified multi-provider)
  getProviderAccounts: () => Promise<IPCResult<{ accounts: ProviderAccount[] }>>;
  saveProviderAccount: (
    account: Omit<ProviderAccount, 'id' | 'createdAt' | 'updatedAt'>,
  ) => Promise<IPCResult<ProviderAccount>>;
  updateProviderAccount: (
    id: string,
    updates: Partial<ProviderAccount>,
  ) => Promise<IPCResult<ProviderAccount>>;
  deleteProviderAccount: (id: string) => Promise<IPCResult>;
  setProviderAccountQueueOrder: (order: string[]) => Promise<IPCResult>;
  setCrossProviderQueueOrder: (order: string[]) => Promise<IPCResult>;
  saveModelOverrides: (overrides: Record<string, unknown>) => Promise<IPCResult>;
  testProviderConnection: (
    provider: string,
    config: ProviderConnectionTestConfig,
  ) => Promise<IPCResult<{ success: boolean; error?: string }>>;
  checkEnvCredentials: () => Promise<IPCResult<Record<string, boolean>>>;

  // Codex CLI status
  checkCodexCliVersion: () => Promise<IPCResult<import('../../shared/types/cli').CodexCliVersionInfo>>;

  // Codex OAuth authentication
  codexAuthLogin: () => Promise<{ success: boolean; data?: { accessToken: string; refreshToken: string; expiresAt: number; email?: string }; error?: string }>;
  codexAuthStatus: () => Promise<{ success: boolean; data?: { isAuthenticated: boolean; expiresAt?: number }; error?: string }>;
  codexAuthLogout: () => Promise<{ success: boolean; error?: string }>;
}

export const createSettingsAPI = (): SettingsAPI => ({
  // App Settings
  getSettings: (): Promise<IPCResult<AppSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),

  saveSettings: (settings: Partial<AppSettings>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  // CLI Tools Detection
  getCliToolsInfo: (): Promise<IPCResult<{
    python: ToolDetectionResult;
    git: ToolDetectionResult;
    gh: ToolDetectionResult;
    glab: ToolDetectionResult;
    claude: ToolDetectionResult;
  }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO),

  // Claude Code onboarding status
  getClaudeCodeOnboardingStatus: (): Promise<IPCResult<{ hasCompletedOnboarding: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS),

  // App Info
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  // Spell check - sync spell checker language with app language
  setSpellCheckLanguages: (language: string): Promise<IPCResult<{ success: boolean }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES, language),

  // Provider Account management (unified multi-provider)
  getProviderAccounts: (): Promise<IPCResult<{ accounts: ProviderAccount[] }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_GET),
  saveProviderAccount: (
    account: Omit<ProviderAccount, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<IPCResult<ProviderAccount>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_SAVE, account),
  updateProviderAccount: (
    id: string,
    updates: Partial<ProviderAccount>,
  ): Promise<IPCResult<ProviderAccount>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_UPDATE, id, updates),
  deleteProviderAccount: (id: string): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_DELETE, id),
  setProviderAccountQueueOrder: (order: string[]): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_QUEUE_ORDER, order),
  setCrossProviderQueueOrder: (order: string[]): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_SET_CROSS_PROVIDER_QUEUE_ORDER, order),
  saveModelOverrides: (overrides: Record<string, unknown>): Promise<IPCResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_OVERRIDES_SAVE, overrides),
  testProviderConnection: (
    provider: string,
    config: ProviderConnectionTestConfig,
  ): Promise<IPCResult<{ success: boolean; error?: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_TEST_CONNECTION, provider, config),
  checkEnvCredentials: (): Promise<IPCResult<Record<string, boolean>>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ACCOUNTS_CHECK_ENV),

  // Codex CLI status
  checkCodexCliVersion: (): Promise<IPCResult<import('../../shared/types/cli').CodexCliVersionInfo>> =>
    ipcRenderer.invoke('codex-cli-check-version'),

  // Codex OAuth authentication
  codexAuthLogin: () =>
    ipcRenderer.invoke('codex-auth-login'),
  codexAuthStatus: () =>
    ipcRenderer.invoke('codex-auth-status'),
  codexAuthLogout: () =>
    ipcRenderer.invoke('codex-auth-logout'),
});
