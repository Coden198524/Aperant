import { describe, expect, it } from 'vitest';

import {
  parseAutocodeStandardPlanningOwnerPlan,
  resolveAutocodeStandardPlanningOwnerPlan,
} from './standard-planning-owner.js';

function changeRequest(input: {
  id: string;
  flowDocuments?: string[];
  impacts?: string[];
  scope?: string;
  mode?: string;
}): string {
  return JSON.stringify({
    id: input.id,
    createdAt: '2026-07-15T00:00:00.000Z',
    scope: input.scope ?? 'planning',
    impacts: input.impacts ?? [],
    iteration: {
      mode: input.mode ?? 'standard-planning',
      flowDocuments: input.flowDocuments ?? [],
    },
  });
}

describe('Standard planning owner plan', () => {
  it('routes tasks-only changes to the planner owner', () => {
    expect(parseAutocodeStandardPlanningOwnerPlan(changeRequest({
      id: 'CR-TASKS',
      flowDocuments: ['HUMAN_INPUT.md', 'change_requests.jsonl', 'tasks.md'],
      impacts: ['tasks', 'validation'],
    }))).toMatchObject({
      stages: ['tasks'],
      changeRequestId: 'CR-TASKS',
      source: 'change_request',
    });
  });

  it('routes design changes through design review and tasks', () => {
    expect(parseAutocodeStandardPlanningOwnerPlan(changeRequest({
      id: 'CR-DESIGN',
      flowDocuments: ['design.md', 'design_review.md', 'tasks.md'],
      impacts: ['design'],
    }))?.stages).toEqual([
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ]);
  });

  it('routes requirements changes through the complete owner chain', () => {
    expect(parseAutocodeStandardPlanningOwnerPlan(changeRequest({
      id: 'CR-REQ',
      flowDocuments: ['requirements.md', 'spec.md', 'design.md', 'tasks.md'],
      impacts: ['requirements'],
    }))?.stages).toEqual([
      'requirements',
      'spec',
      'requirement_model',
      'domain_model',
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ]);
  });

  it('ignores malformed trailing lines and non-planning records', () => {
    const content = [
      changeRequest({ id: 'CR-VALID', flowDocuments: ['tasks.md'] }),
      changeRequest({
        id: 'CR-IMPLEMENTATION',
        scope: 'implementation',
        mode: 'standard-implementation',
        impacts: ['implementation'],
      }),
      '{broken',
    ].join('\n');

    expect(parseAutocodeStandardPlanningOwnerPlan(content)?.changeRequestId).toBe('CR-VALID');
  });

  it('uses full recovery for an invalid force-planning journal', () => {
    expect(resolveAutocodeStandardPlanningOwnerPlan({
      phase: 'planning',
      forcePlanning: true,
      changeRequestsContent: '{broken',
    })).toMatchObject({
      source: 'invalid_change_request',
      stages: [
        'requirements',
        'spec',
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'tasks',
      ],
    });
  });

  it('keeps legacy planning compatible when no journal exists', () => {
    expect(resolveAutocodeStandardPlanningOwnerPlan({
      phase: 'planning',
      forcePlanning: true,
    })).toMatchObject({
      source: 'legacy_force',
      stages: [
        'requirement_model',
        'domain_model',
        'design',
        'design_model',
        'implementation_model',
        'design_review',
        'tasks',
      ],
    });
  });

  it('starts at the earliest explicitly affected model artifact', () => {
    expect(parseAutocodeStandardPlanningOwnerPlan(changeRequest({
      id: 'CR-DOMAIN',
      flowDocuments: [
        'domain_model.md',
        'design.md',
        'design_model.md',
        'implementation_model.md',
        'design_review.md',
        'tasks.md',
      ],
    }))?.stages).toEqual([
      'domain_model',
      'design',
      'design_model',
      'implementation_model',
      'design_review',
      'tasks',
    ]);

    expect(parseAutocodeStandardPlanningOwnerPlan(changeRequest({
      id: 'CR-IMPLEMENTATION-MODEL',
      flowDocuments: ['implementation_model.md', 'design_review.md', 'tasks.md'],
    }))?.stages).toEqual(['implementation_model', 'design_review', 'tasks']);
  });
});
