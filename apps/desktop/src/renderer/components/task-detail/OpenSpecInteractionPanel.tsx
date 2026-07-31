import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OpenSpecInteraction } from '../../../shared/types';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';

export interface OpenSpecInteractionAnswerDraft {
  selected: string[];
  text: string;
}

function interactionQuestions(interaction: OpenSpecInteraction) {
  return interaction.questions?.length
    ? interaction.questions
    : [{
        question: interaction.prompt,
        multiSelect: false,
      }];
}

function answerText(draft: OpenSpecInteractionAnswerDraft | undefined): string {
  const selected = draft?.selected ?? [];
  const text = draft?.text.trim() ?? '';
  return [
    ...(selected.length ? [selected.join(', ')] : []),
    ...(text ? [text] : []),
  ].join('\n');
}

export function serializeOpenSpecInteractionAnswers(
  interaction: OpenSpecInteraction,
  drafts: Record<number, OpenSpecInteractionAnswerDraft>,
): string {
  const questions = interactionQuestions(interaction);
  if (questions.length === 1) {
    return answerText(drafts[0]);
  }
  return questions.map((question, index) => [
    `Question ${index + 1}${question.header ? ` (${question.header})` : ''}: ${question.question}`,
    `Answer: ${answerText(drafts[index])}`,
  ].join('\n')).join('\n\n');
}

export function OpenSpecInteractionPanel({
  interaction,
  disabled = false,
  onSubmit,
}: {
  interaction: OpenSpecInteraction;
  disabled?: boolean;
  onSubmit: (answer: string) => Promise<void> | void;
}) {
  const { t } = useTranslation('tasks');
  const [drafts, setDrafts] = useState<Record<number, OpenSpecInteractionAnswerDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const questions = useMemo(() => interactionQuestions(interaction), [interaction]);
  const previousInteractionId = useRef(interaction.interactionId);

  useEffect(() => {
    if (previousInteractionId.current === interaction.interactionId) return;
    previousInteractionId.current = interaction.interactionId;
    setDrafts({});
    setSubmitting(false);
  }, [interaction.interactionId]);

  const updateDraft = (
    index: number,
    updater: (current: OpenSpecInteractionAnswerDraft) => OpenSpecInteractionAnswerDraft,
  ): void => {
    setDrafts((current) => ({
      ...current,
      [index]: updater(current[index] ?? { selected: [], text: '' }),
    }));
  };

  const complete = questions.every((_, index) => Boolean(answerText(drafts[index])));

  return (
    <div className="space-y-4">
      {questions.map((question, index) => {
        const draft = drafts[index] ?? { selected: [], text: '' };
        const options = question.options ?? [];
        return (
          <fieldset
            key={`${interaction.interactionId}:${question.header ?? ''}:${question.question}`}
            className="space-y-2 rounded border border-border p-3"
            disabled={disabled || submitting}
          >
            {question.header && (
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                {question.header}
              </legend>
            )}
            <p className="text-sm">{question.question}</p>

            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((option) => {
                  const checked = draft.selected.includes(option.label);
                  if (question.multiSelect) {
                    const id = `${interaction.interactionId}-${index}-${option.label}`;
                    return (
                      <Label
                        key={option.label}
                        htmlFor={id}
                        className="flex cursor-pointer items-start gap-2 rounded border border-border p-2"
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(value) => updateDraft(index, (current) => ({
                            ...current,
                            selected: value === true
                              ? [...new Set([...current.selected, option.label])]
                              : current.selected.filter((label) => label !== option.label),
                          }))}
                        />
                        <span>
                          <span className="block text-xs font-medium">{option.label}</span>
                          {option.description && (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </Label>
                    );
                  }
                  return (
                    <Button
                      key={option.label}
                      type="button"
                      variant={checked ? 'default' : 'outline'}
                      size="sm"
                      className="mr-1 h-auto whitespace-normal py-1.5 text-left text-xs"
                      aria-pressed={checked}
                      onClick={() => updateDraft(index, (current) => ({
                        ...current,
                        selected: [option.label],
                      }))}
                    >
                      <span>
                        <span className="block">{option.label}</span>
                        {option.description && (
                          <span className="block text-[10px] opacity-75">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}

            <Textarea
              aria-label={options.length
                ? t('openSpec.interaction.additionalAnswerAria', { number: index + 1 })
                : t('openSpec.interaction.answerAria', { number: index + 1 })}
              value={draft.text}
              onChange={(event) => updateDraft(index, (current) => ({
                ...current,
                text: event.target.value,
              }))}
              placeholder={options.length
                ? t('openSpec.interaction.optionalDetailPlaceholder')
                : t('openSpec.interaction.answerPlaceholder')}
              rows={2}
              maxLength={16_000}
            />
          </fieldset>
        );
      })}

      <Button
        size="sm"
        disabled={!complete || disabled || submitting}
        onClick={() => {
          const answer = serializeOpenSpecInteractionAnswers(interaction, drafts);
          setSubmitting(true);
          void Promise.resolve(onSubmit(answer)).finally(() => {
            setSubmitting(false);
          });
        }}
      >
        {submitting
          ? t('openSpec.interaction.submitting')
          : t('openSpec.interaction.submit')}
      </Button>
    </div>
  );
}
