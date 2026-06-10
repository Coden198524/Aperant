import { assign, createMachine } from 'xstate';
import {
  AUTOCODE_ROADMAP_GENERATION_INITIAL_CONTEXT,
  clampAutocodeProgress,
} from '@autocode/core/tasks/state-machine-rules';

export interface RoadmapGenerationContext {
  progress: number;
  message?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  lastActivityAt?: number;
}

export type RoadmapGenerationEvent =
  | { type: 'START_GENERATION' }
  | { type: 'PROGRESS_UPDATE'; progress: number; message: string }
  | { type: 'DISCOVERY_STARTED' }
  | { type: 'GENERATION_STARTED' }
  | { type: 'GENERATION_COMPLETE' }
  | { type: 'GENERATION_ERROR'; error: string }
  | { type: 'STOP' }
  | { type: 'RESET' };

export const roadmapGenerationMachine = createMachine(
  {
    id: 'roadmapGeneration',
    initial: 'idle',
    types: {} as {
      context: RoadmapGenerationContext;
      events: RoadmapGenerationEvent;
    },
    context: { ...AUTOCODE_ROADMAP_GENERATION_INITIAL_CONTEXT },
    states: {
      idle: {
        on: {
          START_GENERATION: { target: 'analyzing', actions: 'setStarted' },
        },
      },
      analyzing: {
        on: {
          PROGRESS_UPDATE: { actions: 'updateProgress' },
          DISCOVERY_STARTED: 'discovering',
          GENERATION_ERROR: { target: 'error', actions: 'setError' },
          STOP: { target: 'idle', actions: 'resetContext' },
        },
      },
      discovering: {
        on: {
          PROGRESS_UPDATE: { actions: 'updateProgress' },
          GENERATION_STARTED: 'generating',
          GENERATION_ERROR: { target: 'error', actions: 'setError' },
          STOP: { target: 'idle', actions: 'resetContext' },
        },
      },
      generating: {
        on: {
          PROGRESS_UPDATE: { actions: 'updateProgress' },
          GENERATION_COMPLETE: { target: 'complete', actions: 'setCompleted' },
          GENERATION_ERROR: { target: 'error', actions: 'setError' },
          STOP: { target: 'idle', actions: 'resetContext' },
        },
      },
      complete: {
        on: {
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
      error: {
        on: {
          RESET: { target: 'idle', actions: 'resetContext' },
        },
      },
    },
  },
  {
    actions: {
      setStarted: assign({
        progress: () => 0,
        message: () => undefined,
        error: () => undefined,
        startedAt: () => Date.now(),
        completedAt: () => undefined,
        lastActivityAt: () => Date.now(),
      }),
      updateProgress: assign({
        progress: ({ event }) =>
          event.type === 'PROGRESS_UPDATE' ? clampAutocodeProgress(event.progress) : 0,
        message: ({ event }) =>
          event.type === 'PROGRESS_UPDATE' ? event.message : undefined,
        lastActivityAt: () => Date.now(),
      }),
      setCompleted: assign({
        progress: () => 100,
        completedAt: () => Date.now(),
        lastActivityAt: () => Date.now(),
      }),
      setError: assign({
        error: ({ event }) =>
          event.type === 'GENERATION_ERROR' ? event.error : undefined,
        lastActivityAt: () => Date.now(),
      }),
      resetContext: assign({
        progress: () => 0,
        message: () => undefined,
        error: () => undefined,
        startedAt: () => undefined,
        completedAt: () => undefined,
        lastActivityAt: () => undefined,
      }),
    },
  }
);
