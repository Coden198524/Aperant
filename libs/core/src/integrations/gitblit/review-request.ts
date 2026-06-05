import { normalizeAutocodeBaseBranch } from '../../tasks/branch-protocol.js';

export function normalizeGitBlitBaseBranch(baseBranch: string): string {
  return normalizeAutocodeBaseBranch(baseBranch) ?? '';
}

export function parseGitBlitTicketId(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const patterns = [
    /refs\/heads\/ticket\/(\d+)\b/i,
    /origin\/ticket\/(\d+)\b/i,
    /ticket\/(\d+)\b/i,
    /[?&]id=(\d+)\b/i,
    /\bticket\s+#?(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function parseGitBlitTicketIdsFromRemote(output: string): Set<number> {
  const ticketIds = new Set<number>();

  for (const line of output.split(/\r?\n/)) {
    const ticketId = parseGitBlitTicketId(line);
    if (ticketId !== undefined) {
      ticketIds.add(ticketId);
    }
  }

  return ticketIds;
}

export function diffGitBlitTicketIds(before: Set<number>, after: Set<number>): number[] {
  return [...after].filter((ticketId) => !before.has(ticketId)).sort((a, b) => a - b);
}
