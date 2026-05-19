import type { NativeCliSession } from '../../shared/types';
import type { TerminalSession } from '../terminal-session-store';

function formatDeepSeekHistoryTitle(text: unknown, fallback: string): string {
  if (typeof text !== 'string') {
    return fallback;
  }

  const firstLine = text.replace(/\s+/g, ' ').trim();
  if (!firstLine) {
    return fallback;
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function extractTextPart(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textPart = content.find((part) => {
    if (!part || typeof part !== 'object') {
      return false;
    }
    const type = (part as { type?: unknown }).type;
    return type === 'text' || type === 'input_text';
  });
  const text = (textPart as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

function extractDeepSeekUserText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'user') {
    return undefined;
  }

  return extractTextPart(record.content);
}

function getDeepSeekHistoryTitle(session: TerminalSession): string {
  const modelId = session.deepseekState?.modelId || 'deepseek-v4-pro';
  const fallback = session.title && session.title !== 'DeepSeek'
    ? session.title
    : `DeepSeek - ${modelId}`;
  const messages = session.deepseekState?.messages;
  const firstUserText = Array.isArray(messages)
    ? messages.map(extractDeepSeekUserText).find((text): text is string => Boolean(text))
    : undefined;

  return formatDeepSeekHistoryTitle(firstUserText, fallback);
}

export function isDeepSeekStoredSession(session: TerminalSession): boolean {
  return session.isCLIMode === true
    && session.activeCLI === 'deepseek'
    && session.deepseekState !== undefined;
}

export function deepSeekSessionsToNativeHistory(
  sessions: TerminalSession[],
): NativeCliSession[] {
  const byId = new Map<string, NativeCliSession>();

  for (const session of sessions) {
    if (!isDeepSeekStoredSession(session)) {
      continue;
    }

    const updatedAt = session.lastActiveAt || session.createdAt || new Date(0).toISOString();
    const existing = byId.get(session.id);
    if (existing && new Date(existing.updatedAt).getTime() > new Date(updatedAt).getTime()) {
      continue;
    }

    byId.set(session.id, {
      id: session.id,
      cli: 'deepseek',
      title: getDeepSeekHistoryTitle(session),
      createdAt: session.createdAt,
      updatedAt,
      projectPath: session.projectPath,
      sourcePath: 'autocode-terminal-session',
    });
  }

  return [...byId.values()]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
