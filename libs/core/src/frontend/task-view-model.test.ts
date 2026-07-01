import { describe, expect, it } from 'vitest';

import { buildAutocodeTaskCardViewModel } from './task-view-model.js';

describe('Autocode task card view model', () => {
  it('reports completed human review tasks as 100% even with stale subtask progress', () => {
    const viewModel = buildAutocodeTaskCardViewModel({
      id: 'task-1',
      specId: '001-direct',
      title: 'Direct task',
      description: 'Direct task completed',
      status: 'human_review',
      reviewReason: 'completed',
      executionPhase: 'complete',
      subtasks: [
        { status: 'completed' },
        { status: 'pending' },
      ],
      updatedAt: '2026-07-01T09:00:00.000Z',
    });

    expect(viewModel.progressPercent).toBe(100);
  });
});
