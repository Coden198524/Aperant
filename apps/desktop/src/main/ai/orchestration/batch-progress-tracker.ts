/**
 * Batch Progress Tracker
 * =======================
 *
 * Tracks progress during batch subtask execution by parsing model output
 * for progress markers and verifying against implementation_plan.json.
 */

import type { BatchProgress } from './batch-types';
import { loadImplementationPlanFromFiles } from '../schema/plan-shards';

// =============================================================================
// Progress Marker Parsing
// =============================================================================

/** Regular expression to match progress markers in model output */
const PROGRESS_MARKER_REGEX = /\[SUBTASK_COMPLETED:\s*([^\]]+)\]/g;

/**
 * Batch Progress Tracker
 *
 * Tracks subtask completion during batch execution by:
 * 1. Parsing progress markers from model output
 * 2. Verifying actual file status in implementation_plan.json
 * 3. Reconciling differences between markers and file state
 */
export class BatchProgressTracker {
  private completedMarkers = new Set<string>();

  /**
   * Parses model output for progress markers.
   *
   * Looks for markers in the format: [SUBTASK_COMPLETED: subtask_id]
   *
   * @param text - Model output text
   */
  parseOutput(text: string): void {
    let match: RegExpExecArray | null;

    while ((match = PROGRESS_MARKER_REGEX.exec(text)) !== null) {
      const subtaskId = match[1].trim();
      this.completedMarkers.add(subtaskId);
    }
  }

  /**
   * Gets all completed subtask IDs from parsed markers.
   *
   * @returns Set of completed subtask IDs
   */
  getCompletedMarkers(): Set<string> {
    return new Set(this.completedMarkers);
  }

  /**
   * Verifies actual progress by reading implementation_plan.json.
   *
   * @param specDir - Spec directory path
   * @returns Progress information from the file
   */
  async verifyProgress(specDir: string): Promise<BatchProgress> {
    try {
      const plan = await loadImplementationPlanFromFiles(specDir);

      if (!plan || typeof plan !== 'object' || !('phases' in plan)) {
        throw new Error('Invalid implementation plan format');
      }

      const completed: string[] = [];
      const inProgress: string[] = [];
      const blocked: string[] = [];
      const notStarted: string[] = [];

      const phases = plan.phases as Array<{
        subtasks?: Array<{
          id: string;
          status: string;
        }>;
      }>;

      for (const phase of phases) {
        if (!phase.subtasks) continue;

        for (const subtask of phase.subtasks) {
          switch (subtask.status) {
            case 'completed':
              completed.push(subtask.id);
              break;
            case 'in_progress':
              inProgress.push(subtask.id);
              break;
            case 'blocked':
              blocked.push(subtask.id);
              break;
            case 'pending':
              notStarted.push(subtask.id);
              break;
          }
        }
      }

      return { completed, inProgress, blocked, notStarted };
    } catch (error) {
      throw new Error(
        `Failed to verify progress: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Reconciles progress markers with file state.
   *
   * If markers and file state differ, the file state is considered authoritative.
   * Differences are logged for debugging.
   *
   * @param specDir - Spec directory path
   * @param expectedIds - Expected subtask IDs in the batch
   * @returns Reconciled progress information
   */
  async reconcile(specDir: string, expectedIds: string[]): Promise<BatchProgress> {
    const fileProgress = await this.verifyProgress(specDir);

    // Find markers that don't have corresponding file updates
    const markerOnly = Array.from(this.completedMarkers).filter(
      (id) => !fileProgress.completed.includes(id)
    );

    if (markerOnly.length > 0) {
      console.warn(
        `[BatchProgressTracker] Progress markers without file updates: ${markerOnly.join(', ')}`
      );
    }

    // Find file updates that don't have corresponding markers
    const fileOnly = fileProgress.completed.filter(
      (id) => expectedIds.includes(id) && !this.completedMarkers.has(id)
    );

    if (fileOnly.length > 0) {
      console.warn(
        `[BatchProgressTracker] File updates without progress markers: ${fileOnly.join(', ')}`
      );
    }

    // File state is authoritative
    return fileProgress;
  }

  /**
   * Resets the tracker state.
   */
  reset(): void {
    this.completedMarkers.clear();
  }
}

/**
 * Creates a new batch progress tracker.
 *
 * @returns New BatchProgressTracker instance
 */
export function createBatchProgressTracker(): BatchProgressTracker {
  return new BatchProgressTracker();
}
