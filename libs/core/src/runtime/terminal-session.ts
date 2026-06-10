export const AUTOCODE_TERMINAL_SESSION_FILE_VERSION = 2;
export const AUTOCODE_MAX_TERMINAL_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutocodeTerminalSessionStateLike {
  id: string;
  title: string;
  isCLIMode: boolean;
  lastActiveAt: number;
  bufferFile?: string;
  daemonPtyId?: string;
}

export interface AutocodeTerminalRecoveryInfo {
  totalSessions: number;
  recoverableSessions: number;
  recoveryMethod: 'daemon' | 'state' | 'none';
  sessions: Array<{
    id: string;
    title: string;
    isCLIMode: boolean;
    lastActiveAt: number;
    hasBuffer: boolean;
    hasDaemonPty: boolean;
  }>;
}

export function isAutocodeTerminalSessionFresh(
  session: Pick<AutocodeTerminalSessionStateLike, 'lastActiveAt'>,
  now = Date.now(),
  maxAgeMs = AUTOCODE_MAX_TERMINAL_SESSION_AGE_MS,
): boolean {
  return now - session.lastActiveAt < maxAgeMs;
}

export function partitionAutocodeTerminalSessionsByAge<TSession extends Pick<AutocodeTerminalSessionStateLike, 'lastActiveAt'>>(
  sessions: TSession[],
  now = Date.now(),
  maxAgeMs = AUTOCODE_MAX_TERMINAL_SESSION_AGE_MS,
): { validSessions: TSession[]; staleSessions: TSession[] } {
  const validSessions: TSession[] = [];
  const staleSessions: TSession[] = [];

  for (const session of sessions) {
    if (isAutocodeTerminalSessionFresh(session, now, maxAgeMs)) {
      validSessions.push(session);
    } else {
      staleSessions.push(session);
    }
  }

  return { validSessions, staleSessions };
}

export function buildAutocodeTerminalRecoveryInfo(
  sessions: AutocodeTerminalSessionStateLike[],
): AutocodeTerminalRecoveryInfo {
  return {
    totalSessions: sessions.length,
    recoverableSessions: sessions.filter((session) => session.bufferFile || session.daemonPtyId).length,
    recoveryMethod: sessions.some((session) => session.daemonPtyId) ? 'daemon' : 'state',
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      isCLIMode: session.isCLIMode,
      lastActiveAt: session.lastActiveAt,
      hasBuffer: Boolean(session.bufferFile),
      hasDaemonPty: Boolean(session.daemonPtyId),
    })),
  };
}

export function createAutocodeTerminalBufferFileName(sessionId: string): string {
  return `buffer-${sessionId}.txt`;
}
