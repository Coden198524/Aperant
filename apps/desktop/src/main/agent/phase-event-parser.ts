import {
  PHASE_MARKER_PREFIX,
  hasAutocodePhaseMarker,
  parseAutocodePhaseEvent,
} from '@autocode/core/runtime/agent-events';
import type { PhaseEventPayload } from './phase-event-schema';

export { PHASE_MARKER_PREFIX };
export type { PhaseEventPayload as PhaseEvent };

const DEBUG = process.env.DEBUG?.toLowerCase() === 'true' || process.env.DEBUG === '1';

export function parsePhaseEvent(line: string): PhaseEventPayload | null {
  return parseAutocodePhaseEvent(line, { debug: DEBUG, logger: console.log });
}

export function hasPhaseMarker(line: string): boolean {
  return hasAutocodePhaseMarker(line);
}
