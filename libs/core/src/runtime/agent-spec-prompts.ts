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
  | 'requirement_model'
  | 'domain_model'
  | 'design'
  | 'design_model'
  | 'implementation_model'
  | 'design_review'
  | 'validation';

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
    case 'requirement_model':
      return 'requirement_modeler';
    case 'domain_model':
      return 'domain_modeler';
    case 'design':
      return 'software_designer';
    case 'design_model':
      return 'design_modeler';
    case 'implementation_model':
      return 'implementation_modeler';
    case 'design_review':
      return 'design_critic';
    case 'validation':
      return 'validation_fixer';
    default:
      return 'spec_writer';
  }
}
