import { describe, expect, it } from 'vitest';

import {
  getRetryLimits,
  getWorkflowConfig,
} from './workflow-config.js';
import {
  inferAutocodeSpecComplexityFallback,
  selectAutocodeSpecPhases,
} from './spec-orchestrator-strategy.js';

describe('Standard mode optimization defaults', () => {
  it('keeps balanced Standard retries and prompt-heavy quality add-ons lean', () => {
    const config = getWorkflowConfig('balanced');

    expect(getRetryLimits(config)).toEqual({
      planning: 1,
      subtask: 2,
      qa: 1,
      specPhase: 1,
    });
    expect(config.qualityChecks).toMatchObject({
      enablePatternInjection: false,
      enableSelfCritique: false,
      enablePreImplementationChecklist: false,
      enableTieredQualityStandards: true,
    });
  });

  it('uses Standard light planning when local fallback sees no broad or high-risk signal', () => {
    const config = getWorkflowConfig('balanced');
    const fallback = inferAutocodeSpecComplexityFallback({
      taskDescription: 'Fix the settings label text.',
      workflowConfig: config,
    });

    expect(fallback).toMatchObject({
      complexity: 'simple',
      needs_self_critique: false,
    });
    expect(selectAutocodeSpecPhases({
      complexity: fallback.complexity,
      assessment: fallback,
      taskDescription: 'Fix the settings label text.',
      workflowConfig: config,
    })).toEqual(['quick_spec', 'validation']);
  });

  it('keeps local UI affordance changes on the Standard light route', () => {
    const config = getWorkflowConfig('balanced');
    const fallback = inferAutocodeSpecComplexityFallback({
      taskDescription: 'Add a dashboard UI tooltip for the settings button.',
      workflowConfig: config,
    });

    expect(fallback).toMatchObject({
      complexity: 'simple',
      needs_research: false,
      needs_self_critique: false,
    });
    expect(selectAutocodeSpecPhases({
      complexity: fallback.complexity,
      assessment: fallback,
      taskDescription: 'Add a dashboard UI tooltip for the settings button.',
      workflowConfig: config,
    })).toEqual(['quick_spec', 'validation']);
  });

  it('keeps external integrations on the shortened Standard route with research', () => {
    const config = getWorkflowConfig('balanced');
    const fallback = inferAutocodeSpecComplexityFallback({
      taskDescription: 'Create OAuth login integration for an external API.',
      workflowConfig: config,
    });

    expect(fallback).toMatchObject({
      complexity: 'standard',
      needs_research: true,
      needs_self_critique: false,
    });
    expect(selectAutocodeSpecPhases({
      complexity: fallback.complexity,
      assessment: fallback,
      taskDescription: 'Create OAuth login integration for an external API.',
      workflowConfig: config,
    })).toEqual(['requirements', 'research', 'spec_writing', 'planning', 'validation']);
  });

  it('keeps moderate balanced tasks on one compact Standard planning session', () => {
    const config = getWorkflowConfig('balanced');
    const fallback = inferAutocodeSpecComplexityFallback({
      taskDescription: 'Refactor the runtime metadata schema and update compatibility handling.',
      workflowConfig: config,
    });

    expect(fallback.complexity).toBe('standard');
    expect(selectAutocodeSpecPhases({
      complexity: 'standard',
      assessment: fallback,
      taskDescription: 'Refactor the runtime metadata schema and update compatibility handling.',
      workflowConfig: config,
    })).toEqual(['quick_spec', 'validation']);
  });

  it('preserves conservative Standard discovery for explicit high-assurance mode', () => {
    const config = getWorkflowConfig('conservative');
    const fallback = inferAutocodeSpecComplexityFallback({
      taskDescription: 'Fix the settings label text.',
      workflowConfig: config,
    });

    expect(fallback.complexity).toBe('standard');
    expect(fallback.needs_self_critique).toBe(true);
    expect(selectAutocodeSpecPhases({
      complexity: 'standard',
      assessment: fallback,
      taskDescription: 'Fix the settings label text.',
      workflowConfig: config,
    })).toEqual(['discovery', 'requirements', 'spec_writing', 'self_critique', 'planning', 'validation']);
  });
});