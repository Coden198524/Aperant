import { describe, expect, it } from 'vitest';

import { transformAutocodeIdeaFromSnakeCase } from './ideation-transformers.js';

describe('ideation transformers', () => {
  it('maps linked task ids from persisted converted ideas', () => {
    const idea = transformAutocodeIdeaFromSnakeCase({
      id: 'idea-1',
      type: 'security_hardening',
      title: 'Harden command execution',
      description: 'Constrain shell command templates.',
      rationale: 'Reduces shell injection risk.',
      status: 'archived',
      linked_task_id: '012-harden-command-execution',
    });

    expect(idea).toMatchObject({
      id: 'idea-1',
      status: 'archived',
      taskId: '012-harden-command-execution',
    });
  });
});
