import {
  specPhaseToAutocodePromptName,
} from '@autocode/core/runtime/agent-spec-prompts';
import type { SpecPhase } from '../orchestration/spec-orchestrator';

export function specPhaseToPromptName(phase: SpecPhase): string {
  return specPhaseToAutocodePromptName(phase);
}
