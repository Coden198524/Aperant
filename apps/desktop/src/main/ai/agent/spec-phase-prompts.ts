import type { SpecPhase } from '../orchestration/spec-orchestrator';

/**
 * Map a spec orchestration phase to the prompt file name to load.
 * Kept in a separate module so it can be unit-tested without booting the worker.
 */
export function specPhaseToPromptName(phase: SpecPhase): string {
  switch (phase) {
    case 'discovery':
      return 'spec_discovery';
    case 'requirements':
      return 'spec_gatherer';
    case 'complexity_assessment':
      return 'complexity_assessor';
    case 'research':
      return 'spec_researcher';
    case 'context':
      return 'spec_context';
    case 'historical_context':
      return 'spec_context';
    case 'spec_writing':
      return 'spec_writer';
    case 'self_critique':
      return 'spec_critic';
    case 'planning':
      return 'planner';
    case 'quick_spec':
      return 'spec_quick';
    case 'validation':
      return 'validation_fixer';
    default:
      return 'spec_writer';
  }
}
