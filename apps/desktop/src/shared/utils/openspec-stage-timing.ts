import type {
  OpenSpecAction,
  OpenSpecActionRunSummary,
} from '../types';

export const OPEN_SPEC_TIMING_STAGES = [
  'planning',
  'implementation',
  'verification',
  'archive',
] as const;

export type OpenSpecTimingStage = (typeof OPEN_SPEC_TIMING_STAGES)[number];

export interface OpenSpecStageTimingSummary {
  stage: OpenSpecTimingStage;
  durationMs: number;
  runCount: number;
  active: boolean;
}

const ACTIVE_RUN_STATES = new Set<OpenSpecActionRunSummary['state']>([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
]);

const ACTION_TIMING_STAGE: Record<OpenSpecAction, OpenSpecTimingStage> = {
  explore: 'planning',
  propose: 'planning',
  update: 'planning',
  sync: 'planning',
  new: 'planning',
  continue: 'planning',
  ff: 'planning',
  onboard: 'planning',
  apply: 'implementation',
  verify: 'verification',
  archive: 'archive',
  'bulk-archive': 'archive',
};

function parsedTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function runDurationMs(
  run: OpenSpecActionRunSummary,
  nowMs: number,
): number {
  if (
    typeof run.durationMs === 'number' &&
    Number.isFinite(run.durationMs) &&
    run.durationMs >= 0
  ) {
    return run.durationMs;
  }
  const startedAt = parsedTimestamp(run.startedAt);
  if (startedAt === null) return 0;
  const completedAt = parsedTimestamp(run.completedAt);
  if (completedAt !== null) {
    return Math.max(0, completedAt - startedAt);
  }
  if (ACTIVE_RUN_STATES.has(run.state)) {
    return Math.max(0, nowMs - startedAt);
  }
  return 0;
}

/**
 * Summarizes persisted OpenSpec Action wall-clock time for the whole task.
 *
 * This includes provider retries, tool execution, and interaction waits inside
 * an Action, while excluding idle time between Actions. Failed, cancelled, and
 * interrupted attempts remain part of the cumulative task cost.
 */
export function summarizeOpenSpecStageTimings(
  runs: readonly OpenSpecActionRunSummary[],
  nowMs = Date.now(),
): OpenSpecStageTimingSummary[] {
  const summaries = new Map<OpenSpecTimingStage, OpenSpecStageTimingSummary>(
    OPEN_SPEC_TIMING_STAGES.map((stage) => [
      stage,
      {
        stage,
        durationMs: 0,
        runCount: 0,
        active: false,
      },
    ]),
  );
  const latestRuns = new Map<string, OpenSpecActionRunSummary>();
  for (const run of runs) {
    latestRuns.set(run.runId, run);
  }
  for (const run of latestRuns.values()) {
    const summary = summaries.get(ACTION_TIMING_STAGE[run.action]);
    if (!summary) continue;
    summary.durationMs += runDurationMs(run, nowMs);
    summary.runCount += 1;
    summary.active ||= ACTIVE_RUN_STATES.has(run.state);
  }
  return [...summaries.values()];
}

export function formatOpenSpecStageDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => value.toString().padStart(2, '0');
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${twoDigits(minutes)}:${twoDigits(seconds)}`;
}
