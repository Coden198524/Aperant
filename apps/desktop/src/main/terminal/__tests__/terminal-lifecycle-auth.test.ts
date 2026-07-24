import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawnPtyProcess = vi.fn(() => ({
  pty: { pid: 1234 },
  shellType: 'cmd' as const,
}));

vi.mock('../pty-manager', () => ({
  spawnPtyProcess: mockSpawnPtyProcess,
  setupPtyHandlers: vi.fn(),
  writeToPty: vi.fn(),
}));

vi.mock('../session-handler', () => ({
  clearPendingDelete: vi.fn(),
  persistSessionAsync: vi.fn(),
  getSavedSessions: vi.fn(() => []),
}));

vi.mock('../deepseek-cli-session', () => ({
  startDeepSeekCli: vi.fn(),
}));

vi.mock('../../claude-code-settings', () => ({
  getClaudeCodeEnv: vi.fn(() => ({ CLAUDE_SETTING_ENV: 'enabled' })),
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('terminal lifecycle Claude authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not inject the application Claude profile into a smart terminal', async () => {
    const { createTerminal } = await import('../terminal-lifecycle');
    const terminals = new Map();

    const result = await createTerminal(
      { id: 'smart-terminal', cwd: process.cwd() },
      terminals,
      () => null,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(mockSpawnPtyProcess).toHaveBeenCalledWith(
      process.cwd(),
      80,
      24,
      { CLAUDE_SETTING_ENV: 'enabled' },
    );
  });

  it('keeps an explicit config directory for the dedicated login terminal', async () => {
    const { createTerminal } = await import('../terminal-lifecycle');
    const terminals = new Map();

    const result = await createTerminal(
      {
        id: 'claude-login-default-1234567890123',
        cwd: process.cwd(),
        skipOAuthToken: true,
        env: { CLAUDE_CONFIG_DIR: 'E:\\explicit-login-profile' },
      },
      terminals,
      () => null,
      vi.fn(),
    );

    expect(result.success).toBe(true);
    expect(mockSpawnPtyProcess).toHaveBeenCalledWith(
      process.cwd(),
      80,
      24,
      {
        CLAUDE_SETTING_ENV: 'enabled',
        CLAUDE_CONFIG_DIR: 'E:\\explicit-login-profile',
      },
    );
  });
});
