import { describe, expect, it } from 'vitest';

import { resolveAutocodeTaskStartEvent } from './agent-runtime.js';

describe('resolveAutocodeTaskStartEvent', () => {
  it('resumes from human review when current XState is settled even if task status is stale in_progress', () => {
    const event = resolveAutocodeTaskStartEvent({
      currentState: 'human_review',
      planHasSubtasks: true,
      task: {
        status: 'in_progress',
        metadata: {},
      } as never,
    });

    expect(event).toEqual({ type: 'USER_RESUMED' });
  });

  it('restarts planning from human review when no implementation plan exists yet', () => {
    const event = resolveAutocodeTaskStartEvent({
      currentState: 'human_review',
      planHasSubtasks: false,
      task: {
        status: 'in_progress',
        metadata: {},
      } as never,
    });

    expect(event).toEqual({ type: 'PLANNING_STARTED' });
  });
});