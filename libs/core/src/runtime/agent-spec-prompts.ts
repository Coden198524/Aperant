export type AutocodeSpecPhase =
  | 'discovery'
  | 'requirements'
  | 'complexity_assessment'
  | 'historical_context'
  | 'research'
  | 'context'
  | 'spec_writing'
  | 'self_critique'
  | 'planning'
  | 'validation'
  | 'quick_spec';

export function specPhaseToAutocodePromptName(phase: AutocodeSpecPhase | string): string {
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

