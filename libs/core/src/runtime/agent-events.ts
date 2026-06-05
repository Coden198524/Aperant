import { z } from 'zod';

import {
  BACKEND_PHASES,
  PHASE_MARKER_PREFIX,
} from '../tasks/phase-protocol.js';

export { PHASE_MARKER_PREFIX };

export const AUTOCODE_TASK_EVENT_PREFIX = '__TASK_EVENT__:';

export const AutocodeTaskEventSchema = z.object({
  type: z.string(),
  taskId: z.string(),
  specId: z.string(),
  projectId: z.string(),
  timestamp: z.string(),
  eventId: z.string(),
  sequence: z.number().int().min(0),
}).passthrough();

export type AutocodeTaskEventPayload = z.infer<typeof AutocodeTaskEventSchema>;

const AutocodeBackendPhaseSchema = z.enum(BACKEND_PHASES as unknown as [string, ...string[]]);

export const AutocodePhaseEventSchema = z.object({
  phase: AutocodeBackendPhaseSchema,
  message: z.string().default(''),
  progress: z.number().int().min(0).max(100).optional(),
  subtask: z.string().optional(),
  reset_timestamp: z.number().int().optional(),
  profile_id: z.string().optional(),
});

export type AutocodePhaseEventPayload = z.infer<typeof AutocodePhaseEventSchema>;

export interface AutocodeValidationResult<T> {
  success: true;
  data: T;
}

export interface AutocodeValidationError {
  success: false;
  error: z.ZodError;
}

export type AutocodeParseResult<T> = AutocodeValidationResult<T> | AutocodeValidationError;

export interface AutocodeAgentEventParserOptions {
  debug?: boolean;
  logger?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

export function validateAutocodeTaskEvent(data: unknown): AutocodeParseResult<AutocodeTaskEventPayload> {
  const result = AutocodeTaskEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as AutocodeTaskEventPayload };
  }
  return { success: false, error: result.error };
}

export function validateAutocodePhaseEvent(data: unknown): AutocodeParseResult<AutocodePhaseEventPayload> {
  const result = AutocodePhaseEventSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as AutocodePhaseEventPayload };
  }
  return { success: false, error: result.error };
}

export function isValidAutocodePhasePayload(data: unknown): data is AutocodePhaseEventPayload {
  return AutocodePhaseEventSchema.safeParse(data).success;
}

export function parseAutocodeTaskEvent(
  line: string,
  options: AutocodeAgentEventParserOptions = {},
): AutocodeTaskEventPayload | null {
  return parseAutocodeAgentEvent(line, AUTOCODE_TASK_EVENT_PREFIX, validateAutocodeTaskEvent, 'task-event-parser', options);
}

export function hasAutocodeTaskMarker(line: string): boolean {
  return line.includes(AUTOCODE_TASK_EVENT_PREFIX);
}

export function parseAutocodePhaseEvent(
  line: string,
  options: AutocodeAgentEventParserOptions = {},
): AutocodePhaseEventPayload | null {
  return parseAutocodeAgentEvent(line, PHASE_MARKER_PREFIX, validateAutocodePhaseEvent, 'phase-event-parser', options);
}

export function hasAutocodePhaseMarker(line: string): boolean {
  return line.includes(PHASE_MARKER_PREFIX);
}

function parseAutocodeAgentEvent<T>(
  line: string,
  marker: string,
  validate: (data: unknown) => AutocodeParseResult<T>,
  logScope: string,
  options: AutocodeAgentEventParserOptions,
): T | null {
  const markerIndex = line.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  debugLog(options, `[${logScope}] Found marker at index`, markerIndex, 'in line:', line.substring(0, 200));

  const rawJsonStr = line.slice(markerIndex + marker.length).trim();
  if (!rawJsonStr) {
    debugLog(options, `[${logScope}] Empty JSON string after marker`);
    return null;
  }

  const jsonStr = extractAutocodeJsonObject(rawJsonStr);
  if (!jsonStr) {
    debugLog(options, `[${logScope}] Could not extract JSON object from:`, rawJsonStr.substring(0, 200));
    return null;
  }

  debugLog(options, `[${logScope}] Attempting to parse JSON:`, jsonStr.substring(0, 200));

  try {
    const rawPayload = JSON.parse(jsonStr) as unknown;
    const result = validate(rawPayload);

    if (!result.success) {
      debugLog(options, `[${logScope}] Validation failed:`, result.error.format());
      return null;
    }

    debugLog(options, `[${logScope}] Successfully parsed event:`, result.data);
    return result.data;
  } catch (error) {
    debugLog(options, `[${logScope}] JSON parse FAILED for:`, jsonStr);
    debugLog(options, `[${logScope}] Error:`, error);
    return null;
  }
}

export function extractAutocodeJsonObject(str: string): string | null {
  const firstBrace = str.indexOf('{');
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = firstBrace; i < str.length; i++) {
    const char = str[i];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return str.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

function debugLog(options: AutocodeAgentEventParserOptions, message?: unknown, ...optionalParams: unknown[]): void {
  if (!options.debug) return;
  options.logger?.(message, ...optionalParams);
}

