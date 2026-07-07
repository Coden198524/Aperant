import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import type { TerminalSession } from '../../terminal-session-store';

const mockGetSavedSessions = vi.fn();
const mockPersistSessionAsync = vi.fn();
const mockStartDeepSeekCli = vi.fn();

vi.mock('../session-handler', () => ({
  getSavedSessions: (...args: unknown[]) => mockGetSavedSessions(...args),
  getAvailableSessionDates: vi.fn(() => []),
  getSessionsForDate: vi.fn(() => []),
  persistSessionAsync: (...args: unknown[]) => mockPersistSessionAsync(...args),
  persistAllSessionsAsync: vi.fn(async () => undefined),
}));

vi.mock('../deepseek-cli-session', () => ({
  startDeepSeekCli: (...args: unknown[]) => mockStartDeepSeekCli(...args),
}));

vi.mock('../pty-manager', () => ({
  writeToPty: vi.fn(),
}));

vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn(),
}));

vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: vi.fn(() => []),
  },
}));

function createMockDisposable(): pty.IDisposable {
  return { dispose: vi.fn() };
}

function createMockPty(): pty.IPty {
  return {
    pid: 123,
    cols: 80,
    rows: 24,
    process: 'bash',
    handleFlowControl: false,
    onData: vi.fn(() => createMockDisposable()),
    onExit: vi.fn(() => createMockDisposable()),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
  };
}

function createTerminal(overrides: Partial<TerminalProcess> = {}): TerminalProcess {
  return {
    id: 'term-1',
    pty: createMockPty(),
    isCLIMode: false,
    projectPath: 'E:\\Work\\Aperant',
    cwd: 'E:\\Work\\Aperant',
    outputBuffer: '',
    title: 'Terminal',
    ...overrides,
  };
}

function createDeepSeekSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'deepseek-session-1',
    title: 'DeepSeek',
    cwd: 'E:\\Work\\Aperant',
    projectPath: 'E:\\Work\\Aperant',
    isCLIMode: true,
    activeCLI: 'deepseek',
    outputBuffer: 'previous output\r\n',
    createdAt: '2026-05-18T08:00:00.000Z',
    lastActiveAt: '2026-05-18T09:00:00.000Z',
    deepseekState: {
      modelId: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'continue this' }],
    },
    ...overrides,
  };
}

describe('TerminalManager DeepSeek resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the built-in DeepSeek CLI when resuming a DeepSeek history session', async () => {
    const { TerminalManager } = await import('../terminal-manager');
    const manager = new TerminalManager(() => null);
    const terminal = createTerminal();
    mockGetSavedSessions.mockReturnValue([createDeepSeekSession()]);
    (manager as unknown as { terminals: Map<string, TerminalProcess> }).terminals.set(terminal.id, terminal);

    const result = await manager.resumeNativeCliSession(
      terminal.id,
      'deepseek',
      'deepseek-session-1',
      terminal.projectPath,
    );

    expect(result.success).toBe(true);
    expect(result.outputBuffer).toBe('previous output\r\n');
    expect(terminal.isCLIMode).toBe(true);
    expect(terminal.activeCLI).toBe('deepseek');
    expect(terminal.deepseekState?.modelId).toBe('deepseek-v4-flash');
    expect(mockStartDeepSeekCli).toHaveBeenCalledWith(
      terminal,
      'E:\\Work\\Aperant',
      expect.any(Function),
    );
  });
});
