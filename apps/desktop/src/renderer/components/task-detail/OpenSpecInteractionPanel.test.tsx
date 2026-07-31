// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OpenSpecInteraction } from '../../../shared/types';
import {
  OpenSpecInteractionPanel,
  serializeOpenSpecInteractionAnswers,
} from './OpenSpecInteractionPanel';

const interactionTranslations: Record<string, string> = {
  'openSpec.interaction.additionalAnswerAria': 'Additional answer for question {{number}}',
  'openSpec.interaction.answerAria': 'Answer question {{number}}',
  'openSpec.interaction.optionalDetailPlaceholder': 'Optional additional detail…',
  'openSpec.interaction.answerPlaceholder': 'Answer the official workflow question…',
  'openSpec.interaction.submitting': 'Submitting…',
  'openSpec.interaction.submit': 'Submit answer',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = interactionTranslations[key] ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        value = value.replace(`{{${name}}}`, String(replacement));
      }
      return value;
    },
    i18n: { language: 'en' },
  }),
}));

function interaction(overrides: Partial<OpenSpecInteraction> = {}): OpenSpecInteraction {
  return {
    interactionId: 'interaction-a',
    runId: 'run-a',
    taskId: 'task-a',
    prompt: 'Choose how to continue.',
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('OpenSpecInteractionPanel', () => {
  it('collects multiple single- and multi-select official questions', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <OpenSpecInteractionPanel
        interaction={interaction({
          questions: [
            {
              header: 'Sync',
              question: 'How should specs be synchronized?',
              options: [
                { label: 'Sync now', description: 'Recommended' },
                { label: 'Skip sync' },
              ],
            },
            {
              header: 'Changes',
              question: 'Which changes should be archived?',
              options: [
                { label: 'change-a' },
                { label: 'change-b' },
                { label: 'change-c' },
              ],
              multiSelect: true,
            },
          ],
        })}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Sync now/ }));
    fireEvent.click(screen.getByLabelText('change-a'));
    fireEvent.click(screen.getByLabelText('change-b'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([
      'Question 1 (Sync): How should specs be synchronized?',
      'Answer: Sync now',
      '',
      'Question 2 (Changes): Which changes should be archived?',
      'Answer: change-a, change-b',
    ].join('\n')));
  });

  it('supports an open-ended question and preserves a single raw answer', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <OpenSpecInteractionPanel
        interaction={interaction({
          prompt: 'What capability should this change add?',
        })}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('Answer question 1'), {
      target: { value: 'Add immutable audit logging.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      'Add immutable audit logging.',
    ));
  });

  it('serializes option detail without translating the official question', () => {
    const current = interaction({
      questions: [{
        question: 'Proceed despite incomplete tasks?',
        options: [{ label: 'Proceed' }, { label: 'Cancel' }],
      }],
    });
    expect(serializeOpenSpecInteractionAnswers(current, {
      0: {
        selected: ['Proceed'],
        text: 'I reviewed the warning.',
      },
    })).toBe('Proceed\nI reviewed the warning.');
  });
});
