export interface AutocodeTaskMachineContext {
  reviewReason?: string;
  error?: string;
}

export const AUTOCODE_TASK_MACHINE_INITIAL_CONTEXT: AutocodeTaskMachineContext = {
  reviewReason: undefined,
  error: undefined,
};

export const AUTOCODE_TERMINAL_SWAP_PHASES = {
  capturing: 'capturing',
  migrating: 'migrating',
  recreating: 'recreating',
  resuming: 'resuming',
} as const;

export type AutocodeTerminalSwapPhase = keyof typeof AUTOCODE_TERMINAL_SWAP_PHASES;

export interface AutocodeTerminalMachineContext {
  claudeSessionId?: string;
  profileId?: string;
  swapTargetProfileId?: string;
  swapPhase?: AutocodeTerminalSwapPhase;
  isBusy: boolean;
  error?: string;
}

export const AUTOCODE_TERMINAL_MACHINE_INITIAL_CONTEXT: AutocodeTerminalMachineContext = {
  claudeSessionId: undefined,
  profileId: undefined,
  swapTargetProfileId: undefined,
  swapPhase: undefined,
  isBusy: false,
  error: undefined,
};

export function isAutocodeTerminalSwapPhase(
  context: Pick<AutocodeTerminalMachineContext, 'swapPhase'>,
  phase: AutocodeTerminalSwapPhase
): boolean {
  return context.swapPhase === phase;
}

export interface AutocodeRoadmapGenerationContext {
  progress: number;
  message?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  lastActivityAt?: number;
}

export const AUTOCODE_ROADMAP_GENERATION_INITIAL_CONTEXT: AutocodeRoadmapGenerationContext = {
  progress: 0,
  message: undefined,
  error: undefined,
  startedAt: undefined,
  completedAt: undefined,
  lastActivityAt: undefined,
};

export function clampAutocodeProgress(progress: number): number {
  return Math.min(100, Math.max(0, progress));
}

export interface AutocodeRoadmapFeatureContext {
  linkedSpecId?: string;
  taskOutcome?: string;
  previousStatus?: string;
}

export const AUTOCODE_ROADMAP_FEATURE_INITIAL_CONTEXT: AutocodeRoadmapFeatureContext = {
  linkedSpecId: undefined,
  taskOutcome: undefined,
  previousStatus: undefined,
};

export interface AutocodePrReviewContext<TProgress = unknown, TResult = unknown> {
  prNumber: number | null;
  projectId: string | null;
  startedAt: string | null;
  isFollowup: boolean;
  progress: TProgress | null;
  result: TResult | null;
  previousResult: TResult | null;
  error: string | null;
  isExternalReview: boolean;
}

export const AUTOCODE_PR_REVIEW_INITIAL_CONTEXT: AutocodePrReviewContext = {
  prNumber: null,
  projectId: null,
  startedAt: null,
  isFollowup: false,
  progress: null,
  result: null,
  previousResult: null,
  error: null,
  isExternalReview: false,
};

export function createAutocodePrReviewInitialContext<TProgress, TResult>(): AutocodePrReviewContext<TProgress, TResult> {
  return { ...AUTOCODE_PR_REVIEW_INITIAL_CONTEXT } as AutocodePrReviewContext<TProgress, TResult>;
}
