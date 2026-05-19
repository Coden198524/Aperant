import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '../../terminal-session-store';
import { deepSeekSessionsToNativeHistory, isDeepSeekStoredSession } from '../deepseek-history';

function createStoredSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'deepseek-session-1',
    title: 'DeepSeek',
    cwd: 'E:\\Work\\Aperant',
    projectPath: 'E:\\Work\\Aperant',
    isCLIMode: true,
    activeCLI: 'deepseek',
    outputBuffer: '',
    createdAt: '2026-05-18T08:00:00.000Z',
    lastActiveAt: '2026-05-18T09:00:00.000Z',
    deepseekState: {
      modelId: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Explain the renderer state flow' }],
    },
    ...overrides,
  };
}

describe('deepseek-history', () => {
  it('maps persisted DeepSeek terminal sessions to history items', () => {
    const history = deepSeekSessionsToNativeHistory([
      createStoredSession(),
      createStoredSession({
        id: 'shell-session',
        isCLIMode: false,
        activeCLI: undefined,
        deepseekState: undefined,
      }),
    ]);

    expect(history).toEqual([
      {
        id: 'deepseek-session-1',
        cli: 'deepseek',
        title: 'Explain the renderer state flow',
        createdAt: '2026-05-18T08:00:00.000Z',
        updatedAt: '2026-05-18T09:00:00.000Z',
        projectPath: 'E:\\Work\\Aperant',
        sourcePath: 'autocode-terminal-session',
      },
    ]);
  });

  it('sorts newest sessions first and falls back to model title', () => {
    const history = deepSeekSessionsToNativeHistory([
      createStoredSession({
        id: 'older',
        lastActiveAt: '2026-05-18T09:00:00.000Z',
      }),
      createStoredSession({
        id: 'newer',
        lastActiveAt: '2026-05-18T10:00:00.000Z',
        deepseekState: {
          modelId: 'deepseek-v4-flash',
          messages: [],
        },
      }),
    ]);

    expect(history.map((session) => session.id)).toEqual(['newer', 'older']);
    expect(history[0].title).toBe('DeepSeek - deepseek-v4-flash');
  });

  it('recognizes only persisted DeepSeek CLI sessions', () => {
    expect(isDeepSeekStoredSession(createStoredSession())).toBe(true);
    expect(isDeepSeekStoredSession(createStoredSession({ activeCLI: 'codex' }))).toBe(false);
    expect(isDeepSeekStoredSession(createStoredSession({ deepseekState: undefined }))).toBe(false);
  });
});
