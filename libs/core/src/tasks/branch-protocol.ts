export const AUTOCODE_PROJECT_DEFAULT_BRANCH_MARKER = '__project_default__';
export const AUTOCODE_DEFAULT_BASE_BRANCH = 'main';
export const AUTOCODE_COMMON_BASE_BRANCHES = ['main', 'master', 'develop', 'dev', 'trunk'] as const;
export const AUTOCODE_TASK_BRANCH_PREFIX = 'autocode/';

export type AutocodeCommonBaseBranch = (typeof AUTOCODE_COMMON_BASE_BRANCHES)[number];

export const AUTOCODE_GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

export type AutocodeWorktreeBranchValidationReason =
  | 'detection_failed'
  | 'exact_match'
  | 'pattern_match'
  | 'invalid_pattern';

export interface AutocodeWorktreeBranchValidationResult {
  branchToDelete: string;
  usedFallback: boolean;
  reason: AutocodeWorktreeBranchValidationReason;
}

export function normalizeAutocodeBaseBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  if (!trimmed || trimmed === AUTOCODE_PROJECT_DEFAULT_BRANCH_MARKER) {
    return null;
  }
  return trimmed.replace(/^origin\//, '');
}

export function isAutocodeGitBranchName(branch: string | null | undefined): branch is string {
  const trimmed = branch?.trim();
  return Boolean(trimmed && trimmed.length <= 255 && AUTOCODE_GIT_BRANCH_REGEX.test(trimmed));
}

export function isAutocodeCommonBaseBranch(branch: string | null | undefined): branch is AutocodeCommonBaseBranch {
  const normalized = normalizeAutocodeBaseBranch(branch)?.toLowerCase();
  return AUTOCODE_COMMON_BASE_BRANCHES.includes(normalized as AutocodeCommonBaseBranch);
}

export function parseAutocodeOriginHeadBranch(ref: string | null | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return null;
  }

  const symbolicRefMatch = trimmed.match(/refs\/remotes\/origin\/(.+)$/);
  if (symbolicRefMatch?.[1]) {
    return normalizeAutocodeBaseBranch(symbolicRefMatch[1]);
  }

  return trimmed.startsWith('origin/') ? normalizeAutocodeBaseBranch(trimmed) : null;
}

export function resolveAutocodeBaseBranchCandidate(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeAutocodeBaseBranch(candidate);
    if (isAutocodeGitBranchName(normalized)) {
      return normalized;
    }
  }

  return null;
}

export function buildAutocodeTaskBranchName(specId: string): string {
  return `${AUTOCODE_TASK_BRANCH_PREFIX}${specId}`;
}

export function isAutocodeTaskBranchName(branch: string | null | undefined): boolean {
  const normalized = branch?.trim();
  return Boolean(
    normalized &&
      normalized.startsWith(AUTOCODE_TASK_BRANCH_PREFIX) &&
      normalized.length > AUTOCODE_TASK_BRANCH_PREFIX.length,
  );
}

export function validateAutocodeWorktreeBranch(
  detectedBranch: string | null,
  expectedBranch: string,
): AutocodeWorktreeBranchValidationResult {
  if (detectedBranch === null) {
    return {
      branchToDelete: expectedBranch,
      usedFallback: true,
      reason: 'detection_failed',
    };
  }

  if (detectedBranch === expectedBranch) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'exact_match',
    };
  }

  if (isAutocodeTaskBranchName(detectedBranch)) {
    return {
      branchToDelete: detectedBranch,
      usedFallback: false,
      reason: 'pattern_match',
    };
  }

  return {
    branchToDelete: expectedBranch,
    usedFallback: true,
    reason: 'invalid_pattern',
  };
}
