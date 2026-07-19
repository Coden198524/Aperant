import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group';
import { Textarea } from '../../ui/textarea';
import type {
  TaskDecisionAnswer,
  TaskNeedsInputDecisions,
  TaskOpenQuestionDecision,
} from '../../../../shared/types';

const CUSTOM_OPTION_ID = 'custom';

interface NeedsInputDecisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  projectId?: string;
  /** Called after the decisions are written back so the caller can re-run planning. */
  onResolved: () => void;
}

/** Normalizes structured decisions and plain-question fallbacks into a single list. */
function toRenderableQuestions(
  data: TaskNeedsInputDecisions | null,
  approveLabel: string,
): TaskOpenQuestionDecision[] {
  if (!data) return [];
  if (data.decisions.length > 0) return data.decisions;
  // Fallback: reviews without a structured options section still expose plain open
  // questions. Synthesize a recommended "approve the current assumption" choice so the
  // dialog always offers a selectable list with a default, plus the custom-answer option
  // rendered by the component. This keeps the UX working even when the reviewer omits
  // the machine-readable options block.
  return data.questions.map((question, index) => ({
    id: `Q${index + 1}`,
    question,
    options: [{ id: 'A', label: approveLabel, recommended: true }],
  }));
}

/**
 * Presents the design-review open questions as single-choice prompts with a recommended
 * default, letting the user resolve the needs_input gate without hand-editing files.
 */
export function NeedsInputDecisionDialog({
  open,
  onOpenChange,
  taskId,
  projectId,
  onResolved,
}: NeedsInputDecisionDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TaskNeedsInputDecisions | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});

  const approveLabel = t('needsInputDialog.approveAssumptionOption', {
    defaultValue: 'Approve the current assumptions documented in requirements.md and continue',
  });
  const questions = useMemo(() => toRenderableQuestions(data, approveLabel), [data, approveLabel]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setSelections({});
    setCustomText({});
    window.electronAPI
      .getNeedsInputDecisions(taskId, projectId)
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) {
          setError(result.error || t('needsInputDialog.loadError', { defaultValue: 'Could not load the open questions.' }));
          return;
        }
        setData(result.data);
        // Pre-select the recommended option for each renderable question (structured
        // decisions and synthesized fallbacks alike) so a default is always chosen.
        const initial: Record<string, string> = {};
        for (const decision of toRenderableQuestions(result.data, approveLabel)) {
          const recommended = decision.options.find((option) => option.recommended) ?? decision.options[0];
          if (recommended) {
            initial[decision.id] = recommended.id;
          }
        }
        setSelections(initial);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, taskId, projectId, t]);

  const buildAnswers = (): TaskDecisionAnswer[] | null => {
    const answers: TaskDecisionAnswer[] = [];
    for (const decision of questions) {
      const hasOptions = decision.options.length > 0;
      const selectedId = hasOptions ? selections[decision.id] : CUSTOM_OPTION_ID;
      if (!selectedId) {
        return null; // A question is unanswered.
      }
      if (selectedId === CUSTOM_OPTION_ID) {
        const text = (customText[decision.id] ?? '').trim();
        if (!text) return null;
        answers.push({ questionId: decision.id, question: decision.question, optionId: CUSTOM_OPTION_ID, answer: text });
        continue;
      }
      const option = decision.options.find((candidate) => candidate.id === selectedId);
      if (!option) return null;
      answers.push({ questionId: decision.id, question: decision.question, optionId: option.id, answer: option.label });
    }
    return answers;
  };

  const handleSubmit = async () => {
    const answers = buildAnswers();
    if (!answers || answers.length === 0) {
      setError(t('needsInputDialog.incomplete', { defaultValue: 'Please choose or enter an answer for every question.' }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electronAPI.resolveNeedsInputDecisions(taskId, answers, projectId);
      if (!result.success) {
        setError(result.error || t('needsInputDialog.saveError', { defaultValue: 'Could not save your decisions.' }));
        return;
      }
      onOpenChange(false);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('needsInputDialog.title', { defaultValue: 'Resolve Open Questions' })}
          </DialogTitle>
          <DialogDescription>
            {t('needsInputDialog.description', {
              defaultValue:
                'The design review paused on decisions only you can make. Pick an option per question (the recommended one is preselected), then re-run planning.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-5">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('needsInputDialog.loading', { defaultValue: 'Loading open questions...' })}
            </div>
          )}

          {!loading && questions.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">
              {t('needsInputDialog.empty', {
                defaultValue: 'No structured open questions were found. Review design_review.md and edit requirements.md manually.',
              })}
            </p>
          )}

          {!loading &&
            questions.map((decision) => {
              const selectedId = decision.options.length > 0 ? selections[decision.id] : CUSTOM_OPTION_ID;
              return (
                <div key={decision.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                  <p className="text-sm font-medium text-foreground mb-3">
                    <span className="text-muted-foreground mr-1">{decision.id}</span>
                    {decision.question}
                  </p>
                  <RadioGroup
                    value={selectedId}
                    onValueChange={(value) =>
                      setSelections((prev) => ({ ...prev, [decision.id]: value }))
                    }
                    className="gap-2"
                  >
                    {decision.options.map((option) => (
                      <label
                        key={option.id}
                        htmlFor={`${decision.id}-${option.id}`}
                        className="flex items-start gap-2 rounded-lg p-2 cursor-pointer hover:bg-accent/50"
                      >
                        <RadioGroupItem
                          id={`${decision.id}-${option.id}`}
                          value={option.id}
                          className="mt-0.5"
                        />
                        <span className="text-sm text-foreground">
                          {option.label}
                          {option.recommended && (
                            <span className="ml-2 text-xs text-primary font-medium">
                              {t('needsInputDialog.recommended', { defaultValue: 'Recommended' })}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                    <label
                      htmlFor={`${decision.id}-${CUSTOM_OPTION_ID}`}
                      className="flex items-start gap-2 rounded-lg p-2 cursor-pointer hover:bg-accent/50"
                    >
                      <RadioGroupItem
                        id={`${decision.id}-${CUSTOM_OPTION_ID}`}
                        value={CUSTOM_OPTION_ID}
                        className="mt-0.5"
                      />
                      <span className="text-sm text-foreground">
                        {t('needsInputDialog.customOption', { defaultValue: 'Write my own answer' })}
                      </span>
                    </label>
                  </RadioGroup>
                  {selectedId === CUSTOM_OPTION_ID && (
                    <Textarea
                      value={customText[decision.id] ?? ''}
                      onChange={(event) =>
                        setCustomText((prev) => ({ ...prev, [decision.id]: event.target.value }))
                      }
                      placeholder={t('needsInputDialog.customPlaceholder', {
                        defaultValue: 'Describe the decision to apply...',
                      })}
                      className="mt-2 min-h-[72px]"
                    />
                  )}
                </div>
              );
            })}

          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common:buttons.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button onClick={handleSubmit} disabled={loading || submitting || questions.length === 0}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('needsInputDialog.applying', { defaultValue: 'Applying...' })}
              </>
            ) : (
              t('needsInputDialog.applyAndReplan', { defaultValue: 'Apply & Re-run Planning' })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
