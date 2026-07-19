import { create } from 'zustand';

/**
 * App-level store that drives the automatic needs_input decision popup.
 *
 * When a running task pauses at the independent design review because it needs a human
 * decision, the IPC status listener opens this prompt so the decision dialog appears
 * without the user having to open the task detail and click "Re-run Planning".
 */
interface NeedsInputPromptState {
  /** The task awaiting a decision, or null when no popup should be shown. */
  prompt: { taskId: string; projectId?: string } | null;
  /** Task ids already surfaced this session, so a popup is shown only once per pause. */
  shownTaskIds: Set<string>;
  /** Open the popup for a task, unless it was already surfaced for the same pause. */
  openNeedsInputPrompt: (taskId: string, projectId?: string) => void;
  /** Close the popup (user cancelled or resolved). */
  closeNeedsInputPrompt: () => void;
  /** Allow the popup to surface again for a task, e.g. after it re-enters planning. */
  clearShownTaskId: (taskId: string) => void;
}

export const useNeedsInputPromptStore = create<NeedsInputPromptState>((set, get) => ({
  prompt: null,
  shownTaskIds: new Set<string>(),
  openNeedsInputPrompt: (taskId, projectId) => {
    if (get().shownTaskIds.has(taskId)) {
      return;
    }
    const shownTaskIds = new Set(get().shownTaskIds);
    shownTaskIds.add(taskId);
    set({ prompt: { taskId, projectId }, shownTaskIds });
  },
  closeNeedsInputPrompt: () => set({ prompt: null }),
  clearShownTaskId: (taskId) => {
    if (!get().shownTaskIds.has(taskId)) {
      return;
    }
    const shownTaskIds = new Set(get().shownTaskIds);
    shownTaskIds.delete(taskId);
    set({ shownTaskIds });
  },
}));
