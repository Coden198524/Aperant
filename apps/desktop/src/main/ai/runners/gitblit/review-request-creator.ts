import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CreateGitBlitReviewRequestConfig {
  projectDir: string;
  worktreePath: string;
  specId: string;
  branchName: string;
  baseBranch: string;
  title: string;
  gitPath: string;
  existingTicketId?: number;
  existingReviewUrl?: string;
}

export interface CreateGitBlitReviewRequestResult {
  success: boolean;
  prUrl?: string;
  alreadyExists?: boolean;
  message?: string;
  error?: string;
  ticketId?: number;
}

function runGit(
  gitPath: string,
  cwd: string,
  args: string[],
  input?: string,
): string {
  return execFileSync(gitPath, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  }).trim();
}

function extractSpecSummary(projectDir: string, specId: string): string {
  const specFile = join(projectDir, '.autocode', 'specs', specId, 'spec.md');
  if (!existsSync(specFile)) {
    return '';
  }

  try {
    const content = readFileSync(specFile, 'utf-8');
    const withoutTitle = content.replace(/^#+[^\n]+\n/, '').trim();
    return withoutTitle.slice(0, 800);
  } catch {
    return '';
  }
}

export function normalizeGitBlitBaseBranch(baseBranch: string): string {
  return baseBranch.startsWith('origin/')
    ? baseBranch.slice('origin/'.length)
    : baseBranch;
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

function listRemoteTicketIds(worktreePath: string, gitPath: string): Set<number> {
  try {
    const output = runGit(gitPath, worktreePath, ['ls-remote', '--heads', 'origin', 'refs/heads/ticket/*']);
    return parseGitBlitTicketIdsFromRemote(output);
  } catch {
    return new Set<number>();
  }
}

function resolveBaseRef(worktreePath: string, gitPath: string, effectiveBaseBranch: string): string {
  try {
    runGit(gitPath, worktreePath, ['rev-parse', '--verify', `origin/${effectiveBaseBranch}`]);
    return `origin/${effectiveBaseBranch}`;
  } catch {
    return effectiveBaseBranch;
  }
}

function createProposalCommit(
  config: CreateGitBlitReviewRequestConfig,
  effectiveBaseBranch: string,
): string {
  const treeSha = runGit(config.gitPath, config.worktreePath, ['rev-parse', 'HEAD^{tree}']);
  const baseRef = resolveBaseRef(config.worktreePath, config.gitPath, effectiveBaseBranch);

  let parentSha: string;
  try {
    parentSha = runGit(config.gitPath, config.worktreePath, ['merge-base', 'HEAD', baseRef]);
  } catch {
    parentSha = runGit(config.gitPath, config.worktreePath, ['rev-parse', baseRef]);
  }

  const summary = extractSpecSummary(config.projectDir, config.specId);
  const commitMessage = summary
    ? `${config.title}\n\n${summary}`
    : config.title;

  return runGit(
    config.gitPath,
    config.worktreePath,
    ['commit-tree', treeSha, '-p', parentSha],
    commitMessage,
  );
}

function extractFirstUrl(output: string): string | undefined {
  const match = output.match(/https?:\/\/\S+/i);
  if (!match) {
    return undefined;
  }

  return match[0].replace(/[),.;]+$/, '');
}

function pushReviewRef(
  worktreePath: string,
  gitPath: string,
  sourceRef: string,
  targetRef: string,
): { success: true; output: string } | { success: false; error: string; output: string } {
  try {
    const output = runGit(gitPath, worktreePath, ['push', '--porcelain', 'origin', `${sourceRef}:${targetRef}`]);
    return { success: true, output };
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')
      : '';
    const stdout = error instanceof Error && 'stdout' in error
      ? String((error as NodeJS.ErrnoException & { stdout?: string }).stdout ?? '')
      : '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return {
      success: false,
      error: output || (error instanceof Error ? error.message : 'Failed to push review ref'),
      output,
    };
  }
}

function setTicketUpstream(
  worktreePath: string,
  gitPath: string,
  branchName: string,
  ticketId: number,
): void {
  try {
    runGit(
      gitPath,
      worktreePath,
      ['branch', '--set-upstream-to', `origin/ticket/${ticketId}`, branchName],
    );
  } catch {
    // Best-effort only. The review request has already been created.
  }
}

export async function createGitBlitReviewRequest(
  config: CreateGitBlitReviewRequestConfig,
): Promise<CreateGitBlitReviewRequestResult> {
  const effectiveBaseBranch = normalizeGitBlitBaseBranch(config.baseBranch || 'new');
  const knownTicketId = config.existingTicketId ?? parseGitBlitTicketId(config.existingReviewUrl);
  const beforeTicketIds = knownTicketId === undefined
    ? listRemoteTicketIds(config.worktreePath, config.gitPath)
    : new Set<number>();

  const sourceRef = knownTicketId === undefined
    ? createProposalCommit(config, effectiveBaseBranch)
    : 'HEAD';
  const targetRef = knownTicketId === undefined
    ? `refs/for/${effectiveBaseBranch || 'new'}`
    : `refs/for/${knownTicketId}`;

  const pushResult = pushReviewRef(config.worktreePath, config.gitPath, sourceRef, targetRef);
  if (!pushResult.success) {
    return {
      success: false,
      error: pushResult.error,
    };
  }

  const afterTicketIds = knownTicketId === undefined
    ? listRemoteTicketIds(config.worktreePath, config.gitPath)
    : new Set<number>([knownTicketId]);
  const createdTicketIds = diffGitBlitTicketIds(beforeTicketIds, afterTicketIds);
  const ticketId = knownTicketId
    ?? (createdTicketIds.length === 1 ? createdTicketIds[0] : undefined)
    ?? parseGitBlitTicketId(pushResult.output);
  const prUrl = extractFirstUrl(pushResult.output) ?? config.existingReviewUrl;

  if (ticketId !== undefined) {
    setTicketUpstream(config.worktreePath, config.gitPath, config.branchName, ticketId);
  }

  const message = knownTicketId !== undefined
    ? `Updated GitBlit ticket #${ticketId ?? knownTicketId} with a new patchset.`
    : ticketId !== undefined
      ? `Created GitBlit ticket #${ticketId}.`
      : 'Created a GitBlit proposal ticket.';

  return {
    success: true,
    prUrl,
    message,
    ticketId,
  };
}
