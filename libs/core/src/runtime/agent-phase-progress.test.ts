import { describe, it, expect } from 'vitest';

import { AutocodeExecutionPhaseParser } from './agent-phase-parsers.js';
import { PHASE_MARKER_PREFIX } from '../tasks/phase-protocol.js';

const makeMarker = (payload: Record<string, unknown>): string =>
  `${PHASE_MARKER_PREFIX}${JSON.stringify(payload)}`;

describe('AutocodeExecutionPhaseParser progress propagation', () => {
  const parser = new AutocodeExecutionPhaseParser();
  const context = { currentPhase: 'planning' as const, isTerminal: false, isSpecRunner: false };

  it('propagates the stage progress from a phase marker', () => {
    const result = parser.parse(
      makeMarker({ phase: 'planning', message: 'Standard planning: design_model', progress: 60 }),
      context,
    );
    expect(result).not.toBeNull();
    expect(result?.phase).toBe('planning');
    expect(result?.progress).toBe(60);
  });

  it('omits progress when the marker does not provide one', () => {
    const result = parser.parse(
      makeMarker({ phase: 'planning', message: 'Creating implementation plan' }),
      context,
    );
    expect(result).not.toBeNull();
    expect(result?.progress).toBeUndefined();
  });
});
