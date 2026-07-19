import { useNeedsInputPromptStore } from '../stores/needs-input-prompt-store';
import { startTaskOrQueue } from '../stores/task-store';
import { NeedsInputDecisionDialog } from './task-detail/task-review/NeedsInputDecisionDialog';

/**
 * App-level host for the needs_input decision popup. It listens to the prompt store, which
 * the IPC status listener opens when a running task pauses on unresolved design-review open
 * questions. On resolve it re-runs planning so the task can continue past the human gate.
 */
export function GlobalNeedsInputDialog() {
  const prompt = useNeedsInputPromptStore((state) => state.prompt);
  const closeNeedsInputPrompt = useNeedsInputPromptStore((state) => state.closeNeedsInputPrompt);

  if (!prompt) {
    return null;
  }

  return (
    <NeedsInputDecisionDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeNeedsInputPrompt();
        }
      }}
      taskId={prompt.taskId}
      projectId={prompt.projectId}
      onResolved={() => {
        void startTaskOrQueue(prompt.taskId, prompt.projectId);
      }}
    />
  );
}
