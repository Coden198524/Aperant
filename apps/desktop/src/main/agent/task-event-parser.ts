import {
  AUTOCODE_TASK_EVENT_PREFIX,
  hasAutocodeTaskMarker,
  parseAutocodeTaskEvent,
} from '@autocode/core/runtime/agent-events';
import type { TaskEventPayload } from './task-event-schema';

export const TASK_EVENT_PREFIX = AUTOCODE_TASK_EVENT_PREFIX;

const DEBUG = process.env.DEBUG?.toLowerCase() === 'true' || process.env.DEBUG === '1';

export type TaskEvent = TaskEventPayload;

export function parseTaskEvent(line: string): TaskEventPayload | null {
  return parseAutocodeTaskEvent(line, { debug: DEBUG, logger: console.log });
}

export function hasTaskMarker(line: string): boolean {
  return hasAutocodeTaskMarker(line);
}
