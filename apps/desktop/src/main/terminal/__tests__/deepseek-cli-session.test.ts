import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';

const mockSafeSendToRenderer = vi.fn();
const mockPersistSessionAsync = vi.fn();
const mockStreamText = vi.fn();
const mockGetAppLanguage = vi.fn(() => 'en');

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  smoothStream: (options?: unknown) => ({ type: 'smoothStream', options }),
  stepCountIs: (count: number) => ({ type: 'stepCount', count }),
}));

vi.mock('../../ipc-handlers/utils', () => ({
  safeSendToRenderer: (...args: unknown[]) => mockSafeSendToRenderer(...args),
}));

vi.mock('../session-handler', () => ({
  persistSessionAsync: (...args: unknown[]) => mockPersistSessionAsync(...args),
}));

vi.mock('../pty-manager', () => ({
  writeToPty: vi.fn(),
}));

vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
}));

vi.mock('../../app-language', () => ({
  getAppLanguage: () => mockGetAppLanguage(),
}));

vi.mock('../../ai/auth/resolver', () => ({
  resolveAuth: vi.fn(async () => null),
  resolveAuthFromQueue: vi.fn(async () => null),
}));

vi.mock('../../ai/providers/factory', () => ({
  createProvider: vi.fn((options: { modelId: string }) => ({
    provider: 'deepseek',
    modelId: options.modelId,
  })),
}));

vi.mock('../../ai/tools/build-registry', () => ({
  buildToolRegistry: vi.fn(() => ({
    getToolsForAgent: vi.fn(() => ({})),
  })),
}));

vi.mock('../../ai/security/security-profile', () => ({
  getSecurityProfile: vi.fn(() => ({
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  })),
}));

const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
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
});

function createMockTerminal(overrides: Partial<TerminalProcess> = {}): TerminalProcess {
  return {
    id: 'term-1',
    pty: createMockPty(),
    outputBuffer: '',
    isCLIMode: false,
    title: 'Terminal 1',
    cwd: process.cwd(),
    projectPath: process.cwd(),
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('deepseek-cli-session', () => {
  beforeEach(async () => {
    mockSafeSendToRenderer.mockClear();
    mockPersistSessionAsync.mockClear();
    mockStreamText.mockReset();
    mockGetAppLanguage.mockReset();
    mockGetAppLanguage.mockReturnValue('en');
    const mod = await import('../deepseek-cli-session');
    mod.resetDeepSeekSessionsForTest();
  });

  it('starts a built-in DeepSeek session without writing an external command', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;

    const ptyManager = await import('../pty-manager');
    const mod = await import('../deepseek-cli-session');
    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);

    expect(terminal.isCLIMode).toBe(true);
    expect(terminal.activeCLI).toBe('deepseek');
    expect(terminal.title).toBe('DeepSeek');
    expect(ptyManager.writeToPty).not.toHaveBeenCalled();
    const plainOutput = stripAnsi(terminal.outputBuffer);
    expect(plainOutput).toContain('DeepSeek built-in CLI');
    expect(plainOutput).toContain('Model: deepseek-v4-pro');
    expect(plainOutput).toContain('> ');
    expect(plainOutput).toContain('deepseek-v4-pro · ');

    const session = mod.getDeepSeekSessionForTest(terminal.id);
    expect(session?.modelId).toBe('deepseek-v4-pro');
  });

  it('handles slash commands and exits back to shell mode', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    const consumed = mod.handleDeepSeekInput(terminal, '/clear\r/exit\r', getWindow);

    expect(consumed).toBe(true);
    expect(terminal.outputBuffer).toContain('Conversation cleared.');
    expect(terminal.outputBuffer).toContain('Exited DeepSeek CLI.');
    expect(terminal.isCLIMode).toBe(false);
    expect(terminal.activeCLI).toBeUndefined();
  });

  it('shows and switches the active model with /model', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, '/model\r/model flash\r/model\r/model deepseek-v4-pro\r', getWindow);

    const plainOutput = stripAnsi(terminal.outputBuffer);
    expect(plainOutput).toContain('Current model: deepseek-v4-pro');
    expect(plainOutput).toContain('Model switched to deepseek-v4-flash.');
    expect(plainOutput).toContain('Current model: deepseek-v4-flash');
    expect(plainOutput).toContain('Model switched to deepseek-v4-pro.');
    expect(mod.getDeepSeekSessionForTest(terminal.id)?.modelId).toBe('deepseek-v4-pro');
    expect(terminal.deepseekState?.modelId).toBe('deepseek-v4-pro');
  });

  it('restores per-terminal DeepSeek model and messages', async () => {
    const terminal = createMockTerminal({
      deepseekState: {
        modelId: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: 'remember this' },
          { role: 'assistant', content: 'remembered' },
        ],
      },
    });
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);

    const session = mod.getDeepSeekSessionForTest(terminal.id);
    expect(session?.modelId).toBe('deepseek-v4-flash');
    expect(session?.messages).toHaveLength(2);
    expect(stripAnsi(terminal.outputBuffer)).toContain('Model: deepseek-v4-flash');
    expect(terminal.deepseekState?.modelId).toBe('deepseek-v4-flash');
    expect(terminal.deepseekState?.messages).toHaveLength(2);
  });

  it('keeps DeepSeek state terminal-local across sessions', async () => {
    const terminalA = createMockTerminal({ id: 'term-a' });
    const terminalB = createMockTerminal({ id: 'term-b' });
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminalA, terminalA.cwd, getWindow);
    mod.startDeepSeekCli(terminalB, terminalB.cwd, getWindow);
    mod.handleDeepSeekInput(terminalA, '/model flash\r', getWindow);

    expect(mod.getDeepSeekSessionForTest(terminalA.id)?.modelId).toBe('deepseek-v4-flash');
    expect(mod.getDeepSeekSessionForTest(terminalB.id)?.modelId).toBe('deepseek-v4-pro');
    expect(terminalA.deepseekState?.modelId).toBe('deepseek-v4-flash');
    expect(terminalB.deepseekState?.modelId).toBe('deepseek-v4-pro');
  });

  it('clears persisted DeepSeek messages with /clear', async () => {
    const terminal = createMockTerminal({
      deepseekState: {
        modelId: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'old context' }],
      },
    });
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, '/clear\r', getWindow);

    expect(mod.getDeepSeekSessionForTest(terminal.id)?.messages).toHaveLength(0);
    expect(terminal.deepseekState?.modelId).toBe('deepseek-v4-flash');
    expect(terminal.deepseekState?.messages).toEqual([]);
  });

  it('clears unicode input correctly with backspace', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, '你好abc\b\b\b\b\b\r', getWindow);

    const session = mod.getDeepSeekSessionForTest(terminal.id);
    expect(session?.inputBuffer).toBe('');
    expect(session?.cursor).toBe(0);
    expect(terminal.outputBuffer).toContain('\r\x1b[2K');
    expect(stripAnsi(terminal.outputBuffer)).toContain('> ');
    expect(stripAnsi(terminal.outputBuffer)).toContain('deepseek-v4-pro · ');
  });

  it('swallows terminal focus escape sequences instead of echoing their tails', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const mod = await import('../deepseek-cli-session');

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    const beforeInput = terminal.outputBuffer;
    mod.handleDeepSeekInput(terminal, '\u001b[O\u001b[I\u001b[O', getWindow);

    const session = mod.getDeepSeekSessionForTest(terminal.id);
    expect(session?.inputBuffer).toBe('');
    expect(terminal.outputBuffer).toBe(beforeInput);
    expect(terminal.outputBuffer).not.toContain('[O');
    expect(terminal.outputBuffer).not.toContain('[I');
  });

  it('cancels an in-flight response immediately on Ctrl+C', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    let releaseStream: (() => void) | undefined;
    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield { type: 'text-delta', text: 'late output' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'hello\r', getWindow);

    expect(mod.getDeepSeekSessionForTest(terminal.id)?.busy).toBe(true);

    mod.handleDeepSeekInput(terminal, '\u0003', getWindow);

    expect(mod.getDeepSeekSessionForTest(terminal.id)?.busy).toBe(false);
    expect(terminal.outputBuffer).toContain('Request cancelled.');

    mod.handleDeepSeekInput(terminal, '/model\r', getWindow);

    expect(stripAnsi(terminal.outputBuffer)).toContain('Current model: deepseek-v4-pro');

    releaseStream?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminal.outputBuffer).not.toContain('late output');
  });

  it('enables smoothed streaming and writes text deltas as they arrive', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    let releaseSecondChunk: (() => void) | undefined;
    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'first ' };
        await new Promise<void>((resolve) => {
          releaseSecondChunk = resolve;
        });
        yield { type: 'text-delta', text: 'second' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'hello\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      experimental_transform: expect.objectContaining({ type: 'smoothStream' }),
    }));
    expect(terminal.outputBuffer).toContain('first ');
    expect(terminal.outputBuffer).not.toContain('second');

    releaseSecondChunk?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminal.outputBuffer).toContain('second');
  });

  it('instructs DeepSeek to answer in the current app language', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    mockGetAppLanguage.mockReturnValueOnce('zh-CN');
    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });
    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '好的' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'hello\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockStreamText).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('Simplified Chinese'),
    }));
  });

  it('streams Write tool input as readable file content before the tool finishes', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    const input = JSON.stringify({
      file_path: 'E:\\Work\\Test\\aitest\\gomoku.html',
      content: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">',
    });

    let releaseSecondChunk: (() => void) | undefined;
    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Write' };
        yield { type: 'tool-input-delta', toolCallId: 'call-1', delta: input.slice(0, 100) };
        await new Promise<void>((resolve) => {
          releaseSecondChunk = resolve;
        });
        yield { type: 'tool-input-delta', toolCallId: 'call-1', delta: input.slice(100) };
        yield { type: 'tool-input-end', toolCallId: 'call-1', toolName: 'Write' };
        yield { type: 'tool-result', toolCallId: 'call-1', toolName: 'Write', output: 'Successfully wrote 4 lines' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'write file\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const partialOutput = stripAnsi(terminal.outputBuffer);
    expect(partialOutput).toContain('Write E:\\Work\\Test\\aitest\\gomoku.html');
    expect(partialOutput).toContain('<!DOCTYPE html>');
    expect(partialOutput).not.toContain('Successfully wrote 4 lines');

    releaseSecondChunk?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const plainOutput = stripAnsi(terminal.outputBuffer);
    expect(plainOutput).toContain('Write E:\\Work\\Test\\aitest\\gomoku.html');
    expect(plainOutput).toContain('<!DOCTYPE html>\r\n<html lang="zh-CN">\r\n<head>');
    expect(plainOutput).toContain('Write: Successfully wrote 4 lines');
    expect(plainOutput).not.toContain('[tool input]');
    expect(plainOutput).not.toContain('{"file_path"');
    expect(plainOutput).not.toContain('\\n<html');
  });

  it('streams DeepSeek reasoning deltas before final answer text', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    let releaseAnswer: (() => void) | undefined;
    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'reasoning-start' };
        yield { type: 'reasoning-delta', text: 'thinking now' };
        await new Promise<void>((resolve) => {
          releaseAnswer = resolve;
        });
        yield { type: 'reasoning-end' };
        yield { type: 'text-delta', text: 'final answer' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'hello\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const partialOutput = stripAnsi(terminal.outputBuffer);
    expect(partialOutput).toContain('[thinking]');
    expect(partialOutput).toContain('thinking now');
    expect(partialOutput).not.toContain('final answer');
    expect(terminal.outputBuffer).not.toContain('\x1b[90mthinking now');

    releaseAnswer?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stripAnsi(terminal.outputBuffer)).toContain('final answer');
  });

  it('renders assistant markdown as terminal preview instead of raw markdown source', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '# Title\n\n- **Item** with `code`\n```ts\nconst x = 1;\n```\n' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'render markdown\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const plainOutput = stripAnsi(terminal.outputBuffer);
    expect(plainOutput).toContain('TITLE');
    expect(plainOutput).toContain('• Item with code');
    expect(plainOutput).toContain('const x = 1;');
    expect(plainOutput).not.toContain('# Title');
    expect(plainOutput).not.toContain('**Item**');
    expect(plainOutput).not.toContain('```ts');
  });

  it('renders large streamed Write content without truncating', async () => {
    const terminal = createMockTerminal();
    const getWindow = () => null;
    const authResolver = await import('../../ai/auth/resolver');
    const mod = await import('../deepseek-cli-session');

    vi.mocked(authResolver.resolveAuth).mockResolvedValueOnce({
      apiKey: 'test-key',
      source: 'environment',
    });

    const longContent = `${'a'.repeat(4500)}TAIL_SHOULD_RENDER`;
    const input = JSON.stringify({
      file_path: 'E:\\Work\\Test\\large.txt',
      content: longContent,
    });

    mockStreamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Write' };
        yield { type: 'tool-input-delta', toolCallId: 'call-1', delta: input.slice(0, 4200) };
        yield { type: 'tool-input-delta', toolCallId: 'call-1', delta: input.slice(4200) };
        yield { type: 'tool-input-end', toolCallId: 'call-1', toolName: 'Write' };
        yield { type: 'tool-result', toolCallId: 'call-1', toolName: 'Write', output: 'Successfully wrote large file' };
      })(),
    });

    mod.startDeepSeekCli(terminal, terminal.cwd, getWindow);
    mod.handleDeepSeekInput(terminal, 'write large file\r', getWindow);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const plainOutput = stripAnsi(terminal.outputBuffer);
    expect(plainOutput).toContain('Write E:\\Work\\Test\\large.txt');
    expect(plainOutput).not.toContain('...');
    expect(plainOutput).toContain('Write: Successfully wrote large file');
    expect(plainOutput).toContain('TAIL_SHOULD_RENDER');
  });
});
